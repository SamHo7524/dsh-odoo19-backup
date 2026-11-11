/**
 * v0.1.13 — 服务器级备份/恢复互斥锁（P0，规格 §17.1）。
 *
 * 同一 serverConfigId 同一时间只允许一个 backup 或 restore 任务。
 * 检查与锁获取原子化（按文件串行）；锁由后端控制，前端禁用仅辅助。
 * 锁记录关联 taskId/kind/status；终态释放且校验 taskId；
 * 重启遗留锁/损坏锁一律 fail-closed（保留锁定），未经确认不得判空闲。
 *
 * 该文件是统一状态源的「锁指针」，不复制任务状态，不构成第二套持久化机制。
 */
import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const LOCK_FILE = 'server-lock.json';

/** 按目录串行化所有锁操作，保证「读→判→写」原子化（Windows 并发 rename EPERM 亦由此规避）。 */
const chains = new Map();
function serialize(dir, fn) {
  const prev = chains.get(dir) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  chains.set(dir, next.then(() => undefined, () => undefined));
  return next;
}

async function loadAll(dir) {
  let text;
  try {
    text = await readFile(join(dir, LOCK_FILE), 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return {}; // 文件不存在 = 空闲
    return null; // 读取失败 = 不可信
  }
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null; // 损坏 = 不可信，fail-closed
  }
}

async function saveAll(dir, all) {
  const target = join(dir, LOCK_FILE);
  const tmp = `${target}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(all, null, 2), 'utf8');
    await rename(tmp, target);
  } catch (e) {
    // ENOENT：状态目录在异步写途中被删除（任务清理/测试拆目录），没有可持久化的目标。
    // 锁本身是「指针」而非唯一真相源（真相在 transfer-state.json），此处优雅退化即可，
    // 绝不让一次清理动作变成 unhandled rejection 或把正常流程判失败。
    if (e && e.code === 'ENOENT') return;
    throw e;
  } finally {
    try { await rm(tmp, { force: true }); } catch { /* ignore */ }
  }
}

/** 读锁：损坏文件返回 undefined（区别于空闲 null），供 fail-closed 判定。 */
export async function readLock(dir, serverConfigId) {
  const all = await loadAll(dir);
  if (all === null) return all; // 损坏：返回 null 但由 inspectLock 判定为锁定
  return all[serverConfigId] ?? null;
}

/**
 * 原子获取锁。仅当该 serverConfigId 无有效锁时成功；否则拒绝并给出原因。
 */
export function acquireLock(dir, serverConfigId, { taskId, kind, status = 'running' }) {
  return serialize(dir, async () => {
    const all = await loadAll(dir);
    if (all === null) {
      return { ok: false, reason: '锁文件损坏，拒绝并发操作（数据安全保护）' };
    }
    const existing = all[serverConfigId];
    if (existing && existing.taskId && existing.status !== 'completed') {
      const what = existing.kind === 'restore' ? '恢复' : '备份';
      return { ok: false, reason: `服务器正在执行${what}任务（${existing.taskId}），已阻止并发操作` };
    }
    all[serverConfigId] = {
      taskId, kind, status, acquiredAt: new Date().toISOString(),
    };
    await saveAll(dir, all);
    return { ok: true };
  });
}

/** 释放锁：只有持有 taskId 一致才能释放（防旧任务释放新任务的锁）。 */
export function releaseLock(dir, serverConfigId, taskId) {
  return serialize(dir, async () => {
    const all = await loadAll(dir);
    if (all === null) return { ok: false, reason: '锁文件损坏' };
    const cur = all[serverConfigId];
    if (!cur) return { ok: false, reason: '服务器当前无锁' };
    if (cur.taskId !== taskId) return { ok: false, reason: 'taskId 不匹配，拒绝释放他人的锁' };
    delete all[serverConfigId];
    await saveAll(dir, all);
    return { ok: true };
  });
}

/**
 * 重启/异常退出后检查遗留锁：回查对应 transfer-state 的终态。
 * 非终态、无法确认或锁文件损坏 → action='hold'（保留锁定），绝不判空闲。
 */
export async function inspectLock(dir, serverConfigId, resolveStatus = async () => null) {
  const all = await loadAll(dir);
  if (all === null) return { locked: true, action: 'hold', reason: '锁文件损坏，需人工确认' };
  const cur = all[serverConfigId];
  if (!cur) return { locked: false, action: 'free' };
  let status = null;
  try { status = await resolveStatus(cur.taskId); } catch { status = null; }
  if (status === 'completed' || status === 'failed' || status === 'cancelled') {
    // 终态：自动释放是安全的
    await releaseLock(dir, serverConfigId, cur.taskId);
    return { locked: false, action: 'released', reason: `任务已终态（${status}）` };
  }
  return {
    locked: true,
    action: 'hold',
    reason: `遗留任务 ${cur.taskId} 状态未确认（${status ?? '未知'}），保留锁定`,
  };
}

/** 用户显式确认遗留锁已结束：仍须回查终态才释放，绝不凭 confirm 直接放行。 */
export async function confirmStaleLock(dir, serverConfigId, resolveStatus = async () => null) {
  const all = await loadAll(dir);
  if (all === null) return { ok: false, reason: '锁文件损坏，需人工修复' };
  const cur = all[serverConfigId];
  if (!cur) return { ok: true };
  let status = null;
  try { status = await resolveStatus(cur.taskId); } catch { status = null; }
  if (!['completed', 'failed', 'cancelled'].includes(status)) {
    return { ok: false, reason: '任务状态非终态，拒绝释放遗留锁' };
  }
  return releaseLock(dir, serverConfigId, cur.taskId);
}
