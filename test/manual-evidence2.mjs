import { execRemote } from '../lib/ssh.js';

const srv = {
  name: 'staging', host: '119.29.10.202', port: 22, user: 'root',
  keyPath: process.env.USERPROFILE + '/.ssh/toogel_vault',
};

const script = `
set -uo pipefail
echo "=== SAFETY ZIP VALIDITY (full) ==="
ls -lh /tmp/safety-backup-*.zip 2>/dev/null
docker cp /tmp/safety-backup-20261104025944.zip 1Panel-odoo-5td9:/tmp/sbcheck.zip
docker exec 1Panel-odoo-5td9 python3 - <<'PY'
import zipfile
p="/tmp/sbcheck.zip"
print("is_zipfile:", zipfile.is_zipfile(p))
z=zipfile.ZipFile(p)
n=z.namelist()
print("count:", len(n))
print("has dump.sql:", "dump.sql" in n)
print("first5:", n[:5])
PY
echo "PY_RC=\${PIPESTATUS[0]}"
docker exec 1Panel-odoo-5td9 rm -f /tmp/sbcheck.zip

echo "=== ALL DBS (full list) ==="
docker exec 1Panel-postgresql-ZcrG psql -U pgsl -d postgres -Atc "select datname from pg_database order by 1" 2>&1

echo "=== FILESTORE STATE ==="
FS=/opt/1panel/apps/odoo/odoo/data/data/filestore
ls -ld "$FS" 2>/dev/null || echo "no filestore root"
echo "-- dirs matching tg-odoo --"
ls -1 "$FS" 2>/dev/null | grep '^tg-odoo' || echo "none"
echo "-- tg-odoo filestore size --"
du -sh "$FS/tg-odoo" 2>/dev/null || echo "no tg-odoo filestore dir"
echo "-- nested filestore check --"
ls -ld "$FS/tg-odoo/filestore" 2>/dev/null && echo "NESTED EXISTS" || echo "no nesting"

echo "=== DISK ==="
df -h / 2>/dev/null | tail -1
echo "=== END ==="
`;
const r = await execRemote(srv, script, { timeoutMs: 300000 });
console.log(r.stdout);
console.log('--- STDERR ---');
console.log(r.stderr.slice(-500));
