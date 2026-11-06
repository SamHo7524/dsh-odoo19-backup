/**
 * Task 1 RED — service 层接线 fingerprint / pin。
 *
 * 背景（systematic-debugging）：报错文案让用户执行
 * `odoo_backup action=fingerprint` / `action=pin`，但工具里没有这两个 action，
 * 底层 lib/knownhosts.js 的 scanHostKey/pinHostKey 也从未被接线到 service。
 * 这个测试先证明 service 缺这两个方法。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { createService } from '../lib/service.js';
import { createOdooBackupTool } from '../lib/tools.js';

function toolWith(service) {
  return createOdooBackupTool({
    config: { servers: [{ name: 'staging', host: '10.0.0.1' }] },
    service,
  });
}

const cfg = () => ({
  servers: [{ name: 'staging', host: '10.0.0.1', port: 22, user: 'root' }],
  localBackupDir: 'K:/Backup/odoo',
  passphrase: 'pw',
  allowUnencryptedPackage: false,
});

test('service.fingerprint 返回扫描到的指纹列表', async () => {
  const d = {
    scanHostKey: async (s) => ({
      ok: true,
      host: s.host,
      port: 22,
      fingerprints: [{ type: 'ED25519', fingerprint: 'SHA256:abc' }],
    }),
  };
  const svc = createService({ config: cfg(), deps: d });
  const r = await svc.fingerprint('staging');
  assert.equal(r.ok, true);
  assert.equal(r.fingerprints[0].fingerprint, 'SHA256:abc');
});

test('service.pin 把用户确认过的指纹交给 pinHostKey 固化', async () => {
  const calls = [];
  const d = {
    pinHostKey: async (s, fp) => {
      calls.push([s.host, fp]);
      return { ok: true, written: true, fingerprint: fp };
    },
  };
  const svc = createService({ config: cfg(), deps: d });
  const r = await svc.pin('staging', 'SHA256:abc');
  assert.equal(r.ok, true);
  assert.deepEqual(calls[0], ['10.0.0.1', 'SHA256:abc']);
});

test('service.pin 缺少指纹时拒绝，不调用 pinHostKey', async () => {
  let called = false;
  const d = { pinHostKey: async () => { called = true; } };
  const svc = createService({ config: cfg(), deps: d });
  await assert.rejects(() => svc.pin('staging', ''), /指纹/);
  assert.equal(called, false, '空指纹绝不能进入固化流程');
});

test('service.fingerprint 不经过连接指纹闸门（只读扫描，不触达生产库）', async () => {
  let gateCalled = false;
  const d = {
    guardHostKey: async () => { gateCalled = true; return { ok: false, error: { message: '闸门' } }; },
    scanHostKey: async () => ({ ok: true, fingerprints: [{ type: 'ED25519', fingerprint: 'SHA256:abc' }] }),
  };
  const svc = createService({ config: cfg(), deps: d });
  const r = await svc.fingerprint('staging');
  assert.equal(r.ok, true, '扫描指纹本身不应被 not-pinned 闸门拦住');
  assert.equal(gateCalled, false);
});

// ------------------------------------------------------------ Task 2

test('odoo_backup action 枚举包含 fingerprint 与 pin', () => {
  const t = toolWith({});
  const en = t.parameters.properties.action.enum;
  assert.ok(en.includes('fingerprint'), '报错文案要求这个 action 真实存在');
  assert.ok(en.includes('pin'), '报错文案要求这个 action 真实存在');
});

test('action=fingerprint 调用 service.fingerprint', async () => {
  let hit = null;
  const t = toolWith({
    fingerprint: async (n) => { hit = n; return { ok: true, fingerprints: [] }; },
  });
  const r = await t.execute({ action: 'fingerprint', server: 'staging' });
  assert.equal(hit, 'staging');
  assert.equal(r.ok, true);
});

test('action=pin 调用 service.pin 并传指纹', async () => {
  let hit = null;
  const t = toolWith({
    pin: async (n, fp) => { hit = [n, fp]; return { ok: true }; },
  });
  await t.execute({ action: 'pin', server: 'staging', fingerprint: 'SHA256:abc' });
  assert.deepEqual(hit, ['staging', 'SHA256:abc']);
});

test('action=pin 缺少 fingerprint 参数时拒绝，不调用 service.pin', async () => {
  let called = false;
  const t = toolWith({ pin: async () => { called = true; return { ok: true }; } });
  await assert.rejects(() => t.execute({ action: 'pin', server: 'staging' }), /fingerprint/);
  assert.equal(called, false);
});

test('未固定指纹的报错文案必须给出 sshConfigAlias 这条真实可行的放行路径', async () => {
  const { guardHostKey } = await import('../lib/ssh.js');
  const r = await guardHostKey({ host: '10.0.0.1', user: 'root' });
  assert.equal(r.ok, false, 'fail-closed 不得回退');
  assert.match(r.error.message, /sshConfigAlias/,
    '旧文案只让人执行 action=fingerprint/pin，却没告诉用户「填 SSH 别名」这条立即可行的路；'
    + '且那两个 action 当时并不存在，是死路');
});
