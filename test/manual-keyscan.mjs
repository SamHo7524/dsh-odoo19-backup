import {
  scanHostKey,
  pinHostKey,
  checkHostKey,
  readHostKeyFingerprints,
} from '../lib/knownhosts.js';

const srv = {
  host: '119.29.10.202',
  port: 22,
  user: 'root',
  keyPath: process.env.USERPROFILE + '/.ssh/toogel_vault',
};

console.log('=== 1. 扫描主机指纹（不认证、不写 known_hosts）===');
const scan = await scanHostKey(srv);
if (!scan.ok) {
  console.log('FAILED:', JSON.stringify(scan.error, null, 2));
  process.exit(1);
}
for (const f of scan.fingerprints) {
  console.log(`  ${f.type.padEnd(24)} ${f.fingerprint}`);
}

const target = scan.fingerprints[0];

console.log('\n=== 2. 用错误指纹校验，必须拒绝 ===');
const bad = await checkHostKey(srv, 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
console.log('  ok =', bad.ok, '| kind =', bad.ok ? '(UNEXPECTED)' : bad.error.kind);

console.log('\n=== 3. 用空指纹校验，必须拒绝（fail-closed）===');
const none = await checkHostKey(srv, '');
console.log('  ok =', none.ok, '| kind =', none.ok ? '(UNEXPECTED)' : none.error.kind);

console.log('\n=== 4. 固化前读取 known_hosts ===');
const before = await readHostKeyFingerprints(srv);
console.log('  ok =', before.ok, '|', before.ok ? before.fingerprints.map((f) => f.fingerprint).join(', ') : before.error.message);

console.log('\n=== 5. 用正确指纹固化 ===');
const pin = await pinHostKey(srv, target.fingerprint);
console.log('  ok =', pin.ok, '| written =', pin.written, '| fp =', pin.fingerprint);
if (!pin.ok) console.log('  error =', JSON.stringify(pin.error, null, 2));

console.log('\n=== 6. 固化后读取 known_hosts（独立证据）===');
const after = await readHostKeyFingerprints(srv);
console.log('  ok =', after.ok);
if (after.ok) {
  for (const f of after.fingerprints) console.log(`  ${f.type.padEnd(24)} ${f.fingerprint}`);
}

console.log('\n=== 7. 固化后校验，必须通过 ===');
const good = await checkHostKey(srv, target.fingerprint);
console.log('  ok =', good.ok, good.ok ? `| matched ${good.matched.type}` : JSON.stringify(good.error));

console.log('\n=== 8. 幂等：再次固化不应重复写入 ===');
const pin2 = await pinHostKey(srv, target.fingerprint);
console.log('  ok =', pin2.ok, '| written =', pin2.written, '(应为 false)');
