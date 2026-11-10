/**
 * v0.1.14 真机验证：目标库名自动发现（只读）。
 *
 * 目标机 odoo.toogel.cn 的 dbfilter 被注释，db_name 未配置，
 * PG 里有 postgres/template0/template1/pgsql/toogel 五个库。
 * 期望：排除系统库与超级用户同名库 pgsql 后，唯一候选 toogel 被采用。
 */
import { discover } from '../lib/discover.js';

const server = {
  name: 'odoo.toogel.cn',
  host: '134.175.51.9',
  port: 22,
  user: 'root',
  keyPath: 'C:/Users/Ho/.ssh/toogel_vault',
};

const results = [];
const chk = (n, ok, d = '') => {
  results.push([n, ok]);
  console.log(`  ${ok ? '✅' : '❌'} ${n}${d ? ` — ${d}` : ''}`);
};

const found = await discover(server);
const inst = found?.instances?.[0];
chk('发现实例', Boolean(inst));
if (inst) {
  console.log('    pgDatabases =', JSON.stringify(inst.pgDatabases));
  console.log('    pgSuperUser =', JSON.stringify(inst.pgSuperUser));
  console.log('    confDbFilter=', JSON.stringify(inst.confDbFilter), ' confDbName =', JSON.stringify(inst.confDbName));
  console.log('    discovery   =', JSON.stringify(inst.dbNameDiscovery));

  chk('超级用户是 pgsql（角色，不是库名）', inst.pgSuperUser === 'pgsql', inst.pgSuperUser);
  chk('自动发现得到 toogel', inst.dbName === 'toogel', inst.dbName);
  chk('发现来源为 pg-list 或更高', ['pg-list', 'dbfilter', 'db_name'].includes(inst.dbNameDiscovery?.source),
    inst.dbNameDiscovery?.source);
  chk('pgsql 未被当成目标库', inst.dbName !== 'pgsql' && inst.dbName !== 'postgres', inst.dbName);
}

// 手工配置优先
const manual = await discover({ ...server, dbName: 'hand-filled' });
chk('手工配置优先于自动发现', manual?.instances?.[0]?.dbName === 'hand-filled',
  manual?.instances?.[0]?.dbName);

const failed = results.filter(([, ok]) => !ok).length;
console.log(`\nRESULT: ${failed === 0 ? 'PASS' : 'FAIL'} (${results.length - failed}/${results.length})`);
process.exit(failed === 0 ? 0 : 1);
