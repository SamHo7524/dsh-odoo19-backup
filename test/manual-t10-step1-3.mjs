/**
 * Task 10 Step 1-3：服务器配置 → SSH 连接 → 指纹确认 → discover 环境。
 * 只读操作，不修改远端任何状态。
 */
import { testConnection, guardHostKey } from '../lib/ssh.js';
import { discover } from '../lib/discover.js';
import { readHostKeyFingerprints } from '../lib/knownhosts.js';

const srv = {
  name: 'staging', host: '119.29.10.202', port: 22, user: 'root',
  keyPath: process.env.USERPROFILE + '/.ssh/toogel_vault',
};

console.log('=== Step 2a: 当前主机指纹 ===');
let fps = [];
try {
  const r = await readHostKeyFingerprints(srv);
  if (r.ok) {
    fps = r.fingerprints;
    console.log('  known_hosts:', r.path);
    for (const f of fps) console.log(`  ${f.type}: ${f.fingerprint}`);
  } else {
    console.log('  未找到 known_hosts 条目:', r.error?.message ?? '');
  }
} catch (e) {
  console.log('  读取指纹失败:', e.message);
}

if (!fps.length) {
  console.log('\n  → known_hosts 无条目，先扫描主机密钥');
  const { scanHostKey } = await import('../lib/knownhosts.js');
  const sc = await scanHostKey(srv);
  console.log('  scan ok =', sc.ok, '| 指纹 =', sc.fingerprint ?? '-', '| type =', sc.keyType ?? '-');
  if (!sc.ok) throw new Error('扫描主机密钥失败: ' + JSON.stringify(sc.error));
  fps = [{ type: sc.keyType, fingerprint: sc.fingerprint }];
}

console.log('\n=== Step 2b: 未固定指纹时应 fail-closed ===');
const unpinned = await guardHostKey(srv);
console.log('  ok =', unpinned.ok, '| mode =', unpinned.mode ?? '-', '| kind =', unpinned.error?.kind ?? '-');
if (unpinned.ok) throw new Error('闸门未生效！未固定指纹竟然放行');

console.log('\n=== Step 2c: 固定指纹后应放行 ===');
const pinned = { ...srv, pinnedFingerprint: fps[0]?.fingerprint };
const gated = await guardHostKey(pinned);
console.log('  ok =', gated.ok, '| mode =', gated.mode ?? '-');
if (!gated.ok) throw new Error('固定正确指纹后仍被拒：' + (gated.error?.message ?? ''));

console.log('\n=== Step 2d: 测试连接 ===');
const t = await testConnection(srv);
if (!t.ok) throw new Error('连接失败: ' + JSON.stringify(t.error));
console.log('  os       =', t.system.os);
console.log('  kernel   =', t.system.kernel);
console.log('  cpu      =', t.system.cpuCores);
console.log('  memAvail =', t.system.memAvailableMb, 'MB');
console.log('  diskFree =', t.system.diskFreeMb, 'MB');
console.log('  docker   =', t.tools.docker);
console.log('  zstd     =', t.tools.zstd);

console.log('\n=== Step 3: discover 环境 ===');
const d = await discover(srv);
if (!d?.instances?.length) throw new Error('discover 失败: ' + JSON.stringify(d));
for (const i of d.instances) {
  console.log('  kind        =', i.kind);
  console.log('  odooContainer =', i.odooContainer);
  console.log('  pgContainer =', i.pgContainer);
  console.log('  odooVersion =', i.odooVersion);
  console.log('  dbName      =', i.dbName);
  console.log('  dbHost/dbUser =', i.dbHost, '/', i.dbUser);
  console.log('  pgSuperUser =', i.pgSuperUser);
  console.log('  addonsPath  =', i.addonsPath);
  console.log('  dataPath    =', i.dataPath);
  console.log('  confPath    =', i.confPath);
}
console.log('\nSTEP_1_3=PASS');
