/**
 * v0.1.27 RED — transferTimeoutMs 必须真正到达分片下载路径。
 *
 * 真机事故（2026-11-12）：`transferTimeoutMs` 在 index.js 的 schema 里定义过
 * （默认 3600000，描述「传输超时（毫秒）」），但**全插件没有任何消费者**——
 * 用户以为配了 1 小时超时，实际分片 scp 挂死永不超时，任务永久停在 running。
 *
 * 本文件锁定三条接线（A 方案范围，不含自动续传/状态机重构）：
 *   1) service.backup 把 config.transferTimeoutMs 传给 runBackup；
 *   2) runBackup 把它传给 downloadAll；
 *   3) downloadAll 已经把它传给每一片的 scp（由 chunk-timeout-progress.test.js 覆盖）。
 */
import { test } from 'node:test';
import assert from 'node:assert';

const SVC = await import('../lib/service.js');

/** 最小凭证桩：requirePassphrase 走 cred.resolve(REF) → { value }。 */
const CREDS = { resolve: async () => ({ value: 'test-passphrase' }) };

/**
 * 主机指纹闸门直通桩：requireTrusted 判定 `gate.ok === true` 才放行。
 * 真实实现只接受已 pin 指纹的服务器；本测试验证的是「配置是否传到 runBackup」，
 * 不是信任校验本身（信任校验由 trust-flow.test.js 覆盖）。
 */
const passGate = async () => ({ ok: true });
const SERVER_ENTRY = { name: 's1', host: '10.0.0.1', port: 22, user: 'root' };

test('CTW-1 service.backup 把 config.transferTimeoutMs 传给 runBackup', async () => {
  const calls = [];
  const d = {
    discover: async () => ({ instances: [{ dbName: 'tg-odoo', odooContainer: 'oc' }] }),
    runBackup: async (args) => { calls.push(args); return { ok: true }; },
    guardHostKey: passGate,
  };
  const cfg = {
    servers: [SERVER_ENTRY],
    allowUnencrypted: false,
    transferTimeoutMs: 98765,
  };
  const svc = SVC.createService({ config: cfg, deps: d });
  svc.attachCredentials(CREDS);
  await svc.backup('s1');
  assert.equal(calls.length, 1, '必须真正走到 runBackup，否则本测试无意义');
  assert.equal(calls[0].transferTimeoutMs, 98765, 'transferTimeoutMs 必须从 config 传到 runBackup');
});

test('CTW-2 runBackup 把 transferTimeoutMs 传给 downloadAll（源码接线断言）', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../lib/backup.js', import.meta.url), 'utf8');
  assert.match(src, /transferTimeoutMs/, 'runBackup 必须接收 transferTimeoutMs');
  // downloadAll 的调用参数里必须出现它
  const callBlock = src.slice(src.indexOf('downloadAll('), src.indexOf('downloadAll(') + 800);
  assert.match(callBlock, /timeoutMs/, 'downloadAll 调用必须传 timeoutMs（默认值会让超时形同虚设）');
});

test('CTW-3 config 默认值与 schema 一致：未配置时回退 3600000（1 小时），不是 0', async () => {
  const { readFile } = await import('node:fs/promises');
  const idx = await readFile(new URL('../index.js', import.meta.url), 'utf8');
  assert.match(idx, /transferTimeoutMs:\s*z\.number\(\)\.default\(3600000\)/, 'schema 默认值应保持 1 小时');
  const svc = await readFile(new URL('../lib/service.js', import.meta.url), 'utf8');
  assert.match(svc, /transferTimeoutMs/, 'service 必须消费该配置，否则是死配置');
});

test('CTW-4 service 传下去的是数值而非 undefined（未配置时给出 1 小时默认）', async () => {
  const calls = [];
  const d = {
    discover: async () => ({ instances: [{ dbName: 'tg-odoo', odooContainer: 'oc' }] }),
    runBackup: async (args) => { calls.push(args); return { ok: true }; },
    guardHostKey: passGate,
  };
  const cfg = { servers: [SERVER_ENTRY] };
  const svc = SVC.createService({ config: cfg, deps: d });
  svc.attachCredentials(CREDS);
  await svc.backup('s1');
  assert.equal(calls.length, 1, '必须真正走到 runBackup，否则本测试无意义');
  assert.equal(typeof calls[0].transferTimeoutMs, 'number', '不得把 undefined 传下去');
  assert.equal(calls[0].transferTimeoutMs, 3600000, '未配置时应回退 1 小时');
});
