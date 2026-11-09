/**
 * v0.1.13 — 分片下载 / 断点续传 / 组装（规格 §3.4 / §3.5 / §9 / §11 / §12 / §16）。
 *
 * 真实 scp 通过 buildScpArgs 构造参数（别名/显式 host 均适用，安全行为不变）；
 * 调度逻辑可注入 scp 便于单测。SHA-256 只保证完整性，不证明 Manifest 来源真实性。
 */
import { open, readFile, writeFile, rename, rm, stat, statfs } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { buildScpArgs } from './ssh.js';
import { validateManifest, verifyChunk, assembleOrder, checkFullIntegrity, sha256Hex } from './chunks.js';

const partName = (i) => `part${String(i).padStart(3, '0')}`;
const tmpName = (i) => `${partName(i)}.tmp`;

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; }
}

async function writeJsonAtomic(path, value) {
  const tmp = `${path}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
    await rename(tmp, path);
  } finally { try { await rm(tmp, { force: true }); } catch { /* ignore */ } }
}

/** 默认空间检查：目标目录所在卷可用字节（§16 磁盘空间不足安全失败）。 */
export async function defaultFreeBytes(dir) {
  try {
    const s = await statfs(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch { return Number.POSITIVE_INFINITY; }
}

/** 真实 scp 下载一片（复用 buildScpArgs，绝不手写 user@host）。 */
export async function realScp({ server, remotePath, localPath, onSpawn }) {
  const args = buildScpArgs(server, { direction: 'download', remotePath, localPath });
  return new Promise((resolve, reject) => {
    const child = spawn('scp', args, { windowsHide: true });
    let err = '';
    child.stderr?.on('data', (c) => { if (err.length < 65536) err += c.toString('utf8'); });
    onSpawn?.(child);
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ ok: true });
      else reject(new Error(`scp 分片失败（退出码 ${code}）：${err.slice(-300)}`));
    });
  });
}

/** 重验一片：存在 + 大小 + SHA + 属于当前 backupId（§3.5）。禁止只凭 completed 标记跳过。 */
export async function verifyPart(dir, manifest, index) {
  const c = manifest.chunks[index - 1];
  if (!c) return false;
  const p = join(dir, partName(index));
  try {
    const st = await stat(p);
    if (st.size !== c.size) return false;
    const buf = await readFile(p);
    return verifyChunk(buf, c.size, c.sha256).ok;
  } catch { return false; }
}

function initialState(manifest) {
  return {
    schemaVersion: 2,
    backupId: manifest.backupId,
    kind: 'backup',
    status: 'running',
    phase: 'transferring',
    percent: 0,
    chunks: manifest.chunks.map((c) => ({ index: c.index, status: 'pending', bytes: 0, attempts: 0, lastError: null })),
    downloadedBytes: 0,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * 下载（或续传）所有分片。resume=true 时逐片重新 stat+SHA 重验，只重下缺失/损坏片。
 * 返回 { ok, reason?, state }；有失败片绝不标记完成。
 *
 * v0.1.13 统一状态源（§6.3，最小调整，记录原因）：本模块**只把状态返回给调用方**，
 * 不自行写 transfer-state.json（避免根目录状态与任务目录状态两套持久化互相矛盾）；
 * 由 service.runGuarded 的 progressReporter 统一 patch 到唯一状态文件。
 */
export async function downloadAll({ dir, manifest, scp, resume = false, freeBytes = defaultFreeBytes, onSpawn, onProgress }) {
  const valid = validateManifest(manifest);
  if (!valid.ok) return { ok: false, reason: valid.reason };
  // 磁盘空间预检：分片 + 组装 + 加密峰值 ≈ 2×总大小
  const need = manifest.totalBytes * 2 + 16 * 1024 * 1024;
  const free = await freeBytes(dir);
  if (Number.isFinite(free) && free < need) {
    return { ok: false, reason: `磁盘空间不足（需约 ${need} 字节，可用 ${free} 字节），安全失败` };
  }

  // 统一状态源：状态只在内存累积并返回；磁盘状态由 service 统一写。
  // resume 时逐片按「实际文件存在 + 大小 + SHA」重验，不依赖任何完成标记。
  let state = initialState(manifest);
  state.status = 'running';
  state.phase = 'transferring';

  for (const c of manifest.chunks) {
    const done = await verifyPart(dir, manifest, c.index);
    if (done) {
      state.chunks[c.index - 1] = { index: c.index, status: 'verified', bytes: c.size, attempts: 0, lastError: null };
      continue;
    }

    const tmp = join(dir, tmpName(c.index));
    const finalPath = join(dir, partName(c.index));
    state.chunks[c.index - 1] = { index: c.index, status: 'downloading', attempts: 1, bytes: 0, lastError: null };
    try {
      await rm(tmp, { force: true });
      const r = await scp({ remotePath: c.remotePart, localPath: tmp, server: manifest.__server, onSpawn });
      if (r && r.ok === false) throw new Error('分片传输中断');
      const buf = await readFile(tmp);
      const v = verifyChunk(buf, c.size, c.sha256);
      if (!v.ok) { await rm(tmp, { force: true }); throw new Error(v.reason); }
      await rename(tmp, finalPath); // 校验通过才原子落正式片
      state.chunks[c.index - 1] = { index: c.index, status: 'verified', bytes: c.size, attempts: state.chunks[c.index - 1].attempts, lastError: null };
    } catch (e) {
      await rm(tmp, { force: true });
      state.chunks[c.index - 1] = { index: c.index, status: 'failed', bytes: 0, attempts: state.chunks[c.index - 1].attempts, lastError: String(e?.message ?? e) };
    }
    state.downloadedBytes = state.chunks.reduce((n, x) => n + (x.bytes || 0), 0);
    state.percent = Math.round((state.downloadedBytes / manifest.totalBytes) * 100);
    state.updatedAt = new Date().toISOString();
    onProgress?.(state); // 由 service.progressReporter 写回唯一磁盘状态
  }

  const failed = state.chunks.filter((x) => x.status !== 'verified');
  if (failed.length) {
    state.status = 'failed';
    return { ok: false, reason: `${failed.length} 个分片未完成或校验失败，未标记完成`, state };
  }
  state.status = 'downloaded';
  return { ok: true, state };
}

/** 组装：顺序校验 + 全量大小/SHA 校验；任一失败拒绝产出可恢复包（§11 / §12）。 */
export async function assemble({ dir, manifest, expectedBackupId }) {
  const v = validateManifest(manifest, expectedBackupId ?? manifest.backupId);
  if (!v.ok) return { ok: false, reason: v.reason };
  const parts = manifest.chunks.map((c) => ({ index: c.index, sha256: c.sha256 }));
  const order = assembleOrder(parts, manifest.chunkCount);
  if (!order.ok) return { ok: false, reason: order.reason };

  const out = join(dir, 'assembled.tar.tmp');
  const fh = await open(out, 'w');
  try {
    for (const p of order.order) {
      const c = manifest.chunks[p.index - 1];
      const buf = await readFile(join(dir, partName(p.index)));
      if (!verifyChunk(buf, c.size, c.sha256).ok) {
        await fh.close();
        await rm(out, { force: true });
        return { ok: false, reason: `第 ${p.index} 片校验失败，拒绝组装` };
      }
      await fh.write(buf);
    }
  } finally { try { await fh.close(); } catch { /* ignore */ } }

  const full = await readFile(out);
  const integrity = checkFullIntegrity(full, manifest.totalBytes, manifest.fullSha256);
  if (!integrity.ok) {
    await rm(out, { force: true });
    return { ok: false, reason: `${integrity.reason}；禁止恢复` };
  }
  const finalPath = join(dir, manifest.fileName ?? 'odoo-backup.tar');
  await rename(out, finalPath);
  return { ok: true, path: finalPath };
}

/** 远端切片脚本（stdin 传固定路径，不拼 shell 字符串；§8）。 */
export function remoteSplitScript() {
  return [
    'read -r SRC; read -r CS;',
    'n=1; off=0; total=$(stat -c %s "$SRC");',
    'while [ "$off" -lt "$total" ]; do',
    '  size=$CS; [ $((off + size)) -gt "$total" ] && size=$((total - off));',
    '  dd if="$SRC" of="$SRC.part$(printf %03d $n)" bs=1 skip="$off" count="$size" status=none || exit 91;',
    '  sha256sum "$SRC.part$(printf %03d $n)" | awk \'{print $1}\';',
    '  off=$((off + size)); n=$((n + 1));',
    'done; echo "===SPLIT_END==="',
  ].join(' ');
}
