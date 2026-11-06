import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { scanHostKey, pinHostKey, readHostKeyFingerprints } from '../lib/knownhosts.js';

const srv = {
  host: '119.29.10.202',
  port: 22,
  user: 'root',
  keyPath: process.env.USERPROFILE + '/.ssh/toogel_vault',
};

const path = join(homedir(), '.ssh', 'known_hosts');
const original = await readFile(path, 'utf8');

const scan = await scanHostKey(srv);
const target = scan.fingerprints[0];
console.log('target fingerprint =', target.fingerprint);

// 备份并删除该主机的所有条目，制造「首次连接」场景
const kept = original
  .split('\n')
  .filter((l) => !l.startsWith('119.29.10.202 ') && !l.startsWith('[119.29.10.202]:'))
  .join('\n');
await writeFile(path, kept, 'utf8');

try {
  const before = await readHostKeyFingerprints(srv);
  console.log('删除后 known_hosts 有该主机条目 =', before.ok, '(应为 false)');

  console.log('\n--- 固化（应真正写入）---');
  const pin = await pinHostKey(srv, target.fingerprint);
  console.log('ok =', pin.ok, '| written =', pin.written, '(应为 true)');

  const after = await readHostKeyFingerprints(srv);
  console.log('固化后读回 =', after.ok);
  if (after.ok) for (const f of after.fingerprints) console.log(`  ${f.type.padEnd(24)} ${f.fingerprint}`);

  const matched = after.ok && after.fingerprints.some(
    (f) => f.fingerprint === target.fingerprint,
  );
  console.log('\n指纹已进入 known_hosts =', matched);

  console.log('\n--- 幂等复查（应不重复写）---');
  const pin2 = await pinHostKey(srv, target.fingerprint);
  console.log('ok =', pin2.ok, '| written =', pin2.written, '(应为 false)');
} finally {
  await writeFile(path, original, 'utf8');
  console.log('\n已恢复原 known_hosts');
}
