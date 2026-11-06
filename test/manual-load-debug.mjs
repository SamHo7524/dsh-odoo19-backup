import { execRemote } from '../lib/ssh.js';
import { discover } from '../lib/discover.js';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const srv = {
  name: 'staging', host: '119.29.10.202', port: 22, user: 'root',
  keyPath: process.env.USERPROFILE + '/.ssh/toogel_vault',
};
const pkg = process.argv[2];
const scan = await discover(srv);
const inst = scan.instances[0];

// 本地抽取 dump.zip
const tmp = await mkdtemp(join(tmpdir(), 'ldbg-'));
const localDump = join(tmp, 'dump.zip');
const { extractDumpZip } = await import('../lib/restore.js');
const dumpPath = await extractDumpZip(pkg, tmp);
console.log('extracted dump.zip ->', dumpPath);

// 上传到 staging
const remoteDump = '/tmp/debug-dump.zip';
const args = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-i', srv.keyPath, dumpPath, `${srv.user}@${srv.host}:${remoteDump}`];
await new Promise((res, rej) => {
  const p = spawn('scp', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let e = '';
  p.stderr.on('data', (d) => (e += d));
  p.on('error', rej);
  p.on('close', (c) => (c === 0 ? res() : rej(new Error(e.slice(-300)))));
});
console.log('uploaded to', remoteDump);

const script = `
set -uo pipefail
read -r OC
read -r PG
read -r PG_SUPER
read -r TMPDB
read -r PKG
read -r DBUSER

docker exec "$PG" psql -U "$PG_SUPER" -d postgres -c "DROP DATABASE IF EXISTS \\"$TMPDB\\"" >/dev/null 2>&1 || true
docker exec "$PG" psql -U "$PG_SUPER" -d postgres -c "CREATE DATABASE \\"$TMPDB\\" OWNER $DBUSER TEMPLATE template0" >/dev/null

echo "===LOAD_FULL==="
docker exec "$OC" odoo db -r "$(docker exec "$OC" printenv USER)" -w "$(docker exec "$OC" printenv PASSWORD)" --db_host "$(docker exec "$OC" printenv HOST)" --db_port 5432 load -f "$TMPDB" "$PKG" 2>&1
echo "===LOAD_RC=\${PIPESTATUS[0]}==="

echo "===INSTALLED==="
docker exec "$PG" psql -U "$DBUSER" -d "$TMPDB" -Atc "select count(*) from ir_module_module where state='installed'" 2>/dev/null || echo 0
echo "===END==="
`;
const r = await execRemote(srv, script, {
  stdin: [inst.odooContainer, inst.pgContainer, inst.pgSuperUser, inst.dbName + '-ldebug', remoteDump, inst.dbUser].join('\n') + '\n',
  timeoutMs: 600000,
});
console.log(r.stdout);
console.log('STDERR:', r.stderr.slice(-400));
await execRemote(srv, `docker exec "$PG" psql -U "$PG_SUPER" -d postgres -c "DROP DATABASE IF EXISTS \\"$TMPDB\\"" 2>/dev/null; rm -f "$PKG"`, { timeoutMs: 60000 }).catch(()=>{});
await rm(tmp, { recursive: true, force: true });
