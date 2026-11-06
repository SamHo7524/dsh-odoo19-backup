/**
 * Host 侧 /save-servers 路由的行为验证（不启动网络）：
 * 直接驱动 index.js 的 handler，验证它调用 settings.update 并返回正确响应。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const hostSrc = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

// 提取 handleUiRequest：它在 index.js 里是模块内 async function。
// 用最小 ESM 包装执行（不引入 @deepseek-ai/schemastery 等真实依赖）。
function loadHandler() {
  // 去掉 import 与 Config/apply，只保留 handleUiRequest
  const start = hostSrc.indexOf('async function handleUiRequest');
  assert.ok(start > 0, 'index.js 应包含 handleUiRequest');
  const body = hostSrc.slice(start);
  // 截到文件末尾即可（handleUiRequest 是最后一个函数）
  const code = `return (${body.replace(/^async function handleUiRequest/, 'async function')})`;
  // eslint-disable-next-line no-new-func
  return new Function(code)();
}

function makeRes() {
  const out = { statusCode: 0, headers: {}, body: '' };
  return {
    out,
    // index.js 的 send() 直接赋值 res.statusCode（Node 的 http.ServerResponse 语义）
    set statusCode(v) { out.statusCode = v; },
    get statusCode() { return out.statusCode; },
    setHeader(k, v) { out.headers[k] = v; },
    end(b) { out.body = b; },
  };
}

function makeReq({ method = 'POST', url = '/odoo-backup/save-servers', body = {}, origin } = {}) {
  const payload = JSON.stringify(body);
  const chunks = [Buffer.from(payload)];
  return {
    method,
    url,
    headers: { host: '127.0.0.1:15822', ...(origin ? { origin } : {}) },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() { yield* chunks; },
  };
}

test('HANDLER-1 合法请求调用 settings.update("odoo-backup", {servers}) 并返回 ok', async () => {
  const handler = loadHandler();
  const calls = [];
  const settings = { async update(ns, patch) { calls.push([ns, patch]); } };
  const res = makeRes();
  await handler({
    req: makeReq({ body: { servers: [{ name: 'toogel', host: '47.121.205.143' }] } }),
    res,
    config: { servers: [] },
    service: {},
    tokenStore: {},
    settings,
    entryId: 'odoo-backup',
  });

  assert.equal(res.out.statusCode, 200, `应返回 200，实际 ${res.out.statusCode}: ${res.out.body}`);
  const parsed = JSON.parse(res.out.body);
  assert.equal(parsed.ok, true);
  assert.equal(calls.length, 1, '必须调用一次 settings.update');
  assert.equal(calls[0][0], 'odoo-backup', 'namespace 应是 patch row id');
  assert.equal(calls[0][1].servers.length, 1);
  assert.equal(calls[0][1].servers[0].name, 'toogel');
});

test('HANDLER-2 不再手工改 config.servers（写入由 settings.update + volatile 活引用承担）', async () => {
  // v0.1.5：settings.update 写 profile patch 后，volatile 的 servers 是活引用，
  // 运行时自动读到新值；handler 手工赋值反而会破坏引用语义。
  const handler = loadHandler();
  const settings = { async update() {} };
  const config = { servers: [] };
  const res = makeRes();
  await handler({
    req: makeReq({ body: { servers: [{ name: 'a', host: 'h' }] } }),
    res, config, service: {}, tokenStore: {}, settings, entryId: 'odoo-backup',
  });
  assert.equal(JSON.parse(res.out.body).ok, true);
  assert.equal(config.servers.length, 0, 'handler 不得手工改 config.servers（由活引用承担）');
});

test('HANDLER-3 settings 不可用时返回可读错误（不静默）', async () => {
  const handler = loadHandler();
  const res = makeRes();
  await handler({
    req: makeReq({ body: { servers: [{ name: 'a', host: 'h' }] } }),
    res, config: { servers: [] }, service: {}, tokenStore: {},
    settings: undefined, entryId: 'odoo-backup',
  });
  assert.equal(res.out.statusCode, 400);
  const parsed = JSON.parse(res.out.body);
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /设置服务不可用/);
});

test('HANDLER-4 缺 name 的服务器被拒绝，且不写入', async () => {
  const handler = loadHandler();
  let called = false;
  const settings = { async update() { called = true; } };
  const res = makeRes();
  await handler({
    req: makeReq({ body: { servers: [{ host: 'h' }] } }),
    res, config: { servers: [] }, service: {}, tokenStore: {}, settings, entryId: 'odoo-backup',
  });
  assert.equal(res.out.statusCode, 400);
  assert.equal(called, false, '校验失败不得写入配置');
  assert.match(JSON.parse(res.out.body).error, /name/);
});

test('HANDLER-5 跨站 Origin 仍被拒绝（安全边界不回退）', async () => {
  const handler = loadHandler();
  let called = false;
  const settings = { async update() { called = true; } };
  const res = makeRes();
  await handler({
    req: makeReq({ body: { servers: [] }, origin: 'https://evil.example.com' }),
    res, config: { servers: [] }, service: {}, tokenStore: {}, settings, entryId: 'odoo-backup',
  });
  assert.equal(res.out.statusCode, 403);
  assert.equal(called, false);
});
