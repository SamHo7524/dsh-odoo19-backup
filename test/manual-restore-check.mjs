import { discover } from '../lib/discover.js';
import { readFile } from 'node:fs/promises';

const srv = {
  name: 'staging', host: '119.29.10.202', port: 22, user: 'root',
  keyPath: process.env.USERPROFILE + '/.ssh/toogel_vault',
};
const scan = await discover(srv);
const inst = scan.instances[0];
console.log('discover 新增字段:');
console.log('  pgSuperUser =', inst.pgSuperUser);
console.log('  confPath    =', inst.confPath);
console.log('  pgContainer =', inst.pgContainer);

const src = await readFile(new URL('../lib/restore.js', import.meta.url), 'utf8');
// 校验脚本生成不含未转义的 JS 表达式：shell ${VAR} 必须写成 \${VAR}
const leaked = (src.match(/(^|[^\\])\$\{[A-Za-z_]/g) ?? []).length;
console.log('  未转义 ${ 残留数 = ' + leaked + ' (应为 0)');
console.log('  反斜杠转义数 = ' + (src.match(/\\\$/g) ?? []).length);
