/**
 * Task 11 前置：加密失败关闭机制确认（只读源码 + 纯本地实测，不触达任何远端）。
 *
 * 检查「关闭」的语义：任何加密/解密异常都必须抛错并阻断流程，
 * 绝不产出「看似成功但明文/部分解密」的产物。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, writeFile, stat, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  encryptFile, decryptFile, detectFormat, isEncrypted,
} from '../lib/crypto.js';

const tmp = await mkdtemp(join(tmpdir(), 't11-crypto-'));
const src = join(tmp, 'plain.bin');
const enc = join(tmp, 'pkg.enc');
await writeFile(src, Buffer.from('ODOO-BACKUP-PLAINTEXT-CONTENT-1234567890'));

const results = [];
const chk = (n, ok, d = '') => results.push([n, ok, d]);

// 1. 加密需要口令
try {
  await encryptFile(src, join(tmp, 'x.enc'), '');
  chk('无口令加密被拒', false, '未抛错');
} catch (e) {
  chk('无口令加密被拒', /口令/.test(e.message), e.message);
}

// 2. 空文件加密被拒
const empty = join(tmp, 'empty.bin');
await writeFile(empty, Buffer.alloc(0));
try {
  await encryptFile(empty, join(tmp, 'e.enc'), 'pw');
  chk('空文件加密被拒', false);
} catch (e) {
  chk('空文件加密被拒', /为空/.test(e.message), e.message);
}

// 3. 正常加密与格式识别
await encryptFile(src, enc, 'correct-pass');
chk('加密产物标记为已加密', await isEncrypted(enc));
chk('detectFormat 识别 dsh-odoo', (await detectFormat(enc)) === 'dsh-odoo');
const plainBytes = await readFile(src);
const encBytes = await readFile(enc);
chk('密文不含明文片段', !encBytes.includes(Buffer.from('ODOO-BACKUP-PLAINTEXT')));

// 4. 错误口令解密被拒（GCM 认证失败）
try {
  await decryptFile(enc, join(tmp, 'bad.dec'), 'wrong-pass');
  chk('错误口令解密被拒', false, '未抛错');
} catch (e) {
  chk('错误口令解密被拒', /解密失败|认证|口令|tag|auth/i.test(e.message), e.message);
}

// 5. 篡改密文被拒
const tampered = join(tmp, 'tampered.enc');
const t = Buffer.from(encBytes);
t[t.length - 1] ^= 0xff;
await writeFile(tampered, t);
try {
  await decryptFile(tampered, join(tmp, 't.dec'), 'correct-pass');
  chk('篡改密文被拒', false, '未抛错');
} catch (e) {
  chk('篡改密文被拒', /解密失败|认证|tag|auth/i.test(e.message), e.message);
}

// 6. 截断密文被拒
const truncated = join(tmp, 'trunc.enc');
await writeFile(truncated, encBytes.subarray(0, 20));
try {
  await decryptFile(truncated, join(tmp, 'tr.dec'), 'correct-pass');
  chk('截断密文被拒', false, '未抛错');
} catch (e) {
  chk('截断密文被拒', /过小|不是有效|解密失败/i.test(e.message), e.message);
}

// 7. 正确口令往返
const dec = join(tmp, 'ok.dec');
await decryptFile(enc, dec, 'correct-pass');
chk('正确口令往返字节一致', (await readFile(dec)).equals(plainBytes));

// 8. 解密失败不留下部分明文产物
const before = (await stat(join(tmp, 'bad.dec')).catch(() => null));
chk('错误口令未产出部分明文', before === null || before.size === 0);

// 9. 明文格式识别（restore 侧据此拒绝）
const plainTar = join(tmp, 'plain.tar');
await writeFile(plainTar, Buffer.from('ustar-fake-plain-content'));
chk('明文包 detectFormat=plain', (await detectFormat(plainTar)) === 'plain');
chk('明文包 isEncrypted=false', !(await isEncrypted(plainTar)));
chk('空文件 detectFormat=empty', (await detectFormat(empty)) === 'empty');

// 10. 备份侧 fail-closed（U4 决策后）：无口令必须拒绝，不得降级为明文
const backupSrc = await readFile(new URL('../lib/backup.js', import.meta.url), 'utf8');
const hasEntryGate = /typeof passphrase !== 'string' \|\| passphrase\.trim\(\) === ''[\s\S]{0,300}拒绝备份/.test(backupSrc);
chk('备份侧入口门禁：无口令即拒绝（U4 fail-closed）', hasEntryGate);
const noPlainDowngrade = !/警告：未提供加密口令，备份单元以明文保存/.test(backupSrc);
chk('备份侧已移除明文降级分支', noPlainDowngrade);

const restoreSrc = await readFile(new URL('../lib/restore.js', import.meta.url), 'utf8');
const restoreRejectsPlain = /format === 'plain'[\s\S]{0,400}默认拒绝恢复未加密包/.test(restoreSrc);
chk('恢复侧默认拒绝明文包（fail-closed）', restoreRejectsPlain);

await rm(tmp, { recursive: true, force: true });

console.log('=== 加密失败关闭机制确认 ===');
let all = true;
for (const [n, ok, d] of results) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${ok ? '' : '  → ' + d}`);
  if (!ok) all = false;
}
console.log(`\n共 ${results.length} 项`);
console.log(all ? 'CRYPTO_FAILCLOSED=PASS' : 'CRYPTO_FAILCLOSED=FAIL');
