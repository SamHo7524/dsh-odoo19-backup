import { execRemote } from '../lib/ssh.js';
import { discover } from '../lib/discover.js';

const srv = {
  name: 'staging', host: '119.29.10.202', port: 22, user: 'root',
  keyPath: process.env.USERPROFILE + '/.ssh/toogel_vault',
};
const scan = await discover(srv);
const inst = scan.instances[0];
console.log('discovered:', inst.odooContainer, inst.dbName, inst.pgSuperUser, inst.dataPath);

const script = `
set -uo pipefail
read -r OC
read -r PG
read -r PG_SUPER
read -r DB
read -r DATA
read -r SB

echo "=== STEP 1: ensure DB absent (reliable superuser DROP) ==="
docker exec "\$PG" psql -U "\$PG_SUPER" -d postgres -c "DROP DATABASE IF EXISTS \\"\$DB\\"" 2>&1 | tail -1

echo "=== STEP 2: move existing filestore ASIDE (keep as safety net; avoid nesting trap) ==="
TS=\$(date +%s)
if [ -d "\$DATA/filestore/\$DB" ]; then
  mv "\$DATA/filestore/\$DB" "\$DATA/filestore/\$DB.pre-recovery-\$TS"
  echo "moved aside -> \$DB.pre-recovery-\$TS"
else
  echo "no existing filestore for \$DB"
fi

echo "=== STEP 3: copy verified safety zip into container ==="
docker cp "\$SB" "\$OC:/tmp/recovery.zip" && echo COPIED
docker exec "\$OC" unzip -t /tmp/recovery.zip 2>&1 | tail -1

echo "=== STEP 4: load (skill canonical: DROP then load -f; no -n = faithful) ==="
LOAD_OUT=\$(docker exec "\$OC" odoo db -r "\$(docker exec "\$OC" printenv USER)" -w "\$(docker exec "\$OC" printenv PASSWORD)" --db_host "\$(docker exec "\$OC" printenv HOST)" --db_port 5432 load -f "\$DB" /tmp/recovery.zip 2>&1)
LOAD_RC=\$?
echo "\$LOAD_OUT" | tail -20
echo "LOAD_RC=\$LOAD_RC"
docker exec -u root "\$OC" rm -f /tmp/recovery.zip 2>/dev/null || true

echo "=== STEP 5: VERIFY ==="
echo -n "DB exists: "
docker exec "\$PG" psql -U "\$PG_SUPER" -d postgres -Atc "select count(*) from pg_database where datname='\$DB'" 2>/dev/null
echo -n "installed modules: "
docker exec "\$PG" psql -U "\$PG_SUPER" -d "\$DB" -Atc "select count(*) from ir_module_module where state='installed'" 2>/dev/null || echo 0
echo -n "binary attachments (DB): "
docker exec "\$PG" psql -U "\$PG_SUPER" -d "\$DB" -Atc "select count(*) from ir_attachment where type='binary' and store_fname is not null and store_fname<>''" 2>/dev/null || echo 0
echo -n "filestore files: "
find "\$DATA/filestore/\$DB" -type f 2>/dev/null | wc -l
echo -n "nested filestore: "
[ -d "\$DATA/filestore/\$DB/filestore" ] && echo "YES (BAD)" || echo "no"
echo -n "HTTP /web/login: "
curl -s -o /dev/null -w '%{http_code} %{size_download}' --max-time 20 http://127.0.0.1:8069/web/login 2>/dev/null || echo 000
echo ""
echo -n "safety zip still on host: "
ls -lh "\$SB" 2>/dev/null | awk '{print \$5}'
echo "=== END ==="
`;
const r = await execRemote(srv, script, {
  stdin: [
    inst.odooContainer,
    inst.pgContainer,
    inst.pgSuperUser,
    inst.dbName,
    inst.dataPath,
    '/tmp/safety-backup-20261104025944.zip',
  ].join('\n') + '\n',
  timeoutMs: 1800000,
});
console.log(r.stdout);
console.log('--- STDERR ---');
console.log(r.stderr.slice(-500));
