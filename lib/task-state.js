/**
 * v0.1.13 — 统一任务状态源（规格 §6 / §6.1 / §6.2 / §6.3）。
 *
 * transfer-state.json 是唯一持久化状态来源；/status 以磁盘为准，
 * 不形成内存状态与持久化状态互相矛盾的双数据源。
 * 所有写入采用「写 .tmp + rename」原子落盘；旧 taskId 不得覆盖新任务。
 */
import { readFile, writeFile, rename, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';

export const STATE_FILE = 'transfer-state.json';

/**
 * v0.1.17 — 状态目录按服务器隔离：`<stateDir>/<serverId>/transfer-state.json`。
 *
 * 背景（用户裁决 §三）：旧实现全局单文件 `transfer-state.json`，两台服务器
 * 并发备份时互相覆盖同一份状态。v0.1.17 起每个 serverConfigId 独立目录。
 * `serverStateDir(root, serverId)` 返回 `root/serverId`（serverId 缺省时回退
 * 根目录本身，仅用于迁移兼容读取，不用于新任务写入）。
 */
export function serverStateDir(root, serverId) {
  if (!serverId) return root;
  // serverId 是 server-id.js 产出的 16 hex；防御性校验，非法字符一律拒绝入路径
  const id = String(serverId);
  if (!/^[0-9a-f]{16}$/.test(id)) throw new Error(`非法 serverConfigId：${id}`);
  return join(root, id);
}

/**
 * v0.1.17 兼容读取（只读迁移来源，用户裁决 §三「旧全局状态文件兼容读取」）：
 * 先读 `<root>/<serverId>/transfer-state.json`；没有时回读旧全局
 * `<root>/transfer-state.json`，且仅当其 serverConfigId 与请求者一致
 * （或旧文件无该字段，视为未归属）才有效——
 * 绝不把旧全局文件复制成所有服务器的状态。两处都没有返回 null。
 */
export async function readStateCompat(root, serverId) {
  const own = await readState(serverStateDir(root, serverId));
  if (own) return own;
  if (!serverId) return null;
  const legacy = await readState(root);
  return legacy && (legacy.serverConfigId === serverId || !legacy.serverConfigId) ? legacy : null;
}


/**
 * 按目录串行化写操作：Windows 上并发 rename 到同一目标会 EPERM，
 * 且规格 §6.3 要求「检查与写入原子化」。串行链保证同一目录内写不互相踩踏。
 */
const writeChains = new Map();
function serialize(dir, fn) {
  const prev = writeChains.get(dir) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  writeChains.set(dir, next.then(() => undefined, () => undefined));
  return next;
}

const STATUS = ['pending', 'running', 'paused', 'completed', 'failed', 'cancelled'];

/** 六态合法转换表（§6.1）。终态不得回到 running。 */
const TRANSITIONS = {
  pending: ['running', 'cancelled'],
  running: ['paused', 'completed', 'failed', 'cancelled'],
  paused: ['running', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
};

export function isValidTransition(from, to) {
  return (TRANSITIONS[from] ?? []).includes(to);
}

/** 生成全局唯一 taskId：绑定 backupId + kind + 创建信息（§6.2）。 */
export function makeTaskId(backupId, kind, createdAt) {
  return createHash('sha256')
    .update(`${backupId}\u0000${kind}\u0000${createdAt}\u0000${randomBytes(16).toString('hex')}`)
    .digest('hex');
}

export function createState({ backupId, kind = 'backup', backupDirectory, taskDir, extra = {} }) {
  const now = new Date().toISOString();
  const taskId = makeTaskId(backupId, kind, now);
  return {
    schemaVersion: 2,
    taskId,
    backupId,
    kind,
    status: 'pending',
    phase: null,
    percent: 0,
    phaseMessage: '',
    backupDirectory,
    taskDir,
    serverConfigId: extra.serverConfigId ?? null,
    remoteTarPath: extra.remoteTarPath ?? null,
    remoteWorkDir: extra.remoteWorkDir ?? null,
    totalBytes: extra.totalBytes ?? 0,
    fullSha256: extra.fullSha256 ?? null,
    chunkSize: extra.chunkSize ?? 0,
    chunkCount: extra.chunkCount ?? 0,
    chunks: extra.chunks ?? [],
    downloadedBytes: 0,
    speedBytesPerSec: 0,
    etaSeconds: null,
    remoteCleanup: { status: 'pending', attempts: 0, lastError: null },
    finalEncPath: null,
    integrity: { assembled: false, fullSha256Ok: false, encrypted: false, finalEncVerified: false },
    activeExecutor: null,
    createdAt: now,
    updatedAt: now,
    ...extra,
  };
}

/** 原子写：先写「本次唯一 .tmp」再 rename，避免并发写互相覆盖/半写 JSON（§16）。 */
export async function writeState(dir, state) {
  return serialize(dir, async () => {
    // v0.1.17：dir 可能是按服务器隔离的子目录（<stateDir>/<serverId>/），首次写入前不存在
    await mkdir(dir, { recursive: true });
    const target = join(dir, STATE_FILE);
    const tmp = `${target}.${randomBytes(8).toString('hex')}.tmp`;
    const body = JSON.stringify(state, null, 2);
    try {
      await writeFile(tmp, body, 'utf8');
      await rename(tmp, target);
    } finally {
      try { await rm(tmp, { force: true }); } catch { /* ignore */ }
    }
  });
}

/** 读取并做结构校验；损坏/半写返回 null（fail-closed，不假装状态）。 */
export async function readState(dir) {
  try {
    const text = await readFile(join(dir, STATE_FILE), 'utf8');
    const s = JSON.parse(text);
    if (!s || typeof s !== 'object') return null;
    if (!s.taskId || !s.kind || !STATUS.includes(s.status)) return null;
    if (typeof s.percent !== 'number') return null;
    return s;
  } catch {
    return null;
  }
}

/** 只更新指定字段并刷新 updatedAt；taskId 不一致时拒绝写入（防旧任务覆盖新任务，§6.2）。 */
export async function patchState(dir, taskId, patch) {
  const current = await readState(dir);
  if (!current || current.taskId !== taskId) return false;
  const next = { ...current, ...patch, taskId: current.taskId, updatedAt: new Date().toISOString() };
  await writeState(dir, next);
  return true;
}

/** completed 硬约束（§6.1）：只有后端证据齐全才允许置位，前端不得凭 100% 自称完成。 */
export function canComplete(state) {
  if (!state || state.status !== 'running') return false;
  if (state.kind === 'backup') {
    const i = state.integrity ?? {};
    return Boolean(
      i.assembled && i.fullSha256Ok && i.encrypted && i.finalEncVerified
      && state.remoteCleanup?.status === 'done',
    );
  }
  // restore：由 runRestore 状态机成功后显式置位（仍须 running 态）
  return true;
}
