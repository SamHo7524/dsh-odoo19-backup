import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { DEFAULT_TIMEOUT_MS } from './constants.js';

const execFileAsync = promisify(execFile);

/**
 * 构造 ssh 参数。绝不包含密码：只支持私钥 / Agent / ssh config 别名。
 */
export function buildSshArgs(server) {
  if (server.sshConfigAlias) {
    return [server.sshConfigAlias];
  }
  const args = [
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    'ConnectTimeout=15',
  ];
  if (server.port && server.port !== 22) {
    args.push('-p', String(server.port));
  }
  if (server.keyPath) {
    args.push('-i', server.keyPath);
    args.push('-o', 'IdentitiesOnly=yes');
  }
  args.push(`${server.user}@${server.host}`);
  return args;
}

/**
 * 构造 scp 参数。与 buildSshArgs 对称：别名机型用 `<alias>:<path>` 让
 * ~/.ssh/config 展开 HostName/User/IdentityFile，不再拼 user@host（否则
 * 别名机型会因缺私钥而 Permission denied，2026-11-07 真机缺陷）。
 *
 * 安全底线不因别名放宽：BatchMode / StrictHostKeyChecking 始终保留。
 */
export function buildScpArgs(server, { direction, remotePath, localPath }) {
  const args = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes'];
  const alias = server.sshConfigAlias;
  if (alias) {
    // 别名自带端口/用户/私钥信息，不再加 -P/-i
    const spec = `${alias}:${remotePath}`;
    if (direction === 'upload') args.push(localPath, spec);
    else args.push(spec, localPath);
    return args;
  }
  if (server.port && server.port !== 22) args.push('-P', String(server.port));
  if (server.keyPath) {
    args.push('-i', server.keyPath);
    if (direction === 'download') args.push('-o', 'IdentitiesOnly=yes');
  }
  const spec = `${server.user}@${server.host}:${remotePath}`;
  if (direction === 'upload') args.push(localPath, spec);
  else args.push(spec, localPath);
  return args;
}

/**
 * 解析 scp 经典进度行里的百分比。
 * 例："b.tar.enc   12%  512MB  10.2MB/s   00:42" → 12
 * 无百分比返回 null。只取 [0,100] 的值。
 */
export function parseScpProgress(text) {
  const m = String(text ?? '').match(/(\d{1,3})\s*%/);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 0 && n <= 100 ? n : null;
}

/**
 * 由「已写入本地字节数 / 远端总字节数」算传输百分比。
 * 真机可用：scp 的 % 进度条只在 tty 输出，spawn 用 pipe 时静默；
 * 以本地文件增长为准才不会让进度名存实亡。
 * 未知总大小（0）返回 null，绝不编造百分比。
 */
export function computeTransferPercent(localBytes, expectedBytes) {
  const total = Number(expectedBytes);
  if (!Number.isFinite(total) || total <= 0) return null;
  const done = Number(localBytes);
  if (!Number.isFinite(done) || done < 0) return 0;
  return Math.min(100, Math.round((done / total) * 100));
}

/**
 * 把 ssh 的退出码与 stderr 归类成可操作的原因。
 * 分类顺序有意义：hostkey 优先于 auth（指纹变化时 ssh 也会报认证失败）。
 */
export function classifySshError(code, stderr = '') {
  const s = String(stderr ?? '');

  if (/REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(s)) {
    return {
      kind: 'hostkey-changed',
      message: '服务器主机密钥已变化，可能被中间人攻击，已拒绝连接',
    };
  }
  if (/请使用微信扫码|WeChat to scan|扫码安全登录/i.test(s)) {
    return {
      kind: 'cloud-mfa',
      message: '该服务器启用了云厂商二次验证，需在控制台关闭或安装公钥',
    };
  }
  if (/Permission denied|Authentication failed/i.test(s)) {
    return {
      kind: 'auth',
      message: '登录认证失败（客户端公钥未被服务器接受）：检查 keyPath 是否指向本机私钥、该公钥是否已加入服务器 authorized_keys、以及 user 是否正确。这与主机指纹核验是两件独立的事，不要反复重做指纹核验。',
    };
  }
  if (/Connection refused/i.test(s)) {
    return { kind: 'network', message: '连接被拒绝：检查端口与服务状态' };
  }
  if (/Connection timed out|Operation timed out|Timeout, server/i.test(s)) {
    return { kind: 'network', message: '连接超时：检查 host 与防火墙' };
  }
  if (/Could not resolve hostname/i.test(s)) {
    return { kind: 'network', message: '无法解析主机名：检查 host 拼写' };
  }
  if (/Host key verification failed/i.test(s)) {
    return {
      kind: 'hostkey-unknown',
      message: '主机身份核验失败：请在「信任主机」面板重新扫描并让服务器所有者回传指纹核对',
    };
  }
  if (code !== 0) {
    return {
      kind: 'unknown',
      message: `SSH 失败（退出码 ${code}）：${s.split('\n')[0] || '无输出'}`,
    };
  }
  return { kind: 'ok', message: '' };
}

/**
 * 在远程执行一段固定脚本；参数通过 stdin 传入，不拼进命令行。
 *
 * 脚本经 base64 编码后作为单个 argv 传给远端（base64 只含 [A-Za-z0-9+/=]，
 * 不含任何 shell 元字符，因此不存在注入面）；stdin 留给脚本内的 `read` 读参数。
 * 远端先落盘再执行，避免 `sh -s` 与 stdin 参数争用同一通道。
 *
 * 用 bash 而非 sh：Debian/Ubuntu 的 /bin/sh 是 dash，
 * 不支持 `set -o pipefail`、数组、`[[ ]]` 等 bash 语法。
 * 远程没有 bash 时回退到 sh（脚本需自行避免 bash 专有语法）。
 *
 * 不用 execFile：它没有 input 选项，传 input 会被静默忽略。
 */
export function execRemote(server, script, opts = {}) {
  const b64 = Buffer.from(String(script), 'utf8').toString('base64');
  const remote = [
    `f=/tmp/.dsh-script-$$-${Math.random().toString(36).slice(2, 8)}.sh`,
    `echo '${b64}' | base64 -d > "$f" || exit 90`,
    `if command -v bash >/dev/null 2>&1; then bash "$f"; else sh "$f"; fi`,
    `rc=$?`,
    `rm -f "$f"`,
    `exit $rc`,
  ].join('; ');

  const args = buildSshArgs(server);
  args.push(remote);

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBuffer = opts.maxBuffer ?? 16 * 1024 * 1024;

  return new Promise((resolve) => {
    let settled = false;
    let timer = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    let child;
    try {
      child = spawn('ssh', args, { windowsHide: true });
    } catch (e) {
      finish({ code: 1, stdout: '', stderr: String(e.message ?? e) });
      return;
    }

    const outChunks = [];
    const errChunks = [];
    let outLen = 0;
    let errLen = 0;

    child.stdout?.on('data', (c) => {
      outLen += c.length;
      if (outLen <= maxBuffer) outChunks.push(c);
    });
    child.stderr?.on('data', (c) => {
      errLen += c.length;
      if (errLen <= maxBuffer) errChunks.push(c);
    });

    child.on('error', (e) => {
      finish({ code: 1, stdout: '', stderr: String(e.message ?? e) });
    });

    child.on('close', (code) => {
      finish({
        code: code ?? 1,
        stdout: Buffer.concat(outChunks).toString('utf8'),
        stderr: Buffer.concat(errChunks).toString('utf8'),
      });
    });

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
        finish({
          code: 124,
          stdout: Buffer.concat(outChunks).toString('utf8'),
          stderr: `命令超时（${timeoutMs} ms）`,
        });
      }, timeoutMs);
      timer.unref?.();
    }

    if (child.stdin) {
      child.stdin.on('error', () => {
        /* 远端提前关闭 stdin 属正常，忽略 EPIPE */
      });
      child.stdin.end(opts.stdin ?? '', 'utf8');
    }
  });
}

const PROBE_SCRIPT = `
echo "===OS==="; . /etc/os-release 2>/dev/null && echo "$PRETTY_NAME"
echo "===KERNEL==="; uname -r
echo "===ARCH==="; uname -m
echo "===CPU==="; nproc
echo "===MEM==="; free -m | awk '/Mem:/{print $2, $7}'
echo "===DISK==="; df -m / | awk 'NR==2{print $4}'
echo "===DOCKER==="; docker --version 2>/dev/null || echo none
echo "===ZSTD==="; command -v zstd >/dev/null && echo yes || echo no
echo "===GZIP==="; command -v gzip >/dev/null && echo yes || echo no
echo "===HOSTNAME==="; hostname
echo "===END==="
`;

function grab(text, tag) {
  const m = String(text).match(new RegExp(`===${tag}===\\n([^\\n]*)`));
  return m ? m[1].trim() : '';
}

/**
 * 连接前的指纹守卫。必须在任何 execRemote 之前调用。
 *
 * 三种放行条件：
 *  1. sshConfigAlias：信任边界交给用户自己的 ~/.ssh/config，本插件不介入
 *  2. pinnedFingerprint 已配置且与服务器当前指纹一致
 *  3. 否则拒绝——绝不因为「没配置」就放行（fail-closed）
 */
export async function guardHostKey(server) {
  if (server.sshConfigAlias) {
    return { ok: true, mode: 'alias' };
  }
  if (!server.pinnedFingerprint) {
    return {
      ok: false,
      error: {
        kind: 'not-pinned',
        message:
          '该服务器尚未确认主机指纹，拒绝连接。' +
          '请在插件的「信任主机」面板完成两步独立操作：' +
          '① 让服务器所有者把本机公钥加入 authorized_keys（登录认证）；' +
          '② 让服务器所有者执行 ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub 并通过独立可信渠道回传指纹，' +
          '与插件扫描值一致后点「确认信任」（主机身份核验）。' +
          '也可改填 sshConfigAlias，把两项信任交给 ~/.ssh/config。',
      },
    };
  }
  const { checkHostKey } = await import('./knownhosts.js');
  const r = await checkHostKey(server, server.pinnedFingerprint);
  return r.ok ? { ok: true, mode: 'pinned', matched: r.matched } : r;
}

/**
 * 测试连接并采集系统信息。
 */
export async function testConnection(server) {
  const r = await execRemote(server, PROBE_SCRIPT, {
    timeoutMs: DEFAULT_TIMEOUT_MS,
  });

  if (r.code !== 0 || !r.stdout.includes('===END===')) {
    return { ok: false, error: classifySshError(r.code, r.stderr) };
  }

  const [memTotal, memAvail] = grab(r.stdout, 'MEM').split(/\s+/).map(Number);

  return {
    ok: true,
    system: {
      os: grab(r.stdout, 'OS'),
      kernel: grab(r.stdout, 'KERNEL'),
      arch: grab(r.stdout, 'ARCH'),
      cpuCores: Number(grab(r.stdout, 'CPU')) || 0,
      memTotalMb: memTotal || 0,
      memAvailableMb: memAvail || 0,
      diskFreeMb: Number(grab(r.stdout, 'DISK')) || 0,
      hostname: grab(r.stdout, 'HOSTNAME'),
    },
    tools: {
      docker: grab(r.stdout, 'DOCKER'),
      zstd: grab(r.stdout, 'ZSTD') === 'yes',
      gzip: grab(r.stdout, 'GZIP') === 'yes',
    },
  };
}
