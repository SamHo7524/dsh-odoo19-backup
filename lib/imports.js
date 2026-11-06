import { execRemote } from './ssh.js';

/**
 * Python 标准库顶层模块名（Python 3.11/3.12 常用集）。
 * 仅用于过滤：漏掉某个名字只会导致多尝试一次 import，通过即无害。
 */
const STDLIB = new Set([
  '__future__', 'abc', 'argparse', 'ast', 'asyncio', 'base64', 'binascii', 'bisect',
  'builtins', 'bz2', 'calendar', 'cmath', 'codecs', 'collections', 'concurrent',
  'configparser', 'contextlib', 'copy', 'csv', 'ctypes', 'datetime', 'decimal',
  'difflib', 'dis', 'email', 'enum', 'errno', 'faulthandler', 'fcntl', 'filecmp',
  'fileinput', 'fnmatch', 'fractions', 'ftplib', 'functools', 'gc', 'getopt',
  'getpass', 'gettext', 'glob', 'grp', 'gzip', 'hashlib', 'heapq', 'hmac', 'html',
  'http', 'imaplib', 'importlib', 'inspect', 'io', 'ipaddress', 'itertools', 'json',
  'keyword', 'linecache', 'locale', 'logging', 'lzma', 'mailbox', 'math', 'mimetypes',
  'multiprocessing', 'netrc', 'numbers', 'operator', 'os', 'pathlib', 'pdb', 'pickle',
  'pipes', 'pkgutil', 'platform', 'plistlib', 'poplib', 'posixpath', 'pprint',
  'profile', 'pstats', 'pty', 'pwd', 'py_compile', 'queue', 'quopri', 'random', 're',
  'readline', 'reprlib', 'sched', 'secrets', 'select', 'selectors', 'shelve', 'shlex',
  'shutil', 'signal', 'smtplib', 'socket', 'socketserver', 'sqlite3', 'ssl', 'stat',
  'statistics', 'string', 'stringprep', 'struct', 'subprocess', 'sys', 'sysconfig',
  'tarfile', 'tempfile', 'textwrap', 'threading', 'time', 'timeit', 'token',
  'tokenize', 'traceback', 'tracemalloc', 'types', 'typing', 'unicodedata', 'unittest',
  'urllib', 'uuid', 'venv', 'warnings', 'wave', 'weakref', 'webbrowser', 'xml',
  'xmlrpc', 'zipfile', 'zipimport', 'zlib', 'zoneinfo',
]);

export function isStdlib(name) {
  return STDLIB.has(String(name ?? '').split('.')[0]);
}

export function isOdooInternal(name) {
  const top = String(name ?? '').split('.')[0];
  return top === 'odoo' || top === 'openerp';
}

/**
 * 从 Python 源码中提取第三方顶层模块名。
 * 只处理 import / from ... import 语句；相对导入（from . import x）忽略。
 */
export function extractThirdPartyImports(source) {
  const found = new Set();

  for (const rawLine of String(source ?? '').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    // import a, b.c as d
    const importMatch = line.match(/^import\s+(.+)$/);
    if (importMatch) {
      for (const part of importMatch[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/)[0].trim();
        const top = name.split('.')[0];
        if (top && !isStdlib(top) && !isOdooInternal(top)) found.add(top);
      }
      continue;
    }

    // from x import y   （跳过 from . / from .. 相对导入）
    const fromMatch = line.match(/^from\s+(\S+)\s+import\s+/);
    if (fromMatch) {
      const mod = fromMatch[1];
      if (mod.startsWith('.')) continue;
      const top = mod.split('.')[0];
      if (top && !isStdlib(top) && !isOdooInternal(top)) found.add(top);
    }
  }

  return [...found].sort();
}

/**
 * 远程脚本：列出 addons 下的自建模块，并抽取其 Python 源码中的**顶层** import。
 *
 * 关键：只取模块顶层（缩进为 0）的 import 语句。
 * 缩进的 import 位于函数/方法/try 块内，通常是懒加载——
 * 缺失时只在调用该功能时才失败，不影响 Odoo 启动和其他模块。
 * 把它算作必需依赖会产生假阳性（实测：sms_alibaba 故意懒加载阿里云 SDK，
 * 缺失属设计预期）。
 */
function buildScanScript() {
  return `
set -uo pipefail
read -r ADDONS

echo "===MODULES==="
if [ -d "$ADDONS" ]; then
  find "$ADDONS" -maxdepth 2 -name '__manifest__.py' 2>/dev/null | while read -r m; do
    dirname "$m"
  done
else
  echo "ADDONS_MISSING"
fi

echo "===IMPORTS==="
if [ -d "$ADDONS" ]; then
  find "$ADDONS" -maxdepth 3 -name '*.py' 2>/dev/null | while read -r f; do
    # 顶层 import：行首无空白，且不是续行
    grep -hE '^(import|from)[[:space:]]' "$f" 2>/dev/null || true
  done
fi

echo "===END==="
`;
}

/**
 * 在 Odoo 容器内逐个尝试 import。
 * 模块名经 base64 传入，避免任何 shell 引号问题。
 */
function buildProbeScript() {
  return `
set -uo pipefail
read -r OC
read -r B64LIST

LIST=$(echo "$B64LIST" | base64 -d)

while IFS= read -r m; do
  [ -z "$m" ] && continue
  if docker exec "$OC" python3 -c "import $m" >/dev/null 2>&1; then
    echo "OK:$m"
  else
    echo "FAIL:$m"
  fi
done <<< "$LIST"

echo "===END==="
`;
}

/**
 * 预检：自建模块的第三方依赖是否都能在 Odoo 容器内导入。
 *
 * 这是恢复前的硬闸门——若某个依赖缺失，站点会在切换后才暴露
 * ImportError（"Some modules are not loaded" 只是 ERROR 日志，不中断启动），
 * 那时只能回滚。必须在临时库阶段就查出来。
 */
export async function checkImports({ server, instance }) {
  if (!instance?.addonsPath) {
    return {
      ok: true,
      missing: [],
      checked: [],
      note: '未提供 addonsPath，跳过导入预检',
      skipped: true,
    };
  }

  const scan = await execRemote(server, buildScanScript(), {
    stdin: `${instance.addonsPath}\n`,
    timeoutMs: 120000,
  });

  if (!scan.stdout.includes('===END===')) {
    return {
      ok: false,
      missing: [],
      checked: [],
      error: `扫描自建模块失败：${(scan.stderr || scan.stdout).slice(-300)}`,
    };
  }

  const importsSec = scan.stdout.match(/===IMPORTS===\n([\s\S]*?)===END===/);
  const modules = extractThirdPartyImports(importsSec ? importsSec[1] : '');

  if (modules.length === 0) {
    return {
      ok: true,
      missing: [],
      checked: [],
      note: '自建模块无第三方依赖',
    };
  }

  const b64List = Buffer.from(`${modules.join('\n')}\n`, 'utf8').toString('base64');
  const probe = await execRemote(server, buildProbeScript(), {
    stdin: `${instance.odooContainer}\n${b64List}\n`,
    timeoutMs: 180000,
  });

  if (!probe.stdout.includes('===END===')) {
    return {
      ok: false,
      missing: [],
      checked: modules,
      error: `容器内导入探测失败：${(probe.stderr || probe.stdout).slice(-300)}`,
    };
  }

  const results = [];
  for (const line of probe.stdout.split('\n')) {
    const m = line.trim().match(/^(OK|FAIL):(.+)$/);
    if (m) results.push({ status: m[1], name: m[2] });
  }

  const missing = results.filter((r) => r.status === 'FAIL').map((r) => r.name);

  return {
    ok: missing.length === 0,
    missing,
    checked: results.map((r) => r.name),
    error:
      missing.length > 0
        ? `自建模块缺少运行时依赖：${missing.join(', ')}（需在 ${instance.pydepsPath || '容器 Python 路径'} 中安装）`
        : undefined,
  };
}
