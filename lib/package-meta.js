/**
 * v0.1.14 — 从备份包读取源数据库名（只读）。
 *
 * 实证：本插件产出的备份包内 MANIFEST.json 已含 "source": { "dbName": "tg-odoo" }，
 * 因此无需新增元数据格式。sourceDbName 仅用于展示与冲突提示；
 * 目标库名由 dbname-autodiscover.js 独立决定，二者绝不混用。
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectFormat as realDetectFormat, decryptFile as realDecryptFile } from './crypto.js';

/** 解析 MANIFEST.json 文本里的源信息。任何异常都返回 ok:false，绝不外抛。 */
export function parseManifestSource(text) {
  try {
    const doc = JSON.parse(String(text ?? ''));
    const src = doc?.source;
    if (!src || typeof src !== 'object') return { ok: false, reason: 'MANIFEST 缺少 source' };
    const raw = src.dbName;
    if (typeof raw !== 'string' || !raw.trim()) return { ok: false, reason: 'MANIFEST 缺少有效 source.dbName' };
    const dbName = raw.trim();
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(dbName)) {
      return { ok: false, reason: `MANIFEST 的 source.dbName 不合法：${dbName}` };
    }
    return { ok: true, sourceDbName: dbName, source: src, manifest: doc };
  } catch (err) {
    return { ok: false, reason: `MANIFEST 解析失败：${err?.message ?? String(err)}` };
  }
}

/** 用系统 tar 只读抽取单个成员；参数数组传递，不拼 shell。 */
function tarExtractMember(pkgPath, member) {
  return new Promise((resolve) => {
    const p = spawn('tar', ['-xOf', pkgPath, member], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d.toString(); });
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('error', (e) => resolve({ code: 1, stdout: '', stderr: String(e?.message ?? e) }));
    p.on('close', (code) => resolve({ code: code ?? 1, stdout: out, stderr: err }));
  });
}

/**
 * 读备份包元数据。
 * @param {string} packagePath 本地备份包路径（可加密 .enc 或明文 .tar）
 * @param {object} deps 可注入依赖（测试用）
 * @param {object} opts { passphrase } 加密包解密所需口令
 * @returns {Promise<{ok:boolean, sourceDbName?:string, source?:object, manifest?:object, reason?:string}>}
 */
export async function readPackageMeta(packagePath, deps = {}, opts = {}) {
  const detectFormat = deps.detectFormat ?? realDetectFormat;
  const decryptFile = deps.decryptFile ?? realDecryptFile;
  const runTar = deps.runTar ?? tarExtractMember;
  const mkTemp = deps.mkdtemp ?? mkdtemp;
  const rmTemp = deps.rm ?? rm;

  const path = String(packagePath ?? '').trim();
  if (!path) return { ok: false, reason: '备份包路径为空' };

  let format;
  try { format = await detectFormat(path); }
  catch (err) { return { ok: false, reason: `无法识别备份包格式：${err?.message ?? String(err)}` }; }

  if (format === 'empty') return { ok: false, reason: '备份包为空文件' };
  if (format === 'age' || format === 'openssl') {
    return { ok: false, reason: `不支持的加密格式 ${format}（仅支持本插件 DSHODOO1 加密包或明文包）` };
  }

  let workPath = path;
  let tempDir = null;

  if (format === 'dsh-odoo') {
    const passphrase = opts?.passphrase;
    if (typeof passphrase !== 'string' || !passphrase) {
      return { ok: false, reason: '备份包已加密，读取元数据需要解密口令' };
    }
    try {
      tempDir = await mkTemp(join(tmpdir(), 'dsh-odoo-meta-'));
      const decPath = join(tempDir, 'package.tar');
      await decryptFile(path, decPath, passphrase);
      workPath = decPath;
    } catch (err) {
      if (tempDir) await rmTemp(tempDir, { recursive: true, force: true }).catch(() => {});
      return { ok: false, reason: `解密失败：${err?.message ?? String(err)}` };
    }
  } else if (format !== 'plain') {
    return { ok: false, reason: `未知备份包格式：${format}` };
  }

  try {
    // MANIFEST.json 可能带 ./ 前缀，两种都试，兼容不同打包命令。
    let r = await runTar(workPath, './MANIFEST.json');
    if (r.code !== 0 || !r.stdout.trim()) r = await runTar(workPath, 'MANIFEST.json');
    if (r.code !== 0) {
      return { ok: false, reason: `备份包内未找到 MANIFEST.json（tar exit ${r.code}）` };
    }
    return parseManifestSource(r.stdout);
  } catch (err) {
    return { ok: false, reason: `读取备份包元数据失败：${err?.message ?? String(err)}` };
  } finally {
    if (tempDir) await rmTemp(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}
