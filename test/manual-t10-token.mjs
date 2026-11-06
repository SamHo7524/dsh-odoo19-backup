/**
 * Task 10：confirmToken 授权 / 过期 / 一次性 / 错误载荷 —— 对真实工具实测。
 * 不触达远端（全部在 verify 阶段被拒或短路）。
 */
import { createTokenStore, TOKEN_TTL_MS } from '../lib/tokens.js';
import { createOdooRestoreTool } from '../lib/tools.js';

const config = { servers: [{ name: 'staging', host: 'h', port: 22, user: 'root' }] };

// 记录 service.restore 是否被调用——授权失败时绝不应调用
let restoreCalls = 0;
const service = {
  async restore() { restoreCalls += 1; return { ok: true, state: 'COMMITTED' }; },
  status() { return { running: false, lastTask: null }; },
};

function mk(store) {
  return createOdooRestoreTool({ config, service, tokenStore: store });
}

const P = { server: 'staging', packagePath: 'K:/b.tar' };
const results = [];
const check = (name, fn) => {
  try { fn(); results.push([name, true, '']); }
  catch (e) { results.push([name, false, e.message]); }
};

async function expectReject(name, fn, re) {
  try {
    await fn();
    results.push([name, false, '未抛出异常（应拒绝）']);
  } catch (e) {
    results.push([name, re.test(e.message), e.message]);
  }
}

// 1. 正常授权链
{
  const store = createTokenStore();
  const tool = mk(store);
  const pre = await tool.execute({ action: 'precheck', ...P });
  const r = await tool.execute({ action: 'restore', ...P, confirmToken: pre.confirmToken });
  results.push(['precheck→restore 成功', r.ok === true && restoreCalls === 1, '']);
}

// 2. 缺 token
{
  const tool = mk(createTokenStore());
  const before = restoreCalls;
  await expectReject('缺 token 被拒', () => tool.execute({ action: 'restore', ...P }), /缺少 confirmToken/);
  results.push(['缺 token 不触达 service', restoreCalls === before, '']);
}

// 3. 假 token
{
  const tool = mk(createTokenStore());
  const before = restoreCalls;
  await expectReject('假 token 被拒', () => tool.execute({ action: 'restore', ...P, confirmToken: 'deadbeef' }), /无效/);
  results.push(['假 token 不触达 service', restoreCalls === before, '']);
}

// 4. 一次性
{
  const store = createTokenStore();
  const tool = mk(store);
  const pre = await tool.execute({ action: 'precheck', ...P });
  await tool.execute({ action: 'restore', ...P, confirmToken: pre.confirmToken });
  await expectReject('同 token 二次被拒', () => tool.execute({ action: 'restore', ...P, confirmToken: pre.confirmToken }), /已使用过/);
}

// 5. 绑定服务器
{
  const store = createTokenStore();
  const tool = mk(store);
  const pre = await tool.execute({ action: 'precheck', ...P });
  const before = restoreCalls;
  await expectReject('换服务器被拒', () => tool.execute({
    action: 'restore', server: 'other', packagePath: P.packagePath, confirmToken: pre.confirmToken,
  }), /不匹配：server|未找到服务器/);
  results.push(['换服务器不触达 service', restoreCalls === before, '']);
}

// 6. 绑定备份包
{
  const store = createTokenStore();
  const tool = mk(store);
  const pre = await tool.execute({ action: 'precheck', ...P });
  const before = restoreCalls;
  await expectReject('换备份包被拒', () => tool.execute({
    action: 'restore', server: P.server, packagePath: 'K:/evil.tar', confirmToken: pre.confirmToken,
  }), /不匹配：packagePath/);
  results.push(['换包不触达 service', restoreCalls === before, '']);
}

// 7. 绑定 neutralize
{
  const store = createTokenStore();
  const tool = mk(store);
  const pre = await tool.execute({ action: 'precheck', ...P, neutralize: false });
  await expectReject('换 neutralize 被拒', () => tool.execute({
    action: 'restore', ...P, neutralize: true, confirmToken: pre.confirmToken,
  }), /不匹配：neutralize/);
}

// 8. 过期
{
  let now = 1_000_000;
  const store = createTokenStore({ now: () => now });
  const tool = mk(store);
  const pre = await tool.execute({ action: 'precheck', ...P });
  now += TOKEN_TTL_MS + 1;
  await expectReject('过期 token 被拒', () => tool.execute({
    action: 'restore', ...P, confirmToken: pre.confirmToken,
  }), /已过期/);
}

// 9. 载荷不匹配不消耗
{
  const store = createTokenStore();
  const tool = mk(store);
  const pre = await tool.execute({ action: 'precheck', ...P });
  await expectReject('错误载荷被拒', () => tool.execute({
    action: 'restore', server: 'other', packagePath: P.packagePath, confirmToken: pre.confirmToken,
  }), /./);
  const ok = await tool.execute({ action: 'restore', ...P, confirmToken: pre.confirmToken });
  results.push(['错误载荷后仍可用正确载荷兑换', ok.ok === true, '']);
}

// 10. precheck 参数校验
{
  const tool = mk(createTokenStore());
  await expectReject('precheck 未知服务器', () => tool.execute({ action: 'precheck', server: 'nope', packagePath: 'K:/a.tar' }), /未找到服务器/);
  await expectReject('precheck 缺 packagePath', () => tool.execute({ action: 'precheck', server: 'staging' }), /缺少 packagePath/);
}

// 11. 未知 action
{
  const tool = mk(createTokenStore());
  await expectReject('未知 action', () => tool.execute({ action: 'nuke' }), /未知 action/);
}

// 12. token 熵
{
  const store = createTokenStore();
  const t = store.create(P);
  results.push(['token 长度 >= 48 hex（192bit）', /^[0-9a-f]{48}$/.test(t), t.slice(0, 12) + '…']);
  const t2 = store.create(P);
  results.push(['两次 token 不同', t !== t2, '']);
}

console.log('=== confirmToken 全生命周期实测 ===');
let all = true;
for (const [n, ok, detail] of results) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${ok ? '' : '  → ' + detail}`);
  if (!ok) all = false;
}
console.log(`\n共 ${results.length} 项；service.restore 总调用 = ${restoreCalls}`);
console.log(all ? 'TOKEN_GATE=PASS' : 'TOKEN_GATE=FAIL');
