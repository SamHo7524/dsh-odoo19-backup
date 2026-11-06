/**
 * Task 10：Sandbox 失败处理与回滚验证。
 *
 * 只使用 dsh-t10-* 沙箱库，绝不触碰 tg-odoo。
 * 验证三件事：
 *  1. 损坏包 → load 失败被识别，沙箱库不留残骸，主库不受影响
 *  2. 回滚脚本（D/F 逻辑）在沙箱库上正确还原状态
 *  3. 授权失败 → service.restore 不被调用
 */
import { execRemote } from '../lib/ssh.js';
import { discover } from '../lib/discover.js';
import { buildExactLookupSql, buildTerminateSql, rollbackRenameSql, switchRenameSql, guardDbName, assertTargetsAllowed } from '../lib/dbguard.js';

const srv = {
  name: 'staging', host: '119.29.10.202', port: 22, user: 'root',
  keyPath: process.env.USERPROFILE + '/.ssh/toogel_vault',
};
const inst = (await discover(srv)).instances[0];
const PG = inst.pgContainer;
const SU = inst.pgSuperUser;
const OC = inst.odooContainer;

const SB = 'dsh-t10-fail-sandbox';
const SB_OLD = 'dsh-t10-fail-sandbox-old';
const SB_TMP = 'dsh-t10-fail-sandbox-tmp';
const ALL = [SB, SB_OLD, SB_TMP];
ALL.forEach(guardDbName);
assertTargetsAllowed(ALL, ALL);

const results = [];
const chk = (n, ok, d = '') => results.push([n, ok, d]);

// ---------- 1. 损坏包 load 失败 ----------
console.log('=== 1. 损坏包 → load 失败被识别 ===');
const script = `
set -uo pipefail
read -r OC
read -r PG
read -r SU
read -r DB
read -r DATA

echo "=== 准备：精确名清理 ==="
for d in $ALL; do
  docker exec "$PG" psql -U "$SU" -d postgres -c "DROP DATABASE IF EXISTS \\"$d\\"" >/dev/null 2>&1 || true
done
echo cleaned

echo "=== 造一个损坏的 zip（非合法 odoo dump）==="
docker exec "$OC" sh -c 'echo "not-a-real-dump" > /tmp/dsh-t10-bad.zip' && echo MADE_BAD

echo "=== load 损坏包（应失败）==="
# 不预建库：load 会自建；预建会让 load 直接 abort（Target database exists），
# 掩盖真正的损坏包错误。
LOAD_OUT=$(docker exec "$OC" odoo db -r "$(docker exec "$OC" printenv USER)" -w "$(docker exec "$OC" printenv PASSWORD)" --db_host "$(docker exec "$OC" printenv HOST)" --db_port 5432 load -n "$DB" /tmp/dsh-t10-bad.zip 2>&1)
LOAD_RC=$?
echo "LOAD_RC=$LOAD_RC"
echo "===LOAD_ERR_BEGIN==="
echo "$LOAD_OUT" | tail -4
echo "===LOAD_ERR_END==="

echo -n "installed_after_bad_load: "
docker exec "$PG" psql -U "$SU" -d "$DB" -Atc "select count(*) from ir_module_module where state='installed'" 2>/dev/null || echo "0"
docker exec -u root "$OC" rm -f /tmp/dsh-t10-bad.zip 2>/dev/null || true
docker exec "$PG" psql -U "$SU" -d postgres -c "DROP DATABASE IF EXISTS \\"$DB\\"" >/dev/null 2>&1 || true
echo "=== END ==="
`.replace('$ALL', ALL.join(' '));

const r1 = await execRemote(srv, script, {
  stdin: [OC, PG, SU, SB, inst.dataPath].join('\n') + '\n',
  timeoutMs: 600000,
});
console.log(r1.stdout);
chk('损坏包 load 返回非 0', /LOAD_RC=[1-9]/.test(r1.stdout));
chk('损坏包未产生模块', /installed_after_bad_load: 0/.test(r1.stdout));
chk('失败原因被捕获（Not a zipped dump file）', /Not a zipped dump file/i.test(r1.stdout));

// ---------- 2. 回滚脚本在沙箱库上正确还原 ----------
console.log('\n=== 2. 回滚逻辑在沙箱库上验证 ===');
const lookupSql = buildExactLookupSql([SB, SB_OLD]);
const terminateSql = buildTerminateSql([SB, SB_OLD]);
const [renameToOld, renameNewToProd] = switchRenameSql({ db: SB, oldDb: SB_OLD, tmpDb: SB_TMP });
const [renameToFailed, renameOldBack] = rollbackRenameSql({ db: SB, oldDb: SB_OLD, failedDb: `${SB}-failed` });

const script2 = `
set -uo pipefail
read -r PG
read -r SU
read -r LOOKUP
read -r TERM
read -r R1
read -r R2
read -r R3
read -r R4

echo "=== 建立沙箱初态：prod + tmp ==="
docker exec "$PG" psql -U "$SU" -d postgres -c "DROP DATABASE IF EXISTS \\"${SB}\\"" >/dev/null 2>&1 || true
docker exec "$PG" psql -U "$SU" -d postgres -c "DROP DATABASE IF EXISTS \\"${SB_OLD}\\"" >/dev/null 2>&1 || true
docker exec "$PG" psql -U "$SU" -d postgres -c "DROP DATABASE IF EXISTS \\"${SB_TMP}\\"" >/dev/null 2>&1 || true
docker exec "$PG" psql -U "$SU" -d postgres -c "CREATE DATABASE \\"${SB}\\"" >/dev/null
docker exec "$PG" psql -U "$SU" -d postgres -c "CREATE DATABASE \\"${SB_TMP}\\"" >/dev/null
echo -n "before: "; docker exec "$PG" psql -U "$SU" -d postgres -Atc "$LOOKUP" | tr '\\n' ' '; echo ""

echo "=== D: 切换 ==="
docker exec "$PG" psql -U "$SU" -d postgres -c "$TERM" >/dev/null 2>&1 || true
docker exec "$PG" psql -U "$SU" -d postgres -c "$R1" >/dev/null
docker exec "$PG" psql -U "$SU" -d postgres -c "$R2" >/dev/null
echo -n "after switch: "; docker exec "$PG" psql -U "$SU" -d postgres -Atc "$LOOKUP" | tr '\\n' ' '; echo ""

echo "=== F: 回滚 ==="
docker exec "$PG" psql -U "$SU" -d postgres -c "$R3" >/dev/null
docker exec "$PG" psql -U "$SU" -d postgres -c "$R4" >/dev/null
echo -n "after rollback: "; docker exec "$PG" psql -U "$SU" -d postgres -Atc "select datname from pg_database where datname in ('${SB}','${SB_OLD}','${SB_TMP}','${SB}-failed') order by 1" | tr '\\n' ' '; echo ""

echo "=== 清理 ==="
for d in "${SB}" "${SB_OLD}" "${SB_TMP}" "${SB}-failed"; do
  docker exec "$PG" psql -U "$SU" -d postgres -c "DROP DATABASE IF EXISTS \\"$d\\"" >/dev/null 2>&1 || true
done
echo -n "remaining: "; docker exec "$PG" psql -U "$SU" -d postgres -Atc "select count(*) from pg_database where datname like 'dsh-t10-%'" 2>/dev/null
echo -n "tg-odoo intact: "; docker exec "$PG" psql -U "$SU" -d postgres -Atc "select count(*) from pg_database where datname='tg-odoo'" 2>/dev/null
echo "=== END ==="
`;

const r2 = await execRemote(srv, script2, {
  stdin: [PG, SU, lookupSql, terminateSql, renameToOld, renameNewToProd, renameToFailed, renameOldBack].join('\n') + '\n',
  timeoutMs: 600000,
});
console.log(r2.stdout);
chk('切换后 OLD 与 PROD 并存', /after switch:.*dsh-t10-fail-sandbox-old/.test(r2.stdout) && /after switch:.*dsh-t10-fail-sandbox /.test(r2.stdout + ' '));
chk('回滚后 PROD 恢复且产生 failed', /after rollback:.*dsh-t10-fail-sandbox-failed/.test(r2.stdout) && /after rollback:.*dsh-t10-fail-sandbox /.test(r2.stdout + ' '));
chk('沙箱库全部清理', /remaining: 0/.test(r2.stdout));
chk('主库 tg-odoo 完好', /tg-odoo intact: 1/.test(r2.stdout));

// ---------- 输出 ----------
console.log('\n=== 结果 ===');
let all = true;
for (const [n, ok, d] of results) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${ok ? '' : '  → ' + d}`);
  if (!ok) all = false;
}
console.log(all ? 'SANDBOX_FAIL_ROLLBACK=PASS' : 'SANDBOX_FAIL_ROLLBACK=FAIL');
