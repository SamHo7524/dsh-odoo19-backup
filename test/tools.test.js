import { test } from 'node:test';
import assert from 'node:assert';
import { createOdooBackupTool, createOdooRestoreTool } from '../lib/tools.js';
import { createTokenStore } from '../lib/tokens.js';

const servers = [
  { name: 'staging', host: '119.29.10.202', port: 22, user: 'root' },
  { name: 'prod', host: '47.121.205.143', port: 22, user: 'root' },
];

/** 记录调用的假服务；返回固定结果，便于断言"工具只做路由与授权"。 */
function fakeService(overrides = {}) {
  const calls = [];
  const base = {
    calls,
    async test(name) { calls.push(['test', name]); return { ok: true, system: { os: 'Ubuntu 24.04' } }; },
    async discover(name) { calls.push(['discover', name]); return { ok: true, instances: [{ dbName: 'tg-odoo' }] }; },
    async backup(name) { calls.push(['backup', name]); return { ok: true, localPath: 'K:/b.tar', bytes: 1024 }; },
    async restore(name, _pkg, packagePath, opts) {
      calls.push(['restore', name, packagePath, opts]);
      return { ok: true, state: 'COMMITTED' };
    },
    // v0.1.17：precheck 会先做版本预检，工具依赖该结果决定是否发 token。
    async inspectRestore(name, packagePath) {
      calls.push(['inspectRestore', name, packagePath]);
      return {
        sourceDbName: 'tg-odoo', targetDbName: 'tg-odoo', conflict: null,
        sourceVersion: '19.0-20260619', targetVersion: '19.0-20261102',
        versionGate: { ok: true, level: 'same-major', message: '版本一致（同为 Odoo 19 大版本）。' },
      };
    },
    status() { return { running: false, lastTask: null }; },
  };
  return { ...base, ...overrides, calls };
}

function makeTools({ config = { servers }, svc = fakeService(), store = createTokenStore() } = {}) {
  return {
    svc,
    store,
    backupTool: createOdooBackupTool({ config, service: svc }),
    restoreTool: createOdooRestoreTool({ config, service: svc, tokenStore: store }),
  };
}

// ---------------- odoo_backup ----------------

test('odoo_backup: 工具元数据与参数 schema 完整', () => {
  const { backupTool } = makeTools();
  assert.equal(backupTool.name, 'odoo_backup');
  assert.ok(backupTool.description.length > 10);
  assert.equal(backupTool.parameters.type, 'object');
  assert.deepEqual(backupTool.parameters.required, ['action']);
  assert.deepEqual(
    [...backupTool.parameters.properties.action.enum].sort(),
    ['backup', 'discover', 'fingerprint', 'listServers', 'pin', 'test'],
  );
  assert.ok(backupTool.parameters.properties.fingerprint,
    'pin 动作需要 fingerprint 参数来传递人工核对过的指纹');
});

test('odoo_backup: 必须声明 output.schema 与 render', () => {
  const { backupTool } = makeTools();
  assert.ok(backupTool.output, '缺少 output 声明会导致工具注册失败');
  assert.equal(backupTool.output.schema.type, 'object');
  assert.equal(typeof backupTool.output.render, 'function');
  const rendered = backupTool.output.render({ action: 'listServers' }, [{ name: 's', host: 'h', port: 22, user: 'root' }]);
  assert.equal(rendered[0].type, 'text');
  assert.ok(rendered[0].text.includes('s'));
});

test('odoo_backup: listServers 只暴露非敏感字段', async () => {
  const { backupTool } = makeTools();
  const out = await backupTool.execute({ action: 'listServers' });
  // v0.1.16：与 output.schema（type: object）一致，返回对象而不是裸数组。
  assert.ok(out && typeof out === 'object' && !Array.isArray(out), '返回值必须是对象');
  assert.equal(out.servers.length, 2);
  assert.deepEqual(Object.keys(out.servers[0]).sort(), ['host', 'name', 'port', 'user']);
});

test('odoo_backup: test 委托给服务', async () => {
  const { backupTool, svc } = makeTools();
  const r = await backupTool.execute({ action: 'test', server: 'staging' });
  assert.equal(r.ok, true);
  assert.deepEqual(svc.calls[0], ['test', 'staging']);
});

test('odoo_backup: discover / backup 委托给服务', async () => {
  const { backupTool, svc } = makeTools();
  await backupTool.execute({ action: 'discover', server: 'staging' });
  await backupTool.execute({ action: 'backup', server: 'staging' });
  assert.deepEqual(svc.calls.map((c) => c[0]), ['discover', 'backup']);
});

test('odoo_backup: 未知服务器被拒且不调用服务', async () => {
  const { backupTool, svc } = makeTools();
  await assert.rejects(() => backupTool.execute({ action: 'test', server: 'nope' }), /未找到服务器/);
  assert.equal(svc.calls.length, 0);
});

test('odoo_backup: 未知 action 被拒', async () => {
  const { backupTool } = makeTools();
  await assert.rejects(() => backupTool.execute({ action: 'drop' }), /未知 action/);
});

test('odoo_backup: 缺少 server 时对需要它的 action 报错', async () => {
  const { backupTool } = makeTools();
  await assert.rejects(() => backupTool.execute({ action: 'backup' }), /缺少 server/);
});

// ---------------- odoo_restore ----------------

test('odoo_restore: 工具元数据与参数 schema 完整', () => {
  const { restoreTool } = makeTools();
  assert.equal(restoreTool.name, 'odoo_restore');
  assert.deepEqual(
    [...restoreTool.parameters.properties.action.enum].sort(),
    ['precheck', 'restore', 'status'],
  );
  assert.ok(restoreTool.parameters.properties.confirmToken);
});

test('odoo_restore: 必须声明 output.schema 与 render', () => {
  const { restoreTool } = makeTools();
  assert.ok(restoreTool.output);
  assert.equal(restoreTool.output.schema.type, 'object');
  assert.equal(typeof restoreTool.output.render, 'function');
  const rendered = restoreTool.output.render({ action: 'precheck' }, { ok: true, confirmToken: 'abc', expiresInSeconds: 300 });
  assert.equal(rendered[0].type, 'text');
  assert.ok(rendered[0].text.includes('abc'));
});

test('odoo_restore: precheck 返回绑定目标的 token 与警告', async () => {
  const { restoreTool } = makeTools();
  const r = await restoreTool.execute({
    action: 'precheck', server: 'staging', packagePath: 'K:/a.tar',
  });
  assert.equal(r.ok, true);
  assert.equal(typeof r.confirmToken, 'string');
  assert.equal(r.expiresInSeconds, 300);
  assert.match(r.warning, /覆盖目标数据库/);
});

test('odoo_restore: precheck 对未知服务器报错', async () => {
  const { restoreTool } = makeTools();
  await assert.rejects(
    () => restoreTool.execute({ action: 'precheck', server: 'nope', packagePath: 'K:/a.tar' }),
    /未找到服务器/,
  );
});

test('odoo_restore: restore 缺少 confirmToken 被拒（不调用服务）', async () => {
  const { restoreTool, svc } = makeTools();
  await assert.rejects(
    () => restoreTool.execute({ action: 'restore', server: 'staging', packagePath: 'K:/a.tar' }),
    /缺少 confirmToken/,
  );
  assert.equal(svc.calls.length, 0);
});

test('odoo_restore: restore 用错误 token 被拒（不调用服务）', async () => {
  const { restoreTool, svc } = makeTools();
  await assert.rejects(
    () => restoreTool.execute({
      action: 'restore', server: 'staging', packagePath: 'K:/a.tar', confirmToken: 'wrong',
    }),
    /confirmToken 无效/,
  );
  assert.equal(svc.calls.length, 0);
});

test('odoo_restore: precheck→restore 正常路径成功', async () => {
  const { restoreTool, svc } = makeTools();
  const pre = await restoreTool.execute({
    action: 'precheck', server: 'staging', packagePath: 'K:/a.tar',
  });
  const r = await restoreTool.execute({
    action: 'restore', server: 'staging', packagePath: 'K:/a.tar', confirmToken: pre.confirmToken,
  });
  assert.equal(r.ok, true);
  // v0.1.17：precheck 会先做版本预检（inspectRestore），随后才是真正的 restore
  assert.deepEqual(svc.calls.map((c) => c[0]), ['inspectRestore', 'restore']);
});

test('odoo_restore: token 一次性——同 token 二次恢复被拒', async () => {
  const { restoreTool } = makeTools();
  const pre = await restoreTool.execute({
    action: 'precheck', server: 'staging', packagePath: 'K:/a.tar',
  });
  await restoreTool.execute({
    action: 'restore', server: 'staging', packagePath: 'K:/a.tar', confirmToken: pre.confirmToken,
  });
  await assert.rejects(
    () => restoreTool.execute({
      action: 'restore', server: 'staging', packagePath: 'K:/a.tar', confirmToken: pre.confirmToken,
    }),
    /已使用过/,
  );
});

test('odoo_restore: token 绑定目标——换服务器被拒', async () => {
  const { restoreTool, svc } = makeTools();
  const pre = await restoreTool.execute({
    action: 'precheck', server: 'staging', packagePath: 'K:/a.tar',
  });
  await assert.rejects(
    () => restoreTool.execute({
      action: 'restore', server: 'prod', packagePath: 'K:/a.tar', confirmToken: pre.confirmToken,
    }),
    /不匹配：server/,
  );
  assert.equal(
    svc.calls.filter((c) => c[0] === 'restore').length, 0,
    '未授权目标绝不能触发恢复（precheck 的 inspectRestore 只是只读预检）',
  );
});

test('odoo_restore: token 绑定包——换备份包被拒', async () => {
  const { restoreTool } = makeTools();
  const pre = await restoreTool.execute({
    action: 'precheck', server: 'staging', packagePath: 'K:/a.tar',
  });
  await assert.rejects(
    () => restoreTool.execute({
      action: 'restore', server: 'staging', packagePath: 'K:/evil.tar', confirmToken: pre.confirmToken,
    }),
    /不匹配：packagePath/,
  );
});

test('odoo_restore: status 返回服务状态', async () => {
  const { restoreTool } = makeTools();
  const r = await restoreTool.execute({ action: 'status' });
  assert.equal(r.running, false);
});

test('odoo_restore: 未知 action 被拒', async () => {
  const { restoreTool } = makeTools();
  await assert.rejects(() => restoreTool.execute({ action: 'nuke' }), /未知 action/);
});
