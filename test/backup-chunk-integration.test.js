/**
 * v0.1.13 T4 RED — backup.js 集成分片路径（规格 §2.2 / §18）。
 * ≥100 MiB 走分片（远端切片→下载→组装→全量校验→现有 encryptFile）；
 * <100 MiB 保持原单文件 scp 路径，零回归。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../lib/backup.js', import.meta.url), 'utf8');

test('BK-CHUNK-1 runBackup 导入 chunk-transfer 与 chunks 纯函数', () => {
  assert.match(src, /chunk-transfer\.js/, '应引入分片传输模块');
  assert.match(src, /chunks\.js/, '应引入分片计划/校验模块');
});

test('BK-CHUNK-2 runBackup 有分片阈值分支（shouldChunk / 100 MiB）', () => {
  assert.match(src, /shouldChunk\(/, '按阈值分流');
  assert.match(src, /chunked|chunkTransfer|downloadAll/, '大文件走分片路径');
});

test('BK-CHUNK-3 小文件路径保持原 scpDownload 调用（不回归）', () => {
  assert.match(src, /scpDownload\(/, '原单文件下载仍在');
});

test('BK-CHUNK-4 分片成功后仍调用现有 encryptFile（R10 时机/格式不变）', () => {
  const encIdx = src.indexOf('encryptFile(');
  const chunkIdx = src.indexOf('downloadAll');
  assert.ok(encIdx > 0, '仍有 encryptFile');
  assert.ok(chunkIdx > 0 && encIdx > chunkIdx, '加密发生在分片下载/组装之后');
});

test('BK-CHUNK-5 分片路径复用 buildScpArgs（别名/显式 host 均适用）', () => {
  const ct = readFileSync(new URL('../lib/chunk-transfer.js', import.meta.url), 'utf8');
  assert.match(ct, /buildScpArgs\(/, 'chunk-transfer 内部复用统一参数构造');
});

test('BK-CHUNK-6 全量 SHA 校验失败时禁止进入加密/恢复', () => {
  const ct = readFileSync(new URL('../lib/chunk-transfer.js', import.meta.url), 'utf8');
  assert.match(ct, /checkFullIntegrity|禁止恢复/, '组装做全量校验');
});

test('BK-CHUNK-7 远端清理时机：加密与最终验证成功之后才清理（§13）', () => {
  // 清理调用必须出现在 encryptFile + isEncrypted/detectFormat 之后
  const enc = src.indexOf('encryptFile(');
  const verify = src.indexOf('isEncrypted(');
  const cleanup = src.indexOf('清理远程');
  assert.ok(enc > 0 && verify > 0 && cleanup > 0);
  assert.ok(cleanup > enc && cleanup > verify, '不得提前清理远端 tar/分片');
});

test('BK-CHUNK-8 失败路径保留远端数据（不提前清理 tar/分片）', () => {
  const catchIdx = src.indexOf('} catch (err) {');
  const tail = src.slice(catchIdx);
  assert.ok(tail.length > 0);
  assert.ok(!/rm -f "\$O"/.test(tail), '失败时不得删除远端 tar/分片');
  assert.match(tail, /保留远端|供断点续传/, '明确记录保留原因');
});
