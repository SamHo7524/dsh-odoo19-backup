/**
 * v0.1.13 — backupDirectory 配置与目录验证（规格 §3.1 / §3.3 / §15）。
 * 目录不可用 → fail-closed，绝不静默回退其他路径。
 */
import { mkdir, stat, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

export const DEFAULT_BACKUP_DIRECTORY = 'K:/Backup/odoo';

/** backupDirectory 为唯一权威；localBackupDir 仅兼容读取（§3.1）。 */
export function resolveBackupDirectory(config = {}) {
  return config.backupDirectory || config.localBackupDir || DEFAULT_BACKUP_DIRECTORY;
}

/** 修改目录只影响新建任务；旧任务恢复用任务记录中的目录（§3.3 第 3/4 条）。 */
export function directoryForTask(task, currentDirectory) {
  if (task && typeof task.backupDirectory === 'string' && task.backupDirectory) {
    return task.backupDirectory;
  }
  return currentDirectory;
}

/**
 * 验证目录：不存在时按规则创建；真实探测写验证可写；探测文件必清理。
 * 任何失败返回 { ok:false, reason }，不回退默认路径。
 */
export async function validateDirectory(path, { create = true } = {}) {
  const target = String(path ?? '').trim();
  if (!target) return { ok: false, path: target, reason: '目录路径为空', exists: false, writable: false, created: false };
  let exists = false;
  let created = false;
  try {
    const st = await stat(target);
    if (!st.isDirectory()) {
      return { ok: false, path: target, reason: '路径存在但不是目录', exists: true, writable: false, created: false };
    }
    exists = true;
  } catch (e) {
    if (e?.code !== 'ENOENT') {
      return { ok: false, path: target, reason: `目录不可访问：${e?.message ?? e}`, exists: false, writable: false, created: false };
    }
    if (!create) {
      return { ok: false, path: target, reason: '目录不存在且未允许创建', exists: false, writable: false, created: false };
    }
    try {
      await mkdir(target, { recursive: true });
      created = true;
      exists = true;
    } catch (mkErr) {
      return { ok: false, path: target, reason: `目录创建失败：${mkErr?.message ?? mkErr}`, exists: false, writable: false, created: false };
    }
  }

  // 真实探测写（不只看字符串），随后清理
  const probe = join(target, `.dsh-odoo-write-probe-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  try {
    await writeFile(probe, 'ok', 'utf8');
    await stat(probe);
  } catch (e) {
    return { ok: false, path: target, reason: `目录不可写：${e?.message ?? e}`, exists, writable: false, created };
  } finally {
    try { await rm(probe, { force: true }); } catch { /* ignore */ }
  }
  return { ok: true, path: target, exists, writable: true, created, reason: null };
}
