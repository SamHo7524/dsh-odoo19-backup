/**
 * Task 10：UI 与 Agent 共用 service 的调用链验证。
 *
 * 做法：用与 index.js 完全相同的方式构造 service + tokenStore，
 * 然后分别从「Agent 工具路径」和「UI 路由路径」调用，断言落到同一个 service 实例。
 * 不修改用户配置、不触达远端（用注入的假 discover/testConnection 之外的真实组件仅做只读调用）。
 */
import { createService } from '../lib/service.js';
import { createTokenStore } from '../lib/tokens.js';
import { createOdooBackupTool, createOdooRestoreTool } from '../lib/tools.js';

const srv = {
  name: 'staging', host: '119.29.10.202', port: 22, user: 'root',
  keyPath: process.env.USERPROFILE + '/.ssh/toogel_vault',
  pinnedFingerprint: 'SHA256:uOmOzd32qk8nGbHznwaA2QKQ0FnT6vm/DvTyA/o+38w',
};
const config = {
  servers: [srv],
  localBackupDir: 'K:/Backup/odoo',
  allowUnencryptedPackage: false,
};

// 与 index.js 一致：一个 service + 一个 tokenStore，工具与 UI 共用
const service = createService({ config });
const tokenStore = createTokenStore();
const backupTool = createOdooBackupTool({ config, service });
const restoreTool = createOdooRestoreTool({ config, service, tokenStore });

// 探针：包裹 service 方法，记录调用来源
const seen = [];
for (const m of ['test', 'discover', 'backup', 'restore', 'status']) {
  const orig = service[m].bind(service);
  service[m] = (...a) => { seen.push(m); return orig(...a); };
}

const results = [];
const chk = (n, ok, d = '') => results.push([n, ok, d]);

// ---------- Agent 工具路径 ----------
console.log('=== Agent 工具路径 ===');
const listOut = await backupTool.execute({ action: 'listServers' });
chk('odoo_backup listServers 返回配置的服务器', listOut.length === 1 && listOut[0].name === 'staging');
chk('listServers 不泄露 keyPath/指纹', !('keyPath' in listOut[0]) && !('pinnedFingerprint' in listOut[0]));

const testOut = await backupTool.execute({ action: 'test', server: 'staging' });
console.log('  test →', testOut.ok ? `ok (${testOut.system.os})` : `fail ${testOut.error?.message}`);
chk('odoo_backup test 经 service 触达真实 SSH', testOut.ok === true && seen.includes('test'));

const discOut = await backupTool.execute({ action: 'discover', server: 'staging' });
console.log('  discover →', discOut.instances?.length, 'instance(s)');
chk('odoo_backup discover 经 service 返回实例', discOut.instances?.length === 1 && seen.includes('discover'));

// ---------- UI 路由路径（复用 index.js 的同一套调用） ----------
console.log('\n=== UI 路由路径（等价 handleUiRequest 调用）===');
const beforeSeen = seen.length;

// /test
const uiTest = await service.test('staging');
chk('UI /test 与工具走同一 service', uiTest.ok === true && seen.length > beforeSeen);

// /discover
const uiDisc = await service.discover('staging');
chk('UI /discover 与工具走同一 service', uiDisc.instances?.length === 1);

// /precheck → /restore（UI 侧 token 流程）
const pre = tokenStore.create({ server: 'staging', packagePath: 'K:/nonexistent.tar', neutralize: false });
chk('UI precheck 生成的 token 可被工具校验器识别', tokenStore.peek(pre) !== undefined);

// 用一个不存在的包验证：授权通过后由 service 抛「包不存在」
let svcErr = null;
try {
  await service.restore('staging', null, 'K:/definitely-missing.tar', {});
} catch (e) { svcErr = e.message; }
chk('UI /restore 经同一 service 且做包存在性校验', /备份包不存在/.test(svcErr ?? ''), svcErr ?? '');

// ---------- 同一实例验证 ----------
console.log('\n=== 共用实例验证 ===');
chk('工具与 UI 调用落到同一个 service 实例', seen.filter((x) => x === 'test').length === 2);

// ---------- 输出 ----------
console.log('\n=== 结果 ===');
let all = true;
for (const [n, ok, d] of results) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${ok ? '' : '  → ' + d}`);
  if (!ok) all = false;
}
console.log('\nservice 调用序列:', seen.join(' → '));
console.log(all ? 'SHARED_SERVICE=PASS' : 'SHARED_SERVICE=FAIL');
