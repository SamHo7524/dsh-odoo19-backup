import { open, stat } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

/**
 * 自描述加密容器格式（纯 Node 内置 crypto，零外部依赖）。
 *
 * 布局：
 *   magic    8 字节   "DSHODOO1"
 *   salt    16 字节   scrypt 盐
 *   iv      12 字节   AES-256-GCM nonce
 *   tag     16 字节   GCM 认证标签（写在密文之后，此处预留在头部位置计算）
 *   ciphertext ...
 *
 * 选择理由：本机可能既无 age 也无 openssl（实测 Windows 默认环境两者皆无），
 * 依赖外部二进制会让「默认强制加密」在生产机上随时失效。
 * Node 的 crypto 是运行时自带能力，跨平台一致。
 *
 * 认证加密（GCM）保证：口令错误或文件被篡改时解密必然失败，不会静默产出垃圾。
 */
const MAGIC = Buffer.from('DSHODOO1', 'latin1');
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;
const SCRYPT_N = 2 ** 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const HEADER_LEN = MAGIC.length + SALT_LEN + IV_LEN;

async function deriveKey(passphrase, salt) {
  return scryptAsync(String(passphrase), salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 128 * SCRYPT_N * SCRYPT_R * 2,
  });
}

/**
 * 读文件头判断格式。
 *
 * age:       "age-encryption.org/"
 * openssl:   "Salted__"（-salt 时的 OpenSSL 容器格式）
 * dsh-odoo:  "DSHODOO1"（本模块产出）
 * plain:     其他
 * empty:     0 字节
 */
export async function detectFormat(path) {
  const fh = await open(path, 'r');
  try {
    // 读 32 字节足够覆盖三种格式的魔数；不必读满 HEADER_LEN
    const buf = Buffer.alloc(32);
    const { bytesRead } = await fh.read(buf, 0, 32, 0);
    if (bytesRead === 0) return 'empty';
    const head = buf.subarray(0, bytesRead);

    if (head.length >= 8 && head.subarray(0, 8).toString('latin1') === MAGIC.toString('latin1')) {
      return 'dsh-odoo';
    }
    if (head.toString('latin1').startsWith('age-encryption.org/')) {
      return 'age';
    }
    if (head.length >= 8 && head.subarray(0, 8).toString('latin1') === 'Salted__') {
      return 'openssl';
    }
    return 'plain';
  } finally {
    await fh.close();
  }
}

export async function isEncrypted(path) {
  const fmt = await detectFormat(path);
  return fmt === 'dsh-odoo' || fmt === 'age' || fmt === 'openssl';
}

async function ensureNonEmpty(path, label) {
  const st = await stat(path);
  if (!st.isFile()) throw new Error(`${label} 不是普通文件：${path}`);
  if (st.size === 0) throw new Error(`${label} 为空文件，拒绝继续`);
  return st.size;
}

/**
 * 加密文件。口令只存在于内存，绝不写入产物。
 * 明文不出现在密文流中（GCM 流式加密）。
 */
export async function encryptFile(src, dst, passphrase) {
  if (!passphrase) throw new Error('加密需要口令');
  await ensureNonEmpty(src, '源文件');

  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const key = await deriveKey(passphrase, salt);

  const cipher = createCipheriv('aes-256-gcm', key, iv);

  const out = createWriteStream(dst, { mode: 0o600 });
  out.write(MAGIC);
  out.write(salt);
  out.write(iv);

  await pipeline(createReadStream(src), cipher, out);

  // GCM 标签在流结束后才可用，追加到文件尾部
  const tag = cipher.getAuthTag();
  await new Promise((resolve, reject) => {
    const fh = createWriteStream(dst, { flags: 'a' });
    fh.on('error', reject);
    fh.end(tag, resolve);
  });

  const st = await stat(dst);
  if (st.size === 0) throw new Error('加密产物为空');
  if (st.size <= HEADER_LEN + TAG_LEN) {
    throw new Error('加密产物异常小，疑似加密失败');
  }
  return { bytes: st.size, format: 'dsh-odoo' };
}

/**
 * 解密文件。口令错误或文件被篡改时抛错，绝不产出部分明文。
 */
export async function decryptFile(src, dst, passphrase) {
  if (!passphrase) throw new Error('解密需要口令');
  const size = await ensureNonEmpty(src, '加密文件');

  if (size <= HEADER_LEN + TAG_LEN) {
    throw new Error('解密失败：文件过小，不是有效的加密备份包');
  }

  const fh = await open(src, 'r');
  let magic;
  let salt;
  let iv;
  try {
    const head = Buffer.alloc(HEADER_LEN);
    const { bytesRead } = await fh.read(head, 0, HEADER_LEN, 0);
    if (bytesRead < HEADER_LEN) {
      throw new Error('解密失败：文件头不完整');
    }
    magic = head.subarray(0, 8);
    salt = head.subarray(8, 8 + SALT_LEN);
    iv = head.subarray(8 + SALT_LEN, HEADER_LEN);

    if (magic.toString('latin1') !== MAGIC.toString('latin1')) {
      const fmt = await detectFormat(src);
      throw new Error(
        `解密失败：不是本插件产出的加密包（检测到格式 ${fmt}）。` +
          (fmt === 'age' || fmt === 'openssl'
            ? '请使用对应工具解密后再恢复。'
            : '请确认文件是否完整。'),
      );
    }
  } finally {
    await fh.close();
  }

  // 读尾部 GCM tag
  const tagFh = await open(src, 'r');
  let tag;
  try {
    tag = Buffer.alloc(TAG_LEN);
    await tagFh.read(tag, 0, TAG_LEN, size - TAG_LEN);
  } finally {
    await tagFh.close();
  }

  const key = await deriveKey(passphrase, salt);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);

  try {
    await pipeline(
      createReadStream(src, { start: HEADER_LEN, end: size - TAG_LEN - 1 }),
      decipher,
      createWriteStream(dst, { mode: 0o600 }),
    );
  } catch (e) {
    // 认证失败时不留下半成品
    const { rm } = await import('node:fs/promises');
    await rm(dst, { force: true });
    throw new Error(
      `解密失败（口令错误或文件损坏）：${String(e.message ?? e).slice(0, 200)}`,
    );
  }

  const outSt = await stat(dst);
  if (outSt.size === 0) {
    const { rm } = await import('node:fs/promises');
    await rm(dst, { force: true });
    throw new Error('解密失败：产出为空，口令可能错误');
  }

  return { bytes: outSt.size };
}
