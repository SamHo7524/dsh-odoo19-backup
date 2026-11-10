/**
 * v0.1.14 真机验证：库名解析。
 *
 * 目标机 odoo.conf 的 dbfilter 被注释掉，旧实现 discover() 只认 dbfilter → dbName=''，
 * 恢复随即报「不安全的数据库名」。修复后：
 *  - 配置了 dbName → 用它
 *  - 没配置 → 回退 dbfilter（本机为空）
 *  - 两者都空 → 空串（不猜），由恢复前置校验给出可操作错误
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

console.log('\n=== 1. 未配置 dbName（旧行为）：应为空，且不再谎报可用 ===');
{
  const found = await discover(server);
  const inst = found?.instances?.[0];
  chk('能发现实例', Boolean(inst), JSON.stringify(found?.instances?.length));
  if (inst) {
    chk('dbName 为空（dbfilter 被注释）', inst.dbName === '', JSON.stringify(inst.dbName));
    chk('容器/超级用户仍能探测到', Boolean(inst.odooContainer && inst.pgContainer && inst.pgSuperUser),
      `${inst.odooContainer}/${inst.pgContainer}/${inst.pgSuperUser}`);
  }
}

console.log('\n=== 2. 配置 dbName=toogel（修复后）：应直接采用 ===');
{
  const found = await discover({ ...server, dbName: 'toogel' });
  const inst = found?.instances?.[0];
  chk('dbName 采用配置值', inst?.dbName === 'toogel', JSON.stringify(inst?.dbName));
}

const failed = results.filter(([, ok]) => !ok).length;
console.log(`\nRESULT: ${failed === 0 ? 'PASS' : 'FAIL'} (${results.length - failed}/${results.length})`);
process.exit(failed === 0 ? 0 : 1);
