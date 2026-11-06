import { execRemote } from '../lib/ssh.js';
import { discover } from '../lib/discover.js';

// 直接复用 backup.js 导出的 buildDumpScript 的等价逻辑做端到端验证。
// 这里改为：运行一次真实 dump，检查 stdout 的 ===SHA=== 段是否干净。
const srv = {
  host: '119.29.10.202',
  port: 22,
  user: 'root',
  keyPath: process.env.USERPROFILE + '/.ssh/toogel_vault',
};

const scan = await discover(srv);
const inst = scan.instances[0];

// 从 backup.js 内联等价脚本（与已修复版本一致：CLEAN 静默、不产标记行）
const script = `
set -uo pipefail
read -r OC
read -r DB
read -r DB_HOST
read -r DB_PORT
read -r HOST_WD

DB_USER=$(docker exec "$OC" printenv USER 2>/dev/null)
DB_PASS=$(docker exec "$OC" printenv PASSWORD 2>/dev/null)
CINT="/tmp/odoo-dump-int-$$"
docker exec "$OC" mkdir -p "$CINT" || { echo "===ERR==="; echo "mkdir fail"; echo "===END==="; exit 4; }

docker exec "$OC" odoo db -r "$DB_USER" -w "$DB_PASS" --db_host "$DB_HOST" --db_port "$DB_PORT" dump --format=zip "$DB" "$CINT/dump.zip" 2>/dev/null
RC=\${PIPESTATUS[0]}
if [ "$RC" -ne 0 ]; then docker exec "$OC" rm -rf "$CINT"; echo "===RC==="; echo "$RC"; echo "===END==="; exit 0; fi

docker cp "$OC:$CINT/dump.zip" "$HOST_WD/dump.zip"
echo "===SIZE==="
stat -c %s "$HOST_WD/dump.zip" 2>/dev/null || echo 0
echo "===SHA==="
sha256sum "$HOST_WD/dump.zip" 2>/dev/null | awk '{print $1}'
docker exec "$OC" rm -rf "$CINT" 2>/dev/null || true
echo "===RC==="
echo "0"
echo "===END==="
`;

const r = await execRemote(srv, 'read -r D; mkdir -p "$D"; echo OK', {
  stdin: '/tmp/odoo-dump-verify\n', timeoutMs: 30000,
});
if (!r.stdout.includes('OK')) throw new Error('mkdir workdir failed: ' + r.stderr);

const dumpRes = await execRemote(srv, script, {
  stdin: [
    inst.odooContainer,
    inst.dbName,
    inst.dbHost,
    String(inst.dbPort ?? 5432),
    '/tmp/odoo-dump-verify',
  ].join('\n') + '\n',
  timeoutMs: 600000,
});

const section = (t, name, next) => {
  const m = String(t).match(new RegExp(`===${name}===\\n([\\s\\S]*?)(?====${next}===|$)`));
  return m ? m[1].trim() : '';
};

const sha = section(dumpRes.stdout, 'SHA', 'RC');
const size = section(dumpRes.stdout, 'SIZE', 'SHA');
console.log('CODE =', dumpRes.code);
console.log('SIZE =', size);
console.log('SHA  =', sha);
console.log('SHA 行数 =', sha.split('\n').length, '(应为 1)');
console.log('SHA 含非法字符 =', /[^0-9a-f]/.test(sha) ? 'YES (BUG)' : 'NO (clean)');
console.log('--- RAW STDOUT ---');
console.log(dumpRes.stdout);
console.log('--- RAW STDERR (tail) ---');
console.log(dumpRes.stderr.slice(-500));
await execRemote(srv, 'rm -rf /tmp/odoo-dump-verify /tmp/odoo-dump-int-* 2>/dev/null; echo cleaned', { timeoutMs: 30000 });
