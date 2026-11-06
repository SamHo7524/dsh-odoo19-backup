import { discover } from '../lib/discover.js';
import { runBackup } from '../lib/backup.js';

const srv = {
  name: 'staging',
  host: '119.29.10.202',
  port: 22,
  user: 'root',
  keyPath: process.env.USERPROFILE + '/.ssh/toogel_vault',
};

console.log('=== 发现实例 ===');
const scan = await discover(srv);
if (!scan.found) {
  console.error('未发现实例');
  process.exit(1);
}
const inst = scan.instances[0];
console.log(`  ${inst.odooContainer} / ${inst.dbName} / ${inst.odooVersion}`);

console.log('\n=== 开始备份（不加密，先验证主流程）===');
const t0 = Date.now();

const result = await runBackup({
  server: srv,
  instance: inst,
  localDir: 'K:/Backup/odoo-test',
  passphrase: undefined,
  onProgress: (p) => {
    console.log(`  [${String(p.percent).padStart(3)}%] ${p.phase.padEnd(16)} ${p.message}`);
  },
});

const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\n=== 完成（${elapsed} 秒）===`);
console.log(JSON.stringify(result, null, 2));
