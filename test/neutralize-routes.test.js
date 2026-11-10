/**
 * 中立化路由闸门测试（Task 3）。
 * 手法与 restore-domain-setting.test.js 一致：从 index.js 源码提取 handleUiRequest。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { readFile } from 'node:fs/promises';

const SRC = new URL('../index.js', import.meta.url);

async function loadHandler() {
  const src = await readFile(SRC, 'utf8');
  const start = src.indexOf('async function handleUiRequest(');
  assert.ok(start > 0, 'index.js 应包含 handleUiRequest');
  // 取到下一个顶层函数定义之前
  const rest = src.slice(start);
  const endMarkers = ['\nfunction ', '\nasync function ', '\nexport '];
  let end = rest.length;
  for (const m of endMarkers) {
    const i = rest.indexOf(m, 1);
    if (i > 0 && i < end) end = i;
  }
  const body = rest.slice(0, end);
  const { normalizeRestorePath } = await import('../lib/restore-path.js');
  const { isHostname } = await import('../lib/site-domain.js');
  const fn = new Function(
    'normalizeRestorePath', 'isHostname', 'readFile', 'unwrapVolatile', 'resolveLastBackup', 'stateDirOf',
    `${body}\nreturn handleUiRequest;`,
  );
  return fn(
    normalizeRestorePath, isHostname, readFile,
    (v) => (v && typeof v === 'object' && typeof v.get === 'function' ? v.get() : v),
    async () => null,
    () => 'C:/tmp',
  );
}

function mkRes() {
  return {
    statusCode: 0,
    payload: null,
    status(c) { this.statusCode = c; return this; },
    json(p) { this.payload = p; return this; },
    end(p) {
      if (typeof p === 'string') {
        try { this.payload = JSON.parse(p); } catch { this.payload = p; }
      }
      return this;
    },
    setHeader() {},
    writeHead(c) { this.statusCode = c; return this; },
  };
}

function mkReq(route, body) {
  const json = JSON.stringify(body ?? {});
  const req = {
    method: 'POST',
    url: `http://127.0.0.1:6382/odoo-backup${route}`,
    headers: { host: '127.0.0.1:6382', origin: 'http://127.0.0.1:6382', 'content-type': 'application/json' },
    socket: { remoteAddress: '127.0.0.1' },
  };
  // handleUiRequest 用 `for await (const c of req)` 读请求体
  req[Symbol.asyncIterator] = async function* iterate() {
    yield Buffer.from(json, 'utf8');
  };
  return req;
}

const STATUS = {
  ok: true, neutralized: true, dbName: 'toogel',
  cronActive: 1, cronDisabled: 42, mailPlaceholder: 1, mailRealActive: 0,
  mailRealWithCreds: 0, paymentEnabled: 0, paymentDisabled: 26,
};

function mkDeps(over = {}) {
  const calls = [];
  const tokens = [];
  const store = {
    create(p) { tokens.push(p); return 'tok-' + tokens.length; },
    verify(t, p) {
      calls.push({ verify: t, p });
      if (t !== 'tok-1') throw new Error('confirmToken 无效');
      return true;
    },
  };
  return {
    calls,
    tokens,
    deps: {
      service: {
        neutralizeStatus: async () => STATUS,
        applyNeutralize: async (s, a, o) => { calls.push({ apply: s, a, o }); return { ok: true, applied: a === 'release', action: a }; },
        ...(over.service ?? {}),
      },
      neutralizeTokenStore: store,
      ...over.rest,
    },
  };
}

test('NEUROUTE-1 /neutralize-status 返回状态 + dbName', async () => {
  const h = await loadHandler();
  const { deps } = mkDeps();
  const res = mkRes();
  await h({ req: mkReq('/neutralize-status', { server: 's1' }), res, config: { servers: [] }, tokenStore: { create() {}, verify() {} }, settings: {}, entryId: 'odoo-backup', ...deps });
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.neutralized, true);
  assert.equal(res.payload.dbName, 'toogel');
});

test('NEUROUTE-2 release 缺 confirmToken → 拒绝且不调用 applyNeutralize', async () => {
  const h = await loadHandler();
  const { deps, calls } = mkDeps();
  const res = mkRes();
  await h({ req: mkReq('/neutralize-apply', { server: 's1', action: 'release' }), res, config: { servers: [] }, tokenStore: { create() {}, verify() {} }, settings: {}, entryId: 'odoo-backup', ...deps });
  assert.notEqual(res.statusCode, 200);
  assert.equal(calls.filter((c) => c.apply).length, 0);
});

test('NEUROUTE-3 release 带正确 token → 调用 applyNeutralize', async () => {
  const h = await loadHandler();
  const { deps, calls } = mkDeps();
  const res = mkRes();
  await h({ req: mkReq('/neutralize-apply', { server: 's1', action: 'release', confirmToken: 'tok-1' }), res, config: { servers: [] }, tokenStore: { create() {}, verify() {} }, settings: {}, entryId: 'odoo-backup', ...deps });
  assert.equal(res.statusCode, 200);
  assert.equal(calls.filter((c) => c.apply).length, 1);
  assert.equal(calls.find((c) => c.apply).a, 'release');
});

test('NEUROUTE-4 keep 不需要 token 且不调用 verify', async () => {
  const h = await loadHandler();
  const { deps, calls } = mkDeps();
  const res = mkRes();
  await h({ req: mkReq('/neutralize-apply', { server: 's1', action: 'keep' }), res, config: { servers: [] }, tokenStore: { create() {}, verify() {} }, settings: {}, entryId: 'odoo-backup', ...deps });
  assert.equal(res.statusCode, 200);
  assert.equal(calls.filter((c) => c.verify).length, 0);
});

test('NEUROUTE-5 token 绑定 server + action + dbName', async () => {
  const h = await loadHandler();
  const { deps, calls } = mkDeps();
  const res = mkRes();
  await h({ req: mkReq('/neutralize-apply', { server: 's1', action: 'release', confirmToken: 'tok-1' }), res, config: { servers: [] }, tokenStore: { create() {}, verify() {} }, settings: {}, entryId: 'odoo-backup', ...deps });
  const v = calls.find((c) => c.verify);
  assert.equal(v.p.server, 's1');
  assert.equal(v.p.action, 'release');
  assert.equal(v.p.dbName, 'toogel');
});

test('NEUROUTE-6 /neutralize-precheck 返回 6 条 warnings 与 token', async () => {
  const h = await loadHandler();
  const { deps, tokens } = mkDeps();
  const res = mkRes();
  await h({ req: mkReq('/neutralize-precheck', { server: 's1', action: 'release' }), res, config: { servers: [] }, tokenStore: { create() {}, verify() {} }, settings: {}, entryId: 'odoo-backup', ...deps });
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.confirmToken, 'tok-1');
  assert.ok(res.payload.warnings.length >= 5);
  assert.equal(tokens[0].action, 'release');
  assert.equal(tokens[0].dbName, 'toogel');
});

test('NEUROUTE-7 非法 action → 拒绝', async () => {
  const h = await loadHandler();
  const { deps } = mkDeps();
  const res = mkRes();
  await h({ req: mkReq('/neutralize-apply', { server: 's1', action: 'drop' }), res, config: { servers: [] }, tokenStore: { create() {}, verify() {} }, settings: {}, entryId: 'odoo-backup', ...deps });
  assert.notEqual(res.statusCode, 200);
});

test('NEUROUTE-8 已解除状态下 precheck 不再发 token', async () => {
  const h = await loadHandler();
  const { deps, tokens } = mkDeps({ service: { neutralizeStatus: async () => ({ ...STATUS, neutralized: false }) } });
  const res = mkRes();
  await h({ req: mkReq('/neutralize-precheck', { server: 's1', action: 'release' }), res, config: { servers: [] }, tokenStore: { create() {}, verify() {} }, settings: {}, entryId: 'odoo-backup', ...deps });
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.confirmToken, null);
  assert.equal(res.payload.alreadyReleased, true);
  assert.equal(tokens.length, 0);
});
