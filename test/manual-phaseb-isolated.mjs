import { execRemote } from '../lib/ssh.js';
import { discover } from '../lib/discover.js';

const srv = {
  name: 'staging', host: '119.29.10.202', port: 22, user: 'root',
  keyPath: process.env.USERPROFILE + '/.ssh/toogel_vault',
};
const scan = await discover(srv);
const inst = scan.instances[0];

// 与 restore.js buildTempRestoreScript 修正后的 load 命令逐字一致
const TMPDB = 'tg-odoo-phaseb-test';
const SB = '/tmp/safety-backup-20261104025944.zip';

const script = `
set -uo pipefail
read -r OC
read -r PG
read -r PG_SUPER
read -r TMPDB
read -r DATA
read -r SB

echo "=== PRE: exact-name DROP temp DB (never LIKE) ==="
docker exec "\$PG" psql -U "\$PG_SUPER" -d postgres -c "DROP DATABASE IF EXISTS \\"\$TMPDB\\"" 2>&1 | tail -1

echo "=== PRE: move temp filestore aside if exists ==="
if [ -d "\$DATA/filestore/\$TMPDB" ]; then
  mv "\$DATA/filestore/\$TMPDB" "\$DATA/filestore/\$TMPDB.bak-\$(date +%s)"
fi

echo "=== docker cp + EXACT load command ==="
docker cp "\$SB" "\$OC:/tmp/restore-pkg.zip" && echo COPIED
LOAD_OUT=\$(docker exec "\$OC" odoo db -r "\$(docker exec "\$OC" printenv USER)" -w "\$(docker exec "\$OC" printenv PASSWORD)" --db_host "\$(docker exec "\$OC" printenv HOST)" --db_port 5432 load -n "\$TMPDB" /tmp/restore-pkg.zip 2>&1)
LOAD_RC=\$?
echo "LOAD_RC=\$LOAD_RC"
echo "\$LOAD_OUT" | tail -4

echo "=== POST: verify temp DB ==="
echo -n "DB exists: "
docker exec "\$PG" psql -U "\$PG_SUPER" -d postgres -Atc "select count(*) from pg_database where datname='\$TMPDB'" 2>/dev/null
echo -n "installed: "
docker exec "\$PG" psql -U "\$PG_SUPER" -d "\$TMPDB" -Atc "select count(*) from ir_module_module where state='installed'" 2>/dev/null || echo 0
echo -n "filestore files: "
find "\$DATA/filestore/\$TMPDB" -type f 2>/dev/null | wc -l
echo -n "nested: "
[ -d "\$DATA/filestore/\$TMPDB/filestore" ] && echo "YES BAD" || echo "no"

echo "=== CLEANUP (exact names only) ==="
docker exec "\$PG" psql -U "\$PG_SUPER" -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='\$TMPDB' AND pid <> pg_backend_pid()" >/dev/null 2>&1 || true
docker exec "\$PG" psql -U "\$PG_SUPER" -d postgres -c "DROP DATABASE IF EXISTS \\"\$TMPDB\\"" 2>&1 | tail -1
rm -rf "\$DATA/filestore/\$TMPDB" 2>/dev/null && echo "removed temp filestore"
docker exec -u root "\$OC" rm -f /tmp/restore-pkg.zip 2>/dev/null || true
echo "=== MAIN DB STILL INTACT CHECK ==="
echo -n "tg-odoo exists: "
docker exec "\$PG" psql -U "\$PG_SUPER" -d postgres -Atc "select count(*) from pg_database where datname='tg-odoo'" 2>/dev/null
echo "=== END ==="
`;
const r = await execRemote(srv, script, {
  stdin: [inst.odooContainer, inst.pgContainer, inst.pgSuperUser, TMPDB, inst.dataPath, SB].join('\n') + '\n',
  timeoutMs: 1200000,
});
console.log(r.stdout);
console.log('--- STDERR ---');
console.log(r.stderr.slice(-400));
