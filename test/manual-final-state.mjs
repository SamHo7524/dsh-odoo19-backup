import { execRemote } from '../lib/ssh.js';

const srv = {
  name: 'staging', host: '119.29.10.202', port: 22, user: 'root',
  keyPath: process.env.USERPROFILE + '/.ssh/toogel_vault',
};
const script = `
set -uo pipefail
echo "=== ALL DATABASES ==="
docker exec 1Panel-postgresql-ZcrG psql -U pgsl -d postgres -Atc "select datname from pg_database order by 1" 2>&1
echo "=== FILESTORE DIRS ==="
FS=/opt/1panel/apps/odoo/odoo/data/data/filestore
ls -1 "$FS" 2>/dev/null
echo "=== /tmp ARTIFACTS ==="
ls -lh /tmp/safety-backup-*.zip /tmp/restore-*.zip /tmp/debug-dump.zip /tmp/cmp-fresh.zip 2>/dev/null || true
echo "=== DISK ==="
df -h / 2>/dev/null | tail -1
echo "=== ODOO CONTAINER ==="
docker inspect 1Panel-odoo-5td9 --format '{{.State.Status}}' 2>&1
echo "=== HTTP ==="
curl -s -o /dev/null -w '%{http_code} %{size_download}\n' --max-time 15 http://127.0.0.1:8069/web/login 2>/dev/null || echo 000
echo "=== END ==="
`;
const r = await execRemote(srv, script, { timeoutMs: 120000 });
console.log(r.stdout);
