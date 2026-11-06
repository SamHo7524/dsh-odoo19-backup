import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { createService } from '../lib/service.js';

const srv = { name: 's', host: 'h', port: 22, user: 'root' };

function deps(overrides = {}) {
  return {
    guardHostKey: async () => ({ ok: true }),
    discover: async () => ({ instances: [{ dbName: 'db' }] }),
    runBackup: async (a) => ({ ok: true, encrypted: Boolean(a.passphrase), localPath: 'K:/b' }),
    runRestore: async () => ({ ok: true }),
    detectFormat: async () => 'dsh-odoo',
    stat: async () => ({ size: 1 }),
    ...overrides,
  };
}

// 直接读源码断言 schema 字段：避免测试环境缺 @deepseek-ai/schemastery
const indexSrc = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

test('Config schema 必须声明 passphrase（否则备份永不加密）', () => {
  assert.match(indexSrc, /passphrase:\s*z/, 'Config 缺少 passphrase 字段');
});

test('Config schema 保留 keepDays / localBackupDir / allowUnencryptedPackage', () => {
  assert.match(indexSrc, /keepDays:\s*z\./);
  assert.match(indexSrc, /localBackupDir:\s*z\./);
  assert.match(indexSrc, /allowUnencryptedPackage:\s*z/);
});

test('service.backup 把配置的 passphrase 传给 runBackup（R10 强制加密）', async () => {
  const svc = createService({
    config: { servers: [srv], localBackupDir: 'K:/b', passphrase: 'secret-pw' },
    deps: deps(),
  });
  const r = await svc.backup('s');
  assert.equal(r.encrypted, true, 'passphrase 未传下去，备份不会加密');
});

test('未配置 passphrase 时备份被拒绝（U4 fail-closed）', async () => {
  const svc = createService({ config: { servers: [srv], localBackupDir: 'K:/b' }, deps: deps() });
  await assert.rejects(() => svc.backup('s'), /加密口令|passphrase/);
});
