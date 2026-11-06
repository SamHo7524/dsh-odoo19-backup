import { test } from 'node:test';
import assert from 'node:assert';
import { createService } from '../lib/service.js';

const baseServer = {
  name: 'staging', host: '119.29.10.202', port: 22, user: 'root',
};

const cfg = (server = baseServer) => ({
  servers: [server],
  localBackupDir: 'K:/Backup/odoo',
  passphrase: 'test-pw', // U4：有口令才能走到指纹闸门
  allowUnencryptedPackage: false,
});

function deps(overrides = {}) {
  const calls = [];
  return {
    calls,
    testConnection: async (s) => { calls.push(['testConnection', s.host]); return { ok: true, system: { os: 'X' } }; },
    discover: async (s) => { calls.push(['discover', s.host]); return { ok: true, instances: [{ dbName: 'tg-odoo' }] }; },
    runBackup: async (a) => { calls.push(['runBackup', a.server.host]); return { ok: true, localPath: 'K:/b.tar' }; },
    runRestore: async (a) => { calls.push(['runRestore', a.server.host]); return { ok: true }; },
    detectFormat: async () => 'dsh-odoo',
    stat: async () => ({ size: 1 }),
    guardHostKey: async () => ({ ok: true, mode: 'pinned' }),
    ...overrides,
  };
}

test('service.test 在未固定指纹时拒绝连接且不触达远端', async () => {
  const d = deps({
    guardHostKey: async () => ({ ok: false, error: { kind: 'not-pinned', message: '尚未确认主机指纹' } }),
  });
  const svc = createService({ config: cfg(), deps: d });
  await assert.rejects(() => svc.test('staging'), /尚未确认主机指纹|指纹/);
  assert.equal(d.calls.length, 0, '未通过指纹闸门绝不能触达远端');
});

test('service.test 通过闸门后才调用 testConnection', async () => {
  const d = deps();
  const svc = createService({ config: cfg(), deps: d });
  await svc.test('staging');
  assert.deepEqual(d.calls[0], ['testConnection', '119.29.10.202']);
});

test('service.discover 未固定指纹时拒绝', async () => {
  const d = deps({ guardHostKey: async () => ({ ok: false, error: { message: '尚未确认主机指纹' } }) });
  const svc = createService({ config: cfg(), deps: d });
  await assert.rejects(() => svc.discover('staging'), /指纹/);
  assert.equal(d.calls.length, 0);
});

test('service.backup 未固定指纹时拒绝', async () => {
  const d = deps({ guardHostKey: async () => ({ ok: false, error: { message: '尚未确认主机指纹' } }) });
  const svc = createService({ config: cfg(), deps: d });
  await assert.rejects(() => svc.backup('staging'), /指纹/);
  assert.equal(d.calls.filter((c) => c[0] === 'runBackup').length, 0);
});

test('service.restore 未固定指纹时拒绝（即使包合法）', async () => {
  const d = deps({ guardHostKey: async () => ({ ok: false, error: { message: '尚未确认主机指纹' } }) });
  const svc = createService({ config: cfg(), deps: d });
  await assert.rejects(() => svc.restore('staging', null, 'K:/b.tar', {}), /指纹/);
  assert.equal(d.calls.filter((c) => c[0] === 'runRestore').length, 0);
});
