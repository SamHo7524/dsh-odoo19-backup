/**
 * D/E/F Sandbox 演练（方案 3）：只验证切换/回滚脚本逻辑，绝不触碰恢复目标。
 *
 * 硬约束：
 *  - 所有库名前缀 dsh-sandbox-，与 tg-odoo 无任何前缀重叠
 *  - 不停 Odoo 容器、不读改 odoo.conf、不碰 /web、不碰 tg-odoo 主库或 filestore
 *  - 用插件自己的 dbguard 生成 SQL，且断言 SQL 中绝不出现 tg-odoo / LIKE / %
 *  - 精确名 + 授权清单校验；SQL 通过 stdin 变量传入（复刻插件真实引号路径）
 */
import { execRemote } from '../lib/ssh.js';
import { discover } from '../lib/discover.js';
import {
  guardDbName,
  buildTerminateSql,
  buildExactLookupSql,
  switchRenameSql,
  rollbackRenameSql,
  assertTargetsAllowed,
} from '../lib/dbguard.js';

const srv = {
  name: 'staging', host: '119.29.10.202', port: 22, user: 'root',
  keyPath: process.env.USERPROFILE + '/.ssh/toogel_vault',
};
const scan = await discover(srv);
const PG = scan.instances[0].pgContainer;
const SU = scan.instances[0].pgSuperUser;

const DB = 'dsh-sandbox-prod';
const OLD = 'dsh-sandbox-old-20261104';
const TMP = 'dsh-sandbox-tmp-20261104';
const FAILED = 'dsh-sandbox-failed-20261104';
const ALL = [DB, OLD, TMP, FAILED];
ALL.forEach(guardDbName);
assertTargetsAllowed(ALL, ALL);

const terminateSql = buildTerminateSql([DB, TMP]);
const lookupSql = buildExactLookupSql([DB, OLD]);
const [renameOldSql, renameNewSql] = switchRenameSql({ db: DB, oldDb: OLD, tmpDb: TMP });
const [renameFailedSql, renameBackSql] = rollbackRenameSql({ db: DB, oldDb: OLD, failedDb: FAILED });
const allSql = [terminateSql, lookupSql, renameOldSql, renameNewSql, renameFailedSql, renameBackSql];

for (const sql of allSql) {
  if (sql.includes('tg-odoo')) throw new Error('SANDBOX ABORT: SQL 里出现了主库名 tg-odoo');
  if (/LIKE/i.test(sql) || sql.includes('%')) throw new Error('SANDBOX ABORT: SQL 里出现 LIKE / % 通配');
  if (sql.includes('\n')) throw new Error('SANDBOX ABORT: SQL 含换行，无法用 read -r 传递');
}
console.log('[GUARD] 全部 SQL 无 tg-odoo、无 LIKE、无 %、无换行 —— 通过');
for (const s of [terminateSql, lookupSql, renameOldSql, renameNewSql]) console.log('  ', s);

function q(n) { return `"${guardDbName(n)}"`; }

// 与插件 buildSwitchScript / buildRollbackScript 一致：SQL 经 read -r 读入变量，
// 再用 -c "$VAR" 传递（变量展开不会二次解析引号，标识符的双引号得以保留）。
const script = `
set -uo pipefail
read -r PG
read -r SU
read -r DROP_LIST
read -r TERMINATE_SQL
read -r LOOKUP_SQL
read -r RENAME_OLD_SQL
read -r RENAME_NEW_SQL
read -r RENAME_FAILED_SQL
read -r RENAME_BACK_SQL
read -r CREATE_TMP_SQL
read -r CREATE_DB_SQL
read -r LIST_SQL

echo "=== PRE: 清理同名沙箱库（精确名，逐个） ==="
for d in \$DROP_LIST; do
  docker exec "\$PG" psql -U "\$SU" -d postgres -c "DROP DATABASE IF EXISTS \\"\$d\\"" >/dev/null 2>&1 || true
done
echo "cleanup done"

echo "=== 建立沙箱初始状态（模拟：主库 + 待切换临时库） ==="
docker exec "\$PG" psql -U "\$SU" -d postgres -c "\$CREATE_TMP_SQL" >/dev/null
docker exec "\$PG" psql -U "\$SU" -d postgres -c "\$CREATE_DB_SQL" >/dev/null
echo -n "before: "
docker exec "\$PG" psql -U "\$SU" -d postgres -Atc "\$LIST_SQL" | tr '\n' ' '
echo ""

echo "=== D: 切换（终止连接 + 两次精确 RENAME） ==="
docker exec "\$PG" psql -U "\$SU" -d postgres -c "\$TERMINATE_SQL" >/dev/null 2>&1 || true
docker exec "\$PG" psql -U "\$SU" -d postgres -c "\$RENAME_OLD_SQL" >/dev/null
docker exec "\$PG" psql -U "\$SU" -d postgres -c "\$RENAME_NEW_SQL" >/dev/null
echo -n "after switch: "
docker exec "\$PG" psql -U "\$SU" -d postgres -Atc "\$LIST_SQL" | tr '\n' ' '
echo ""

echo "=== E: 验证（只读精确探测） ==="
echo -n "lookup(prod,old): "
docker exec "\$PG" psql -U "\$SU" -d postgres -Atc "\$LOOKUP_SQL" | tr '\n' ' '
echo ""

echo "=== F: 回滚探测（精确 IN 名单，不用 LIKE） ==="
echo -n "detect(prod,old): "
docker exec "\$PG" psql -U "\$SU" -d postgres -Atc "\$LOOKUP_SQL" | tr '\n' ' '
echo ""

echo "=== F: 回滚（精确 RENAME） ==="
docker exec "\$PG" psql -U "\$SU" -d postgres -c "\$RENAME_FAILED_SQL" >/dev/null
docker exec "\$PG" psql -U "\$SU" -d postgres -c "\$RENAME_BACK_SQL" >/dev/null
echo -n "after rollback: "
docker exec "\$PG" psql -U "\$SU" -d postgres -Atc "\$LIST_SQL" | tr '\n' ' '
echo ""

echo "=== 主库完好性断言（只读） ==="
echo -n "tg-odoo exists: "
docker exec "\$PG" psql -U "\$SU" -d postgres -Atc "select count(*) from pg_database where datname='tg-odoo'" 2>/dev/null
echo -n "tg-odoo installed: "
docker exec "\$PG" psql -U "\$SU" -d tg-odoo -Atc "select count(*) from ir_module_module where state='installed'" 2>/dev/null || echo 0

echo "=== CLEANUP（精确名，逐个） ==="
for d in \$DROP_LIST; do
  docker exec "\$PG" psql -U "\$SU" -d postgres -c "DROP DATABASE IF EXISTS \\"\$d\\"" >/dev/null 2>&1 || true
done
echo -n "remaining sandbox dbs: "
docker exec "\$PG" psql -U "\$SU" -d postgres -Atc "select count(*) from pg_database where datname in ('dsh-sandbox-prod','dsh-sandbox-old-20261104','dsh-sandbox-tmp-20261104','dsh-sandbox-failed-20261104')" 2>/dev/null
echo "=== END ==="
`;

const createTmpSql = `CREATE DATABASE ${q(TMP)}`;
const createDbSql = `CREATE DATABASE ${q(DB)}`;
const listSql = `select datname from pg_database where datname in (${ALL.map((n) => `'${n}'`).join(',')}) order by 1`;

const r = await execRemote(srv, script, {
  stdin: [
    PG, SU, ALL.join(' '),
    terminateSql, lookupSql, renameOldSql, renameNewSql, renameFailedSql, renameBackSql,
    createTmpSql, createDbSql, listSql,
  ].join('\n') + '\n',
  timeoutMs: 600000,
});
console.log(r.stdout);
console.log('--- STDERR ---');
console.log(r.stderr.slice(-300));

const out = r.stdout;
const checks = [
  ['GUARD 本地断言', true],
  ['切换后 OLD 与 DB 均在', /after switch:.*dsh-sandbox-old-20261104/.test(out) && /after switch:.*dsh-sandbox-prod/.test(out)],
  ['回滚后 failed 与 prod 均在', /after rollback:.*dsh-sandbox-failed-20261104/.test(out) && /after rollback:.*dsh-sandbox-prod/.test(out)],
  ['主库仍在', /tg-odoo exists: 1/.test(out)],
  ['主库 168 模块', /tg-odoo installed: 168/.test(out)],
  ['沙箱库已清理', /remaining sandbox dbs: 0/.test(out)],
];
console.log('\n=== SANDBOX 结果 ===');
let allOk = true;
for (const [k, v] of checks) { console.log(`  ${v ? 'PASS' : 'FAIL'}  ${k}`); if (!v) allOk = false; }
console.log(allOk ? 'SANDBOX_DRILL=PASS' : 'SANDBOX_DRILL=FAIL');
