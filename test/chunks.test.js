/**
 * v0.1.13 T4 RED — 分片计划 / Manifest / 校验 / 组装顺序（纯函数，规格 §5 / §11 / §12）。
 */
import { test } from 'node:test';
import assert from 'node:assert';

const C = await import('../lib/chunks.js');

const MiB = 104857600; // 100 MiB（规格 3.3）

test('CHUNK-1 <100 MiB 不分片（保持原单文件路径）', () => {
  assert.equal(C.shouldChunk(50 * 1024 * 1024), false);
  assert.equal(C.shouldChunk(MiB - 1), false);
  assert.equal(C.shouldChunk(MiB), true);
});

test('CHUNK-2 >500 MB 正确分片：数量、偏移、大小、总字节精确', () => {
  const total = 563 * 1024 * 1024 + 12345; // > 500 MB
  const plan = C.planChunks(total, MiB);
  assert.equal(plan.length, 6, '563MB / 100MiB = 6 片');
  let off = 0;
  for (let i = 0; i < plan.length; i++) {
    assert.equal(plan[i].index, i + 1);
    assert.equal(plan[i].offset, off);
    assert.ok(plan[i].size > 0 && plan[i].size <= MiB);
    off += plan[i].size;
  }
  assert.equal(off, total, '所有片大小之和 == 总字节');
  assert.equal(plan[plan.length - 1].size, total - (plan.length - 1) * MiB);
});

test('CHUNK-3 恰好 100 MiB → 1 片；恰好 2×100 MiB → 2 片', () => {
  assert.equal(C.planChunks(MiB, MiB).length, 1);
  assert.equal(C.planChunks(2 * MiB, MiB).length, 2);
});

test('CHUNK-4 buildManifest 绑定 backupId 且字段完整', () => {
  const plan = C.planChunks(2 * MiB + 10, MiB);
  const m = C.buildManifest({
    backupId: 'bid-1', createdAt: '2026-11-09T00:00:00Z',
    serverConfigId: 'srv', remoteTarPath: '/tmp/a.tar', remoteWorkDir: '/tmp/a',
    fileName: 'a.tar', totalBytes: 2 * MiB + 10, fullSha256: 'a'.repeat(64),
    chunkSize: MiB, chunks: plan.map((p) => ({ ...p, sha256: 'b'.repeat(64) })),
  });
  assert.equal(m.schemaVersion, 1);
  assert.equal(m.backupId, 'bid-1');
  assert.equal(m.chunkCount, 3);
  assert.equal(m.chunks.length, 3);
  assert.equal(m.totalBytes, 2 * MiB + 10);
});

test('CHUNK-5 validateManifest 拒绝结构错误（片数/序号/偏移/哈希格式）', () => {
  const plan = C.planChunks(2 * MiB, MiB).map((p) => ({ ...p, sha256: 'c'.repeat(64) }));
  const base = C.buildManifest({
    backupId: 'bid', createdAt: 'x', serverConfigId: 's', remoteTarPath: '/t',
    remoteWorkDir: '/w', fileName: 'f', totalBytes: 2 * MiB,
    fullSha256: 'd'.repeat(64), chunkSize: MiB, chunks: plan,
  });
  assert.equal(C.validateManifest(base).ok, true);
  assert.equal(C.validateManifest({ ...base, chunkCount: 9 }).ok, false);
  assert.equal(C.validateManifest({ ...base, chunks: [plan[1], plan[0]] }).ok, false, '顺序错');
  assert.equal(C.validateManifest({ ...base, chunks: [{ ...plan[0], sha256: 'bad' }, plan[1]] }).ok, false);
});

test('CHUNK-6 verifyChunk 按 SHA-256 与大小校验', () => {
  const buf = Buffer.from('hello');
  const sha = C.sha256Hex(buf);
  assert.equal(C.verifyChunk(buf, 5, sha).ok, true);
  assert.equal(C.verifyChunk(buf, 4, sha).ok, false, '大小不符');
  assert.equal(C.verifyChunk(Buffer.from('hellp'), 5, sha).ok, false, '哈希不符');
});

test('CHUNK-7 assembleOrder 拒绝重复/缺失/乱序，返回按 index 升序', () => {
  const parts = [
    { index: 2, sha256: 'b'.repeat(64) },
    { index: 1, sha256: 'a'.repeat(64) },
    { index: 3, sha256: 'c'.repeat(64) },
  ];
  const r = C.assembleOrder(parts, 3);
  assert.equal(r.ok, true);
  assert.deepEqual(r.order.map((p) => p.index), [1, 2, 3]);
  assert.equal(C.assembleOrder([parts[0], parts[0], parts[2]], 3).ok, false, '重复');
  assert.equal(C.assembleOrder([parts[0], parts[1]], 3).ok, false, '缺失');
});

test('CHUNK-8 checkFullIntegrity：总大小与全量 SHA 全通过才允许', () => {
  const buf = Buffer.from('full content');
  const sha = C.sha256Hex(buf);
  assert.equal(C.checkFullIntegrity(buf, buf.length, sha).ok, true);
  assert.equal(C.checkFullIntegrity(buf, buf.length + 1, sha).ok, false);
  assert.equal(C.checkFullIntegrity(buf, buf.length, 'e'.repeat(64)).ok, false);
});

test('CHUNK-9 Manifest 与 backupId 不匹配 → 拒绝组装（规格测试 7）', () => {
  const plan = C.planChunks(MiB, MiB).map((p) => ({ ...p, sha256: 'f'.repeat(64) }));
  const m = C.buildManifest({
    backupId: 'bid-A', createdAt: 'x', serverConfigId: 's', remoteTarPath: '/t',
    remoteWorkDir: '/w', fileName: 'f', totalBytes: MiB,
    fullSha256: 'a'.repeat(64), chunkSize: MiB, chunks: plan,
  });
  assert.equal(C.validateManifest(m, 'bid-B').ok, false, '绑定 backupId 不符');
  assert.equal(C.validateManifest(m, 'bid-A').ok, true);
});
