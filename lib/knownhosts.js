import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const execFileAsync = promisify(execFile);

/**
 * 解析 ssh-keyscan 输出。每行形如 `<host> <type> <base64>`；
 * `#` 开头是服务器 banner 注释，跳过。
 */
export function parseKeyscan(output) {
  const out = [];
  for (const line of String(output ?? '').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const parts = t.split(/\s+/);
    if (parts.length < 3) continue;
    const [, type, raw] = parts;
    if (!/^(ssh-|ecdsa-)/.test(type)) continue;
    out.push({ type, raw });
  }
  return out;
}

/**
 * 计算 OpenSSH 风格的 SHA256 指纹：base64(sha256(公钥二进制))，去掉尾部 '='。
 * 与 `ssh-keygen -lf` 输出的 SHA256: 部分一致。
 */
export function computeFingerprint(rawBase64) {
  const buf = Buffer.from(String(rawBase64 ?? ''), 'base64');
  return createHash('sha256').update(buf).digest('base64').replace(/=+$/, '');
}

/** 去掉算法前缀与空白，只保留指纹主体，便于比较 */
export function normalizeFingerprint(fp) {
  return String(fp ?? '')
    .trim()
    .replace(/^SHA256:/i, '')
    .trim();
}

/**
 * 比较指纹。任一方缺失都拒绝（fail-closed）——绝不能因为「没配置」就放行。
 */
export function compareFingerprint(actual, expected) {
  const a = normalizeFingerprint(actual);
  const e = normalizeFingerprint(expected);

  if (!a || !e) {
    return { ok: false, reason: 'missing', actual: a, expected: e };
  }
  if (a !== e) {
    return { ok: false, reason: 'mismatch', actual: a, expected: e };
  }
  return { ok: true, reason: 'match', actual: a, expected: e };
}

function knownHostsPath() {
  return join(homedir(), '.ssh', 'known_hosts');
}

function hostSpec(server) {
  return server.port && server.port !== 22
    ? `[${server.host}]:${server.port}`
    : String(server.host);
}

/**
 * 从 `ssh -v` 的 debug 输出中提取服务器主机密钥。
 *
 * 为什么不用 ssh-keyscan：Windows 内置 OpenSSH 9.5p2 的 ssh-keyscan
 * 既不支持 -O 也不支持 -o 传 KexAlgorithms，遇到服务器的
 * sntrup761x25519-sha512 KEX 直接失败，无法指定替代算法。
 * 而 ssh 客户端自身协商正常，且 -v 会打印 "Server host key: <type> <fp>"。
 *
 * 关键：用 UserKnownHostsFile=/dev/null + StrictHostKeyChecking=no
 * 让这次探测不写 known_hosts、不因未信任而失败——指纹校验由
 * checkHostKey 独立完成，探测阶段只负责「读」。
 */
const HOSTKEY_RE = /^debug1: Server host key:\s+(\S+)\s+(SHA256:\S+)\s*$/;

export function parseHostKeyFromVerbose(output) {
  const found = [];
  for (const line of String(output ?? '').split('\n')) {
    const m = line.trim().match(HOSTKEY_RE);
    if (!m) continue;
    const [, type, fingerprint] = m;
    if (!found.some((f) => f.type === type)) {
      found.push({ type, fingerprint });
    }
  }
  return found;
}

/**
 * 读取服务器主机公钥指纹。
 *
 * 用一个必然失败但能完成握手的命令（`true` 在远端执行后立即退出）：
 * 我们只需要握手阶段的 debug 输出，不需要登录成功。
 * 如果本地没有任何可用私钥，握手仍会完成并打印主机密钥，
 * 随后认证失败——这不影响结果。
 */
export async function scanHostKey(server) {
  const args = ['-v'];
  args.push('-o', 'BatchMode=yes');
  args.push('-o', 'StrictHostKeyChecking=no');
  args.push('-o', 'UserKnownHostsFile=/dev/null');
  args.push('-o', 'ConnectTimeout=15');
  if (server.port && server.port !== 22) args.push('-p', String(server.port));
  if (server.keyPath) {
    args.push('-i', server.keyPath, '-o', 'IdentitiesOnly=yes');
  }
  args.push(`${server.user ?? 'root'}@${server.host}`, 'true');

  let stderr = '';
  try {
    const r = await execFileAsync('ssh', args, {
      timeout: 25000,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
    stderr = r.stderr ?? '';
  } catch (e) {
    // 认证失败是预期结果之一（只要握手完成就拿到了主机密钥）
    stderr = e.stderr ?? String(e.message ?? '');
  }

  const keys = parseHostKeyFromVerbose(stderr);

  if (keys.length === 0) {
    const lines = String(stderr)
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('debug1:'))
      .slice(0, 3);
    return {
      ok: false,
      error: {
        kind: 'no-key',
        message: '未从 SSH 握手中取得主机密钥：检查 host/port 与网络连通性',
        detail: lines,
      },
    };
  }

  return {
    ok: true,
    host: server.host,
    port: server.port ?? 22,
    fingerprints: keys.map((k) => ({
      type: k.type,
      fingerprint: k.fingerprint,
    })),
  };
}

/**
 * 把主机公钥固化进 ~/.ssh/known_hosts。
 *
 * 实现方式：用 ssh 自身的一次 `accept-new` 握手写入。
 * 这是唯一可靠的做法——`ssh -v` 只暴露指纹，不暴露公钥原文，
 * 而手工构造 known_hosts 行需要公钥原文。
 *
 * 安全前提：调用方必须**先**用 scanHostKey 拿到指纹、让用户核对确认，
 * 再把用户确认的那个指纹传进来比对，最后才写。写之前再校验一次，
 * 防止「用户确认的指纹」与「即将写入的服务器」不是同一个。
 */
export async function pinHostKey(server, expectedFingerprint) {
  const expected = normalizeFingerprint(expectedFingerprint);
  if (!expected) {
    return {
      ok: false,
      error: { kind: 'missing-fingerprint', message: 'pin 需要已确认的指纹' },
    };
  }

  // 写之前再读一次，确认服务器当前返回的指纹就是用户确认过的那个
  const verify = await scanHostKey(server);
  if (!verify.ok) return verify;

  const hit = verify.fingerprints.find(
    (f) => normalizeFingerprint(f.fingerprint) === expected,
  );
  if (!hit) {
    return {
      ok: false,
      error: {
        kind: 'fingerprint-changed',
        message: '服务器当前指纹与待固化的指纹不一致，拒绝写入 known_hosts',
        actual: verify.fingerprints.map((f) => `${f.type} ${f.fingerprint}`),
        expected,
      },
    };
  }

  const dir = join(homedir(), '.ssh');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = knownHostsPath();

  // 已固化过同一指纹则不重复写
  const before = await readHostKeyFingerprints(server);
  if (before.ok && before.fingerprints.some((f) => normalizeFingerprint(f.fingerprint) === expected)) {
    return { ok: true, path, written: false, fingerprint: `SHA256:${expected}` };
  }

  const args = [
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=15',
  ];
  if (server.port && server.port !== 22) args.push('-p', String(server.port));
  if (server.keyPath) args.push('-i', server.keyPath, '-o', 'IdentitiesOnly=yes');
  args.push(`${server.user ?? 'root'}@${server.host}`, 'true');

  try {
    await execFileAsync('ssh', args, { timeout: 25000, windowsHide: true });
  } catch {
    // 认证失败无妨：accept-new 在认证前就把主机密钥写进 known_hosts
  }

  // 复查：写入后 known_hosts 中确实存在该指纹
  const after = await readHostKeyFingerprints(server);
  if (!after.ok) {
    return {
      ok: false,
      error: {
        kind: 'pin-unverified',
        message: `写入后无法从 known_hosts 读回该主机的密钥：${after.error?.message ?? ''}`,
      },
    };
  }
  const present = after.fingerprints.some(
    (f) => normalizeFingerprint(f.fingerprint) === expected,
  );
  if (!present) {
    return {
      ok: false,
      error: {
        kind: 'pin-unverified',
        message: 'known_hosts 中未找到预期指纹，固化未生效',
        found: after.fingerprints.map((f) => `${f.type} ${f.fingerprint}`),
        expected,
      },
    };
  }

  return { ok: true, path, written: true, fingerprint: `SHA256:${expected}` };
}

/**
 * 用 `ssh-keygen -F <hostspec>` 读出 known_hosts 里该主机的密钥指纹。
 * 这是校验「固化是否生效」的独立证据来源，不依赖 ssh 连接。
 */
export async function readHostKeyFingerprints(server) {
  const spec = hostSpec(server);
  const path = knownHostsPath();

  let out = '';
  try {
    const r = await execFileAsync('ssh-keygen', ['-F', spec, '-f', path], {
      timeout: 15000,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    out = r.stdout ?? '';
  } catch (e) {
    // 未找到时 ssh-keygen 返回非零且 stdout 为空
    out = e.stdout ?? '';
    if (!out) {
      return {
        ok: false,
        error: { kind: 'not-found', message: `known_hosts 中无 ${spec} 的条目` },
      };
    }
  }

  const lines = out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));

  if (lines.length === 0) {
    return {
      ok: false,
      error: { kind: 'not-found', message: `known_hosts 中无 ${spec} 的条目` },
    };
  }

  // 用 ssh-keygen -lf 把这些行转成指纹
  const fingerprints = [];
  for (const line of lines) {
    const parts = line.split(/\s+/);
    if (parts.length < 3) continue;
    const type = parts[1];
    const raw = parts[2];
    fingerprints.push({
      type,
      fingerprint: `SHA256:${computeFingerprint(raw)}`,
    });
  }

  return { ok: true, hostSpec: spec, path, fingerprints };
}

/**
 * 校验当前主机指纹是否与固化值一致。
 * 不一致时调用方必须拒绝连接，不得降级。
 */
export async function checkHostKey(server, expectedFingerprint) {
  const expected = normalizeFingerprint(expectedFingerprint);
  if (!expected) {
    return {
      ok: false,
      error: {
        kind: 'not-pinned',
        message: '该服务器尚未确认主机指纹，请先执行 fingerprint 扫描并 pin',
      },
    };
  }

  const scan = await scanHostKey(server);
  if (!scan.ok) return scan;

  const hit = scan.fingerprints.find(
    (f) => normalizeFingerprint(f.fingerprint) === expected,
  );

  if (hit) return { ok: true, matched: hit };

  return {
    ok: false,
    error: {
      kind: 'hostkey-mismatch',
      message:
        '服务器主机密钥与固化值不一致，可能被中间人攻击或服务器重装过，已拒绝连接',
      actual: scan.fingerprints.map((f) => `${f.type} ${f.fingerprint}`),
      expected,
      remedy:
        '若确认服务器确实重装/更换了密钥，请重新执行 fingerprint 并 pin；' +
        '若没有预期变更，立即停止并排查',
    },
  };
}
