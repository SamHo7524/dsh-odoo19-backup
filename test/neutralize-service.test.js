/**
 * 中立化状态管理 — Service 层（Task 2）。
 *
 * 验证点：
 *  - keep 不触达远端（不写库、不需要指纹闸门之外的动作）
 *  - release 必须过指纹闸门、必须校验目标库名、只执行一次远端脚本
 *  - action 非法一律拒绝
 *  - status 透传 parseStatus 结果 + dbName
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { createService } from '../lib/service.js';

function makeConfig(servers = [{ name: 's1', host: 'h', user: 'root', dbName: 'toogel' }]) {
  return { servers };
}

function fakeDiscover(dbName = 'toogel') {
  return async () => ({ instances: [{ dbName, odooContainer: 'oc', pgContainer: 'pc', pgSuperUser: 'pgsql', dataPath: '/d', addonsPath: '/a' }] });
}

const STATUS_STDOUT = [
  '===NEU_STATUS===',
  'flag|true',
  'cron_active|1',
  'cron_disabled|42',
  'mail_placeholder|1',
  'mail_real_active|0',
  'mail_real_with_creds|0',
  'payment_enabled|0',
  'payment_disabled|26',
  'webhook_neutralized|0',
  '===NEU_STATUS_END===',
].join('\n');

test('NEUSVC-1 keep 不执行任何远端脚本（不写库）', async () => {
  const calls = [];
  const svc = createService({
    config: makeConfig(),
    deps: {
      guardHostKey: async () => ({ ok: true }),
      discover: fakeDiscover(),
      execRemote: async (...a) => { calls.push(a); return { stdout: '', stderr: '', code: 0 }; },
    },
  });
  const r = await svc.applyNeutralize('s1', 'keep');
  assert.equal(r.ok, true);
  assert.equal(r.applied, false);
  assert.equal(r.action, 'keep');
  assert.equal(calls.length, 0, 'keep 绝不能执行远端命令');
});

test('NEUSVC-2 release 执行一次远端脚本且 stdin 含目标库名', async () => {
  const calls = [];
  const svc = createService({
    config: makeConfig(),
    deps: {
      guardHostKey: async () => ({ ok: true }),
      discover: fakeDiscover('toogel'),
      execRemote: async (server, script, opts) => {
        calls.push({ server, script, opts });
        return { stdout: '===NEU_APPLY===\nrc=0\ncron_enabled|42\n===NEU_APPLY_END===', stderr: '', code: 0 };
      },
    },
  });
  const r = await svc.applyNeutralize('s1', 'release');
  assert.equal(calls.length, 1);
  assert.match(calls[0].opts.stdin, /toogel/);
  assert.match(calls[0].script, /NEU_APPLY/);
  assert.equal(r.ok, true);
});

test('NEUSVC-3 目标库名为空 → 抛错且不执行远端', async () => {
  let called = false;
  const svc = createService({
    config: makeConfig(),
    deps: {
      guardHostKey: async () => ({ ok: true }),
      discover: fakeDiscover(''),
      execRemote: async () => { called = true; return { stdout: '', stderr: '', code: 0 }; },
    },
  });
  await assert.rejects(() => svc.applyNeutralize('s1', 'release'), /数据库名/);
  assert.equal(called, false);
});

test('NEUSVC-4 action 非法 → 抛错', async () => {
  const svc = createService({
    config: makeConfig(),
    deps: { guardHostKey: async () => ({ ok: true }), discover: fakeDiscover() },
  });
  await assert.rejects(() => svc.applyNeutralize('s1', 'drop'), /action/);
});

test('NEUSVC-5 neutralizeStatus 返回解析结果 + dbName', async () => {
  const svc = createService({
    config: makeConfig(),
    deps: {
      guardHostKey: async () => ({ ok: true }),
      discover: fakeDiscover('toogel'),
      execRemote: async () => ({ stdout: STATUS_STDOUT, stderr: '', code: 0 }),
    },
  });
  const r = await svc.neutralizeStatus('s1');
  assert.equal(r.ok, true);
  assert.equal(r.neutralized, true);
  assert.equal(r.dbName, 'toogel');
  assert.equal(r.cronDisabled, 42);
});

test('NEUSVC-6 release 传 enablePaymentCodes 会进入脚本', async () => {
  let script = '';
  const svc = createService({
    config: makeConfig(),
    deps: {
      guardHostKey: async () => ({ ok: true }),
      discover: fakeDiscover('toogel'),
      execRemote: async (_s, sc) => {
        script = sc;
        return { stdout: '===NEU_APPLY===\nrc=0\n===NEU_APPLY_END===', stderr: '', code: 0 };
      },
    },
  });
  await svc.applyNeutralize('s1', 'release', { enablePaymentCodes: ['alipay'] });
  assert.match(script, /alipay/);
  assert.match(script, /payment_provider/);
});

test('NEUSVC-7 指纹闸门未通过 → 拒绝（不执行）', async () => {
  let called = false;
  const svc = createService({
    config: makeConfig(),
    deps: {
      guardHostKey: async () => ({ ok: false, error: { message: '指纹未确认' } }),
      discover: fakeDiscover(),
      execRemote: async () => { called = true; return { stdout: '', stderr: '', code: 0 }; },
    },
  });
  await assert.rejects(() => svc.applyNeutralize('s1', 'release'), /指纹未确认/);
  assert.equal(called, false);
});
