import { checkImports } from '../lib/imports.js';
import { discover } from '../lib/discover.js';

const srv = {
  name: 'staging',
  host: '119.29.10.202',
  port: 22,
  user: 'root',
  keyPath: process.env.USERPROFILE + '/.ssh/toogel_vault',
};

const scan = await discover(srv);
const inst = scan.instances[0];
console.log('instance:', inst.odooContainer, '/', inst.addonsPath);

console.log('\n=== 正向：当前环境依赖应全部可导入 ===');
const r = await checkImports({ server: srv, instance: inst });
console.log(JSON.stringify(r, null, 2));
