import { execRemote } from '../lib/ssh.js';

const srv = {
  host: '119.29.10.202',
  port: 22,
  user: 'root',
  keyPath: process.env.USERPROFILE + '/.ssh/toogel_vault',
};

const script = `
set -uo pipefail
read -r C

echo "===ENVMOUNTS==="
docker inspect "$C" --format '{{range .Config.Env}}{{println .}}{{end}}---MOUNTS---{{range .Mounts}}{{.Source}}=>{{.Destination}}{{println}}{{end}}---IMAGE---{{.Image}}' 2>/dev/null || true

echo "===CONF==="
docker exec "$C" sh -c 'cat /etc/odoo/odoo.conf 2>/dev/null | grep -E "^[[:space:]]*dbfilter"' 2>/dev/null || true

echo "===VERSION==="
docker exec "$C" odoo --version 2>/dev/null | head -1 || true

echo "===UIDGID==="
docker exec "$C" sh -c 'id -u; id -g' 2>/dev/null || true

echo "===ENDPOINT==="
docker port "$C" 8069/tcp 2>/dev/null | head -1 || true

echo "===END==="
`;

const r = await execRemote(srv, script, {
  stdin: '1Panel-odoo-5td9\n',
  timeoutMs: 90000,
});

console.log('code =', r.code);
console.log('=== STDOUT ===');
console.log(r.stdout);
console.log('=== STDERR ===');
console.log(r.stderr.slice(0, 800));
