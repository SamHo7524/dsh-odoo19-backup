/**
 * v0.1.13 — 分片计划 / Manifest / 校验（纯函数，规格 §3.3 / §5 / §11 / §12）。
 * 无 I/O，便于全单测。SHA-256 只验证数据完整性，不证明 Manifest 来源真实性。
 */
import { createHash } from 'node:crypto';

export const DEFAULT_CHUNK_SIZE = 100 * 1024 * 1024; // 100 MiB（规格 3.3）
export const CHUNK_THRESHOLD = 100 * 1024 * 1024;   // ≥100 MiB 才分片

export function shouldChunk(totalBytes, threshold = CHUNK_THRESHOLD) {
  return Number(totalBytes) >= threshold;
}

/** 按固定片大小切分；返回 [{index, offset, size}]，总大小精确等于 totalBytes。 */
export function planChunks(totalBytes, chunkSize = DEFAULT_CHUNK_SIZE) {
  const total = Number(totalBytes);
  if (!Number.isFinite(total) || total <= 0) return [];
  const out = [];
  let offset = 0;
  let index = 1;
  while (offset < total) {
    const size = Math.min(chunkSize, total - offset);
    out.push({ index, offset, size });
    offset += size;
    index += 1;
  }
  return out;
}

export function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/** Manifest 由 Host 根据现有 SSH 信任通道获取的信息生成（§5.1，不是来源认证）。 */
export function buildManifest({
  backupId, createdAt, serverConfigId, remoteTarPath, remoteWorkDir,
  fileName, totalBytes, fullSha256, chunkSize = DEFAULT_CHUNK_SIZE, chunks,
}) {
  const list = (chunks ?? []).map((c) => ({
    index: c.index,
    offset: c.offset,
    size: c.size,
    sha256: c.sha256,
    remotePart: c.remotePart ?? `${remoteTarPath}.part${String(c.index).padStart(3, '0')}`,
  }));
  return {
    schemaVersion: 1,
    backupId,
    createdAt,
    serverConfigId,
    remoteTarPath,
    remoteWorkDir,
    fileName,
    totalBytes,
    fullSha256,
    chunkSize,
    chunkCount: list.length,
    chunks: list,
    source: 'host-generated-over-existing-ssh-trust',
  };
}

const HEX64 = /^[0-9a-f]{64}$/i;

/** 结构及一致性校验；expectedBackupId 存在时校验绑定（规格测试 7）。 */
export function validateManifest(m, expectedBackupId) {
  if (!m || typeof m !== 'object') return { ok: false, reason: 'Manifest 非对象' };
  if (m.schemaVersion !== 1) return { ok: false, reason: 'schemaVersion 不符' };
  if (typeof m.backupId !== 'string' || !m.backupId) return { ok: false, reason: '缺 backupId' };
  if (expectedBackupId && m.backupId !== expectedBackupId) {
    return { ok: false, reason: 'Manifest 与 backupId 不匹配，拒绝组装' };
  }
  if (!Number.isFinite(m.totalBytes) || m.totalBytes <= 0) return { ok: false, reason: '总大小非法' };
  if (!HEX64.test(String(m.fullSha256 ?? ''))) return { ok: false, reason: '全量 SHA 格式非法' };
  if (!Array.isArray(m.chunks) || m.chunks.length === 0) return { ok: false, reason: '无分片' };
  if (m.chunkCount !== m.chunks.length) return { ok: false, reason: '分片数量不符' };
  let offset = 0;
  for (let i = 0; i < m.chunks.length; i++) {
    const c = m.chunks[i];
    if (!c || c.index !== i + 1) return { ok: false, reason: `分片序号错误（期望 ${i + 1}）` };
    if (c.offset !== offset) return { ok: false, reason: `分片偏移错误（第 ${i + 1} 片）` };
    if (!Number.isFinite(c.size) || c.size <= 0) return { ok: false, reason: '分片大小非法' };
    if (!HEX64.test(String(c.sha256 ?? ''))) return { ok: false, reason: '分片 SHA 格式非法' };
    offset += c.size;
  }
  if (offset !== m.totalBytes) return { ok: false, reason: '分片总字节与总大小不符' };
  return { ok: true };
}

/** 单片校验：大小 + SHA-256 全部通过才 ok（§11.1）。 */
export function verifyChunk(buffer, expectedSize, expectedSha256) {
  if (!Buffer.isBuffer(buffer) || buffer.length !== expectedSize) {
    return { ok: false, reason: '分片大小不符' };
  }
  if (sha256Hex(buffer) !== String(expectedSha256).toLowerCase()) {
    return { ok: false, reason: '分片 SHA-256 不符' };
  }
  return { ok: true };
}

/** 组装前顺序校验：必须序号连续、无重复无缺失（规格测试 8）。 */
export function assembleOrder(parts, chunkCount) {
  if (!Array.isArray(parts) || parts.length !== chunkCount) {
    return { ok: false, reason: '分片数量不足或过多' };
  }
  const seen = new Set();
  for (const p of parts) {
    if (!p || !Number.isInteger(p.index) || seen.has(p.index)) {
      return { ok: false, reason: '分片重复或序号非法' };
    }
    seen.add(p.index);
  }
  const order = [...parts].sort((a, b) => a.index - b.index);
  for (let i = 0; i < order.length; i++) {
    if (order[i].index !== i + 1) return { ok: false, reason: '分片顺序错误，拒绝组装' };
  }
  return { ok: true, order };
}

/** 完整文件校验：总大小 + 全量 SHA-256（规格测试 9）。 */
export function checkFullIntegrity(buffer, expectedBytes, expectedSha256) {
  if (!Buffer.isBuffer(buffer) || buffer.length !== expectedBytes) {
    return { ok: false, reason: '完整文件大小不符' };
  }
  if (sha256Hex(buffer) !== String(expectedSha256).toLowerCase()) {
    return { ok: false, reason: '完整文件 SHA-256 不一致，禁止恢复' };
  }
  return { ok: true };
}
