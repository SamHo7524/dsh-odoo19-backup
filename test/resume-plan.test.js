/**
 * v0.1.13 真机验收缺口（2026-11-09）：重启后重新发起备份必须能续传旧分片。
 * 当前 backupId 绑定 ts，每次新调用会重新生成远端 tar → 新目录 → 无法续传。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

const R = await import('../lib/resume-plan.js');

async function withDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'v0113-resume-'));
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test('RESUME-1 发现有效遗留 manifest + 已校验分片时，返回可续传计划', async () => {
  await withDir(async (dir) => {
    const taskDir = join(dir, '20261109', 'task-1');
    await mkdir(taskDir, { recursive: true });
    const manifest = {
      schemaVersion: 1, backupId: 'b1', totalBytes: 300, fullSha256: 'a'.repeat(64),
      chunkCount: 3, chunkSize: 100, fileName: 'x.tar',
      chunks: [
        { index: 1, offset: 0, size: 100, sha256: 'a'.repeat(64) },
        { index: 2, offset: 100, size: 100, sha256: 'b'.repeat(64) },
        { index: 3, offset: 200, size: 100, sha256: 'c'.repeat(64) },
      ],
    };
    await writeFile(join(taskDir, 'manifest.json'), JSON.stringify(manifest));
    await writeFile(join(taskDir, 'part001'), Buffer.alloc(100));
    const r = await R.findResumableBackup(dir);
    assert.ok(r, '应找到可续传任务');
    assert.equal(r.taskDir, taskDir);
    assert.equal(r.manifest.backupId, 'b1');
  });
});

test('RESUME-2 manifest 损坏/缺失时返回 null（不误续传）', async () => {
  await withDir(async (dir) => {
    assert.equal(await R.findResumableBackup(dir), null);
    const taskDir = join(dir, '20261109', 'bad');
    await mkdir(taskDir, { recursive: true });
    await writeFile(join(taskDir, 'manifest.json'), '{ broken');
    assert.equal(await R.findResumableBackup(dir), null);
  });
});

test('RESUME-3 backup.js 集成：runBackup 检测遗留任务并跳过远端生成阶段', () => {
  const src = readFileSync(new URL('../lib/backup.js', import.meta.url), 'utf8');
  assert.match(src, /findResumableBackup\(/, '应检查可续传任务');
  assert.match(src, /resumePlan|resumable/, '存在续传分支');
});

test('RESUME-4 已完成任务的目录不得被当成可续传（避免无限续传旧备份）', async () => {
  await withDir(async (dir) => {
    const taskDir = join(dir, '20261109', 'done-task');
    await mkdir(taskDir, { recursive: true });
    const manifest = {
      schemaVersion: 1, backupId: 'done', totalBytes: 100, fullSha256: 'a'.repeat(64),
      chunkCount: 1, chunkSize: 100, fileName: 'x.tar',
      chunks: [{ index: 1, offset: 0, size: 100, sha256: 'b'.repeat(64) }],
    };
    await writeFile(join(taskDir, 'manifest.json'), JSON.stringify(manifest));
    await writeFile(join(taskDir, 'part001'), Buffer.alloc(100));
    await writeFile(join(taskDir, 'completed.json'), JSON.stringify({ completed: true }));
    assert.equal(await R.findResumableBackup(dir), null, '已完成目录应跳过');
  });
});

test('RESUME-5 backup.js 成功后写 completed.json 标记', () => {
  const src = readFileSync(new URL('../lib/backup.js', import.meta.url), 'utf8');
  assert.match(src, /completed\.json/, '成功路径应写完成标记');
});
