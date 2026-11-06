import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  encryptFile,
  decryptFile,
  detectFormat,
  isEncrypted,
} from '../lib/crypto.js';

test('加密后解密能还原原文', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'crypto-test-'));
  try {
    const src = join(dir, 'plain.txt');
    const enc = join(dir, 'plain.enc');
    const dec = join(dir, 'plain.dec');
    const content = 'hello odoo backup 中文测试 ' + 'x'.repeat(500);
    await writeFile(src, content, 'utf8');

    await encryptFile(src, enc, 'test-passphrase-123');
    await decryptFile(enc, dec, 'test-passphrase-123');

    assert.equal(await readFile(dec, 'utf8'), content);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('错误口令解密失败', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'crypto-test-'));
  try {
    const src = join(dir, 'p.txt');
    const enc = join(dir, 'p.enc');
    const dec = join(dir, 'p.dec');
    await writeFile(src, 'secret data here', 'utf8');
    await encryptFile(src, enc, 'right-pass');
    await assert.rejects(
      () => decryptFile(enc, dec, 'wrong-pass'),
      /解密失败|decrypt|bad/i,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('加密产物与原文不同且非空', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'crypto-test-'));
  try {
    const src = join(dir, 'a.txt');
    const enc = join(dir, 'a.enc');
    const content = 'plaintext that must not appear in ciphertext';
    await writeFile(src, content, 'utf8');

    await encryptFile(src, enc, 'pass-abc');

    const encBuf = await readFile(enc);
    assert.ok(encBuf.length > 0, '加密产物不得为空');
    assert.ok(
      !encBuf.toString('utf8').includes(content),
      '密文不得包含明文',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('空文件拒绝加密', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'crypto-test-'));
  try {
    const src = join(dir, 'empty.txt');
    await writeFile(src, '', 'utf8');
    await assert.rejects(
      () => encryptFile(src, join(dir, 'e.enc'), 'p'),
      /空文件/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('不存在的文件拒绝加密', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'crypto-test-'));
  try {
    await assert.rejects(
      () => encryptFile(join(dir, 'nope.txt'), join(dir, 'o.enc'), 'p'),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('detectFormat 识别明文 tar', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'crypto-test-'));
  try {
    const p = join(dir, 'plain.tar');
    // tar 文件在 offset 257 处有 "ustar"
    const buf = Buffer.alloc(512);
    buf.write('ustar', 257, 'latin1');
    await writeFile(p, buf);
    assert.equal(await detectFormat(p), 'plain');
    assert.equal(await isEncrypted(p), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('detectFormat 识别 openssl Salted__ 头', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'crypto-test-'));
  try {
    const p = join(dir, 'fake.enc');
    await writeFile(p, Buffer.concat([Buffer.from('Salted__'), Buffer.alloc(32, 1)]));
    assert.equal(await detectFormat(p), 'openssl');
    assert.equal(await isEncrypted(p), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('detectFormat 识别 age 头（仅用于识别外部包）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'crypto-test-'));
  try {
    const p = join(dir, 'fake.age');
    await writeFile(p, Buffer.from('age-encryption.org/v1\n-> X25519 abc\n'));
    assert.equal(await detectFormat(p), 'age');
    assert.equal(await isEncrypted(p), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('detectFormat 识别空文件', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'crypto-test-'));
  try {
    const p = join(dir, 'empty.bin');
    await writeFile(p, '');
    assert.equal(await detectFormat(p), 'empty');
    assert.equal(await isEncrypted(p), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('加密产物格式为 dsh-odoo 且可识别', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'crypto-test-'));
  try {
    const src = join(dir, 'b.txt');
    const enc = join(dir, 'b.enc');
    await writeFile(src, 'z'.repeat(300), 'utf8');
    await encryptFile(src, enc, 'pw');

    assert.equal(await detectFormat(enc), 'dsh-odoo');
    assert.equal(await isEncrypted(enc), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('密文不含明文片段（含长重复串）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'crypto-test-'));
  try {
    const src = join(dir, 'c.txt');
    const enc = join(dir, 'c.enc');
    const marker = 'UNIQUE_MARKER_' + 'A'.repeat(200);
    await writeFile(src, marker.repeat(10), 'utf8');
    await encryptFile(src, enc, 'pw');

    const buf = await readFile(enc);
    assert.ok(!buf.toString('latin1').includes('UNIQUE_MARKER_'), '密文不得含明文标记');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('篡改密文导致解密失败（GCM 认证）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'crypto-test-'));
  try {
    const src = join(dir, 'd.txt');
    const enc = join(dir, 'd.enc');
    const dec = join(dir, 'd.dec');
    await writeFile(src, 'x'.repeat(500), 'utf8');
    await encryptFile(src, enc, 'pw');

    const buf = await readFile(enc);
    buf[buf.length - 20] ^= 0xff; // 破坏密文或 tag
    await writeFile(enc, buf);

    await assert.rejects(() => decryptFile(enc, dec, 'pw'), /解密失败/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('解密非本插件格式时给出明确原因', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'crypto-test-'));
  try {
    const p = join(dir, 'plain.tar');
    const buf = Buffer.alloc(2048);
    buf.write('ustar', 257, 'latin1');
    await writeFile(p, buf);

    await assert.rejects(
      () => decryptFile(p, join(dir, 'o.bin'), 'pw'),
      /不是本插件产出的加密包/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('不同口令产生不同密文（盐随机）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'crypto-test-'));
  try {
    const src = join(dir, 'e.txt');
    await writeFile(src, 'same content', 'utf8');

    const e1 = join(dir, 'e1.enc');
    const e2 = join(dir, 'e2.enc');
    await encryptFile(src, e1, 'pw');
    await encryptFile(src, e2, 'pw');

    const b1 = await readFile(e1);
    const b2 = await readFile(e2);
    assert.ok(!b1.equals(b2), '相同明文+相同口令的两次加密应因随机盐而不同');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('isEncrypted 识别本插件 dsh-odoo 格式（备份侧接入点）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'crypto-test-'));
  try {
    const src = join(dir, 'a.txt');
    const enc = join(dir, 'a.enc');
    await writeFile(src, 'x'.repeat(100), 'utf8');
    await encryptFile(src, enc, 'pass');
    assert.equal(await isEncrypted(enc), true);
    assert.equal(await detectFormat(enc), 'dsh-odoo');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('isEncrypted 对明文 tar 返回 false', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'crypto-test-'));
  try {
    const p = join(dir, 'plain.tar');
    await writeFile(p, Buffer.from([0x75, 0x73, 0x74, 0x61, 0x72])); // "ustar"
    assert.equal(await isEncrypted(p), false);
    assert.equal(await detectFormat(p), 'plain');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('detectFormat 对空文件返回 empty', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'crypto-test-'));
  try {
    const p = join(dir, 'empty');
    await writeFile(p, '');
    assert.equal(await detectFormat(p), 'empty');
    assert.equal(await isEncrypted(p), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('备份侧：加密产物非空且可解密还原', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'crypto-test-'));
  try {
    const src = join(dir, 'backup.tar');
    await writeFile(src, 'y'.repeat(2000), 'utf8');
    const enc = join(dir, 'backup.tar.enc');
    await encryptFile(src, enc, 'backup-pass');
    assert.ok((await stat(enc)).size > 0);
    assert.equal(await isEncrypted(enc), true);
    const dec = join(dir, 'backup.dec.tar');
    await decryptFile(enc, dec, 'backup-pass');
    assert.equal(await readFile(dec, 'utf8'), 'y'.repeat(2000));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

