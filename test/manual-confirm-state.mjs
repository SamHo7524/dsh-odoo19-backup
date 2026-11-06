import { execRemote } from '../lib/ssh.js';

const srv = {
  name: 'staging', host: '119.29.10.202', port: 22, user: 'root',
  keyPath: process.env.USERPROFILE + '/.ssh/toogel_vault',
};
const script = `
set -uo pipefail
echo "=== 只读确认（不执行任何写操作） ==="
echo -n "tg-odoo DB 存在: "
docker exec 1Panel-postgresql-ZcrG psql -U pgsl -d postgres -Atc "select count(*) from pg_database where datname='tg-odoo'" 2>/dev/null
echo -n "installed 模块数: "
docker exec 1Panel-postgresql-ZcrG psql -U pgsl -d tg-odoo -Atc "select count(*) from ir_module_module where state='installed'" 2>/dev/null || echo 0
echo -n "filestore 文件数: "
find /opt/1panel/apps/odoo/odoo/data/data/filestore/tg-odoo -type f 2>/dev/null | wc -l
echo -n "filestore 嵌套: "
[ -d /opt/1panel/apps/odoo/odoo/data/data/filestore/tg-odoo/filestore ] && echo "YES BAD" || echo "no"
echo -n "HTTP /web/login: "
curl -s -o /dev/null -w '%{http_code}\n' --max-time 15 http://127.0.0.1:8069/web/login 2>/dev/null || echo 000
echo "=== 所有库（应只有 tg-odoo + 系统库） ==="
docker exec 1Panel-postgresql-ZcrG psql -U pgsl -d postgres -Atc "select datname from pg_database order by 1" 2>/dev/null
echo "=== END ==="
`;
const r = await execRemote(srv, script, { timeoutMs: 180000 });
console.log(r.stdout);
