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
read -r TMPDB
read -r PKG
echo "===HELP==="
docker exec "$OC" odoo db load --help 2>&1 | head -40
echo "===END==="
`;
const r = await execRemote(srv, script, {
  stdin: [inst.odooContainer, 'tg-odoo-restore-debug', '/tmp/restore-debug.zip'].join('\n') + '\n',
  timeoutMs: 60000,
});
console.log(r.stdout);
console.log('STDERR:', r.stderr.slice(-500));
