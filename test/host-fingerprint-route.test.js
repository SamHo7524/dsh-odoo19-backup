/**
 * Task 3 RED — HTTP 路由接线 /fingerprint /pin。
 *
 * 直接驱动 index.js 的 handleUiRequest（与 host-save-route.test.js 同法），
 * 证明这两个路由当前不存在（返回 404「未知路由」）。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const hostSrc = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

function loadHandler() {
  const start = hostSrc.indexOf('async function handleUiRequest');
  assert.ok(start > 0);
  const body = hostSrc.slice(start);
  // eslint-disable-next-line no-new-func
  return new Function(`return (${body.replace(/^async function handleUiRequest/, 'async function')})`)();
}

function makeRes() {
  const out = { statusCode: 0, headers: {}, body: '' };
  return {
    out,
    set statusCode(v) { out.statusCode = v; },
    get statusCode() { return out.statusCode; },
    setHeader(k, v) { out.headers[k] = v; },
    end(b) { out.body = b; },
  };
}

function makeReq({ url = '/odoo-backup/fingerprint', body = {} } = {}) {
  const chunks = [Buffer.from(JSON.stringify(body))];
  return {
    method: 'POST',
    url,
    headers: { host: '127.0.0.1:26675' },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() { yield* chunks; },
  };
}

function base(service) {
  return {
    config: { servers: [{ name: 'toogel', host: '47.121.205.143' }] },
    tokenStore: {},
    settings: undefined,
    entryId: 'odoo-backup',
    service,
  };
}

test('ROUTE-1 POST /fingerprint 返回扫描到的指纹', async () => {
  const handler = loadHandler();
  const res = makeRes();
  await handler({
    req: makeReq({ url: '/odoo-backup/fingerprint', body: { server: 'toogel' } }),
    res,
    ...base({
      fingerprint: async (n) => {
        assert.equal(n, 'toogel');
        return { ok: true, fingerprints: [{ type: 'ED25519', fingerprint: 'SHA256:abc' }] };
      },
    }),
  });
  assert.equal(res.out.statusCode, 200, `实际 ${res.out.statusCode}: ${res.out.body}`);
  const parsed = JSON.parse(res.out.body);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.result.fingerprints[0].fingerprint, 'SHA256:abc');
});

test('ROUTE-2 POST /pin 把指纹交给 service.pin 并返回结果', async () => {
  const handler = loadHandler();
  const res = makeRes();
  let hit = null;
  await handler({
    req: makeReq({ url: '/odoo-backup/pin', body: { server: 'toogel', fingerprint: 'SHA256:abc' } }),
    res,
    ...base({
      pin: async (n, fp) => { hit = [n, fp]; return { ok: true, written: true, fingerprint: fp }; },
    }),
  });
  assert.equal(res.out.statusCode, 200, `实际 ${res.out.statusCode}: ${res.out.body}`);
  assert.deepEqual(hit, ['toogel', 'SHA256:abc']);
  assert.equal(JSON.parse(res.out.body).result.written, true);
});

test('ROUTE-3 POST /pin 缺少 fingerprint 时返回 400，不调用 service.pin', async () => {
  const handler = loadHandler();
  const res = makeRes();
  let called = false;
  await handler({
    req: makeReq({ url: '/odoo-backup/pin', body: { server: 'toogel' } }),
    res,
    ...base({ pin: async () => { called = true; } }),
  });
  assert.equal(res.out.statusCode, 400);
  assert.match(JSON.parse(res.out.body).error, /fingerprint/);
  assert.equal(called, false);
});

test('ROUTE-4 POST /fingerprint 缺少 server 时返回 400', async () => {
  const handler = loadHandler();
  const res = makeRes();
  await handler({
    req: makeReq({ url: '/odoo-backup/fingerprint', body: {} }),
    res,
    ...base({ fingerprint: async () => ({ ok: true }) }),
  });
  assert.equal(res.out.statusCode, 400);
  assert.match(JSON.parse(res.out.body).error, /server/);
});
