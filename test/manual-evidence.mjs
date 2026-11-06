import { execRemote } from '../lib/ssh.js';

const srv = {
  name: 'staging', host: '119.29.10.202', port: 22, user: 'root',
  keyPath: process.env.USERPROFILE + '/.ssh/toogel_vault',
};

const script = `
set -uo pipefail
echo "=== ALL DBS LIKE tg-odoo% ==="
docker exec 1Panel-postgresql-ZcrG psql -U pgsl -d postgres -Atc "select datname, pg_size_pretty(pg_database_size(datname)) from pg_database where datname like 'tg-odoo%' order by 1" 2>&1
echo "=== tg-odoo EXISTS? ==="
docker exec 1Panel-postgresql-ZcrG psql -U pgsl -d postgres -Atc "select count(*) from pg_database where datname='tg-odoo'" 2>&1
echo "=== ODOO CONTAINER STATE ==="
docker inspect 1Panel-odoo-5td9 --format '{{.State.Status}}' 2>&1
echo "=== HOST SAFETY BACKUPS ==="
ls -lh /tmp/safety-backup-*.zip 2>/dev/null || echo "none"
echo "=== HOST RESTORE PKGS ==="
ls -lh /tmp/restore-*.zip 2>/dev/null || echo "none"
echo "=== EXACT DUMP CMD (full stderr + rc) ==="
CINT="/tmp/odoo-safety-probe-\$\$"
docker exec 1Panel-odoo-5td9 mkdir -p "$CINT" || echo MKDIRFAIL
docker exec 1Panel-odoo-5td9 odoo db -r "$(docker exec 1Panel-odoo-5td9 printenv USER)" -w "$(docker exec 1Panel-odoo-5td9 printenv PASSWORD)" --db_host "$(docker exec 1Panel-odoo-5td9 printenv HOST)" --db_port 5432 dump --format=zip tg-odoo "$CINT/probe.zip" 2>&1
echo "DUMP_RC=\${PIPESTATUS[0]}"
docker exec 1Panel-odoo-5td9 rm -rf "$CINT"
echo "=== END ==="
`;
const r = await execRemote(srv, script, { timeoutMs: 300000 });
console.log(r.stdout);
console.log('--- STDERR ---');
console.log(r.stderr.slice(-500));
