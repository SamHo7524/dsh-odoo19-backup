import { discover } from '../lib/discover.js';
import { runBackup } from '../lib/backup.js';
import { runRestore } from '../lib/restore.js';

const srv = {
  name: 'staging', host: '119.29.10.202', port: 22, user: 'root',
  keyPath: process.env.USERPROFILE + '/.ssh/toogel_vault',
};
const localDir = 'K:/Backup/odoo-test';

const scan = await discover(srv);
const inst = scan.instances[0];
console.log('instance:', inst.odooContainer, '| db:', inst.dbName, '| pgSuper:', inst.pgSuperUser);

console.log('\n=== 1) 备份 ===');
const backup = await runBackup({
  server: srv, instance: inst, localDir,
  passphrase: undefined, // 明文以便恢复演练（真实使用应加密）
  onProgress: (p) => console.log(`  [${p.percent}%] ${p.phase}: ${p.message}`),
});
console.log('  备份完成:', backup.localPath, '| sha', backup.sha256Remote, '| enc', backup.encrypted);

console.log('\n=== 2) 恢复（恢复自身备份 → 切换 → 回滚） ===');
const restore = await runRestore({
  server: srv, instance: inst, packagePath: backup.localPath,
  options: { allowUnencrypted: true, baseline: { installed: 168 } },
  onProgress: (p) => console.log(`  [${p.percent}%] ${p.phase}: ${p.message}`),
});
console.log('\n恢复结果:', JSON.stringify(restore, null, 2));
