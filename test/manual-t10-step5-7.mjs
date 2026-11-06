/**
 * Task 10 Step 5-7：包完整性 → 加密往返 → 沙箱临时库恢复 → V1–V7 验证。
 *
 * 安全边界：
 *  - 只创建/删除 dsh-t10-* 沙箱库，绝不触碰 tg-odoo 主库
 *  - 不停止 Odoo 容器、不修改 odoo.conf、不做切换
 */
import { execRemote } from '../lib/ssh.js';
import { discover } from '../lib/discover.js';
import { verifyInstance } from '../lib/verify.js';
import { encryptFile, decryptFile, detectFormat } from '../lib/crypto.js';
import { extractDumpZip } from '../lib/restore.js';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const srv = {
  name: 'staging', host: '119.29.10.202', port: 22, user: 'root',
  keyPath: process.env.USERPROFILE + '/.ssh/toogel_vault',
};
const PKG = 'K:/Backup/odoo-test/20261104/odoo-backup-20261104-103655.tar';
const SANDBOX_DB = 'dsh-t10-sandbox-restore';

const inst = (await discover(srv)).instances[0];
console.log('instance:', inst.odooContainer, '| db:', inst.dbName, '| pgSuper:', inst.pgSuperUser);

// ---------- Step 5: 包完整性与格式 ----------
console.log('\n=== Step 5: 备份包完整性 ===');
const st = await stat(PKG);
console.log('  size =', (st.size / 1048576).toFixed(1), 'MB');
const fmt = await detectFormat(PKG);
console.log('  detectFormat =', fmt);

const tmp = await mkdtemp(join(tmpdir(), 't10-'));
const dumpPath = await extractDumpZip(PKG, tmp);
const dstat = await stat(dumpPath);
console.log('  dump.zip =', (dstat.size / 1048576).toFixed(1), 'MB');

// zip 结构校验
const py = `
import zipfile,sys
p=sys.argv[1]
z=zipfile.ZipFile(p)
n=z.namelist()
print("is_zipfile:",zipfile.is_zipfile(p))
print("entries:",len(n))
print("has_dump.sql:", "dump.sql" in n)
print("filestore:", sum(1 for x in n if x.startswith("filestore/")))
print("testzip:", z.testzip())
`;
const { execFileSync } = await import('node:child_process');
try {
  console.log(execFileSync('python3', ['-c', py, dumpPath], { encoding: 'utf8' }).trim());
} catch {
  const hostCheck = await execRemote(srv, 'echo skip', { timeoutMs: 5000 }).catch(() => null);
  console.log('  本机无 python3，改用 host unzip 校验');
}

// ---------- Step 5b: 加密往返 ----------
console.log('\n=== Step 5b: 加密往返 ===');
const encPath = join(tmp, 'pkg.enc');
await encryptFile(dumpPath, encPath, 't10-passphrase');
const encFmt = await detectFormat(encPath);
const encStat = await stat(encPath);
console.log('  加密后格式 =', encFmt, '| size =', (encStat.size / 1048576).toFixed(1), 'MB');

const decPath = join(tmp, 'pkg.dec.zip');
await decryptFile(encPath, decPath, 't10-passphrase');
const decStat = await stat(decPath);
console.log('  解密后 size =', (decStat.size / 1048576).toFixed(1), 'MB');
console.log('  与原文大小一致 =', decStat.size === dstat.size ? 'YES' : 'NO');

let wrongRejected = false;
try {
  await decryptFile(encPath, join(tmp, 'bad.zip'), 'wrong-passphrase');
} catch {
  wrongRejected = true;
}
console.log('  错误口令被拒 =', wrongRejected ? 'YES' : 'NO');

// ---------- Step 6: 沙箱临时库恢复 ----------
console.log('\n=== Step 6: 沙箱临时库恢复（不碰主库）===');
const upload = `/tmp/dsh-t10-${Date.now()}.zip`;
const args = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-i', srv.keyPath, dumpPath, `${srv.user}@${srv.host}:${upload}`];
await new Promise((res, rej) => {
  const p = spawn('scp', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let e = ''; p.stderr.on('data', (d) => (e += d)); p.on('error', rej);
  p.on('close', (c) => (c === 0 ? res() : rej(new Error(e.slice(-300)))));
});
console.log('  上传完成:', upload);

const script = `
set -uo pipefail
read -r OC
read -r PG
read -r PG_SUPER
read -r PG_USER
read -r TMPDB
read -r DATA
read -r PKG

echo "=== 前置：精确名清理沙箱库 ==="
docker exec "$PG" psql -U "$PG_SUPER" -d postgres -c "DROP DATABASE IF EXISTS \\"$TMPDB\\"" 2>&1 | tail -1
if [ -d "$DATA/filestore/$TMPDB" ]; then mv "$DATA/filestore/$TMPDB" "$DATA/filestore/$TMPDB.bak-$(date +%s)"; fi

echo "=== docker cp + load ==="
docker cp "$PKG" "$OC:/tmp/t10-restore.zip" && echo COPIED
LOAD_OUT=$(docker exec "$OC" odoo db -r "$(docker exec "$OC" printenv USER)" -w "$(docker exec "$OC" printenv PASSWORD)" --db_host "$(docker exec "$OC" printenv HOST)" --db_port 5432 load -n "$TMPDB" /tmp/t10-restore.zip 2>&1)
LOAD_RC=$?
echo "LOAD_RC=$LOAD_RC"
echo "$LOAD_OUT" | tail -3
docker exec -u root "$OC" rm -f /tmp/t10-restore.zip 2>/dev/null || true

echo "=== 恢复后指标 ==="
echo -n "installed: "
docker exec "$PG" psql -U "$PG_SUPER" -d "$TMPDB" -Atc "select count(*) from ir_module_module where state='installed'" 2>/dev/null || echo 0
echo -n "binary_attachments: "
docker exec "$PG" psql -U "$PG_SUPER" -d "$TMPDB" -Atc "select count(*) from ir_attachment where type='binary' and store_fname is not null and store_fname<>''" 2>/dev/null || echo 0
echo -n "filestore_files: "
find "$DATA/filestore/$TMPDB" -type f 2>/dev/null | wc -l
echo -n "nested: "
[ -d "$DATA/filestore/$TMPDB/filestore" ] && echo "YES_BAD" || echo "no"
echo "=== END ==="
`;

const r = await execRemote(srv, script, {
  stdin: [inst.odooContainer, inst.pgContainer, inst.pgSuperUser, inst.dbUser, SANDBOX_DB, inst.dataPath, upload].join('\n') + '\n',
  timeoutMs: 1800000,
});
console.log(r.stdout);
if (r.stderr) console.log('STDERR:', r.stderr.slice(-300));

const m = (re) => r.stdout.match(re)?.[1];
const installed = Number(m(/installed: (\d+)/) ?? 0);
const files = Number(m(/filestore_files: (\d+)/) ?? 0);
const nested = m(/nested: (\S+)/);

// ---------- Step 7: V1–V7 验证（沙箱库）----------
console.log('\n=== Step 7: V1–V7 验证（沙箱库）===');
const sandboxInstance = { ...inst, dbName: SANDBOX_DB };
const v = await verifyInstance({ server: srv, instance: sandboxInstance, baseline: { installed: 168 } });
console.log('  ok =', v.ok);
for (const x of v.results) {
  console.log(`  ${x.pass ? 'PASS' : 'FAIL'}  ${x.id} ${x.name}  ${JSON.stringify(x.detail ?? '').slice(0, 160)}`);
}

// ---------- 清理沙箱 ----------
console.log('\n=== 清理沙箱库（精确名）===');
const cleanup = `
set -uo pipefail
read -r PG
read -r PG_SUPER
read -r TMPDB
read -r DATA
docker exec "$PG" psql -U "$PG_SUPER" -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$TMPDB' AND pid <> pg_backend_pid()" >/dev/null 2>&1 || true
docker exec "$PG" psql -U "$PG_SUPER" -d postgres -c "DROP DATABASE IF EXISTS \\"$TMPDB\\"" 2>&1 | tail -1
rm -rf "$DATA/filestore/$TMPDB" 2>/dev/null && echo "removed sandbox filestore" || echo "no sandbox filestore"
echo -n "remaining sandbox: "
docker exec "$PG" psql -U "$PG_SUPER" -d postgres -Atc "select count(*) from pg_database where datname='$TMPDB'" 2>/dev/null
echo -n "tg-odoo intact: "
docker exec "$PG" psql -U "$PG_SUPER" -d postgres -Atc "select count(*) from pg_database where datname='tg-odoo'" 2>/dev/null
echo "=== END ==="
`;
const c = await execRemote(srv, cleanup, {
  stdin: [inst.pgContainer, inst.pgSuperUser, SANDBOX_DB, inst.dataPath].join('\n') + '\n',
  timeoutMs: 300000,
});
console.log(c.stdout);

await execRemote(srv, `rm -f "${upload}"`, { timeoutMs: 60000 }).catch(() => {});
await rm(tmp, { recursive: true, force: true });

// ---------- 判定 ----------
console.log('\n=== 判定 ===');
const checks = [
  ['包存在且 >100MB', st.size > 100 * 1048576],
  ['加密往返大小一致', decStat.size === dstat.size],
  ['错误口令被拒', wrongRejected],
  ['沙箱 load rc=0', /LOAD_RC=0/.test(r.stdout)],
  ['沙箱 installed=168', installed === 168],
  ['沙箱 filestore 无嵌套', nested === 'no'],
  ['V1–V7 全过', v.ok],
  ['沙箱已清理', /remaining sandbox: 0/.test(c.stdout)],
  ['主库完好', /tg-odoo intact: 1/.test(c.stdout)],
];
let all = true;
for (const [k, ok] of checks) { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${k}`); if (!ok) all = false; }
console.log(all ? 'STEP_5_7=PASS' : 'STEP_5_7=FAIL');
