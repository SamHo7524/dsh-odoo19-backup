import { test } from 'node:test';
import assert from 'node:assert';
import { createService } from '../lib/service.js';
import { serverConnection } from '../lib/tools.js';

const cfg = {
  servers: [{
    name: 'staging', host: '119.29.10.202', port: 22, user: 'root',
    keyPath: 'C:/k/id', pinnedFingerprint: 'SHA256:abc',
    odooContainer: '1Panel-odoo-5td9', pgContainer: '1Panel-postgresql-ZcrG',
    dbName: 'tg-odoo', dataPath: '/data', addonsPath: '/addons',
  }],
  localBackupDir: 'K:/Backup/odoo',
  passphrase: 'test-pw', // U4 fail-closed：备份类测试必须提供有效口令
  sshTimeoutMs: 30000,
  transferTimeoutMs: 3600000,
  allowUnencryptedPackage: false,
};

function deps(overrides = {}) {
  const calls = [];
  const base = {
    calls,
    guardHostKey: async () => ({ ok: true, mode: 'pinned' }),
    discover: async (server) => {
      calls.push(['discover', server.host]);
      return { ok: true, instances: [{ dbName: 'tg-odoo', odooVersion: '19.0' }] };
    },
    runBackup: async (a) => {
      calls.push(['runBackup', a.server.host, a.localDir]);
      return { ok: true, localPath: 'K:/b.tar', bytes: 10, sha256Remote: 'x', encrypted: false };
    },
    runRestore: async (a) => {
      calls.push(['runRestore', a.server.host, a.packagePath]);
      return { ok: true, state: 'COMMITTED' };
    },
    testConnection: async (server) => {
      calls.push(['testConnection', server.host]);
      return { ok: true, system: { os: 'Ubuntu' } };
    },
    stat: async () => ({ size: 100 }),
    detectFormat: async () => 'plain',
    // v0.1.11：口令统一走 Credentials；测试注入固定口令的 stub
    credentials: {
      resolve: async (ref) => {
        calls.push(['credentials.resolve', ref]);
        return { value: cfg.passphrase, source: 'file' };
      },
    },
  };
  return { ...base, ...overrides };
}

test('service.test 委托 testConnection 并带上完整连接参数', async () => {
  const d = deps();
  const svc = createService({ config: cfg, deps: d });
  const r = await svc.test('staging');
  assert.equal(r.ok, true);
  assert.deepEqual(d.calls[0], ['testConnection', '119.29.10.202']);
});

test('service.discover 委托 discover', async () => {
  const d = deps();
  const svc = createService({ config: cfg, deps: d });
  const r = await svc.discover('staging');
  assert.equal(r.instances[0].dbName, 'tg-odoo');
});

test('service.backup 用配置的本地目录与超时', async () => {
  const d = deps();
  const svc = createService({ config: cfg, deps: d });
  await svc.backup('staging');
  const backupCall = d.calls.find((c) => c[0] === 'runBackup');
  assert.ok(backupCall, '应调用 runBackup');
  assert.deepEqual(backupCall, ['runBackup', '119.29.10.202', 'K:/Backup/odoo']);
});

test('service.backup 要求先能发现实例', async () => {
  const d = deps({ discover: async () => ({ ok: false, instances: [] }) });
  const svc = createService({ config: cfg, deps: d });
  await assert.rejects(() => svc.backup('staging'), /未发现 Odoo 实例/);
});

test('service.restore 要求备份包存在', async () => {
  const d = deps({ stat: async () => { throw new Error('ENOENT'); } });
  const svc = createService({ config: cfg, deps: d });
  await assert.rejects(
    () => svc.restore('staging', null, 'K:/missing.tar', {}),
    /备份包不存在/,
  );
});

test('service.restore 拒绝未加密包（除非配置显式允许）', async () => {
  const d = deps({ detectFormat: async () => 'plain' });
  const svc = createService({ config: cfg, deps: d });
  await assert.rejects(
    () => svc.restore('staging', null, 'K:/b.tar', {}),
    /未加密/,
  );
  assert.equal(d.calls.filter((c) => c[0] === 'runRestore').length, 0);
});

test('service.restore 允许未加密包时透传 allowUnencrypted', async () => {
  const d = deps({ detectFormat: async () => 'plain' });
  const svc = createService({ config: cfg, deps: d, allowUnencrypted: true });
  await svc.restore('staging', null, 'K:/b.tar', {});
  assert.equal(d.calls.some((c) => c[0] === 'runRestore'), true);
});

test('service.restore 加密包正常执行', async () => {
  const d = deps({ detectFormat: async () => 'dsh-odoo' });
  const svc = createService({ config: cfg, deps: d });
  const r = await svc.restore('staging', null, 'K:/b.tar.enc', { passphrase: 'pw' });
  assert.equal(r.ok, true);
  assert.equal(d.calls.filter((c) => c[0] === 'runRestore').length, 1);
});

test('service.status 初始无任务', async () => {
  const svc = createService({ config: cfg, deps: deps() });
  const s = await svc.status();
  assert.equal(s.running, false);
  assert.equal(s.lastTask, null);
});

test('service.status 在恢复进行中标记 running', async () => {
  let release;
  const gate = new Promise((res) => { release = res; });
  const d = deps({ detectFormat: async () => 'dsh-odoo', runRestore: async () => { await gate; return { ok: true }; } });
  const svc = createService({ config: cfg, deps: d });
  const p = svc.restore('staging', null, 'K:/b.tar', {});
  await new Promise((r) => setTimeout(r, 10));
  assert.equal((await svc.status()).running, true);
  release();
  await p;
  assert.equal((await svc.status()).running, false);
});

test('service 对未知服务器抛错', async () => {
  const svc = createService({ config: cfg, deps: deps() });
  await assert.rejects(() => svc.test('nope'), /未找到服务器/);
});

test('serverConnection 过滤掉插件专有字段', () => {
  const conn = serverConnection(cfg.servers[0]);
  assert.equal(conn.host, '119.29.10.202');
  assert.equal(conn.keyPath, 'C:/k/id');
  assert.equal(conn.odooContainer, undefined);
  assert.equal(conn.dbName, undefined);
});

// ---------------- v0.1.17：版本闸门 + 失败诊断 ----------------

test('SVC-VG-1 跨大版本：恢复在动手前就被拒绝，绝不调用 runRestore', async () => {
  const d = deps({
    detectFormat: async () => 'dsh-odoo',
    discover: async () => ({ ok: true, instances: [{ dbName: 'tg-odoo', odooVersion: '20.0-20261102' }] }),
    readPackageMeta: async () => ({
      ok: true, sourceDbName: 'tg-odoo',
      source: { odooVersion: '19.0-20260619' },
    }),
  });
  const svc = createService({ config: cfg, deps: d });
  await assert.rejects(
    () => svc.restore('staging', null, 'K:/b.tar.enc', {}),
    (err) => {
      assert.match(err.message, /19\.0-20260619/);
      assert.match(err.message, /20\.0-20261102/);
      assert.match(err.message, /建议/);
      return true;
    },
  );
  assert.equal(d.calls.filter((c) => c[0] === 'runRestore').length, 0);
});

test('SVC-VG-2 同大版本：正常执行', async () => {
  const d = deps({
    detectFormat: async () => 'dsh-odoo',
    readPackageMeta: async () => ({ ok: true, sourceDbName: 'tg-odoo', source: { odooVersion: '19.0-20260619' } }),
  });
  const svc = createService({ config: cfg, deps: d });
  const r = await svc.restore('staging', null, 'K:/b.tar.enc', {});
  assert.equal(r.ok, true);
  assert.equal(d.calls.filter((c) => c[0] === 'runRestore').length, 1);
});

test('SVC-DIAG-3 恢复失败时错误里必须带诊断与建议（不再只有原始报错）', async () => {
  const d = deps({
    detectFormat: async () => 'dsh-odoo',
    readPackageMeta: async () => ({ ok: true, sourceDbName: 'tg-odoo', source: { odooVersion: '19.0-20260619' } }),
    runRestore: async () => {
      throw new Error('odoo db load 失败 (rc=1)：psycopg2.errors.UndefinedColumn: column "is_live" of relation "payment_provider" does not exist');
    },
  });
  const svc = createService({ config: cfg, deps: d });
  await assert.rejects(
    () => svc.restore('staging', null, 'K:/b.tar.enc', {}),
    (err) => {
      assert.match(err.message, /is_live/);       // 原始错误仍在
      assert.match(err.message, /【诊断】/);
      assert.match(err.message, /【建议】/);
      return true;
    },
  );
});

test('SVC-DIAG-4 未命中的错误原样透出，不伪造诊断', async () => {
  const d = deps({
    detectFormat: async () => 'dsh-odoo',
    readPackageMeta: async () => ({ ok: true, sourceDbName: 'tg-odoo', source: { odooVersion: '19.0-20260619' } }),
    runRestore: async () => { throw new Error('weird unknown failure xyz'); },
  });
  const svc = createService({ config: cfg, deps: d });
  await assert.rejects(
    () => svc.restore('staging', null, 'K:/b.tar.enc', {}),
    (err) => {
      assert.equal(err.message, 'weird unknown failure xyz');
      return true;
    },
  );
});
