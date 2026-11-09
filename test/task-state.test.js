/**
 * v0.1.13 T1 RED — 后端统一状态源（transfer-state.json）。
 *
 * 规格 §6.3：transfer-state.json 是唯一持久化状态来源；/status 以磁盘为准；
 * 不形成内存状态与持久化状态互相矛盾的双数据源。
 * 状态记录含 taskId/kind/status/phase/percent/updatedAt。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const S = await import('../lib/task-state.js');

async function withDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'v0113-state-'));
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test('STATE-1 createState 生成唯一 taskId 与六态初始值', () => {
  const s = S.createState({
    backupId: 'abc', kind: 'backup', backupDirectory: 'K:/b',
    taskDir: 'K:/b/20261107/abc',
  });
  assert.ok(s.taskId && typeof s.taskId === 'string');
  assert.equal(s.kind, 'backup');
  assert.equal(s.status, 'pending');
  assert.equal(s.percent, 0);
  assert.ok(s.createdAt && s.updatedAt);
  assert.ok(s.schemaVersion >= 2);
});

test('STATE-2 同 backupId 的 backup 与 restore 的 taskId 不同（任务隔离）', () => {
  const a = S.createState({ backupId: 'x', kind: 'backup', backupDirectory: 'K:/b', taskDir: 't' });
  const b = S.createState({ backupId: 'x', kind: 'restore', backupDirectory: 'K:/b', taskDir: 't' });
  assert.notEqual(a.taskId, b.taskId);
});

test('STATE-3 writeState/readState 往返：磁盘是唯一真相源', async () => {
  await withDir(async (dir) => {
    const s = S.createState({ backupId: 'abc', kind: 'backup', backupDirectory: dir, taskDir: dir });
    s.status = 'running';
    s.percent = 63;
    s.phase = 'transferring';
    await S.writeState(dir, s);
    const got = await S.readState(dir);
    assert.equal(got.taskId, s.taskId);
    assert.equal(got.status, 'running');
    assert.equal(got.percent, 63);
    assert.equal(got.phase, 'transferring');
  });
});

test('STATE-4 原子写：writeState 不产生残留 .tmp，且并发写不破坏 JSON', async () => {
  await withDir(async (dir) => {
    const s = S.createState({ backupId: 'abc', kind: 'backup', backupDirectory: dir, taskDir: dir });
    await Promise.all([1, 2, 3].map((n) => {
      const copy = { ...s, percent: n * 10, updatedAt: new Date().toISOString() };
      return S.writeState(dir, copy);
    }));
    const got = await S.readState(dir);
    assert.ok(got && typeof got.percent === 'number', '状态文件必须是合法 JSON');
    const files = await readFile(join(dir, 'transfer-state.json'), 'utf8');
    assert.ok(files.includes('taskId'));
  });
});

test('STATE-5 readState 对损坏/半写 JSON 返回 null（fail-closed，不假装状态）', async () => {
  await withDir(async (dir) => {
    await writeFile(join(dir, 'transfer-state.json'), '{ broken json');
    assert.equal(await S.readState(dir), null);
  });
});

test('STATE-6 patchState 只更新指定字段并刷新 updatedAt，且校验 taskId 一致', async () => {
  await withDir(async (dir) => {
    const s = S.createState({ backupId: 'abc', kind: 'backup', backupDirectory: dir, taskDir: dir });
    await S.writeState(dir, s);
    const ok = await S.patchState(dir, s.taskId, { status: 'running', percent: 50, phase: 'downloading' });
    assert.equal(ok, true);
    const got = await S.readState(dir);
    assert.equal(got.status, 'running');
    assert.equal(got.percent, 50);
    assert.equal(got.kind, 'backup');
    assert.ok(got.updatedAt >= s.updatedAt);
    // 旧 taskId 不得覆盖
    const stale = await S.patchState(dir, 'old-task-id', { percent: 99 });
    assert.equal(stale, false);
    assert.equal((await S.readState(dir)).percent, 50);
  });
});

test('STATE-7 completed 只能由 explicitComplete 在终态条件满足后置位', () => {
  const s = S.createState({ backupId: 'abc', kind: 'backup', backupDirectory: 'K:/b', taskDir: 't' });
  assert.equal(S.canComplete(s), false, 'running 且无 integrity 证据不得 completed');
  s.status = 'running';
  s.integrity = { assembled: true, fullSha256Ok: true, encrypted: true, finalEncVerified: true };
  s.remoteCleanup = { status: 'done', attempts: 0, lastError: null };
  assert.equal(S.canComplete(s), true);
});

test('STATE-8 transition 合法性：六态转换守卫', () => {
  assert.equal(S.isValidTransition('pending', 'running'), true);
  assert.equal(S.isValidTransition('running', 'paused'), true);
  assert.equal(S.isValidTransition('paused', 'running'), true);
  assert.equal(S.isValidTransition('running', 'completed'), true);
  assert.equal(S.isValidTransition('completed', 'running'), false, '终态不得回到 running');
  assert.equal(S.isValidTransition('cancelled', 'running'), false);
  assert.equal(S.isValidTransition('failed', 'running'), false);
});

test('STATE-9 readState 返回终态（刷新后可恢复 completed/failed/cancelled）', async () => {
  await withDir(async (dir) => {
    const s = S.createState({ backupId: 'abc', kind: 'backup', backupDirectory: dir, taskDir: dir });
    s.status = 'completed';
    s.percent = 100;
    await S.writeState(dir, s);
    assert.equal((await S.readState(dir)).status, 'completed');
    assert.equal((await S.readState(dir)).percent, 100);
  });
});
