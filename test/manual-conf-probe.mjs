import { execRemote } from '../lib/ssh.js';

const srv = {
  name: 'staging', host: '119.29.10.202', port: 22, user: 'root',
  keyPath: process.env.USERPROFILE + '/.ssh/toogel_vault',
};
const script = `
set -uo pipefail
echo "=== odoo.conf dbfilter / list_db (inside container) ==="
docker exec 1Panel-odoo-5td9 sh -c "grep -nE '^(dbfilter|list_db|db_name|db_host|db_user|db_password)' /etc/odoo/odoo.conf 2>/dev/null || echo NONE"
echo "=== full conf (sanitized) ==="
docker exec 1Panel-odoo-5td9 sh -c "sed -E 's/(admin_passwd|db_password)[[:space:]]*=.*/\\1 = <redacted>/' /etc/odoo/odoo.conf 2>/dev/null" | head -40
echo "=== is conf a mount? ==="
docker inspect 1Panel-odoo-5td9 --format '{{range .Mounts}}{{.Source}} => {{.Destination}}{{println}}{{end}}'
echo "=== END ==="
`;
const r = await execRemote(srv, script, { timeoutMs: 120000 });
console.log(r.stdout);
