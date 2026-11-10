/**
 * v0.1.14 真机验证：空白目标机（odoo.toogel.cn）的安全备份路径与域名守卫。
 *
 * 只读验证：目标库是空壳库，安全备份走「跳过」分支（不产生 dump、不动数据）；
 * 域名守卫因未装 website 模块而跳过（不执行 UPDATE、不重启容器）。
 */
import { execRemote } from '../lib/ssh.js';
import { buildSafetyBackupScript, parseSafetyBackup } from '../lib/restore.js';
import { buildDomainPatchScript, parseDomainPatch, resolveTargetDomain } from '../lib/site-domain.js';

const server = {
  name: 'odoo.toogel.cn',
  host: '134.175.51.9',
  port: 22,
  user: 'root',
  keyPath: 'C:/Users/Ho/.ssh/toogel_vault',
};
const instance = {
  odooContainer: '1Panel-odoo-OmjL',
  pgContainer: '1Panel-postgresql-TmgT',
  pgSuperUser: 'tugou',
  dbUser: 'tugou',
  dbName: 'toogel',
};

const results = [];
const chk = (name, ok, detail = '') => {
  results.push([name, ok]);
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};

console.log('\n=== 1. 安全备份：空目标库应「跳过」而不是 DUMP_FAIL ===');
{
  const stdin = [
    instance.odooContainer,
    instance.pgContainer,
    instance.pgSuperUser,
    instance.dbName,
    '20261109-verify',
  ].join('\n') + '\n';
  const r = await execRemote(server, buildSafetyBackupScript(), { stdin, timeoutMs: 120000 });
  const parsed = parseSafetyBackup(r.stdout, r.code);
  chk('脚本退出码为 0', r.code === 0, `code=${r.code}`);
  chk('判定为 skipped（不是失败）', parsed.skipped === true, JSON.stringify(parsed));
  chk('跳过原因是无架构', parsed.reason === 'no_schema', parsed.reason);
  chk('输出不含 DUMP_FAIL', !r.stdout.includes('DUMP_FAIL'));
}

console.log('\n=== 2. 域名守卫：未装 website 模块应安全跳过 ===');
{
  const domain = resolveTargetDomain({ server });
  chk('服务器名可作域名', domain === 'odoo.toogel.cn', String(domain));
  const stdin = [
    instance.odooContainer,
    instance.pgContainer,
    instance.pgSuperUser,
    instance.dbName,
    domain,
  ].join('\n') + '\n';
  const r = await execRemote(server, buildDomainPatchScript(), { stdin, timeoutMs: 120000 });
  const parsed = parseDomainPatch(r.stdout);
  chk('域名补丁安全跳过', parsed.ok === true && parsed.skipped === true, JSON.stringify(parsed));
  chk('跳过原因 no_website', parsed.reason === 'no_website', parsed.reason);
}

const failed = results.filter(([, ok]) => !ok).length;
console.log(`\nRESULT: ${failed === 0 ? 'PASS' : 'FAIL'} (${results.length - failed}/${results.length})`);
process.exit(failed === 0 ? 0 : 1);
