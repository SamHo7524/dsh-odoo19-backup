/**
 * v0.1.14 — 从 completed.json 解析「最终加密备份包」权威路径（只读，不写盘）。
 * 只有后端已确认成功、产物存在且为加密格式时才允许回填恢复输入框。
 */
import { readdir, readFile, stat as fsStat } from 'node:fs/promises';
import { join } from 'node:path';
import { detectFormat as realDetectFormat } from './crypto.js';
import { normalizeRestorePath } from './restore-path.js';

const ENCRYPTED = new Set(['dsh-odoo', 'age', 'openssl']);

export async function resolveLastBackup(backupDirectory, deps = {}) {
  const readdirFn = deps.readdir ?? readdir;
  const readFileFn = deps.readFile ?? readFile;
  const statFn = deps.stat ?? fsStat;
  const detectFormat = deps.detectFormat ?? realDetectFormat;
  const root = String(backupDirectory ?? '').trim();
  if (!root) return { ok: false, reason: '备份目录为空' };

  let days;
  try { days = await readdirFn(root, { withFileTypes: true }); }
  catch { return { ok: false, reason: '备份目录不可读' }; }

  const candidates = [];
  for (const day of days) {
    if (!day.isDirectory() || !/^\d{8}$/.test(day.name)) continue;
    const dayDir = join(root, day.name);
    let tasks;
    try { tasks = await readdirFn(dayDir, { withFileTypes: true }); } catch { continue; }
    for (const task of tasks) {
      if (!task.isDirectory()) continue;
      const cp = join(dayDir, task.name, 'completed.json');
      let doc;
      try { doc = JSON.parse(await readFileFn(cp, 'utf8')); } catch { continue; }
      if (!doc || doc.completed !== true) continue;
      candidates.push({ localPath: doc.localPath, finishedAt: String(doc.finishedAt ?? '') });
    }
  }
  if (!candidates.length) return { ok: false, reason: '无已完成备份记录' };
  candidates.sort((a, b) => b.finishedAt.localeCompare(a.finishedAt));

  for (const c of candidates) {
    if (typeof c.localPath !== 'string' || !c.localPath.trim()) continue;
    const p = normalizeRestorePath(c.localPath);
    if (!/\.tar\.enc$/i.test(p)) continue;              // 拒绝分片目录中的明文 .tar
    let st;
    try { st = await statFn(p); } catch { continue; }
    if (!st || typeof st.isFile !== 'function' || !st.isFile() || !(st.size > 0)) continue;
    let fmt;
    try { fmt = await detectFormat(p); } catch { continue; }
    if (!ENCRYPTED.has(fmt)) continue;                  // 格式验证：必须加密
    return { ok: true, localPath: p };
  }
  return { ok: false, reason: '最终加密产物不存在或格式校验未通过' };
}
