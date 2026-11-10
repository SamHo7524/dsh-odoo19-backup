/**
 * 真机验证：签名密钥重签脚本（含 docker exec 封装与结果解析）。
 *
 * 在目标机上用一个**临时库**跑完整 buildRotateSecretScript()，
 * 绝不对当前正式库 toogel 执行；结束后删除临时库。
 * 断言：密钥确实变化、长度为 36、解析结果 applied=true，且解析结果不含明文密钥。
 */
import { buildRotateSecretScript, parseRotateSecret } from '../lib/restore.js';
import { execRemote } from '../lib/ssh.js';

const server = {
  name: 'odoo.toogel.cn',
  host: '134.175.51.9',
  port: 22,
  user: 'root',
  keyPath: 'C:/Users/Ho/.ssh/toogel_vault',
};

const PG = '1Panel-postgresql-TmgT';
const SU = 'pgsql';
const TMP = 'secret-rotate-e2e-probe';

const results = [];
const chk = (n, ok, d = '') => {
  results.push([n, ok]);
  console.log(`  ${ok ? '✅' : '❌'} ${n}${d ? ` — ${d}` : ''}`);
};

const run = async (cmd) => execRemote(server, cmd, { timeoutMs: 120000 });

try {
  await run(`docker exec ${PG} psql -U ${SU} -d postgres -c "DROP DATABASE IF EXISTS \\"${TMP}\\"" >/dev/null 2>&1 || true`);
  await run(`docker exec ${PG} psql -U ${SU} -d postgres -c "CREATE DATABASE \\"${TMP}\\"" >/dev/null`);
  await run(`docker exec ${PG} psql -U ${SU} -d ${TMP} -c "CREATE TABLE ir_config_parameter(key text, value text)" >/dev/null`);
  await run(`docker exec ${PG} psql -U ${SU} -d ${TMP} -c "INSERT INTO ir_config_parameter VALUES ('database.secret','9f200f36-ac01-4796-9f6e-52c47f076130')" >/dev/null`);

  const before = (await run(`docker exec ${PG} psql -U ${SU} -d ${TMP} -Atc "SELECT value FROM ir_config_parameter WHERE key='database.secret'"`)).stdout.trim();
  chk('临时库已植入原密钥', before === '9f200f36-ac01-4796-9f6e-52c47f076130', before);

  // 与插件完全相同的脚本与参数顺序：PG / SUPER / DB
  const stdin = [PG, SU, TMP].join('\n') + '\n';
  const r = await execRemote(server, buildRotateSecretScript(), { stdin, timeoutMs: 120000 });
  const parsed = parseRotateSecret(r.stdout);

  chk('脚本解析 applied=true', parsed.applied === true, JSON.stringify(parsed));
  chk('changed=true', parsed.changed === true);
  chk('长度仍为 36', parsed.afterLength === 36, String(parsed.afterLength));
  chk('解析结果不含明文密钥', !JSON.stringify(parsed).includes('9f200f36'), JSON.stringify(parsed));

  const after = (await run(`docker exec ${PG} psql -U ${SU} -d ${TMP} -Atc "SELECT value FROM ir_config_parameter WHERE key='database.secret'"`)).stdout.trim();
  chk('库内密钥确实变化', after !== before && after.length === 36, after);
  chk('新密钥是 uuid4 形态', /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(after), after);

  // 幂等性：再跑一次仍应成功且再次变化
  const r2 = await execRemote(server, buildRotateSecretScript(), { stdin, timeoutMs: 120000 });
  const parsed2 = parseRotateSecret(r2.stdout);
  const after2 = (await run(`docker exec ${PG} psql -U ${SU} -d ${TMP} -Atc "SELECT value FROM ir_config_parameter WHERE key='database.secret'"`)).stdout.trim();
  chk('可重复执行且每次不同', parsed2.applied === true && after2 !== after);
} finally {
  await run(`docker exec ${PG} psql -U ${SU} -d postgres -c "DROP DATABASE IF EXISTS \\"${TMP}\\"" >/dev/null 2>&1 || true`);
  console.log('  已清理临时库');
}

const failed = results.filter(([, ok]) => !ok).length;
console.log(`\nRESULT: ${failed === 0 ? 'PASS' : 'FAIL'} (${results.length - failed}/${results.length})`);
process.exit(failed === 0 ? 0 : 1);
