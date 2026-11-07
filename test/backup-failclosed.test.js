import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBackup } from '../lib/backup.js';
import { createService } from '../lib/service.js';
import { createOdooBackupTool } from '../lib/tools.js';

const MSG = /加密口令|passphrase|配置/;

// ---------- runBackup：入口门禁（不得触达远端、不得产生文件） ----------

test('runBackup 缺少口令时直接拒绝（不触达远端）', async () => {
  let remoteTouched = false;
  await assert.rejects(
    () => runBackup({
      server: { host: 'should-not-connect' },
      instance: { dbName: 'db' },
      localDir: 'K:/unused',
      // 不传 passphrase
      _execRemote: () => { remoteTouched = true; throw new Error('不该触达远端'); },
    }),
    (e) => MSG.test(e.message),
  );
  assert.equal(remoteTouched, false);
});

test('runBackup 空口令时直接拒绝', async () => {
  await assert.rejects(
    () => runBackup({
      server: {}, instance: {}, localDir: 'K:/unused', passphrase: '',
    }),
    (e) => MSG.test(e.message),
  );
});

test('runBackup 全空白口令时直接拒绝', async () => {
  await assert.rejects(
    () => runBackup({
      server: {}, instance: {}, localDir: 'K:/unused', passphrase: '   ',
    }),
    (e) => MSG.test(e.message),
  );
});

test('runBackup 非字符串口令时直接拒绝', async () => {
  await assert.rejects(
    () => runBackup({
      server: {}, instance: {}, localDir: 'K:/unused', passphrase: 12345,
    }),
    (e) => MSG.test(e.message),
  );
});

test('runBackup 无口令时本地目录不留任何文件', async () => {
  const dir = await mkdtemp(join(tmpdir(), 't11-fc-'));
  try {
    await assert.rejects(
      () => runBackup({ server: {}, instance: {}, localDir: dir, passphrase: '' }),
      MSG,
    );
    assert.deepEqual(await readdir(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------- service：前置校验（比 runBackup 更早失败） ----------

const srv = { name: 'staging', host: 'h', port: 22, user: 'root' };
function deps(overrides = {}) {
  const calls = [];
  return {
    calls,
    guardHostKey: async () => ({ ok: true }),
    discover: async () => { calls.push(['discover']); return { instances: [{ dbName: 'db' }] }; },
    runBackup: async (a) => { calls.push(['runBackup', a.passphrase]); return { ok: true, encrypted: true }; },
    stat: async () => ({ size: 1 }),
    detectFormat: async () => 'dsh-odoo',
    runRestore: async () => ({ ok: true }),
    // v0.1.11：口令统一走 Credentials；stub 默认未配置（未提供 credentialsValue 时 resolve 返回 undefined），
    // 需要有效口令的测试用 overrides 传入 credentialsValue。
    ...overrides,
    credentials: overrides.credentials ?? {
      resolve: async (ref) => (overrides.credentialsValue === undefined
        ? undefined
        : { value: overrides.credentialsValue, source: 'file' }),
    },
  };
}

test('service.backup 未配置口令时拒绝，且不调用 discover/runBackup', async () => {
  const d = deps();
  const svc = createService({ config: { servers: [srv], localBackupDir: 'K:/b' }, deps: d });
  await assert.rejects(() => svc.backup('staging'), (e) => MSG.test(e.message));
  assert.equal(d.calls.length, 0, '口令缺失时不应触达任何远端操作');
});

test('service.backup 空口令时拒绝', async () => {
  const d = deps({ credentialsValue: '' });
  const svc = createService({ config: { servers: [srv], localBackupDir: 'K:/b', passphrase: '' }, deps: d });
  await assert.rejects(() => svc.backup('staging'), (e) => MSG.test(e.message));
  assert.equal(d.calls.length, 0);
});

test('service.backup 有效口令时正常执行且透传口令', async () => {
  const d = deps({ credentialsValue: 'pw' });
  const svc = createService({ config: { servers: [srv], localBackupDir: 'K:/b', passphrase: 'pw' }, deps: d });
  const r = await svc.backup('staging');
  assert.equal(r.ok, true);
  assert.deepEqual(d.calls, [['discover'], ['runBackup', 'pw']]);
});

// ---------- Agent 工具：错误信息明确可操作 ----------

test('odoo_backup 工具在无口令时返回可操作错误', async () => {
  const d = deps();
  const svc = createService({ config: { servers: [srv], localBackupDir: 'K:/b' }, deps: d });
  const tool = createOdooBackupTool({
    config: { servers: [srv], localBackupDir: 'K:/b' },
    service: svc,
  });
  await assert.rejects(
    () => tool.execute({ action: 'backup', server: 'staging' }),
    (e) => MSG.test(e.message) && /凭证|口令/.test(e.message),
  );
});

// ---------- 有效口令仍走既有加密流程（不改格式） ----------

test('有效口令时加密格式仍为 dsh-odoo（回归）', async () => {
  const { encryptFile, detectFormat, isEncrypted } = await import('../lib/crypto.js');
  const dir = await mkdtemp(join(tmpdir(), 't11-enc-'));
  try {
    const src = join(dir, 'a.bin');
    const enc = join(dir, 'a.enc');
    await writeFile(src, Buffer.from('plain-content-1234567890'));
    await encryptFile(src, enc, 'valid-pw');
    assert.equal(await detectFormat(enc), 'dsh-odoo');
    assert.equal(await isEncrypted(enc), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
