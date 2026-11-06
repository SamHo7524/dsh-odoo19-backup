/**
 * Task 10 Step 11：最终检查 staging 主库、filestore、HTTP 服务与临时资源。
 * 全程只读（DROP/CREATE 均不执行；仅 SELECT 与 ls/du/curl）。
 */
import { execRemote } from '../lib/ssh.js';
import { verifyInstance } from '../lib/verify.js';
import { discover } from '../lib/discover.js';

const srv = {
  name: 'staging', host: '119.29.10.202', port: 22, user: 'root',
  keyPath: process.env.USERPROFILE + '/.ssh/toogel_vault',
};
const inst = (await discover(srv)).instances[0];
console.log('instance:', inst.odooContainer, '| db:', inst.dbName);

const script = `
set -uo pipefail
echo "=== 1. 所有数据库（应只有 tg-odoo + 系统库）==="
docker exec 1Panel-postgresql-ZcrG psql -U pgsl -d postgres -Atc "select datname from pg_database order by 1"

echo "=== 2. 主库关键指标 ==="
echo -n "tg-odoo exists: "
docker exec 1Panel-postgresql-ZcrG psql -U pgsl -d postgres -Atc "select count(*) from pg_database where datname='tg-odoo'"
echo -n "installed: "
docker exec 1Panel-postgresql-ZcrG psql -U pgsl -d tg-odoo -Atc "select count(*) from ir_module_module where state='installed'"
echo -n "binary_attachments: "
docker exec 1Panel-postgresql-ZcrG psql -U pgsl -d tg-odoo -Atc "select count(*) from ir_attachment where type='binary' and store_fname is not null and store_fname<>''"

echo "=== 3. filestore ==="
FS=/opt/1panel/apps/odoo/odoo/data/data/filestore
echo "-- 目录列表 --"
ls -1 "$FS" 2>/dev/null
echo -n "tg-odoo 文件数: "
find "$FS/tg-odoo" -type f 2>/dev/null | wc -l
echo -n "tg-odoo 大小: "
du -sh "$FS/tg-odoo" 2>/dev/null | awk '{print $1}'
echo -n "嵌套检查: "
[ -d "$FS/tg-odoo/filestore" ] && echo "YES_BAD" || echo "no"

echo "=== 4. Odoo 容器 ==="
docker inspect 1Panel-odoo-5td9 --format '{{.State.Status}} (started {{.State.StartedAt}})'
echo -n "odoo.conf dbfilter: "
docker exec 1Panel-odoo-5td9 sh -c "grep -E '^dbfilter' /etc/odoo/odoo.conf 2>/dev/null || echo NONE"

echo "=== 5. HTTP 服务 ==="
for p in / /shop /web/login; do
  echo -n "  $p → "
  curl -s -o /dev/null -w '%{http_code} %{size_download}\\n' --max-time 15 "http://127.0.0.1:8069$p" 2>/dev/null || echo "000"
done

echo "=== 6. 临时资源（应为空）==="
echo "-- /tmp 中的 dsh/t10/odoo 残留 --"
ls -lh /tmp/dsh-t10-* /tmp/restore-*.zip /tmp/safety-backup-*.zip /tmp/debug-dump.zip 2>/dev/null || echo "  none"
echo "-- 容器内 /tmp 残留 --"
docker exec 1Panel-odoo-5td9 sh -c 'ls -1 /tmp/*.zip 2>/dev/null || echo "  none"'

echo "=== 7. 磁盘 ==="
df -h / | tail -1
echo "=== END ==="
`;
const r = await execRemote(srv, script, { timeoutMs: 300000 });
console.log(r.stdout);

// 插件层 V1-V7 复验（只读）
console.log('=== 8. 插件 V1–V7 复验（主库，只读）===');
const v = await verifyInstance({ server: srv, instance: inst, baseline: { installed: 168 } });
console.log('  ok =', v.ok);
for (const x of v.results) {
  console.log(`  ${x.pass ? 'PASS' : 'FAIL'}  ${x.id} ${x.name}  ${JSON.stringify(x.detail ?? '').slice(0, 150)}`);
}

// 判定
const out = r.stdout;
const checks = [
  ['主库 tg-odoo 存在', /tg-odoo exists: 1/.test(out)],
  ['installed = 168', /installed: 168/.test(out)],
  ['filestore 文件 = 1887', /tg-odoo 文件数: 1887/.test(out)],
  ['filestore 无嵌套', /嵌套检查: no/.test(out)],
  ['容器 running', /running \(started/.test(out)],
  ['dbfilter 锁定 tg-odoo', /dbfilter = \^tg-odoo\$/.test(out)],
  ['HTTP 全 200', (out.match(/→ 200 /g) ?? []).length >= 3],
  ['无沙箱库残留', !/dsh-t10-/.test(out.split('=== 6.')[0] ?? '')],
  ['V1–V7 全过', v.ok],
];
console.log('\n=== 最终检查判定 ===');
let all = true;
for (const [n, ok] of checks) { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}`); if (!ok) all = false; }
console.log(all ? 'FINAL_CHECK=PASS' : 'FINAL_CHECK=FAIL');
