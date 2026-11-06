import { test } from 'node:test';
import assert from 'node:assert';
import { createService } from '../lib/service.js';

const srv = { name: 'staging', host: 'h', port: 22, user: 'root' };
const cfg = { servers: [srv], localBackupDir: 'K:/b', passphrase: 'test-pw', allowUnencryptedPackage: false };

function deps(overrides = {}) {
  const calls = [];
  return {
    calls,
    guardHostKey: async () => ({ ok: true }),
    // discover 的真实返回契约：{ server, instances, found }，没有 ok 字段
    discover: async () => { calls.push(['discover']); return { server: 'staging', instances: [{ dbName: 'tg-odoo' }], found: true }; },
    runBackup: async () => { calls.push(['runBackup']); return { ok: true, localPath: 'K:/b.tar' }; },
    runRestore: async () => { calls.push(['runRestore']); return { ok: true }; },
    detectFormat: async () => 'dsh-odoo',
    stat: async () => ({ size: 1 }),
    ...overrides,
  };
}

test('backup 认 discover 的 found 字段（无 ok 字段时不应失败）', async () => {
  const d = deps();
  const svc = createService({ config: cfg, deps: d });
  const r = await svc.backup('staging');
  assert.equal(r.ok, true);
  assert.ok(d.calls.some((c) => c[0] === 'runBackup'), '应真正执行备份');
});

test('backup 在 instances 为空时报错', async () => {
  const d = deps({ discover: async () => ({ server: 's', instances: [], found: false }) });
  const svc = createService({ config: cfg, deps: d });
  await assert.rejects(() => svc.backup('staging'), /未发现 Odoo 实例/);
});

test('restore 认 discover 的 found 字段', async () => {
  const d = deps();
  const svc = createService({ config: cfg, deps: d });
  const r = await svc.restore('staging', null, 'K:/b.tar', {});
  assert.equal(r.ok, true);
  assert.ok(d.calls.some((c) => c[0] === 'runRestore'));
});

test('restore 在 instances 为空时报错', async () => {
  const d = deps({ discover: async () => ({ server: 's', instances: [], found: false }) });
  const svc = createService({ config: cfg, deps: d });
  await assert.rejects(() => svc.restore('staging', null, 'K:/b.tar', {}), /未发现 Odoo 实例/);
});

test('discover 结果既无 found 也无 ok 时，有 instances 即视为可用', async () => {
  const d = deps({ discover: async () => ({ instances: [{ dbName: 'x' }] }) });
  const svc = createService({ config: cfg, deps: d });
  const r = await svc.backup('staging');
  assert.equal(r.ok, true);
});
