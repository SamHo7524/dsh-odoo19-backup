/**
 * v0.1.8 RED — Host 路由：/client-pubkey、/servers 增量字段、/trust-host。
 * 直接驱动 index.js 的 handleUiRequest（与 host-save-route.test.js 同法）。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import {
  publicKeyPathOf, validatePublicKey, confirmTrust, applyTrust,
} from '../lib/trust.js';

const hostSrc = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

// 与 index.js 模块级定义一致的替身（避免 import index.js 触发 schemastery 解析）
const unwrapVolatile = (v) =>
  (v !== null && typeof v === 'object' && typeof v.get === 'function') ? v.get() : v;

function loadHandler() {
  const start = hostSrc.indexOf('async function handleUiRequest');
  assert.ok(start > 0);
  const body = hostSrc.slice(start).replace(/^async function handleUiRequest/, 'async function');
  const factory = new Function(
    'unwrapVolatile', 'publicKeyPathOf', 'validatePublicKey', 'confirmTrust', 'applyTrust', 'readFile',
    `return (${body})`,
  );
  return factory(unwrapVolatile, publicKeyPathOf, validatePublicKey, confirmTrust, applyTrust, async () => '');
}
function makeRes() {
  const out = { statusCode: 0, body: '' };
  return {
    out,
    set statusCode(v) { out.statusCode = v; },
    get statusCode() { return out.statusCode; },
    setHeader() {},
    end(b) { out.body = b; },
  };
}
function makeReq(route, body = {}) {
  const chunks = [Buffer.from(JSON.stringify(body))];
  return {
    method: 'POST', url: `/odoo-backup${route}`,
    headers: { host: '127.0.0.1:20303' },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() { yield* chunks; },
  };
}
function base(overrides = {}) {
  return {
    config: { servers: [
      { name: 'toogel', host: '47.121.205.143', port: 22, user: 'root', sshConfigAlias: 'toogel-vault', pinnedFingerprint: '', keyPath: '' },
      { name: 'odoo.toogel.cn', host: '134.175.51.9', port: 22, user: 'root', keyPath: 'C:/k/id', pinnedFingerprint: '' },
    ] },
    tokenStore: {}, settings: { update: async () => {} }, entryId: 'odoo-backup',
    service: {},
    ...overrides,
  };
}

test('API-1 /servers 增量返回 keyPath / sshConfigAlias / pinnedFingerprint（不破坏原有 4 字段）', async () => {
  const h = loadHandler(); const res = makeRes();
  await h({ req: makeReq('/servers'), res, ...base() });
  const list = JSON.parse(res.out.body).servers;
  const s = list.find((x) => x.name === 'odoo.toogel.cn');
  assert.equal(s.name, 'odoo.toogel.cn');
  assert.equal(s.host, '134.175.51.9');
  assert.equal(s.port, 22);
  assert.equal(s.user, 'root');
  assert.equal(s.keyPath, 'C:/k/id', 'UI 要显示登录认证状态需要 keyPath');
  assert.equal(s.pinnedFingerprint, '');
  assert.equal(s.sshConfigAlias, '');
});

test('API-2 /client-pubkey 只返回公钥，绝不返回私钥内容', async () => {
  const h = loadHandler(); const res = makeRes();
  await h({
    req: makeReq('/client-pubkey', { keyPath: 'C:/k/id' }), res,
    ...base({ readPublicKey: async () => 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample dsh-backup' }),
  });
  const b = JSON.parse(res.out.body);
  assert.equal(res.out.statusCode, 200);
  assert.match(b.publicKey, /^ssh-ed25519 /);
  assert.ok(!JSON.stringify(b).includes('PRIVATE'));
});

test('API-3 /client-pubkey 未配置 keyPath 时明确提示，不猜测默认路径', async () => {
  const h = loadHandler(); const res = makeRes();
  await h({ req: makeReq('/client-pubkey', {}), res, ...base() });
  assert.equal(res.out.statusCode, 400);
  const err = JSON.parse(res.out.body).error;
  assert.match(err, /keyPath|私钥路径/);
  // v0.1.9：后端文案也要引导到信任面板内的输入框，不能指向外部「服务器表单」
  assert.ok(!/服务器表单/.test(err), '错误文案不得再把用户指向面板外部');
});

test('API-7 /client-pubkey 后端文案与面板内联引导一致（v0.1.9）', () => {
  const idx = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  assert.match(idx, /信任面板|上方.*私钥路径/,
    '后端 /client-pubkey 的错误文案应引导到信任面板内的本机私钥路径输入框');
});

test('API-4 /trust-host 只改 pinnedFingerprint，保留 keyPath', async () => {
  let written = null;
  const h = loadHandler(); const res = makeRes();
  await h({
    req: makeReq('/trust-host', {
      server: 'odoo.toogel.cn',
      answerFingerprint: 'SHA256:Yty1O6gmuMyQ3i7vUqiZy0gomEAF/Ssg2h9uNNC0qn0',
      answerType: 'ssh-ed25519',
      expectedHost: '134.175.51.9', expectedPort: 22, expectedUser: 'root',
    }),
    res,
    ...base({
      service: { fingerprint: async () => ({ ok: true, host: '134.175.51.9', port: 22, fingerprints: [{ type: 'ssh-ed25519', fingerprint: 'SHA256:Yty1O6gmuMyQ3i7vUqiZy0gomEAF/Ssg2h9uNNC0qn0' }] }) },
      settings: { update: async (_ns, patch) => { written = patch.servers; } },
    }),
  });
  assert.equal(res.out.statusCode, 200, res.out.body);
  const s = written.find((x) => x.name === 'odoo.toogel.cn');
  assert.equal(s.pinnedFingerprint, 'SHA256:Yty1O6gmuMyQ3i7vUqiZy0gomEAF/Ssg2h9uNNC0qn0');
  assert.equal(s.keyPath, 'C:/k/id', '不得覆盖原有 keyPath');
  assert.equal(written.find((x) => x.name === 'toogel').sshConfigAlias, 'toogel-vault', '其他服务器配置不得改动');
});

test('API-5 /trust-host 指纹不一致 → 400，不写任何配置', async () => {
  let called = false;
  const h = loadHandler(); const res = makeRes();
  await h({
    req: makeReq('/trust-host', {
      server: 'odoo.toogel.cn', answerFingerprint: 'SHA256:WRONG', answerType: 'ssh-ed25519',
      expectedHost: '134.175.51.9', expectedPort: 22, expectedUser: 'root',
    }),
    res,
    ...base({
      service: { fingerprint: async () => ({ ok: true, host: '134.175.51.9', port: 22, fingerprints: [{ type: 'ssh-ed25519', fingerprint: 'SHA256:Yty1O6gmuMyQ3i7vUqiZy0gomEAF/Ssg2h9uNNC0qn0' }] }) },
      settings: { update: async () => { called = true; } },
    }),
  });
  assert.equal(res.out.statusCode, 400);
  assert.equal(called, false, '指纹不一致绝不写入信任');
});

test('API-6 /trust-host host 在核验后被替换 → 拒绝（防信任迁移）', async () => {
  let called = false;
  const h = loadHandler(); const res = makeRes();
  await h({
    req: makeReq('/trust-host', {
      server: 'odoo.toogel.cn', answerFingerprint: 'SHA256:Yty1O6gmuMyQ3i7vUqiZy0gomEAF/Ssg2h9uNNC0qn0',
      answerType: 'ssh-ed25519', expectedHost: '134.175.51.9', expectedPort: 22, expectedUser: 'root',
    }),
    res,
    ...base({
      config: { servers: [{ name: 'odoo.toogel.cn', host: '9.9.9.9', port: 22, user: 'root', keyPath: 'C:/k/id', pinnedFingerprint: '' }] },
      service: { fingerprint: async () => ({ ok: true, host: '9.9.9.9', port: 22, fingerprints: [{ type: 'ssh-ed25519', fingerprint: 'SHA256:Yty1O6gmuMyQ3i7vUqiZy0gomEAF/Ssg2h9uNNC0qn0' }] }) },
      settings: { update: async () => { called = true; } },
    }),
  });
  assert.equal(res.out.statusCode, 400);
  assert.equal(called, false);
});
