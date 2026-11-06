import { execRemote } from '../lib/ssh.js';
import { discover } from '../lib/discover.js';

const srv = {
  name: 'staging', host: '119.29.10.202', port: 22, user: 'root',
  keyPath: process.env.USERPROFILE + '/.ssh/toogel_vault',
};
const scan = await discover(srv);
const inst = scan.instances[0];

const script = `
set -uo pipefail
read -r OC
read -r PG
read -r PG_SUPER
read -r TMPDB
read -r PKG
read -r DBUSER

echo "===PYCHECK_UPLOADED==="
docker exec "$OC" python3 - <<'PY'
import zipfile, sys
p = "/tmp/debug-dump.zip"
print("is_zipfile:", zipfile.is_zipfile(p))
try:
    z = zipfile.ZipFile(p)
    names = z.namelist()
    print("entry_count:", len(names))
    print("first10:", names[:10])
    print("has dump.sql:", "dump.sql" in names)
except Exception as e:
    print("ZIPERR:", repr(e))
PY

echo "===FRESH DUMP->LOAD TEST==="
CINT="/tmp/odoo-fresh-\$\$"
docker exec "$OC" mkdir -p "$CINT" || true
docker exec "$OC" odoo db -r "$(docker exec "$OC" printenv USER)" -w "$(docker exec "$OC" printenv PASSWORD)" --db_host "$(docker exec "$OC" printenv HOST)" --db_port 5432 dump --format=zip tg-odoo "$CINT/fresh.zip" 2>/dev/null
echo "fresh dump rc=\${PIPESTATUS[0]}"
docker exec "$OC" ls -l "$CINT/fresh.zip" 2>/dev/null || echo "NO FRESH DUMP"

# create target
docker exec "$PG" psql -U "$PG_SUPER" -d postgres -c "DROP DATABASE IF EXISTS \\"$TMPDB\\"" >/dev/null 2>&1 || true
docker exec "$PG" psql -U "$PG_SUPER" -d postgres -c "CREATE DATABASE \\"$TMPDB\\" OWNER $DBUSER TEMPLATE template0" >/dev/null

echo "--- load fresh ---"
docker exec "$OC" odoo db -r "$(docker exec "$OC" printenv USER)" -w "$(docker exec "$OC" printenv PASSWORD)" --db_host "$(docker exec "$OC" printenv HOST)" --db_port 5432 load -f "$TMPDB" "$CINT/fresh.zip" 2>&1
echo "fresh load rc=\${PIPESTATUS[0]}"
docker exec "$PG" psql -U "$PG_SUPER" -d postgres -c "DROP DATABASE IF EXISTS \\"$TMPDB\\"" >/dev/null 2>&1 || true
docker exec "$OC" rm -rf "$CINT" 2>/dev/null || true

echo "===END==="
`;
const r = await execRemote(srv, script, {
  stdin: [inst.odooContainer, inst.pgContainer, inst.pgSuperUser, inst.dbName + '-probe', '/tmp/debug-dump.zip', inst.dbUser].join('\n') + '\n',
  timeoutMs: 900000,
});
console.log(r.stdout);
console.log('STDERR:', r.stderr.slice(-300));
