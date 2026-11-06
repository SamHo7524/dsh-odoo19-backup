import { execRemote } from '../lib/ssh.js';
import { checkImports } from '../lib/imports.js';

const srv = {
  host: '119.29.10.202',
  port: 22,
  user: 'root',
  keyPath: process.env.USERPROFILE + '/.ssh/toogel_vault',
};

const ADDONS = '/opt/1panel/apps/odoo/odoo/data/addons';
const inst = {
  odooContainer: '1Panel-odoo-5td9',
  addonsPath: ADDONS,
  pydepsPath: '/opt/1panel/apps/odoo/odoo/data/data/.local',
};

const fakeDir = `${ADDONS}/zz_probe_fake_dep`;

console.log('=== 基线：当前应通过 ===');
const base = await checkImports({ server: srv, instance: inst });
console.log('  ok =', base.ok, '| checked =', base.checked.join(', '));

try {
  console.log('\n=== 注入一个引用了不存在依赖的模块 ===');
  await execRemote(
    srv,
    `
set -euo pipefail
read -r D
mkdir -p "$D"
printf '%s\\n' "__manifest__.py" >/dev/null
cat > "$D/__manifest__.py" <<'EOF'
{'name': 'probe', 'version': '1.0', 'depends': ['base']}
EOF
cat > "$D/models.py" <<'EOF'
import definitely_not_installed_pkg_xyz
from odoo import models
EOF
echo WROTE
`,
    { stdin: `${fakeDir}\n`, timeoutMs: 30000 },
  );
  console.log('  已写入探测模块');

  console.log('\n=== 负向：必须检出缺失 ===');
  const bad = await checkImports({ server: srv, instance: inst });
  console.log('  ok =', bad.ok, '(应为 false)');
  console.log('  missing =', JSON.stringify(bad.missing));
  console.log('  error =', bad.error);
} finally {
  console.log('\n=== 清理探测模块 ===');
  const clean = await execRemote(srv, 'read -r D; rm -rf "$D"; echo CLEANED', {
    stdin: `${fakeDir}\n`,
    timeoutMs: 30000,
  });
  console.log(' ', clean.stdout.trim());

  console.log('\n=== 清理后应恢复通过 ===');
  const after = await checkImports({ server: srv, instance: inst });
  console.log('  ok =', after.ok, '| missing =', JSON.stringify(after.missing));
}
