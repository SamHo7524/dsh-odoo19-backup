/**
 * v0.1.13 T3 RED — 服务器级备份/恢复互斥锁（P0 数据安全约束，规格 §17.1）。
 *
 * 同一服务器同一时间只允许一个备份或恢复任务；后端原子锁为唯一裁决；
 * 锁关联 taskId/kind/status；终态释放且校验 taskId；重启遗留锁未经确认不判空闲。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const L = await import('../lib/server-lock.js');

async function withDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'v0113-lock-'));
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test('LOCK-1 空闲服务器可获取锁，记录 taskId/kind/status', async () => {
  await withDir(async (dir) => {
    const r = await L.acquireLock(dir, 'srv-1', { taskId: 't1', kind: 'backup', status: 'running' });
    assert.equal(r.ok, true);
    const lock = await L.readLock(dir, 'srv-1');
    assert.equal(lock.taskId, 't1');
    assert.equal(lock.kind, 'backup');
    assert.equal(lock.status, 'running');
  });
});

test('LOCK-2 同时两个备份请求，只有一个成功启动（原子互斥）', async () => {
  await withDir(async (dir) => {
    const [a, b] = await Promise.all([
      L.acquireLock(dir, 'srv-1', { taskId: 't1', kind: 'backup', status: 'running' }),
      L.acquireLock(dir, 'srv-1', { taskId: 't2', kind: 'backup', status: 'running' }),
    ]);
    assert.equal(a.ok + b.ok, 1, '只能有一个成功');
  });
});

test('LOCK-3 备份期间发起恢复 → 拒绝；恢复期间发起备份 → 拒绝（跨 kind）', async () => {
  await withDir(async (dir) => {
    await L.acquireLock(dir, 'srv-1', { taskId: 't1', kind: 'backup', status: 'running' });
    const restore = await L.acquireLock(dir, 'srv-1', { taskId: 't2', kind: 'restore', status: 'running' });
    assert.equal(restore.ok, false);
    assert.match(restore.reason, /备份|任务/);
    // 释放后再恢复→备份也拒绝
    await L.releaseLock(dir, 'srv-1', 't1');
    await L.acquireLock(dir, 'srv-1', { taskId: 't3', kind: 'restore', status: 'running' });
    const backup = await L.acquireLock(dir, 'srv-1', { taskId: 't4', kind: 'backup', status: 'running' });
    assert.equal(backup.ok, false);
  });
});

test('LOCK-4 任务 completed/failed/cancelled 后释放锁，且只有持有者能释放', async () => {
  await withDir(async (dir) => {
    await L.acquireLock(dir, 'srv-1', { taskId: 't1', kind: 'backup', status: 'running' });
    assert.equal((await L.releaseLock(dir, 'srv-1', 'wrong-task')).ok, false, '非持有者不得释放');
    const r = await L.releaseLock(dir, 'srv-1', 't1');
    assert.equal(r.ok, true);
    assert.equal(await L.readLock(dir, 'srv-1'), null, '释放后空闲');
    const again = await L.acquireLock(dir, 'srv-1', { taskId: 't2', kind: 'backup', status: 'running' });
    assert.equal(again.ok, true);
  });
});

test('LOCK-5 重启后遗留锁不丢失；状态非终态时未经确认不得判定空闲', async () => {
  await withDir(async (dir) => {
    await L.acquireLock(dir, 'srv-1', { taskId: 't1', kind: 'backup', status: 'running' });
    // 模拟重启：仅重新读锁（不清内存）
    const stale = await L.inspectLock(dir, 'srv-1', async () => 'running');
    assert.equal(stale.locked, true);
    assert.equal(stale.action, 'hold', '非终态保留锁定');
    const acquire = await L.acquireLock(dir, 'srv-1', { taskId: 't2', kind: 'backup', status: 'running' });
    assert.equal(acquire.ok, false, '未确认前不得启动冲突任务');
    // 显式确认（且回查终态）后才释放
    const ok = await L.confirmStaleLock(dir, 'srv-1', async () => 'completed');
    assert.equal(ok.ok, true);
    assert.equal(await L.readLock(dir, 'srv-1'), null);
  });
});

test('LOCK-6 锁文件损坏 → fail-closed：视为锁定，不判空闲', async () => {
  await withDir(async (dir) => {
    await writeFile(join(dir, 'server-lock.json'), '{ broken');
    const inspected = await L.inspectLock(dir, 'srv-1', async () => 'running');
    assert.equal(inspected.locked, true);
    assert.equal(inspected.action, 'hold');
  });
});

test('LOCK-7 不同服务器互不阻塞', async () => {
  await withDir(async (dir) => {
    const a = await L.acquireLock(dir, 'srv-1', { taskId: 't1', kind: 'backup', status: 'running' });
    const b = await L.acquireLock(dir, 'srv-2', { taskId: 't2', kind: 'restore', status: 'running' });
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
  });
});
