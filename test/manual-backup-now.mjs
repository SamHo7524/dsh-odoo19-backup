import { discover } from '../lib/discover.js';
import { runBackup } from '../lib/backup.js';

const srv = {
  name: 'staging', host: '119.29.10.202', port: 22, user: 'root',
  keyPath: process.env.USERPROFILE + '/.ssh/toogel_vault',
};
const localDir = 'K:/Backup/odoo-test';

const scan = await discover(srv);
const inst = scan.instances[0];
console.log('instance:', inst.odooContainer, '| db:', inst.dbName, '| pgSuper:', inst.pgSuperUser);

console.log('\n=== 1) 备份（经代码 runBackup 路径） ===');
const backup = await runBackup({
  server: srv, instance: inst, localDir,
  passphrase: undefined,
  onProgress: (p) => console.log(`  [${p.percent}%] ${p.phase}: ${p.message}`),
});
console.log('  备份完成:', backup.localPath, '| sha', backup.sha256Remote, '| enc', backup.encrypted, '| bytes', backup.bytes);
console.log('BACKUP_DONE:' + backup.localPath);
