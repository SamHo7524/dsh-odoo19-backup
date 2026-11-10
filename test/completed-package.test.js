import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveLastBackup } from '../lib/completed-package.js';

async function withDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'v0114-cp-'));
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
async function makeTask(root, { day = '20261109', id = 'abc', completed = true,
  localPath = 'K:/Backup/odoo/20261109/x.tar.enc', finishedAt = '2026-11-09T03:01:43.075Z' } = {}) {
  const taskDir = join(root, day, id);
  await mkdir(taskDir, { recursive: true });
  await writeFile(join(taskDir, 'completed.json'),
    JSON.stringify({ completed, backupId: id, localPath, finishedAt }));
  return taskDir;
}
// 注入的文件系统/格式探测：.tar.enc 视为存在且加密
const encDeps = () => ({
  detectFormat: async () => 'dsh-odoo',
  stat: async (p) => {
    if (p.endsWith('.tar.enc')) return { isFile: () => true, size: 588103732 };
    throw new Error('ENOENT');
  },
});

test('CP-1 正常：completed.json 有效且 .enc 加密校验通过 → 返回规范化 localPath', async () => {
  await withDir(async (root) => {
    await makeTask(root);
    const r = await resolveLastBackup(root, encDeps());
    assert.equal(r.ok, true);
    assert.equal(r.localPath, 'K:\\Backup\\odoo\\20261109\\x.tar.enc');
  });
});
test('CP-2 completed.json 不存在 → 拒绝回填', async () => {
  await withDir(async (root) => {
    assert.equal((await resolveLastBackup(root, encDeps())).ok, false);
  });
});
test('CP-3 completed=false → 拒绝回填', async () => {
  await withDir(async (root) => {
    await makeTask(root, { completed: false });
    assert.equal((await resolveLastBackup(root, encDeps())).ok, false);
  });
});
test('CP-4 localPath 指向分片目录明文 .tar → 拒绝回填', async () => {
  await withDir(async (root) => {
    await makeTask(root, { localPath: 'K:/Backup/odoo/20261109/abc/odoo-backup.tar' });
    assert.equal((await resolveLastBackup(root, encDeps())).ok, false);
  });
});
test('CP-5 localPath 为空 / null → 拒绝回填', async () => {
  await withDir(async (root) => {
    await makeTask(root, { localPath: '' });
    assert.equal((await resolveLastBackup(root, encDeps())).ok, false);
    await makeTask(root, { day: '20261110', id: 'b', localPath: null });
    assert.equal((await resolveLastBackup(root, encDeps())).ok, false);
  });
});
test('CP-6 最终文件不存在 → 拒绝回填', async () => {
  await withDir(async (root) => {
    await makeTask(root);
    const r = await resolveLastBackup(root, {
      detectFormat: async () => 'dsh-odoo',
      stat: async () => { throw new Error('ENOENT'); },
    });
    assert.equal(r.ok, false);
  });
});
test('CP-7 最终文件是明文（detectFormat=plain）→ 拒绝回填', async () => {
  await withDir(async (root) => {
    await makeTask(root);
    const r = await resolveLastBackup(root, {
      detectFormat: async () => 'plain',
      stat: async () => ({ isFile: () => true, size: 100 }),
    });
    assert.equal(r.ok, false);
  });
});
test('CP-8 多个任务取 finishedAt 最新者', async () => {
  await withDir(async (root) => {
    await makeTask(root, { day: '20261108', id: 'old', localPath: 'K:/b/old.tar.enc', finishedAt: '2026-11-08T01:00:00Z' });
    await makeTask(root, { day: '20261109', id: 'new', localPath: 'K:/b/new.tar.enc', finishedAt: '2026-11-09T03:00:00Z' });
    const r = await resolveLastBackup(root, encDeps());
    assert.equal(r.ok, true);
    assert.match(r.localPath, /new\.tar\.enc$/);
  });
});
test('CP-9 completed.json 是坏 JSON → 拒绝回填且不抛异常', async () => {
  await withDir(async (root) => {
    const taskDir = join(root, '20261109', 'abc');
    await mkdir(taskDir, { recursive: true });
    await writeFile(join(taskDir, 'completed.json'), '{ broken');
    assert.equal((await resolveLastBackup(root, encDeps())).ok, false);
  });
});
