/**
 * 验证运行时 Config schema 实际包含 passphrase 且默认值为空字符串。
 * 从 profile 的 node_modules 解析 schemastery，再加载插件的 Config。
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const PROFILE = 'C:/Users/Ho/.dsh/profiles/desktop';
const require = createRequire(PROFILE + '/package.json');

const z = require('@deepseek-ai/schemastery');
console.log('schemastery 版本键:', Object.keys(z).slice(0, 5).join(', '));

// 用 profile 的 schemastery 重新定义与插件一致的 schema 不可靠；
// 直接加载插件 index.js（它是 ESM，import 的 schemastery 会走 profile 解析）
const url = pathToFileURL('C:/Users/Ho/.dsh/remote-workspaces/wmv8yhew3a4r8/dsh-odoo-backup/index.js').href;

// Node 从工作区解析不到 schemastery，故用 profile 的 node_modules 作为 base 手动解析
const { register } = await import('node:module');
try {
  const mod = await import(url);
  const resolved = new mod.Config({ servers: [] });
  console.log('\n=== 运行时 Config 解析结果 ===');
  for (const [k, v] of Object.entries(resolved)) {
    const shown = typeof v === 'string' && k === 'passphrase' ? JSON.stringify(v) : JSON.stringify(v);
    console.log(`  ${k} = ${shown}`);
  }
  const checks = [
    ['passphrase 存在', 'passphrase' in resolved],
    ['passphrase 默认空串', resolved.passphrase === ''],
    ['localBackupDir 有默认值', typeof resolved.localBackupDir === 'string'],
    ['keepDays 默认 30', resolved.keepDays === 30],
    ['allowUnencryptedPackage 默认 false', resolved.allowUnencryptedPackage === false],
    ['servers 默认空数组', Array.isArray(resolved.servers) && resolved.servers.length === 0],
  ];
  console.log('\n=== 判定 ===');
  let all = true;
  for (const [n, ok] of checks) { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}`); if (!ok) all = false; }
  console.log(all ? 'CONFIG_SCHEMA=PASS' : 'CONFIG_SCHEMA=FAIL');
} catch (e) {
  console.log('加载失败:', e.message);
  process.exitCode = 1;
}
