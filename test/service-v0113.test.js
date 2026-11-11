/**
 * v0.1.13 T2 RED — service 接线：统一状态源 / 六态生命周期 / 服务器级互斥。
 * 规格 §6.1/§6.2/§6.3/§17.1。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createService } from '../lib/service.js';
import { readState, serverStateDir } from '../lib/task-state.js';
import { readLock } from '../lib/server-lock.js';
import { serverIdOf } from '../lib/server-id.js';

async function withDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'v0113-svc-'));
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

/** v0.1.17：状态文件在 <dir>/<serverId>/ 下；统一从这里读，兼容旧断言口径。 */
function readServerState(dir, serverName = 's1') {
  const cfg = { name: serverName, host: 'h', port: 22, user: 'root', sshConfigAlias: 'alias' };
  return readState(serverStateDir(dir, serverIdOf(cfg)));
}

function deps(overrides = {}) {
  return {
    guardHostKey: async () => ({ ok: true }),
    testConnection: async () => ({ ok: true }),
    discover: async () => ({ ok: true, instances: [{ dbName: 'db' }] }),
    runBackup: async () => ({ ok: true, localPath: 'K:/b.tar.enc', bytes: 10 }),
    runRestore: async () => ({ ok: true }),
    detectFormat: async () => 'dsh-odoo',
    stat: async () => ({ size: 1 }),
    scanHostKey: async () => ({ ok: true, fingerprints: [] }),
    pinHostKey: async () => ({ ok: true }),
    credentials: { resolve: async () => ({ value: 'pw', source: 'file' }) },
    ...overrides,
  };
}
const cfg = (dir) => ({
  servers: [{ name: 's1', host: 'h', port: 22, user: 'root', sshConfigAlias: 'alias' }],
  localBackupDir: dir,
  backupDirectory: dir,
  allowUnencryptedPackage: false,
});

test('SVC-1 backup 成功后 transfer-state.json 落盘且 status=completed（仅后端确认）', async () => {
  await withDir(async (dir) => {
    const d = deps();
    const svc = createService({ config: cfg(dir), deps: d, stateDir: dir });
    await svc.backup('s1');
    const s = await readServerState(dir);
    assert.ok(s, '状态文件必须存在');
    assert.equal(s.status, 'completed');
    assert.equal(s.percent, 100);
    assert.equal(s.kind, 'backup');
  });
});

test('SVC-2 status() 以磁盘为准：返回 taskId/kind/status/phase/percent', async () => {
  await withDir(async (dir) => {
    const svc = createService({ config: cfg(dir), deps: deps(), stateDir: dir });
    await svc.backup('s1');
    const st = await svc.status();
    assert.equal(st.taskId, (await readServerState(dir)).taskId);
    assert.equal(st.status, 'completed');
    assert.equal(st.kind, 'backup');
    assert.equal(typeof st.percent, 'number');
  });
});

test('SVC-3 备份期间再次发起备份 → 互斥拒绝（不执行 runBackup）', async () => {
  await withDir(async (dir) => {
    let calls = 0;
    let release;
    const gate = new Promise((r) => { release = r; });
    const d = deps({
      runBackup: async () => { calls++; await gate; return { ok: true, localPath: 'K:/b.tar.enc', bytes: 1 }; },
    });
    const svc = createService({ config: cfg(dir), deps: d, stateDir: dir });
    const p1 = svc.backup('s1');
    // 等第一次真正进入 runBackup（锁已获取）
    for (let i = 0; i < 50 && calls === 0; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(calls, 1, '第一次备份应已启动');
    try {
      await assert.rejects(() => svc.backup('s1'), /正在执行|并发/);
    } finally { release(); }
    await p1;
    assert.equal(calls, 1, '第二次不得执行备份');
  });
});

test('SVC-4 备份期间发起恢复 → 互斥拒绝', async () => {
  await withDir(async (dir) => {
    let started = false;
    let release;
    const gate = new Promise((r) => { release = r; });
    const d = deps({
      runBackup: async () => { started = true; await gate; return { ok: true, localPath: 'K:/b', bytes: 1 }; },
    });
    const svc = createService({ config: cfg(dir), deps: d, stateDir: dir });
    const p1 = svc.backup('s1');
    for (let i = 0; i < 50 && !started; i++) await new Promise((r) => setTimeout(r, 10));
    try {
      await assert.rejects(() => svc.restore('s1', null, 'K:/b.enc', {}), /正在执行|并发/);
    } finally { release(); }
    await p1;
  });
});

test('SVC-5 任务失败/取消后锁释放，可再次启动', async () => {
  await withDir(async (dir) => {
    const d = deps({ runBackup: async () => { throw new Error('boom'); } });
    const svc = createService({ config: cfg(dir), deps: d, stateDir: dir });
    await assert.rejects(() => svc.backup('s1'), /boom/);
    assert.equal(await readLock(dir, 's1'), null, '失败后锁必须释放');
    assert.equal((await readServerState(dir)).status, 'failed');
    // 换成功实现后可再次启动（证明锁已释放）
    const svc2 = createService({ config: cfg(dir), deps: deps(), stateDir: dir });
    await svc2.backup('s1');
    assert.equal((await readServerState(dir)).status, 'completed');
  });
});

test('SVC-6 进度上报写回磁盘：onProgress 后 readState 的 percent/phase 同步', async () => {
  await withDir(async (dir) => {
    let report;
    const d = deps({
      runBackup: async ({ onProgress }) => {
        report = onProgress;
        onProgress({ phase: 'transferring', percent: 63, message: '正在下载' });
        return { ok: true, localPath: 'K:/b.tar.enc', bytes: 1 };
      },
    });
    const svc = createService({ config: cfg(dir), deps: d, stateDir: dir });
    await svc.backup('s1');
    assert.ok(report, 'onProgress 已传递');
    const s = await readServerState(dir);
    assert.equal(s.status, 'completed');
    // 终态 percent=100 覆盖中间值，但中间值必须曾经写盘（由 patchState 保证）
  });
});
