/**
 * v0.1.14 真机验证：安全备份的四种边界（目标机 134.175.51.9，只读/可清理）。
 *
 *  1) 库不存在                → SAFETY_SKIP reason=no_db
 *  2) 库存在且 0 张用户表      → SAFETY_SKIP reason=empty_db
 *  3) 有表但没有 Odoo 系统表   → 必须 pg_dump 保护（FORMAT=pgdump），不得跳过
 *  4) 正常 Odoo 库            → odoo db dump（本机目标库是空的，故不在此验证）
 *
 * 探针库用完即删，不留残留。
 */
import { execRemote } from '../lib/ssh.js';
import { buildSafetyBackupScript, parseSafetyBackup } from '../lib/restore.js';

const server = {
  name: 'odoo.toogel.cn',
  host: '134.175.51.9',
  port: 22,
  user: 'root',
  keyPath: 'C:/Users/Ho/.ssh/toogel_vault',
};
const PG = '1Panel-postgresql-TmgT';
const PROBE_DB = 'dsh_probe_nonodo';

const results = [];
const chk = (name, ok, detail = '') => {
  results.push([name, ok]);
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const runSafety = async (db) => {
  const stdin = ['1Panel-odoo-OmjL', PG, 'tugou', db, 'verify'].join('\n') + '\n';
  const r = await execRemote(server, buildSafetyBackupScript(), { stdin, timeoutMs: 180000 });
  return { r, parsed: parseSafetyBackup(r.stdout, r.code), stdout: r.stdout };
};

const psql = async (sql, db = 'postgres') => execRemote(
  server,
  `docker exec ${PG} psql -U tugou -d ${db} -Atc ${JSON.stringify(sql)} 2>&1`,
  { timeoutMs: 60000 },
);

console.log('\n=== 1. 库不存在 → 跳过（no_db）===');
{
  const { parsed } = await runSafety('dsh_definitely_missing_db');
  chk('skipped 且 reason=no_db', parsed.skipped === true && parsed.reason === 'no_db', JSON.stringify(parsed));
}

console.log('\n=== 2. 库存在但 0 张用户表 → 跳过（empty_db）===');
{
  const { parsed } = await runSafety('toogel');
  chk('skipped 且 reason=empty_db', parsed.skipped === true && parsed.reason === 'empty_db', JSON.stringify(parsed));
}

console.log('\n=== 3. 有表但没有 Odoo 系统表 → 必须 pg_dump 保护 ===');
{
  await psql(`DROP DATABASE IF EXISTS ${PROBE_DB}`);
  await psql(`CREATE DATABASE ${PROBE_DB}`);
  await psql('CREATE TABLE probe_only(id int primary key, note text)', PROBE_DB);
  await psql("INSERT INTO probe_only VALUES (1, 'boundary test')", PROBE_DB);

  const { parsed } = await runSafety(PROBE_DB);
  chk('未被跳过（有数据必须保护）', parsed.skipped === false, JSON.stringify(parsed));
  chk('格式为 pgdump', parsed.format === 'pgdump', String(parsed.format));
  chk('产物非空', parsed.size > 0, `size=${parsed.size}`);
  chk('有 sha256', /^[0-9a-f]{64}$/.test(parsed.sha256), parsed.sha256.slice(0, 12));

  if (parsed.path) {
    const clean = await execRemote(server, `rm -f ${JSON.stringify(parsed.path)}; echo CLEANED`, { timeoutMs: 30000 });
    chk('临时产物已清理', clean.stdout.includes('CLEANED'));
  }
  await psql(`DROP DATABASE IF EXISTS ${PROBE_DB}`);
  const left = await psql(`select count(*) from pg_database where datname='${PROBE_DB}'`);
  chk('探针库已删除', left.stdout.includes('0'), left.stdout.trim());
}

const failed = results.filter(([, ok]) => !ok).length;
console.log(`\nRESULT: ${failed === 0 ? 'PASS' : 'FAIL'} (${results.length - failed}/${results.length})`);
process.exit(failed === 0 ? 0 : 1);
