/**
 * v0.1.13 T4 RED — 分片传输 / 断点续传 / 组装（规格 §3.4 / §3.5 / §11 / §12 / §16）。
 * 注入 fake scp / execRemote，测试真实调度逻辑（不触达真实远端）。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CT = await import('../lib/chunk-transfer.js');
const C = await import('../lib/chunks.js');

const MiB = 104857600;

async function withDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'v0113-ct-'));
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

/** 构造一个 2 片 + 尾片的 manifest，fake 远端数据按片返回。 */
function fixture(total = 2 * MiB + 12345) {
  const plan = C.planChunks(total, MiB);
  const data = Buffer.alloc(total, 0x41);
  const chunks = plan.map((p) => ({
    ...p,
    sha256: C.sha256Hex(data.subarray(p.offset, p.offset + p.size)),
    remotePart: `/tmp/a.tar.part${String(p.index).padStart(3, '0')}`,
  }));
  const manifest = C.buildManifest({
    backupId: 'bid-1', createdAt: '2026-11-09T00:00:00Z',
    serverConfigId: 'srv', remoteTarPath: '/tmp/a.tar', remoteWorkDir: '/tmp/w',
    fileName: 'a.tar', totalBytes: total, fullSha256: C.sha256Hex(data),
    chunkSize: MiB, chunks,
  });
  return { manifest, data, plan };
}

function fakeScp({ data, manifest, failIndex = null, interruptAt = null } = {}) {
  const calls = [];
  const scp = async ({ localPath, remotePath }) => {
    calls.push({ localPath, remotePath });
    const part = manifest.chunks.find((c) => c.remotePart === remotePath);
    if (!part) throw new Error(`未知分片 ${remotePath}`);
    if (failIndex === part.index) throw new Error(`模拟单片中断 ${part.index}`);
    const buf = data.subarray(part.offset, part.offset + part.size);
    if (interruptAt !== null && part.index === interruptAt) {
      // 模拟中断：只写一半，不 rename
      await writeFile(localPath, buf.subarray(0, Math.floor(buf.length / 2)));
      return { ok: false, interrupted: true };
    }
    await writeFile(localPath, buf);
    return { ok: true };
  };
  return { scp, calls };
}

test('CT-1 正常下载所有分片：tmp→校验→rename 为正式片，返回完整 state（持久化由 service 统一负责）', async () => {
  await withDir(async (dir) => {
    const { manifest, data } = fixture();
    await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest));
    const f = fakeScp({ data, manifest });
    const r = await CT.downloadAll({ dir, manifest, scp: f.scp });
    assert.equal(r.ok, true);
    assert.equal(f.calls.length, manifest.chunkCount);
    for (const c of manifest.chunks) {
      const p = join(dir, `part${String(c.index).padStart(3, '0')}`);
      assert.equal((await stat(p)).size, c.size, `第 ${c.index} 片应落盘`);
    }
    // 统一状态源：状态随结果返回，由 service.progressReporter 写入唯一磁盘文件
    assert.equal(r.state.chunks.every((c) => c.status === 'verified'), true);
    assert.equal(r.state.backupId, manifest.backupId);
  });
});

test('CT-2 单片中断后可重试，tmp 不当有效片', async () => {
  await withDir(async (dir) => {
    const { manifest, data } = fixture();
    await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest));
    const f1 = fakeScp({ data, manifest, failIndex: 2 });
    const r1 = await CT.downloadAll({ dir, manifest, scp: f1.scp });
    assert.equal(r1.ok, false, '有失败片时不得标记完成');
    assert.equal(r1.state.chunks[1].status, 'failed');
    // 重试：只重下失败片
    const f2 = fakeScp({ data, manifest });
    const r2 = await CT.downloadAll({ dir, manifest, scp: f2.scp, resume: true });
    assert.equal(r2.ok, true);
    assert.equal(f2.calls.length, 1, '只重新下载失败的那一片');
  });
});

test('CT-3 多片完成后「重启」只下载缺失片（重新 stat+SHA 重验）', async () => {
  await withDir(async (dir) => {
    const { manifest, data } = fixture();
    await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest));
    const f1 = fakeScp({ data, manifest, interruptAt: 3 });
    await CT.downloadAll({ dir, manifest, scp: f1.scp });
    // 模拟重启：重新加载状态并重验，第 3 片只有半截 tmp，第 1/2 片已校验
    const f2 = fakeScp({ data, manifest });
    const r = await CT.downloadAll({ dir, manifest, scp: f2.scp, resume: true });
    assert.equal(r.ok, true);
    assert.equal(f2.calls.length, 1, '只下载第 3 片（缺失/未完成）');
  });
});

test('CT-4 已完成分片被篡改 → 重新下载', async () => {
  await withDir(async (dir) => {
    const { manifest, data } = fixture();
    await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest));
    await CT.downloadAll({ dir, manifest, scp: fakeScp({ data, manifest }).scp });
    // 篡改第 2 片
    await writeFile(join(dir, 'part002'), Buffer.from('TAMPERED'));
    const f = fakeScp({ data, manifest });
    const r = await CT.downloadAll({ dir, manifest, scp: f.scp, resume: true });
    assert.equal(r.ok, true);
    assert.equal(f.calls.length, 1, '篡改片必须重新下载');
    assert.equal(f.calls[0].remotePath, manifest.chunks[1].remotePart);
  });
});

test('CT-5 Manifest 与 backupId 不匹配 → 拒绝组装', async () => {
  await withDir(async (dir) => {
    const { manifest, data } = fixture();
    await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest));
    await CT.downloadAll({ dir, manifest, scp: fakeScp({ data, manifest }).scp });
    const bad = { ...manifest, backupId: 'other' };
    const r = await CT.assemble({ dir, manifest: bad, expectedBackupId: 'bid-1' });
    assert.equal(r.ok, false);
    assert.match(r.reason, /backupId|不匹配/);
  });
});

test('CT-6 分片顺序错误 → 拒绝组装', async () => {
  await withDir(async (dir) => {
    const { manifest, data } = fixture();
    await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest));
    await CT.downloadAll({ dir, manifest, scp: fakeScp({ data, manifest }).scp });
    const reordered = { ...manifest, chunks: [manifest.chunks[1], manifest.chunks[0], manifest.chunks[2]] };
    const r = await CT.assemble({ dir, manifest: reordered, expectedBackupId: 'bid-1' });
    assert.equal(r.ok, false);
  });
});

test('CT-7 完整 SHA-256 不一致 → 禁止恢复（不产出可恢复包）', async () => {
  await withDir(async (dir) => {
    const { manifest, data } = fixture();
    await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest));
    await CT.downloadAll({ dir, manifest, scp: fakeScp({ data, manifest }).scp });
    const bad = { ...manifest, fullSha256: 'f'.repeat(64) };
    const r = await CT.assemble({ dir, manifest: bad, expectedBackupId: 'bid-1' });
    assert.equal(r.ok, false);
    assert.match(r.reason, /SHA|禁止恢复/);
  });
});

test('CT-8 正常组装：按序拼接、全量大小与 SHA 通过，产出完整 tar 路径', async () => {
  await withDir(async (dir) => {
    const { manifest, data } = fixture();
    await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest));
    await CT.downloadAll({ dir, manifest, scp: fakeScp({ data, manifest }).scp });
    const r = await CT.assemble({ dir, manifest, expectedBackupId: 'bid-1' });
    assert.equal(r.ok, true);
    assert.equal((await stat(r.path)).size, manifest.totalBytes);
    assert.equal(C.sha256Hex(await readFile(r.path)), manifest.fullSha256);
  });
});

test('CT-9 磁盘空间不足 → 安全失败（不产出半成品）', async () => {
  await withDir(async (dir) => {
    const { manifest, data } = fixture();
    await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest));
    const r = await CT.downloadAll({
      dir, manifest, scp: fakeScp({ data, manifest }).scp,
      freeBytes: () => 1024, // 模拟几乎无空间
    });
    assert.equal(r.ok, false);
    assert.match(r.reason, /空间/);
  });
});

test('CT-10 未完成的 .tmp 永不当有效分片', async () => {
  await withDir(async (dir) => {
    const { manifest, data } = fixture();
    await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest));
    await writeFile(join(dir, 'part001.tmp'), Buffer.from('half'));
    const f = fakeScp({ data, manifest, resume: true });
    const r = await CT.downloadAll({ dir, manifest, scp: f.scp, resume: true });
    assert.equal(r.ok, true, 'tmp 不阻碍，但不会被当作已校验片');
    assert.equal(f.calls.length, manifest.chunkCount, '所有片都要真正下载');
  });
});

test('CT-11 远端切片脚本不得用 bs=1 逐字节读大文件（真机性能缺陷回归）', () => {
  const script = CT.remoteSplitScript();
  assert.ok(!/bs=1\b/.test(script), 'bs=1 会让 500MB 级切片耗时数小时');
  assert.match(script, /split -b|bs=1M|iflag=skip_bytes/, '应使用块级切分/读取');
});
