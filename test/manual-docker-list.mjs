import { execRemote } from '../lib/ssh.js';

const srv = {
  host: '119.29.10.202',
  port: 22,
  user: 'root',
  keyPath: process.env.USERPROFILE + '/.ssh/toogel_vault',
};

const DOCKER_LIST_SCRIPT = `
echo "===CONTAINERS==="
docker ps -a --format '{{.Names}}|{{.Image}}|{{.State}}' 2>/dev/null | grep -i odoo || true
echo "===PG==="
docker ps --format '{{.Names}}|{{.Image}}' 2>/dev/null | grep -i postgres || true
echo "===END==="
`;

const r = await execRemote(srv, DOCKER_LIST_SCRIPT, { timeoutMs: 60000 });
console.log('code =', r.code);
console.log('stdout raw:');
console.log(JSON.stringify(r.stdout));
console.log('\nstderr:', JSON.stringify(r.stderr.slice(0, 300)));

const m = r.stdout.match(/===CONTAINERS===\n([\s\S]*?)===PG===/);
console.log('\nmatch =', m ? JSON.stringify(m[1]) : 'NULL');
