/**
 * U4 验证：UI 与 Agent 工具路径的失败关闭与可操作错误信息（纯本地，不触达远端）。
 */
import { createService } from '../lib/service.js';
import { createOdooBackupTool } from '../lib/tools.js';
import { createTokenStore } from '../lib/tokens.js';

const srv = { name: 'staging', host: 'h', port: 22, user: 'root' };
const noPwCfg = { servers: [srv], localBackupDir: 'K:/b' };
const withPwCfg = { ...noPwCfg, passphrase: 'pw' };

function deps() {
  const calls = [];
  return {
    calls,
    guardHostKey: async () => { calls.push('guard'); return { ok: true }; },
    discover: async () => { calls.push('discover'); return { instances: [{ dbName: 'db' }] }; },
    runBackup: async () => { calls.push('runBackup'); return { ok: true, encrypted: true }; },
    runRestore: async () => ({ ok: true }),
    detectFormat: async () => 'dsh-odoo',
    stat: async () => ({ size: 1 }),
  };
}

const results = [];
const chk = (n, ok, d = '') => results.push([n, ok, d]);

// Agent 工具：无口令
{
  const d = deps();
  const svc = createService({ config: noPwCfg, deps: d });
  const tool = createOdooBackupTool({ config: noPwCfg, service: svc });
  let msg = '';
  try { await tool.execute({ action: 'backup', server: 'staging' }); } catch (e) { msg = e.message; }
  console.log('Agent 工具错误:', msg);
  chk('Agent 无口令 → 拒绝', /拒绝备份/.test(msg));
  chk('Agent 错误提示配置 passphrase', /设置页|passphrase/.test(msg));
  chk('Agent 错误说明不生成明文包', /不会生成明文/.test(msg));
  chk('Agent 无口令不触达任何远端', d.calls.length === 0, d.calls.join(','));
}

// UI 路由等价调用（service.backup 就是 /backup 路由的实现）
{
  const d = deps();
  const svc = createService({ config: noPwCfg, deps: d });
  let msg = '';
  try { await svc.backup('staging'); } catch (e) { msg = e.message; }
  console.log('UI 路由错误:', msg);
  chk('UI 无口令 → 拒绝', /拒绝备份/.test(msg));
  chk('UI 错误提示配置口令', /设置页|passphrase|加密口令/.test(msg));
  chk('UI 无口令不触达任何远端', d.calls.length === 0, d.calls.join(','));
}

// 有效口令：正常执行，且仍加密
{
  const d = deps();
  const svc = createService({ config: withPwCfg, deps: d });
  const tool = createOdooBackupTool({ config: withPwCfg, service: svc });
  const r = await tool.execute({ action: 'backup', server: 'staging' });
  chk('有效口令 → 备份成功', r.ok === true);
  chk('有效口令 → 产物加密', r.encrypted === true);
  chk('有效口令 → 走完整 discover+runBackup', d.calls.includes('discover') && d.calls.includes('runBackup'));
}

// 空白口令也算无效
{
  const d = deps();
  const svc = createService({ config: { ...noPwCfg, passphrase: '   ' }, deps: d });
  let msg = '';
  try { await svc.backup('staging'); } catch (e) { msg = e.message; }
  chk('全空白口令 → 拒绝', /拒绝备份/.test(msg));
  chk('全空白口令不触达远端', d.calls.length === 0);
}

// tokenStore 未受影响（回归）
{
  const s = createTokenStore();
  const t = s.create({ server: 'x', packagePath: 'y', neutralize: false });
  chk('confirmToken 仍可用', s.verify(t, { server: 'x', packagePath: 'y', neutralize: false }) === true);
}

console.log('\n=== U4 验证结果 ===');
let all = true;
for (const [n, ok, d] of results) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${ok ? '' : '  → ' + d}`);
  if (!ok) all = false;
}
console.log(`\n共 ${results.length} 项`);
console.log(all ? 'U4_FAILCLOSED=PASS' : 'U4_FAILCLOSED=FAIL');
