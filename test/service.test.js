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

// ---------------- v0.1.21：credentials 必须是活引用，不能在创建时被快照 ----------------

test('SVC-CRED-1 创建后才注入的 credentials 必须立即可用（getter 不能被展开快照）', async () => {
  let creds = null; // 创建时还没有凭证服务（ctx.inject 尚未回调）
  const base = deps();
  const lazyDeps = {
    ...base,
    get credentials() { return creds; },
  };
  const svc = createService({ config: cfg, deps: lazyDeps });
  // 注入前：应明确报「凭证服务不可用」
  await assert.rejects(() => svc.backup('staging'), /凭证服务不可用/);
  // 注入后：必须立刻可用（活引用，而不是创建时的快照 undefined）
  creds = { resolve: async () => ({ value: 'pw-late', source: 'file' }) };
  const r = await svc.backup('staging');
  assert.equal(r.ok, true);
});

test('SVC-CRED-2 键顺序无关：credentials getter 在展开之后定义也要生效', async () => {
  const base = deps();
  let creds = { resolve: async () => ({ value: 'pw-a', source: 'file' }) };
  const lazyDeps = { ...base };
  Object.defineProperty(lazyDeps, 'credentials', { get: () => creds, enumerable: true, configurable: true });
  const svc = createService({ config: cfg, deps: lazyDeps });
  const r1 = await svc.backup('staging');
  assert.equal(r1.ok, true);
  creds = { resolve: async () => ({ value: 'pw-b', source: 'file' }) }; // 变化后仍应读到新值
  const r2 = await svc.backup('staging');
  assert.equal(r2.ok, true);
});

test('SVC-CRED-3 attachCredentials 不能因只读 getter 抛错（0.1.21 回归）', async () => {
  // 复现线上：deps 用 getter 透传 credentials（活引用），service 创建后
  // UI 路由每次请求都会调用 attachCredentials()，而 getter 属性无 setter。
  let creds = null;
  const lazyDeps = { ...deps(), get credentials() { return creds; } };
  const svc = createService({ config: cfg, deps: lazyDeps });
  // createService 已把 getter 装回，d.credentials 只有 getter；赋值必须走 setter 而不是直接抛
  assert.doesNotThrow(() => svc.attachCredentials({ resolve: async () => ({ value: 'pw-x', source: 'file' }) }));
  // 显式 attach 的凭证必须真的可用（盖过尚未注入的 live getter）
  const r = await svc.backup('staging');
  assert.equal(r.ok, true);
});

test('SVC-CRED-4 attachCredentials 忽略非法参数，不破坏已有引用', async () => {
  const svc = createService({ config: cfg, deps: deps() });
  assert.doesNotThrow(() => svc.attachCredentials(null));
  assert.doesNotThrow(() => svc.attachCredentials({}));
  const r = await svc.backup('staging');
  assert.equal(r.ok, true, '注入的 deps.credentials 仍然可用');
});

// ---------------- v0.1.24：配置字段必须到达 discover（dbName 被 serverConnection 剥掉） ----------------

test('SVC-SRV-1 discover 必须收到配置里的 dbName（不能只给连接字段）', async () => {
  const seen = [];
  const d = deps({
    discover: async (server) => {
      seen.push({ name: server.name, dbName: server.dbName, odooContainer: server.odooContainer });
      return { ok: true, instances: [{ dbName: server.dbName || '', odooVersion: '19.0' }] };
    },
  });
  const svc = createService({ config: cfg, deps: d });
  const r = await svc.discover('staging');
  assert.equal(seen[0].dbName, 'tg-odoo', '配置里的 dbName 必须透传给 discover');
  assert.equal(seen[0].odooContainer, '1Panel-odoo-5td9', '容器名同样不能丢');
  assert.equal(r.instances[0].dbName, 'tg-odoo');
});

test('SVC-SRV-2 指纹闸门只拿连接字段：不得把 dbName 等插件字段送进 SSH 层', async () => {
  let guardArg = null;
  const d = deps({ guardHostKey: async (s) => { guardArg = s; return { ok: true, mode: 'pinned' }; } });
  const svc = createService({ config: cfg, deps: d });
  await svc.discover('staging');
  assert.ok(guardArg, 'guardHostKey 必须被调用');
  assert.equal(guardArg.dbName, undefined, 'SSH 层不应看到 dbName');
  assert.equal(guardArg.host, '119.29.10.202');
});

test('SVC-SRV-3 dbfilter 被注释时，runRestore 必须拿到配置里的 dbName', async () => {
  let gotInstance = null;
  const d = deps({
    detectFormat: async () => 'dsh-odoo',
    readPackageMeta: async () => ({ ok: true, sourceDbName: 'tg-odoo', source: { odooVersion: '19.0-1' } }),
    discover: async (server) => ({
      ok: true,
      instances: [{ dbName: server.dbName || '', odooVersion: '19.0-1', odooContainer: 'c', pgContainer: 'p', addonsPath: '/a', dataPath: '/d' }],
    }),
    runRestore: async (a) => { gotInstance = a.instance; return { ok: true, state: 'COMMITTED' }; },
  });
  const svc = createService({ config: cfg, deps: d });
  const r = await svc.restore('staging', null, 'K:/b.tar.enc', {});
  assert.equal(r.ok, true);
  assert.equal(gotInstance.dbName, 'tg-odoo', '经 dbfilter 缺失路径后仍要拿到配置库名，否则 runRestore 会拒绝');
});
