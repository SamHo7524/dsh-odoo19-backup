import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { createService } from '../lib/service.js';
import { createOdooRestoreTool } from '../lib/tools.js';
import { createTokenStore } from '../lib/tokens.js';

const cfg = {
  servers: [{ name: 's1', host: 'h', port: 22, user: 'root', sshConfigAlias: 'a' }],
  localBackupDir: 'K:/b',
  allowUnencryptedPackage: false,
};

function deps(overrides = {}) {
  const calls = [];
  return {
    calls,
    ...{
      guardHostKey: async () => ({ ok: true }),
      discover: async () => ({ ok: true, instances: [{ dbName: 'db' }] }),
      runRestore: async (a) => { calls.push(['runRestore', a.packagePath]); return { ok: true }; },
      detectFormat: async () => 'dsh-odoo',
      stat: async () => ({ size: 1, isFile: () => true }),
      credentials: { resolve: async () => ({ value: 'pw' }) },
      scanHostKey: async () => ({ ok: true }),
      pinHostKey: async () => ({ ok: true }),
    },
    ...overrides,
  };
}

test('FLOW-1 service.restore 带引号+斜杠路径 → runRestore 收到规范路径', async () => {
  const d = deps();
  const svc = createService({ config: cfg, deps: d });
  await svc.restore('s1', null, '  "K:/Backup/odoo/x.tar.enc"  ', {});
  const run = d.calls.find((c) => c[0] === 'runRestore');
  assert.ok(run, '应调用 runRestore');
  assert.equal(run[1], 'K:\\Backup\\odoo\\x.tar.enc');
});

test('FLOW-2 service.restore 明文 .tar 仍被拒绝（安全不降低）', async () => {
  const d = deps({ detectFormat: async () => 'plain' });
  const svc = createService({ config: cfg, deps: d });
  await assert.rejects(() => svc.restore('s1', null, '"K:/b/x.tar"', {}), /未加密/);
  assert.equal(d.calls.filter((c) => c[0] === 'runRestore').length, 0);
});

test('FLOW-3 service.restore .tar.enc 正常识别并执行', async () => {
  const d = deps();
  const svc = createService({ config: cfg, deps: d });
  const r = await svc.restore('s1', null, 'K:/b/x.tar.enc', {});
  assert.equal(r.ok, true);
});

test('FLOW-4 Agent: precheck 与 restore 在规范值上绑定 token（带引号也能通过）', async () => {
  const svc = { restore: async () => ({ ok: true }) };
  const store = createTokenStore();
  const tool = createOdooRestoreTool({ config: cfg, service: svc, tokenStore: store });
  const pre = await tool.execute({ action: 'precheck', server: 's1', packagePath: '"K:/b/x.tar.enc"' });
  assert.equal(pre.boundTo.packagePath, 'K:\\b\\x.tar.enc');
  const r = await tool.execute({
    action: 'restore', server: 's1', packagePath: 'K:/b/x.tar.enc', confirmToken: pre.confirmToken,
  });
  assert.equal(r.ok, true, '引号版与无引号版规范化后必须一致');
});

test('FLOW-5 Agent: token 仍绑定包（换包被拒）→ 安全不降低', async () => {
  const store = createTokenStore();
  const tool = createOdooRestoreTool({
    config: cfg, service: { restore: async () => ({ ok: true }) }, tokenStore: store,
  });
  const pre = await tool.execute({ action: 'precheck', server: 's1', packagePath: 'K:/b/a.tar.enc' });
  await assert.rejects(() => tool.execute({
    action: 'restore', server: 's1', packagePath: 'K:/b/evil.tar.enc', confirmToken: pre.confirmToken,
  }), /不匹配：packagePath/);
});

test('FLOW-6 Host /precheck 与 /restore 都规范化 body.packagePath（源码一致性）', () => {
  const host = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  assert.match(host, /normalizeRestorePath\(body\.packagePath\)/,
    '/precheck 与 /restore 必须规范化同一输入');
});

test('FLOW-8 Host /last-backup 路由只依据 completed.json（源码断言）', () => {
  const host = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  assert.match(host, /route === '\/last-backup'/);
  assert.match(host, /resolveLastBackup\(stateDirOf\(config\)\)/);
});

test('FLOW-9 备份失败分支不回填（源码断言）', () => {
  const client = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  const start = client.indexOf("api('/backup'");
  assert.ok(start > 0, '应存在备份按钮回调');

  // 以回调内的 `} else {` 为界：之前是成功分支（应回填），之后是失败分支（不得回填）。
  const elseIdx = client.indexOf('} else {', start);
  assert.ok(elseIdx > start, '备份回调应区分成功/失败分支');

  const successBranch = client.slice(start, elseIdx);
  assert.ok(successBranch.includes('/last-backup'), '成功分支必须回填最终路径');

  // 失败分支截到该回调结束（下一条 status 渲染）为止
  const endIdx = client.indexOf('h(Status, { text: status[s.name] })', elseIdx);
  assert.ok(endIdx > elseIdx, '失败分支应能定位到回调结束');
  const failBranch = client.slice(elseIdx, endIdx);
  assert.ok(!failBranch.includes('/last-backup'), '失败分支不得调用回填');
});

test('FLOW-12 恢复页三项提示齐全（格式/不要选中间文件/时间点与目标库）', () => {
  const client = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  assert.match(client, /\.tar\.enc/, '须提示正确格式 .tar.enc');
  assert.match(client, /分片目录/, '须提示不要选分片目录的明文 .tar');
  assert.match(client, /备份时间点/, '须提示确认备份时间点');
  assert.match(client, /目标数据库/, '须提示确认目标数据库');
});

test('FLOW-7 单侧引号不猜测：原样路径 stat 失败 → 报备份包不存在', async () => {
  const d = deps({
    stat: async (p) => { if (p.includes('"')) throw new Error('ENOENT'); return { size: 1, isFile: () => true }; },
  });
  const svc = createService({ config: cfg, deps: d });
  await assert.rejects(() => svc.restore('s1', null, '"K:/b/x.tar.enc', {}), /备份包不存在/);
});
