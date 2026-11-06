import { discover } from '../lib/discover.js';
import { verifyInstance } from '../lib/verify.js';

const srv = {
  name: 'staging', host: '119.29.10.202', port: 22, user: 'root',
  keyPath: process.env.USERPROFILE + '/.ssh/toogel_vault',
};
const scan = await discover(srv);
const inst = scan.instances[0];
console.log('instance:', inst.dbName, inst.odooContainer, 'v', inst.odooVersion);
const r = await verifyInstance({ server: srv, instance: inst, baseline: { installed: 168 } });
console.log('ok =', r.ok);
for (const v of r.results) {
  console.log(`  ${v.pass ? 'PASS' : 'FAIL'}  ${v.id} ${v.name}  detail=${JSON.stringify(v.detail ?? v).slice(0, 200)}`);
}
