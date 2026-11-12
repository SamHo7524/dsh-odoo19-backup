/**
 * v0.1.27 RED — 分片 SCP 下载的超时 / 进程终止 / 文件增长进度 / 定时器生命周期。
 *
 * 真机事故（2026-11-12 备份 toogel）：
 *   16:34 发起备份 → 第 1 片 16:40:59 校验通过 → 第 2 片一个字节没进来，
 *   状态文件从此再没被写过，界面停在 64% 且**不报错**；
 *   16:47 DSH 自动更新重启，宿主进程内的 scp 子进程被连带杀掉，
 *   任务永久停在 running（非终态），服务器锁 fail-closed 无法直接重跑。
 *
 * 根因（两条下载路径护栏不对等）：
 *   - 单文件 scpDownload（lib/backup.js）有 setTimeout + kill('SIGKILL')、有 2s 文件增长轮询；
 *   - 分片 realScp（lib/chunk-transfer.js）只有 child.on('close')，无 timer、无 kill、无进度；
 *   - 且 `transferTimeoutMs` 只在 index.js 的 schema 里定义过，**全插件无消费者**，
 *     即配置写了「传输超时 1 小时」却从未生效。
 *
 * 本文件锁定 v0.1.27 的修复契约（A 方案，仅此三条，不含自动续传/状态机重构）：
 *   1) realScp 接受 timeoutMs，超时即 kill('SIGKILL') 并 reject（错误文案含「超时」）；
 *   2) realScp 按本地文件真实增长回调 onProgress，未知总大小时不得编造百分比；
 *   3) 正常完成 / 异常退出 / 超时三条路径都必须清理定时器（无泄漏、不再回调）；
 *   4) downloadAll 把 expectedBytes/timeoutMs/onProgress 透传给注入的 scp，
 *      并把分片内的字节增长换算成整体百分比转发给外层 onProgress。
 *
 * 注入方式：`spawn` 依赖注入（与既有 `scp` 注入同一风格），测试不触达真实远端。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile, rm, stat, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CT = await import('../lib/chunk-transfer.js');
const C = await import('../lib/chunks.js');

const MiB = 104857600;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'v0127-ctp-'));
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

/** 假子进程：可触发 stderr / close，记录被 kill 的信号。 */
function fakeChild() {
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killedWith = [];
  child.kill = (sig) => { child.killedWith.push(sig); return true; };
  return child;
}

/** 只读连接信息，避免测试触达真实主机（buildScpArgs 只做字符串拼装）。 */
const SERVER = { host: '127.0.0.1', port: 22, user: 'root' };

// ---------------------------------------------------------------- 超时与终止

test('CTP-1 分片下载超时 → kill(SIGKILL) 并 reject，错误文案含「超时」', async () => {
  await withDir(async (dir) => {
    const localPath = join(dir, 'part001.aaa.tmp');
    const child = fakeChild(); // 永不 close，模拟 scp 挂死
    const p = CT.realScp({
      server: SERVER,
      remotePath: '/tmp/a.tar.part001',
      localPath,
      timeoutMs: 60,
      spawn: () => child,
    });
    await assert.rejects(p, /超时/, '挂死的 scp 必须超时报错，而不是永久静默');
    assert.deepEqual(child.killedWith, ['SIGKILL'], '超时必须真正终止子进程');
  });
});

test('CTP-2 子进程异常退出（非 0）→ reject 且错误含退出码', async () => {
  await withDir(async (dir) => {
    const localPath = join(dir, 'part001.bbb.tmp');
    const child = fakeChild();
    const p = CT.realScp({
      server: SERVER, remotePath: '/tmp/a.tar.part001', localPath, timeoutMs: 5000,
      spawn: () => child,
    });
    child.stderr.emit('data', Buffer.from('Permission denied (publickey)'));
    child.emit('close', 1);
    await assert.rejects(p, /退出码 1/, '异常退出要带退出码');
  });
});

test('CTP-3 正常完成 → resolve 且之后不再产生任何进度回调（定时器已清理）', async () => {
  await withDir(async (dir) => {
    const localPath = join(dir, 'part001.ccc.tmp');
    await writeFile(localPath, Buffer.alloc(100));
    const child = fakeChild();
    const seen = [];
    const p = CT.realScp({
      server: SERVER, remotePath: '/tmp/a.tar.part001', localPath,
      timeoutMs: 5000, expectedBytes: 100, pollMs: 20,
      onProgress: (v) => seen.push(v),
      spawn: () => child,
    });
    child.emit('close', 0);
    const r = await p;
    assert.equal(r.ok, true);
    const atResolve = seen.length;
    await writeFile(localPath, Buffer.alloc(400)); // 完成后本地文件继续变化
    await sleep(120);
    assert.equal(seen.length, atResolve, 'resolve 后轮询必须停止，不得继续回调');
  });
});

test('CTP-4 超时路径同样清理轮询：超时后本地文件再增长也不回调', async () => {
  await withDir(async (dir) => {
    const localPath = join(dir, 'part001.ddd.tmp');
    await writeFile(localPath, Buffer.alloc(10));
    const child = fakeChild();
    const seen = [];
    const p = CT.realScp({
      server: SERVER, remotePath: '/tmp/a.tar.part001', localPath,
      timeoutMs: 60, expectedBytes: 1000, pollMs: 20,
      onProgress: (v) => seen.push(v),
      spawn: () => child,
    });
    await assert.rejects(p, /超时/);
    const atReject = seen.length;
    await writeFile(localPath, Buffer.alloc(900));
    await sleep(120);
    assert.equal(seen.length, atReject, '超时后轮询必须停止，不得继续回调');
  });
});

// ---------------------------------------------------------------- 真实进度

test('CTP-5 按本地文件真实增长回调进度百分比（不得等到结束才报一次）', async () => {
  await withDir(async (dir) => {
    const localPath = join(dir, 'part001.eee.tmp');
    await writeFile(localPath, Buffer.alloc(0));
    const child = fakeChild();
    const seen = [];
    const p = CT.realScp({
      server: SERVER, remotePath: '/tmp/a.tar.part001', localPath,
      timeoutMs: 5000, expectedBytes: 1000, pollMs: 20,
      onProgress: (v) => seen.push(v),
      spawn: () => child,
    });
    await writeFile(localPath, Buffer.alloc(500)); // 50%
    await sleep(80);
    await writeFile(localPath, Buffer.alloc(1000)); // 100%
    await sleep(80);
    child.emit('close', 0);
    await p;
    assert.ok(seen.length >= 2, `下载中应多次上报真实进度，实际 ${seen.length} 次`);
    assert.ok(seen.includes(50), `应上报 50%，实际 ${JSON.stringify(seen)}`);
    assert.equal(Math.max(...seen), 100);
  });
});

test('CTP-6 未知总大小（expectedBytes=0）→ 不上报百分比，绝不编造', async () => {
  await withDir(async (dir) => {
    const localPath = join(dir, 'part001.fff.tmp');
    await writeFile(localPath, Buffer.alloc(123));
    const child = fakeChild();
    const seen = [];
    const p = CT.realScp({
      server: SERVER, remotePath: '/tmp/a.tar.part001', localPath,
      timeoutMs: 5000, expectedBytes: 0, pollMs: 20,
      onProgress: (v) => seen.push(v),
      spawn: () => child,
    });
    await sleep(80);
    child.emit('close', 0);
    await p;
    assert.deepEqual(seen, [], '总大小未知时必须沉默，不得伪造进度');
  });
});

// ---------------------------------------------------------------- downloadAll 接线

function fixture(total = 2 * MiB + 12345) {
  const plan = C.planChunks(total, MiB);
  const data = Buffer.alloc(total, 0x41);
  const chunks = plan.map((p) => ({
    ...p,
    sha256: C.sha256Hex(data.subarray(p.offset, p.offset + p.size)),
    remotePart: `/tmp/a.tar.part${String(p.index).padStart(3, '0')}`,
  }));
  const manifest = C.buildManifest({
    backupId: 'bid-ctp', createdAt: '2026-11-12T00:00:00Z',
    serverConfigId: 'srv', remoteTarPath: '/tmp/a.tar', remoteWorkDir: '/tmp/w',
    fileName: 'a.tar', totalBytes: total, fullSha256: C.sha256Hex(data),
    chunkSize: MiB, chunks,
  });
  return { manifest, data };
}

test('CTP-7 downloadAll 把 expectedBytes/timeoutMs/onProgress 透传给 scp', async () => {
  await withDir(async (dir) => {
    const { manifest, data } = fixture();
    const got = [];
    const scp = async ({ localPath, remotePath, expectedBytes, timeoutMs, onProgress }) => {
      got.push({ remotePath, expectedBytes, timeoutMs, hasProgress: typeof onProgress === 'function' });
      const part = manifest.chunks.find((c) => c.remotePart === remotePath);
      await writeFile(localPath, data.subarray(part.offset, part.offset + part.size));
      return { ok: true };
    };
    const r = await CT.downloadAll({ dir, manifest, scp, timeoutMs: 1234 });
    assert.equal(r.ok, true);
    assert.equal(got.length, manifest.chunkCount);
    for (let i = 0; i < got.length; i++) {
      const g = got[i];
      assert.equal(g.hasProgress, true, '必须传 onProgress 给 scp，否则分片内无进度');
      assert.equal(g.timeoutMs, 1234, 'transferTimeoutMs 必须到达分片下载');
      // 每片应知道自己的字节数（尾片小于整片，不能写死 chunkSize）
      assert.equal(g.expectedBytes, manifest.chunks[i].size, '每片应知道自己的字节数以便算百分比');
    }
  });
});

test('CTP-8 分片内字节增长被换算成整体百分比转发给外层 onProgress（下载中即上报）', async () => {
  await withDir(async (dir) => {
    const { manifest, data } = fixture();
    const mid = [];
    const scp = async ({ localPath, remotePath, expectedBytes, onProgress }) => {
      const part = manifest.chunks.find((c) => c.remotePart === remotePath);
      // 模拟分片下载到一半时上报字节增长
      onProgress?.(Math.floor(expectedBytes / 2));
      mid.push({ remotePath, half: Math.floor(expectedBytes / 2) });
      await writeFile(localPath, data.subarray(part.offset, part.offset + part.size));
      return { ok: true };
    };
    const outer = [];
    const r = await CT.downloadAll({
      dir, manifest, scp,
      // 必须快照：downloadAll 复用同一个 state 对象回调，保存引用会全指向终态。
      // 生产端 service.progressReporter 是同步 patchState，不受影响。
      onProgress: (state) => outer.push({ percent: state.percent, downloadedBytes: state.downloadedBytes }),
    });
    assert.equal(r.ok, true);
    assert.equal(mid.length, manifest.chunkCount, '每个分片都应有机会上报中途进度');
    // 每个非尾片都有「中途 + 完成」两次；尾片极小（12345 B），中途值经 floor 后
    // 可能落在同一整数百分比上被去重，故以「片数」为下界而非「片数×2」。
    assert.ok(outer.length >= manifest.chunkCount,
      `外层应收到分片中途与完成两类进度，实际 ${outer.length} 次`);
    assert.ok(outer.some((s) => s.downloadedBytes > 0 && s.downloadedBytes < manifest.totalBytes),
      '必须存在「已下载但未完成」的中间态，否则进度条只是假动');
    // 中间态不得自称完成（100% 仅留给最终全 verified）
    const intermediates = outer.filter((s) => s.downloadedBytes < manifest.totalBytes);
    assert.ok(intermediates.every((s) => s.percent < 100),
      '未全部完成时不得报 100%');
  });
});

test('CTP-9 分片中途进度不改变最终状态：全部 verified 才算完成（不得虚报）', async () => {
  await withDir(async (dir) => {
    const { manifest, data } = fixture();
    const scp = async ({ localPath, remotePath, expectedBytes, onProgress }) => {
      const part = manifest.chunks.find((c) => c.remotePart === remotePath);
      onProgress?.(expectedBytes); // 谎报「已传满」
      await writeFile(localPath, data.subarray(part.offset, part.offset + part.size));
      return { ok: true };
    };
    const r = await CT.downloadAll({ dir, manifest, scp });
    assert.equal(r.ok, true);
    for (const c of manifest.chunks) {
      assert.equal((await stat(join(dir, `part${String(c.index).padStart(3, '0')}`))).size, c.size);
    }
    assert.equal(r.state.chunks.every((x) => x.status === 'verified'), true);
  });
});
