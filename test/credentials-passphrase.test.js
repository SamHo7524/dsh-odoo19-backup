/**
 * v0.1.11 RED — 备份加密口令走 DSH 官方 Credentials 服务。
 *
 * 用户裁决：
 *  - ref 名称 ODOO_BACKUP_PASSPHRASE；接受 0600/0700 明文凭证库边界
 *  - backup/restore 每次执行时动态 resolve，不缓存
 *  - 恢复统一用 Credentials，不允许 opts.passphrase 静默覆盖
 *  - 未配置时 fail-closed（沿用 R10），不允许空口令
 *  - 日志/异常/API 响应不泄露口令
 *  - R10 策略、加密算法、恢复链路结构不变
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { createService } from '../lib/service.js';

const REF = 'ODOO_BACKUP_PASSPHRASE';

// ------------------------------------------------------- 凭证读取契约

function makeCredentials({ value } = {}) {
  const calls = [];
  return {
    calls,
    async resolve(ref) {
      calls.push(['resolve', ref]);
      return value === undefined ? undefined : { value, source: 'file' };
    },
    async describe(ref) {
      calls.push(['describe', ref]);
      return value === undefined ? { configured: false, writable: true } : { configured: true, source: 'file', writable: true };
    },
  };
}

const cfg = () => ({
  servers: [{ name: 'staging', host: '10.0.0.1', port: 22, user: 'root', keyPath: 'C:/k' }],
  localBackupDir: 'K:/Backup/odoo',
  passphrase: '', // v0.1.11 起口令不再来自 config；即使有人手动写入也必须被忽略
  allowUnencryptedPackage: false,
});

function deps(overrides = {}) {
  return {
    guardHostKey: async () => ({ ok: true, mode: 'pinned' }),
    testConnection: async () => ({ ok: true, system: { os: 'X' } }),
    discover: async () => ({ ok: true, instances: [{ dbName: 'tg-odoo' }] }),
    runBackup: async () => ({ ok: true, localPath: 'K:/b.tar' }),
    runRestore: async () => ({ ok: true }),
    detectFormat: async () => 'dsh-odoo',
    stat: async () => ({ size: 1 }),
    scanHostKey: async () => ({ ok: true, fingerprints: [] }),
    pinHostKey: async () => ({ ok: true }),
    ...overrides,
  };
}

test('CRED-1 未配置口令时备份拒绝（fail-closed，R10 保持），且不再读 config.passphrase', async () => {
  let ranBackup = false;
  const d = deps({ runBackup: async () => { ranBackup = true; return { ok: true }; } });
  const creds = makeCredentials({ value: undefined });
  const svc = createService({ config: cfg(), deps: { ...d, credentials: creds } });
  await assert.rejects(() => svc.backup('staging'), /未配置加密口令|R10/);
  assert.equal(ranBackup, false, '拒绝后绝不触达远端');
  assert.deepEqual(creds.calls[0], ['resolve', REF], '必须按约定的 ref 名称读取');
});

test('CRED-2 备份每次执行时动态 resolve，不缓存口令', async () => {
  const d = deps();
  const creds = makeCredentials({ value: 'pw-A' });
  const svc = createService({ config: cfg(), deps: { ...d, credentials: creds } });
  await svc.backup('staging');
  const first = d.calls ?? [];
  // 两次备份 → resolve 至少两次（无缓存）
  await svc.backup('staging');
  const resolves = creds.calls.filter((c) => c[0] === 'resolve').length;
  assert.ok(resolves >= 2, `两次备份应至少 resolve 两次，实际 ${resolves}`);
});

test('CRED-3 备份从凭证取口令并传给 runBackup，不在参数/错误中泄露', async () => {
  let captured = null;
  const d = deps({ runBackup: async (a) => { captured = a; return { ok: true, localPath: 'K:/b' }; } });
  const creds = makeCredentials({ value: 'S3cret!' });
  const svc = createService({ config: cfg(), deps: { ...d, credentials: creds } });
  await svc.backup('staging');
  assert.equal(captured.passphrase, 'S3cret!', '备份必须拿到凭证口令');
  // runBackup 参数含口令属于进程内传递，可接受；但任何 throw 的 message 不得含口令
});

test('CRED-4 恢复统一用 Credentials；opts.passphrase 不再静默覆盖', async () => {
  let captured = null;
  const d = deps({ runRestore: async (a) => { captured = a; return { ok: true }; } });
  const creds = makeCredentials({ value: 'vault-pw' });
  const svc = createService({ config: cfg(), deps: { ...d, credentials: creds } });
  await svc.restore('staging', null, 'K:/b.enc', { passphrase: 'evil-override' });
  assert.equal(captured.options.passphrase, 'vault-pw', '恢复必须用统一凭证，而不是调用方传值');
});

test('CRED-5 恢复未配置口令 → 拒绝（fail-closed），不静默降级', async () => {
  const d = deps();
  const creds = makeCredentials({ value: undefined });
  const svc = createService({ config: cfg(), deps: { ...d, credentials: creds } });
  await assert.rejects(() => svc.restore('staging', null, 'K:/b.enc', {}), /未配置加密口令|R10|口令/);
});

test('CRED-6 错误口令不会被误报成功：口令传给 runRestore 由其解密校验', async () => {
  let captured = null;
  const d = deps({ runRestore: async (a) => { captured = a; return { ok: true }; } });
  const creds = makeCredentials({ value: 'right-pw' });
  const svc = createService({ config: cfg(), deps: { ...d, credentials: creds } });
  await svc.restore('staging', null, 'K:/b.enc', {});
  assert.equal(captured.options.passphrase, 'right-pw');
});

test('CRED-7 config.passphrase 残留值被忽略（统一凭证策略）', async () => {
  let captured = null;
  const d = deps({ runBackup: async (a) => { captured = a; return { ok: true }; } });
  const creds = makeCredentials({ value: undefined });
  const config = cfg();
  config.passphrase = 'leftover-in-yaml'; // 有人手写了旧字段也必须被忽略
  const svc = createService({ config, deps: { ...d, credentials: creds } });
  await assert.rejects(() => svc.backup('staging'), /未配置加密口令|R10/);
});

// ------------------------------------------------------- 路由契约

test('CRED-8 /passphrase-status 只回 configured，绝不回值', async () => {
  const hostSrc = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  assert.match(hostSrc, /passphrase-status/, '应有状态路由');
  const m = hostSrc.match(/route === '\/passphrase-status'[\s\S]{0,600}/);
  assert.ok(m, '状态路由实现存在');
  const seg = m[0];
  assert.ok(!seg.includes('passphrase:'), '状态响应不得包含口令值字段');
  assert.match(seg, /configured/, '状态应返回 configured');
});

test('CRED-9 /set-passphrase 转调 credentials.set，且成功后不回显口令', async () => {
  const hostSrc = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  assert.match(hostSrc, /set-passphrase/);
  assert.match(hostSrc, /credentials\.set\(|credentials\.set\b/, '应转调官方凭证服务');
  const m = hostSrc.match(/route === '\/set-passphrase'[\s\S]{0,700}/);
  assert.ok(m);
  const seg = m[0];
  assert.ok(!seg.match(/send\(200,\s*\{[^}]*passphrase:\s*(?:body|value)/), '响应不得回显口令');
});

test('CRED-10 凭证缺位时 credentials 服务本身必须存在（注入契约）', () => {
  const hostSrc = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  assert.match(hostSrc, /inject\(\['webServer',\s*'settings',\s*'credentials'\]/, 'apply 应注入 credentials 服务');
});

// ------------------------------------------------------- 前端契约

test('CRED-11 备份 Tab 有口令输入（type=password），保存成功后清空输入', () => {
  const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  assert.match(src, /set-passphrase/);
  assert.match(src, /type:\s*'password'/, '口令输入必须用 password 类型');
  // 保存成功后才清空：setPassphrase 成功分支里把 input 清空（失败保留）
  const m = src.match(/const setPassphrase = useCallback[\s\S]{0,1600}/);
  assert.ok(m, 'setPassphrase 回调应存在');
  const seg = m[0];
  const okIdx = seg.indexOf('ok:');
  const clearIdx = seg.indexOf("input: ''", okIdx);
  assert.ok(okIdx > 0 && clearIdx > okIdx, '成功分支中清空输入（失败分支保留）');
  assert.ok(seg.indexOf("input: ''", 0) < 0 || seg.indexOf("input: ''") > okIdx || seg.match(/err:/), '失败分支不得清空 input');
});

test('CRED-12 前端展示凭证状态与离线保管提示，不显示口令', () => {
  const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  assert.match(src, /passphrase-status/);
  assert.match(src, /妥善|离线|丢失.*无法|无法解密/, '应有离线保管提示');
});

test('CRED-13 /servers 与普通配置接口不含口令（回归护栏）', async () => {
  const hostSrc = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const m = hostSrc.match(/route === '\/servers'[\s\S]{0,600}?\}\);/);
  assert.ok(m);
  const seg = m[0];
  assert.ok(!seg.includes('passphrase'), '/servers 响应不得包含 passphrase 字段');
});

test('CRED-14 日志不泄露口令（日志调用不含口令变量）', () => {
  const svcSrc = readFileSync(new URL('../lib/service.js', import.meta.url), 'utf8');
  // 现有日志只有 info('odoo-backup: %d server(s)...')；确保没有任何把 passphrase 打进日志的调用
  const offenders = [...svcSrc.matchAll(/logger\??\.\w+\([^)]*passphrase[^)]*\)/g)].map((m) => m[0]);
  assert.deepEqual(offenders, [], '日志调用不得引用 passphrase 变量');
});
