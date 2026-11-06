import { execRemote } from '../lib/ssh.js';

const srv = {
  name: 'staging', host: '119.29.10.202', port: 22, user: 'root',
  keyPath: process.env.USERPROFILE + '/.ssh/toogel_vault',
};

const script = `
set -uo pipefail
read -r OC
read -r PG
read -r SU

docker exec "$OC" sh -c 'echo bad > /tmp/x.zip'
docker exec "$PG" psql -U "$SU" -d postgres -c "DROP DATABASE IF EXISTS dsh-t10-probe" >/dev/null 2>&1 || true
docker exec "$PG" psql -U "$SU" -d postgres -c "CREATE DATABASE dsh-t10-probe TEMPLATE template0" >/dev/null
echo "=== RAW LOAD OUTPUT ==="
docker exec "$OC" odoo db -r "$(docker exec "$OC" printenv USER)" -w "$(docker exec "$OC" printenv PASSWORD)" --db_host "$(docker exec "$OC" printenv HOST)" --db_port 5432 load -n dsh-t10-probe /tmp/x.zip 2>&1 | tail -6
echo "=== END ==="
docker exec -u root "$OC" rm -f /tmp/x.zip
docker exec "$PG" psql -U "$SU" -d postgres -c "DROP DATABASE IF EXISTS dsh-t10-probe" >/dev/null 2>&1 || true
`;

const r = await execRemote(srv, script, {
  stdin: ['1Panel-odoo-5td9', '1Panel-postgresql-ZcrG', 'pgsl'].join('\n') + '\n',
  timeoutMs: 180000,
});
console.log(r.stdout);
