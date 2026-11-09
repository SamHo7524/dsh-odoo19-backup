/**
 * v0.1.13 T5 RED — backupDirectory 配置与目录验证（规格 §3.1 / §15）。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const D = await import('../lib/backup-directory.js');

async function withDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'v0113-dir-'));
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test('DIR-1 默认目录为 K:\\Backup\\odoo', () => {
  assert.equal(D.DEFAULT_BACKUP_DIRECTORY, 'K:/Backup/odoo');
});

test('DIR-2 存在的可写目录 → ok:true 且返回规范路径', async () => {
  await withDir(async (dir) => {
    const r = await D.validateDirectory(dir);
    assert.equal(r.ok, true);
    assert.equal(r.exists, true);
    assert.equal(r.writable, true);
    assert.ok(r.path);
  });
});

test('DIR-3 不存在的目录 → 按规则创建并验证可写', async () => {
  await withDir(async (dir) => {
    const target = join(dir, 'nested', 'backups');
    const r = await D.validateDirectory(target, { create: true });
    assert.equal(r.ok, true);
    assert.equal(r.created, true);
    assert.equal(r.writable, true);
  });
});

test('DIR-4 不可写/无效路径 → fail-closed，不静默回退默认路径', async () => {
  const r = await D.validateDirectory('', { create: false });
  assert.equal(r.ok, false);
  assert.match(r.reason, /路径|目录|空/);
  assert.notEqual(r.path, D.DEFAULT_BACKUP_DIRECTORY, '不得回退默认路径');
});

test('DIR-5 目录探测写不留残留文件', async () => {
  await withDir(async (dir) => {
    await D.validateDirectory(dir);
    const { readdir } = await import('node:fs/promises');
    const files = await readdir(dir);
    assert.deepEqual(files, [], '探测写必须清理');
  });
});

test('DIR-6 resolveBackupDirectory：backupDirectory 优先于 localBackupDir（兼容读取）', () => {
  assert.equal(D.resolveBackupDirectory({ backupDirectory: 'X:/new', localBackupDir: 'K:/old' }), 'X:/new');
  assert.equal(D.resolveBackupDirectory({ localBackupDir: 'K:/old' }), 'K:/old');
  assert.equal(D.resolveBackupDirectory({}), 'K:/Backup/odoo');
});

test('DIR-7 修改目录只影响新建任务：旧任务绑定任务记录中的目录', () => {
  const task = { backupDirectory: 'K:/old', taskId: 't1' };
  const current = 'X:/new';
  assert.equal(D.directoryForTask(task, current), 'K:/old', '恢复旧任务用记录目录');
  assert.equal(D.directoryForTask(null, current), current, '新任务用当前配置');
});
