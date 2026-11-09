/**
 * v0.1.13 — 重启后分片续传计划（规格 §3.5 / §10）。
 * 扫描 <backupDirectory>/<YYYYMMDD>/<backupId>/manifest.json，找到结构有效
 * 且至少有一片已落盘的任务，供 runBackup 跳过「远端打包 + 切片」直接续传。
 * SHA-256 只保证完整性，不证明 Manifest 来源真实性。
 */
import { readdir, readFile, stat, access } from 'node:fs/promises';
import { join } from 'node:path';
import { validateManifest } from './chunks.js';

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

export async function findResumableBackup(backupDirectory) {
  if (!backupDirectory) return null;
  let days;
  try { days = await readdir(backupDirectory, { withFileTypes: true }); }
  catch { return null; }
  for (const day of days) {
    if (!day.isDirectory() || !/^\d{8}$/.test(day.name)) continue;
    const dayDir = join(backupDirectory, day.name);
    let tasks;
    try { tasks = await readdir(dayDir, { withFileTypes: true }); } catch { continue; }
    for (const task of tasks) {
      if (!task.isDirectory()) continue;
      const taskDir = join(dayDir, task.name);
      // 已完成任务（有 completed.json）不再续传，避免下次备份永远复用旧分片
      if (await exists(join(taskDir, 'completed.json'))) continue;
      let manifest;
      try { manifest = JSON.parse(await readFile(join(taskDir, 'manifest.json'), 'utf8')); }
      catch { continue; }
      if (!validateManifest(manifest).ok) continue;
      // 至少有一个已校验分片才算「值得续传」，避免误把空任务当续传目标
      let hasPart = false;
      for (const c of manifest.chunks) {
        try {
          const p = join(taskDir, `part${String(c.index).padStart(3, '0')}`);
          if ((await stat(p)).size === c.size) { hasPart = true; break; }
        } catch { /* ignore */ }
      }
      if (hasPart) return { taskDir, manifest, backupId: manifest.backupId };
    }
  }
  return null;
}
