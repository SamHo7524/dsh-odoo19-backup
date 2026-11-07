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
    // v0.1.11：口令统一走 Credentials；stub 从 overrides.credentialsValue 取
        credentials: overrides.credentials ?? {
      resolve: async () => (overrides.credentialsValue ?? cfg?.passphrase
        ? { value: overrides.credentialsValue ?? cfg?.passphrase, source: 'file' }
        : undefined),
    },
    ...overrides,
  };
}

// 直接读源码断言 schema 字段：避免测试环境缺 @deepseek-ai/schemastery
const indexSrc = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

test('Config schema 保留 keepDays / localBackupDir / allowUnencryptedPackage', () => {
  assert.match(indexSrc, /keepDays:\s*z\./);
  assert.match(indexSrc, /localBackupDir:\s*z\./);
  assert.match(indexSrc, /allowUnencryptedPackage:\s*z/);
});

test('service.backup 把 Credentials 口令传给 runBackup（R10 强制加密）', async () => {
  const svc = createService({
    config: { servers: [srv], localBackupDir: 'K:/b' },
    deps: deps({ credentialsValue: 'secret-pw' }),
  });
  const r = await svc.backup('s');
  assert.equal(r.encrypted, true, 'passphrase 未传下去，备份不会加密');
});

test('未配置口令（凭证缺位）时备份被拒绝（U4 fail-closed）', async () => {
  const svc = createService({
    config: { servers: [srv], localBackupDir: 'K:/b' },
    deps: deps({ credentialsValue: '' }), // 凭证存在但为空 → 视为未配置
  });
  await assert.rejects(() => svc.backup('s'), /加密口令|R10/);
});
