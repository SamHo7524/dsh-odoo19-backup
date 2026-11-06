import { discover } from '../lib/discover.js';
import { runRestore } from '../lib/restore.js';

const srv = {
  name: 'staging', host: '119.29.10.202', port: 22, user: 'root',
  keyPath: process.env.USERPROFILE + '/.ssh/toogel_vault',
};
const pkg = process.argv[2];
if (!pkg) { console.error('用法: node manual-restore-now.mjs <package.tar>'); process.exit(1); }

const scan = await discover(srv);
const inst = scan.instances[0];
console.log('instance:', inst.odooContainer, '| db:', inst.dbName, '| pgSuper:', inst.pgSuperUser);
console.log('package:', pkg);

console.log('\n=== 恢复演练（自身备份 → 切换 → 回滚） ===');
const restore = await runRestore({
  server: srv, instance: inst, packagePath: pkg,
  options: { allowUnencrypted: true, baseline: { installed: 168 } },
  onProgress: (p) => console.log(`  [${p.percent}%] ${p.phase}: ${p.message}`),
});
console.log('\n恢复结果:', JSON.stringify(restore, null, 2));
console.log('RESTORE_DONE:' + (restore.ok ? 'OK' : 'FAIL'));
