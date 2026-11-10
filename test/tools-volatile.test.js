import { test } from 'node:test';
import assert from 'node:assert';
import { createOdooBackupTool, createOdooRestoreTool } from '../lib/tools.js';
import { createTokenStore } from '../lib/tokens.js';

/**
 * 真机回归（2026-11-10，v0.1.14 装上 GitHub pin 后首次调用 agent 工具时发现）：
 *
 * `Config.servers` 带 `.volatile()`（settings.update 只允许写 volatile 路径），
 * 所以 Host 运行时读到的是 `{ get(): T }` 活引用而不是普通数组。
 * Host 路由层（index.js）一直用 `unwrapVolatile()` 解包，但 `lib/tools.js` 直接
 * `config?.servers ?? []` 就 `.map()` / `.find()`，于是真机报错：
 *    - odoo_backup(action=listServers) → "((intermediate value) ?? []).map is not a function"
 *    - odoo_backup(action=test)        → "list.find is not a function"
 * 单元测试此前全绿，是因为测试注入的是普通数组，测不出 volatile 包装。
 */
function volatile(value) {
  return { get() { return value; } };
}

const servers = [
  { name: 'toogel', host: '47.121.205.143', port: 22, user: 'root' },
  { name: 'staging', host: '119.29.10.202' },
];

function fakeService() {
  const calls = [];
  return {
    calls,
    async test(name) { calls.push(['test', name]); return { ok: true }; },
    async discover(name) { calls.push(['discover', name]); return { ok: true }; },
    async backup(name) { calls.push(['backup', name]); return { ok: true }; },
    async restore(name, _pkg, packagePath, opts) {
      calls.push(['restore', name, packagePath, opts]);
      return { ok: true };
    },
    status() { return { running: false, lastTask: null }; },
  };
}

test('TOOLVOL-1 listServers 必须解包 volatile servers', async () => {
  const tool = createOdooBackupTool({ config: { servers: volatile(servers) }, service: fakeService() });
  const out = await tool.execute({ action: 'listServers' });
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { name: 'toogel', host: '47.121.205.143', port: 22, user: 'root' });
  assert.deepEqual(out[1], { name: 'staging', host: '119.29.10.202', port: 22, user: 'root' },
    '缺省 port/user 也要回填');
});

test('TOOLVOL-2 其他动作按 volatile servers 解析服务器', async () => {
  const svc = fakeService();
  const tool = createOdooBackupTool({ config: { servers: volatile(servers) }, service: svc });
  const r = await tool.execute({ action: 'test', server: 'toogel' });
  assert.equal(r.ok, true);
  assert.deepEqual(svc.calls[0], ['test', 'toogel']);
});

test('TOOLVOL-3 解包后未知服务器仍按未找到拒绝', async () => {
  const tool = createOdooBackupTool({ config: { servers: volatile(servers) }, service: fakeService() });
  await assert.rejects(() => tool.execute({ action: 'test', server: 'nope' }), /未找到服务器/);
});

test('TOOLVOL-4 odoo_restore precheck 必须解包 volatile servers', async () => {
  const store = createTokenStore();
  const tool = createOdooRestoreTool({
    config: { servers: volatile(servers) }, service: fakeService(), tokenStore: store,
  });
  const out = await tool.execute({ action: 'precheck', server: 'toogel', packagePath: 'K:/b.tar.enc' });
  assert.ok(out.confirmToken, '应当拿到 confirmToken');
  assert.equal(out.boundTo.server, 'toogel');
});

test('TOOLVOL-5 普通数组配置仍然可用（回归）', async () => {
  const svc = fakeService();
  const tool = createOdooBackupTool({ config: { servers }, service: svc });
  const out = await tool.execute({ action: 'listServers' });
  assert.equal(out.length, 2);
  await tool.execute({ action: 'discover', server: 'staging' });
  assert.deepEqual(svc.calls.at(-1), ['discover', 'staging']);
});

test('TOOLVOL-6 servers 缺失或为空时 listServers 返回空数组而不是抛错', async () => {
  const tool = createOdooBackupTool({ config: {}, service: fakeService() });
  assert.deepEqual(await tool.execute({ action: 'listServers' }), []);
  const tool2 = createOdooBackupTool({ config: { servers: volatile([]) }, service: fakeService() });
  assert.deepEqual(await tool2.execute({ action: 'listServers' }), []);
});
