import { execRemote } from '../lib/ssh.js';
import { discover } from '../lib/discover.js';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const srv = {
  name: 'staging', host: '119.29.10.202', port: 22, user: 'root',
  keyPath: process.env.USERPROFILE + '/.ssh/toogel_vault',
};
const pkg = process.argv[2];
const scan = await discover(srv);
const inst = scan.instances[0];

// 本地重新抽取 dump.zip（与 restore.js 同一逻辑）
const tmp = await mkdtemp(join(tmpdir(), 'cmp-'));
const { extractDumpZip } = await import('../lib/restore.js');
const dumpPath = await extractDumpZip(pkg, tmp);
const { stat: st } = await import('node:fs/promises');
console.log('本地抽取 dump.zip bytes =', (await st(dumpPath)).size);

// 用本机 python 比对结构
import { execFile } from 'node:child_process';
const py = `
import zipfile, sys
p = sys.argv[1]
print("is_zipfile:", zipfile.is_zipfile(p))
try:
    z = zipfile.ZipFile(p)
    n = z.namelist()
    print("count:", len(n))
    print("has dump.sql:", "dump.sql" in n)
    print("first5:", n[:5])
except Exception as e:
    print("ERR:", repr(e))
`;
const { execFileSync } = await import('node:child_process');
try {
  const out = execFileSync('python3', ['-c', py, dumpPath], { encoding: 'utf8' });
  console.log('--- 本地抽取 dump.zip 结构 ---');
  console.log(out);
} catch (e) {
  console.log('本地 python 失败(可能无 python3):', e.message.slice(0, 200));
}

// 在 staging 生成 fresh dump，比对结构
const remoteDump = '/tmp/cmp-fresh.zip';
const script = `
set -uo pipefail
read -r OC
CINT="/tmp/cmp-\$\$"
docker exec "$OC" mkdir -p "$CINT" || true
docker exec "$OC" odoo db -r "$(docker exec "$OC" printenv USER)" -w "$(docker exec "$OC" printenv PASSWORD)" --db_host "$(docker exec "$OC" printenv HOST)" --db_port 5432 dump --format=zip tg-odoo "$CINT/fresh.zip" 2>/dev/null
docker cp "$OC:$CINT/fresh.zip" "$remoteDump"
docker exec "$OC" rm -rf "$CINT"
echo "DONE"
`;
await execRemote(srv, script, { stdin: [inst.odooContainer].join('\n') + '\n', timeoutMs: 600000 });

// scp 拉回 fresh dump
const localFresh = join(tmp, 'fresh.zip');
const args = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-i', srv.keyPath, `${srv.user}@${srv.host}:${remoteDump}`, localFresh];
await new Promise((res, rej) => {
  const p = spawn('scp', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let e = ''; p.stderr.on('data', (d) => (e += d));
  p.on('error', rej); p.on('close', (c) => (c === 0 ? res() : rej(new Error(e.slice(-200)))));
});
try {
  const out = execFileSync('python3', ['-c', py, localFresh], { encoding: 'utf8' });
  console.log('--- staging fresh dump.zip 结构 ---');
  console.log(out);
} catch (e) {
  console.log('fresh python 失败:', e.message.slice(0, 200));
}

await rm(tmp, { recursive: true, force: true });
