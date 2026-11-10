/**
 * v0.1.14：设置页「恢复目标域名」可编辑项。
 *
 * 语义：留空 = 自动用服务器名（仅当它是主机名）；填了就按填的走并做主机名校验。
 * 域名在 Host 侧读取（配置），不从前端请求体取，避免被页面参数注入。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { createService } from '../lib/service.js';
import { isHostname } from '../lib/site-domain.js';

const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const hostSrc = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

// ---------------- UI ----------------

test('DOMUI-1 恢复页有「恢复目标域名」输入框', () => {
  assert.match(src, /恢复目标域名/, '必须有可编辑输入项');
  assert.match(src, /aria-label'?:\s*['"]恢复目标域名|['"]恢复目标域名\s/, '需有无障碍标签');
});

test('DOMUI-2 输入框说明「留空=用服务器名」，避免用户误以为必填', () => {
  assert.match(src, /留空/, '必须说明留空语义');
});

test('DOMUI-3 保存走 /restore-domain 路由（不写浏览器存储）', () => {
  assert.match(src, /\/restore-domain/, '必须调用 Host 路由');
  assert.ok(!/localStorage[^\n]*restoreDomain/.test(src), '不得存 localStorage');
});

test('DOMUI-4 前端提交前做主机名校验，非法值不静默发送', () => {
  assert.match(src, /isHostname|isValidDomain|域名不合法/, '前端应有可见的校验反馈');
});

// ---------------- Host 路由 ----------------

const start = hostSrc.indexOf('async function handleUiRequest');
assert.ok(start > 0, 'index.js 应包含 handleUiRequest');
const body = hostSrc.slice(start).replace(/^async function handleUiRequest/, 'async function');
// eslint-disable-next-line no-new-func
const handleUiRequest = new Function(
  'normalizeRestorePath', 'resolveLastBackup', 'unwrapVolatile', 'stateDirOf', 'DEFAULT_BACKUP_DIRECTORY',
  'isHostname', 'isValidRestoreDomain',
  `${body.replace(/^async function/, 'return (async function')})`,
)(
  () => '', () => ({ ok: false }), (v) => v, () => 'K:/Backup/odoo', 'K:/Backup/odoo',
  isHostname,
  (v) => v === '' || isHostname(v),
);

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
function makeReq({ method = 'GET', url, payload } = {}) {
  const chunks = payload === undefined ? [] : [Buffer.from(JSON.stringify(payload))];
  return {
    method, url,
    headers: { host: '127.0.0.1:29123' },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() { yield* chunks; },
  };
}
function drive({ method, url, payload, config, settings }) {
  const res = makeRes();
  return handleUiRequest({
    req: makeReq({ method, url, payload }),
    res,
    config,
    service: {},
    tokenStore: { create() {}, verify() {} },
    settings,
    entryId: 'odoo-backup',
  }).then(() => res);
}

test('DOMHOST-1 GET /restore-domain 返回当前值（空=自动）', async () => {
  const res = await drive({
    url: '/odoo-backup/restore-domain',
    config: { restoreDomain: '' },
    settings: {},
  });
  const data = JSON.parse(res.out.body);
  assert.equal(res.out.statusCode, 200);
  assert.equal(data.ok, true);
  assert.equal(data.domain, '');
  assert.equal(data.mode, 'auto');
});

test('DOMHOST-2 POST 合法域名 → 写入 settings.update 并回读', async () => {
  const updates = [];
  const res = await drive({
    method: 'POST',
    url: '/odoo-backup/restore-domain',
    payload: { domain: 'stage.toogel.cn' },
    config: { restoreDomain: '' },
    settings: { async update(ns, patch) { updates.push([ns, patch]); } },
  });
  const data = JSON.parse(res.out.body);
  assert.equal(res.out.statusCode, 200, res.out.body);
  assert.equal(data.ok, true);
  assert.equal(data.domain, 'stage.toogel.cn');
  assert.deepEqual(updates, [['odoo-backup', { restoreDomain: 'stage.toogel.cn' }]]);
});

test('DOMHOST-3 POST 非法域名 → 400 且不写配置', async () => {
  const updates = [];
  const res = await drive({
    method: 'POST',
    url: '/odoo-backup/restore-domain',
    payload: { domain: "evil'; DROP TABLE website;--" },
    config: { restoreDomain: '' },
    settings: { async update(ns, patch) { updates.push([ns, patch]); } },
  });
  assert.equal(res.out.statusCode, 400);
  assert.match(JSON.parse(res.out.body).error, /域名不合法/);
  assert.equal(updates.length, 0, '非法值绝不能落盘');
});

test('DOMHOST-4 POST 空值 = 恢复自动模式', async () => {
  const updates = [];
  const res = await drive({
    method: 'POST',
    url: '/odoo-backup/restore-domain',
    payload: { domain: '' },
    config: { restoreDomain: 'old.toogel.cn' },
    settings: { async update(ns, patch) { updates.push([ns, patch]); } },
  });
  assert.equal(JSON.parse(res.out.body).mode, 'auto');
  assert.deepEqual(updates, [['odoo-backup', { restoreDomain: '' }]]);
});

// ---------------- service 透传 ----------------

function deps(captured) {
  return {
    guardHostKey: async () => ({ ok: true }),
    discover: async () => ({ ok: true, instances: [{ dbName: 'db' }] }),
    runRestore: async (a) => { captured.push(a.options); return { ok: true }; },
    detectFormat: async () => 'dsh-odoo',
    stat: async () => ({ size: 1 }),
    credentials: { resolve: async () => ({ value: 'pw' }) },
    scanHostKey: async () => ({ ok: true }),
    pinHostKey: async () => ({ ok: true }),
  };
}
const cfg = (extra = {}) => ({
  servers: [{ name: 's1', host: 'h', port: 22, user: 'root', sshConfigAlias: 'a' }],
  localBackupDir: 'K:/b',
  allowUnencryptedPackage: false,
  ...extra,
});

test('DOMSVC-1 配置了 restoreDomain → 传给 runRestore', async () => {
  const captured = [];
  const svc = createService({ config: cfg({ restoreDomain: 'stage.toogel.cn' }), deps: deps(captured) });
  await svc.restore('s1', null, 'K:/b/x.tar.enc', {});
  assert.equal(captured[0].websiteDomain, 'stage.toogel.cn');
});

test('DOMSVC-2 未配置 → websiteDomain 为 undefined（走自动服务器名）', async () => {
  const captured = [];
  const svc = createService({ config: cfg({ restoreDomain: '' }), deps: deps(captured) });
  await svc.restore('s1', null, 'K:/b/x.tar.enc', {});
  assert.equal(captured[0].websiteDomain, undefined);
});

test('DOMSVC-3 volatile 活引用被解包（配置改完立即生效）', async () => {
  const captured = [];
  const svc = createService({
    config: cfg({ restoreDomain: { get: () => 'live.toogel.cn' } }),
    deps: deps(captured),
  });
  await svc.restore('s1', null, 'K:/b/x.tar.enc', {});
  assert.equal(captured[0].websiteDomain, 'live.toogel.cn');
});
