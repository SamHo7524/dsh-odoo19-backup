import { discover } from '../lib/discover.js';
import { verifyInstance, checkVersionCompatible } from '../lib/verify.js';

const srv = {
  name: 'staging',
  host: '119.29.10.202',
  port: 22,
  user: 'root',
  keyPath: process.env.USERPROFILE + '/.ssh/toogel_vault',
};

const scan = await discover(srv);
const inst = scan.instances[0];
console.log('instance:', inst.odooContainer, '| pg:', inst.pgContainer, '| db:', inst.dbName, '| ver:', inst.odooVersion);

console.log('\n=== 版本兼容性 ===');
const vc = checkVersionCompatible(inst.odooVersion, inst.odooVersion);
console.log(JSON.stringify(vc));

console.log('\n=== V1–V7 验证 ===');
const r = await verifyInstance({ server: srv, instance: inst });
for (const x of r.results) {
  console.log(`  [${x.pass ? 'PASS' : 'FAIL'}] ${x.id} ${x.name} — ${x.detail ?? ''}`);
}
console.log('\n整体 ok =', r.ok);
