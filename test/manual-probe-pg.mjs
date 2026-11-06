import { execRemote } from '../lib/ssh.js';
import { discover } from '../lib/discover.js';

const srv = {
  name: 'staging', host: '119.29.10.202', port: 22, user: 'root',
  keyPath: process.env.USERPROFILE + '/.ssh/toogel_vault',
};
const scan = await discover(srv);
const inst = scan.instances[0];
console.log('pgContainer =', inst.pgContainer, '| dbUser =', inst.dbUser, '| dbHost =', inst.dbHost);

const script = `
set -uo pipefail
read -r PG
echo "===ENV==="
docker exec "$PG" printenv | grep -iE 'POSTGRES|PGUSER|USER|PASSWORD' 2>/dev/null || echo none
echo "===ROLES==="
docker exec "$PG" psql -U "$1" -d postgres -Atc "select rolname, rolsuper from pg_roles where rolname in ('postgres','toogel') or rolsuper" 2>&1 | head -20
echo "===END==="
`;
// pass dbUser as $1 via -- (our execRemote uses bash -c script, arg not supported) -> use stdin trick instead
const script2 = `
set -uo pipefail
read -r PG
read -r DU
echo "===ENV==="
docker exec "$PG" printenv | grep -iE 'POSTGRES|PGUSER|USER=|PASSWORD' 2>/dev/null || echo none
echo "===ROLES==="
docker exec "$PG" psql -U "$DU" -d postgres -Atc "select rolname||'|'||rolsuper from pg_roles where rolsuper" 2>&1 | head -20
echo "===END==="
`;
const r = await execRemote(srv, script2, {
  stdin: [inst.pgContainer, inst.dbUser].join('\n') + '\n', timeoutMs: 60000,
});
console.log(r.stdout);
