/**
 * v0.1.14：恢复预检展示源库名与目标库名，二者独立。
 *
 * 源库名来自备份包 MANIFEST（告诉我们备份来自哪里）。
 * 目标库名来自目标机自动发现（决定覆盖哪个库）。
 * 源库名绝不能被写进服务器配置或当作目标库名。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { normalizeRestorePath } from '../lib/restore-path.js';

const hostSrc = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const clientSrc = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const discoverSrc = readFileSync(new URL('../lib/discover.js', import.meta.url), 'utf8');

const start = hostSrc.indexOf('async function handleUiRequest');
assert.ok(start > 0);
const body = hostSrc.slice(start).replace(/^async function handleUiRequest/, 'async function');
const handleUiRequest = new Function(
  'normalizeRestorePath', 'resolveLastBackup', 'unwrapVolatile', 'stateDirOf', 'DEFAULT_BACKUP_DIRECTORY',
  'isHostname', 'isValidRestoreDomain',
  `${body.replace(/^async function/, 'return (async function')})`,
)(
  normalizeRestorePath, () => ({ ok: false }), (v) => v, () => 'K:/Backup/odoo', 'K:/Backup/odoo',
  () => true, () => true,
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
function makeReq(payload) {
  const chunks = [Buffer.from(JSON.stringify(payload))];
  return {
    method: 'POST',
    url: '/odoo-backup/precheck',
    headers: { host: '127.0.0.1:29123' },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() { yield* chunks; },
  };
}

const SERVERS = [{ name: 'odoo.toogel.cn', host: '134.175.51.9', dbName: '' }];

async function precheck({ service, settings, servers = SERVERS, packagePath = 'K:/Backup/odoo/x.tar.enc' }) {
  const res = makeRes();
  const created = [];
  await handleUiRequest({
    req: makeReq({ server: 'odoo.toogel.cn', packagePath }),
    res,
    config: { servers },
    service,
    tokenStore: {
      create(binding) { created.push(binding); return 'tok-1'; },
      verify() {},
    },
    settings,
    entryId: 'odoo-backup',
    credentials: { resolve: async () => ({ value: 'pw' }) },
  });
  return { status: res.out.statusCode, data: JSON.parse(res.out.body || '{}'), created };
}

test('PREDB-1 预检同时返回源库名与目标库名，且二者独立', async () => {
  const { status, data } = await precheck({
    service: {
      attachCredentials() {},
      async inspectRestore() {
        return {
          sourceDbName: 'tg-odoo',
          targetDbName: 'toogel',
          conflict: null,
          discovery: { ok: true, dbName: 'toogel', source: 'pg-list', confidence: 'medium' },
        };
      },
    },
    settings: { async update() {} },
  });
  assert.equal(status, 200, JSON.stringify(data));
  assert.equal(data.sourceDbName, 'tg-odoo');
  assert.equal(data.targetDbName, 'toogel');
  assert.equal(data.conflict, null);
  assert.notEqual(data.targetDbName, data.sourceDbName);
});

test('PREDB-2 token 仍只绑定服务器与包路径，不把库名写进绑定', async () => {
  const { created } = await precheck({
    service: {
      attachCredentials() {},
      async inspectRestore() {
        return { sourceDbName: 'tg-odoo', targetDbName: 'toogel', discovery: { ok: true, dbName: 'toogel', source: 'dbfilter', confidence: 'high' } };
      },
    },
    settings: { async update() {} },
    packagePath: '"K:/Backup/odoo/x.tar.enc"',
  });
  assert.equal(created.length, 1);
  assert.equal(created[0].server, 'odoo.toogel.cn');
  assert.equal(created[0].packagePath, 'K:\\Backup\\odoo\\x.tar.enc');
  assert.equal(created[0].sourceDbName, undefined);
  assert.equal(created[0].targetDbName, undefined);
});

test('PREDB-3 自动识别成功且服务器未填库名时，写回的是目标库名而不是源库名', async () => {
  const updates = [];
  await precheck({
    service: {
      attachCredentials() {},
      async inspectRestore() {
        return {
          sourceDbName: 'tg-odoo',
          targetDbName: 'toogel',
          discovery: { ok: true, dbName: 'toogel', source: 'pg-list', confidence: 'medium' },
        };
      },
    },
    settings: { async update(_id, patch) { updates.push(patch); } },
  });
  assert.equal(updates.length, 1);
  assert.equal(updates[0].servers[0].dbName, 'toogel');
  assert.notEqual(updates[0].servers[0].dbName, 'tg-odoo');
});

test('PREDB-4 已手工填写的库名不被自动发现覆盖', async () => {
  const updates = [];
  await precheck({
    servers: [{ name: 'odoo.toogel.cn', dbName: 'hand-filled' }],
    service: {
      attachCredentials() {},
      async inspectRestore() {
        return {
          sourceDbName: 'tg-odoo',
          targetDbName: 'hand-filled',
          discovery: { ok: true, dbName: 'toogel', source: 'pg-list', confidence: 'medium' },
        };
      },
    },
    settings: { async update(_id, patch) { updates.push(patch); } },
  });
  assert.equal(updates.length, 0);
});

test('PREDB-5 目标库名有歧义时不写配置，并返回可操作原因', async () => {
  const updates = [];
  const { data } = await precheck({
    service: {
      attachCredentials() {},
      async inspectRestore() {
        return {
          sourceDbName: 'tg-odoo',
          targetDbName: null,
          targetReason: '有多个候选库（toogel、toogel-old），请手工填写数据库名',
          discovery: { ok: false, reason: 'ambiguous', candidates: ['toogel', 'toogel-old'] },
        };
      },
    },
    settings: { async update(_id, patch) { updates.push(patch); } },
  });
  assert.equal(updates.length, 0);
  assert.equal(data.targetDbName, null);
  assert.match(data.targetReason, /手工填写/);
  assert.ok(!/tg-odoo/.test(data.targetReason), '不能建议用源库名当目标');
});

test('PREDB-6 discover 在 PG 列表之后走 resolveDiscoveredDbName，并排除超级用户', () => {
  assert.match(discoverSrc, /resolveDiscoveredDbName/);
  assert.match(discoverSrc, /SELECT datname/);
  assert.match(discoverSrc, /pgSuperUser/);
});

test('PREDB-7 恢复页展示来源库与目标库；目标库缺失时不调用 /restore', () => {
  const seg = clientSrc.slice(clientSrc.indexOf("tab === 'restore'"));
  assert.match(seg, /来源库/);
  assert.match(seg, /目标库/);
  assert.match(seg, /pre\.sourceDbName/);
  assert.match(seg, /pre\.targetDbName/);
  const restoreCall = seg.indexOf("api('/restore'");
  const guard = seg.indexOf('!pre.targetDbName');
  assert.ok(guard > 0 && guard < restoreCall, '必须在调用 /restore 之前因目标库名缺失而返回');
});

test('PREDB-8 服务器页提供「发现库名」，留空说明为自动发现', () => {
  assert.match(clientSrc, /api\('\/discover'/);
  assert.match(clientSrc, /发现库名/);
  assert.match(clientSrc, /留空则自动发现/);
});
