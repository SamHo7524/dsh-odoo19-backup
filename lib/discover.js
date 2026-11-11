import { execRemote } from './ssh.js';
import { parseConfValue, resolveDiscoveredDbName } from './dbname-autodiscover.js';

/**
 * 从 odoo.conf 文本里提取 dbfilter 对应的库名。
 *
 * 关键：绝不能用 sed 的 ERE 反向引用去剥 ^...$。
 * 在 ERE 中反斜杠-dollar 是行尾锚点而非字面 dollar 符号，
 * 对 ^tg-odoo$ 会得到单字符 'o'。这里改用逐字符剥离，行为可预测。
 */
export function parseDbFilter(confText) {
  const text = String(confText ?? '');
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => /^dbfilter\s*=/.test(l) && !l.startsWith('#'));

  if (!line) return '';

  const raw = line.replace(/^dbfilter\s*=\s*/, '').trim();
  const unquoted = raw.replace(/^["']|["']$/g, '').trim();
  const cleaned = unquoted.replace(/\^/g, '').replace(/\$/g, '').replace(/\s/g, '');

  if (cleaned === '' || cleaned === '.*') return '';
  return cleaned;
}

/**
 * 解析目标库名：显式配置优先，其次 dbfilter。
 *
 * 真机缺陷（2026-11-09）：目标机 odoo.conf 的 dbfilter 被注释掉，parseDbFilter 返回 ''，
 * 而 discover() 从不读取配置里的 dbName，于是恢复带着空库名进入执行阶段并报
 * 「不安全的数据库名」。插件**绝不猜测**要覆盖哪个库：两处都没有就返回空，
 * 由调用方以可操作的方式要求用户填写。
 */
export function resolveDbName({ configured, confText } = {}) {
  const explicit = typeof configured === 'string' ? configured.trim() : '';
  if (explicit) return explicit;
  return parseDbFilter(confText);
}

/**
 * 解析 docker inspect 的格式化输出（ENV / MOUNTS / IMAGE 三段）。
 * 明确丢弃 PASSWORD，解析结果绝不携带密码。
 */
export function parseInspect(text) {
  const out = { dbHost: '', dbUser: '', addonsPath: '', dataPath: '', imageId: '' };
  const str = String(text ?? '');

  const [envPart, rest] = str.split('---MOUNTS---');
  const [mountsPart, imagePart] = (rest ?? '').split('---IMAGE---');

  for (const line of (envPart ?? '').split('\n')) {
    const m = line.trim().match(/^(HOST|USER)=(.+)$/);
    if (!m) continue;
    if (m[1] === 'HOST') out.dbHost = m[2].trim();
    if (m[1] === 'USER') out.dbUser = m[2].trim();
  }

  for (const line of (mountsPart ?? '').split('\n')) {
    const m = line.trim().match(/^(.+?)=>(.+)$/);
    if (!m) continue;
    const [, src, dst] = m;
    if (dst.trim() === '/mnt/extra-addons') out.addonsPath = src.trim();
    if (dst.trim() === '/var/lib/odoo') out.dataPath = src.trim();
  }

  out.imageId =
    (imagePart ?? '')
      .split('\n')
      .map((s) => s.trim())
      .find(Boolean) ?? '';

  return out;
}

const DOCKER_LIST_SCRIPT = `
echo "===CONTAINERS==="
docker ps -a --format '{{.Names}}|{{.Image}}|{{.State}}' 2>/dev/null | grep -i odoo || true
echo "===PG==="
docker ps --format '{{.Names}}|{{.Image}}' 2>/dev/null | grep -i postgres || true
echo "===END==="
`;

const BARE_PROBE_SCRIPT = `
echo "===SERVICES==="
systemctl list-units --type=service --all 2>/dev/null | grep -i odoo || true
echo "===CONF==="
for f in /etc/odoo/odoo.conf /etc/odoo-server.conf /opt/odoo/odoo.conf; do
  [ -f "$f" ] && echo "FOUND:$f"
done
echo "===PG==="
systemctl is-active postgresql 2>/dev/null || echo inactive
echo "===END==="
`;

function section(text, name, next) {
  const re = new RegExp(`===${name}===\\n([\\s\\S]*?)(?====${next}===|$)`);
  const m = String(text).match(re);
  return m ? m[1].trim() : '';
}

/**
 * 探测单个 Docker Odoo 容器。
 * 参数经 stdin 传入，不拼进命令行。
 */
async function probeDockerInstance(server, containerName, imageName) {
  const script = `
set -uo pipefail
read -r C

echo "===ENVMOUNTS==="
docker inspect "$C" --format '{{range .Config.Env}}{{println .}}{{end}}---MOUNTS---{{range .Mounts}}{{.Source}}=>{{.Destination}}{{println}}{{end}}---IMAGE---{{.Image}}' 2>/dev/null || true

echo "===CONF==="
# v0.1.14：dbfilter 与 db_name 是不同配置项，都要读；忽略注释行交给 JS 侧解析。
docker exec "$C" sh -c 'cat /etc/odoo/odoo.conf 2>/dev/null | grep -E "^[[:space:]]*(dbfilter|db_name)"' 2>/dev/null || true

echo "===VERSION==="
docker exec "$C" odoo --version 2>/dev/null | head -1 || true

echo "===UIDGID==="
docker exec "$C" sh -c 'id -u; id -g' 2>/dev/null || true

echo "===ENDPOINT==="
docker port "$C" 8069/tcp 2>/dev/null | head -1 || true

echo "===ENDC==="
`;

  const r = await execRemote(server, script, {
    stdin: `${containerName}\n`,
    timeoutMs: 90000,
  });

  if (!r.stdout.includes('===ENDC===')) return null;

  const info = parseInspect(section(r.stdout, 'ENVMOUNTS', 'CONF'));
  const confSec = section(r.stdout, 'CONF', 'VERSION');
  const dbName = resolveDbName({
    configured: server?.dbName,
    confText: confSec,
  });
  const versionLine = section(r.stdout, 'VERSION', 'UIDGID');
  const uidgid = section(r.stdout, 'UIDGID', 'ENDPOINT').split('\n').map((s) => Number(s.trim()));
  const endpoint = section(r.stdout, 'ENDPOINT', 'ENDC');

  const versionMatch = versionLine.match(/Odoo Server\s+(\S+)/);

  // odoo.conf 容器内路径 /etc/odoo/odoo.conf。实测它是**挂载卷**（1Panel：
  // data/conf/odoo.conf → /etc/odoo/odoo.conf），并非镜像内文件，改动会持久生效、
  // 不会因容器重启还原。因此改 dbfilter 仍用 `docker exec -u root` 写容器内路径即可，
  // 无需改宿主机 compose 挂载。注意 conf 中严禁写 db_host/db_user/db_password
  // （entrypoint 的 check_config 会因这些键跳过 env 注入，导致容器连不上库）。
  const confPath = '/etc/odoo/odoo.conf';

  return {
    kind: 'docker',
    odooContainer: containerName,
    odooImage: imageName,
    odooVersion: versionMatch ? versionMatch[1] : '',
    imageId: info.imageId,
    dbHost: info.dbHost,
    dbUser: info.dbUser,
    dbName,
    // v0.1.14：把原始配置值与解析出的自动发现线索一并带回，供 /discover 持久化
    // 与 /precheck 展示使用。dbfilter / db_name / pgSuperUser 概念互不混用。
    confDbFilter: parseConfValue(confSec, 'dbfilter'),
    confDbName: parseConfValue(confSec, 'db_name'),
    addonsPath: info.addonsPath,
    dataPath: info.dataPath,
    pydepsPath: info.dataPath ? `${info.dataPath}/.local` : '',
    confPath,
    uid: uidgid[0] || 0,
    gid: uidgid[1] || 0,
    httpEndpoint: endpoint,
  };
}

/**
 * 探测 postgres 容器的超级用户（POSTGRES_USER），用于 DROP/CREATE/ALTER DATABASE。
 * 在 1Panel 部署里该角色通常是 postgres 之外的专用角色（如 pgsl）。
 */
async function probePgSuperUser(server, pgContainer) {
  if (!pgContainer) return undefined;
  const r = await execRemote(
    server,
    'read -r P; docker exec "$P" printenv POSTGRES_USER 2>/dev/null || echo postgres',
    { stdin: `${pgContainer}\n`, timeoutMs: 30000 },
  );
  const u = r.stdout.trim().split('\n')[0];
  return u || 'postgres';
}

/**
 * 列出 PostgreSQL 里允许连接的库。超级用户名（如 pgsql）只用于登录，
 * 不作为库名；排除逻辑在 resolveDiscoveredDbName。
 */
async function probePgDatabases(server, pgContainer, pgSuperUser) {
  if (!pgContainer) return [];
  const script = `
set -uo pipefail
read -r P
read -r U
docker exec "$P" psql -U "$U" -d postgres -Atc "SELECT datname FROM pg_database WHERE datallowconn ORDER BY 1" 2>/dev/null || true
`;
  const r = await execRemote(server, script, {
    stdin: `${pgContainer}\n${pgSuperUser || 'postgres'}\n`,
    timeoutMs: 30000,
  });
  return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}

/** 用配置、dbfilter、db_name、PG 列表解析目标库名。源库名不参与。 */
function applyDbNameDiscovery(inst, server, pgDatabases) {
  const discovery = resolveDiscoveredDbName({
    configuredDbName: server?.dbName,
    confDbFilter: inst.confDbFilter,
    confDbName: inst.confDbName,
    pgDatabases,
    pgSuperUser: inst.pgSuperUser,
  });
  inst.pgDatabases = pgDatabases;
  inst.dbNameDiscovery = discovery;
  if (discovery.ok) inst.dbName = discovery.dbName;
  else if (!String(server?.dbName ?? '').trim()) inst.dbName = '';
  return inst;
}

/**
 * 探测裸机（systemd）部署的 Odoo。
 */
async function probeBareInstance(server, confPath) {
  const script = `
set -uo pipefail
read -r CONF

echo "===CONF==="
grep -E '^[[:space:]]*(addons_path|data_dir|dbfilter|db_name|db_host|db_user)' "$CONF" 2>/dev/null || true

echo "===VERSION==="
odoo --version 2>/dev/null | head -1 || true

echo "===END==="
`;

  const r = await execRemote(server, script, {
    stdin: `${confPath}\n`,
    timeoutMs: 60000,
  });

  if (!r.stdout.includes('===END===')) return null;

  const conf = section(r.stdout, 'CONF', 'VERSION');
  const grab = (k) => {
    const m = conf.match(new RegExp(`^\\s*${k}\\s*=\\s*(.+)$`, 'm'));
    return m ? m[1].trim() : '';
  };

  const versionLine = section(r.stdout, 'VERSION', 'END');
  const versionMatch = versionLine.match(/Odoo Server\s+(\S+)/);
  const dataDir = grab('data_dir');

  return {
    kind: 'bare',
    confPath,
    odooVersion: versionMatch ? versionMatch[1] : '',
    dbHost: grab('db_host') || 'localhost',
    dbUser: grab('db_user'),
    dbName: resolveDbName({ configured: server?.dbName, confText: conf }),
    confDbFilter: parseConfValue(conf, 'dbfilter'),
    confDbName: parseConfValue(conf, 'db_name'),
    addonsPath: grab('addons_path').split(',')[0].trim(),
    dataPath: dataDir,
    pydepsPath: dataDir ? `${dataDir}/.local` : '',
  };
}

/**
 * 扫描远程环境的 Odoo 实例。
 * 优先按 Docker 探测；没有 Docker 实例时回退到裸机探测。
 */
export async function discover(server) {
  const listProbe = await execRemote(server, DOCKER_LIST_SCRIPT, {
    timeoutMs: 60000,
  });

  const instances = [];

  if (listProbe.code === 0 && listProbe.stdout.includes('===END===')) {
    const containerSec = section(listProbe.stdout, 'CONTAINERS', 'PG');
    const lines = containerSec.split('\n').filter((l) => l.includes('|'));

    // 提取第一个 postgres 容器名，供 V4 验证脚本使用
    const pgSec = section(listProbe.stdout, 'PG', 'END');
    const pgName = (pgSec.split('\n').find((l) => l.includes('|')) ?? '')
      .split('|')[0]
      .trim();

    for (const line of lines) {
      const [name, image, state] = line.split('|');
      const inst = await probeDockerInstance(server, name.trim(), (image ?? '').trim());
      if (!inst) continue;
      inst.state = (state ?? '').trim();
      inst.pgContainer = pgName;
      inst.pgSuperUser = await probePgSuperUser(server, pgName);
      const pgDatabases = await probePgDatabases(server, pgName, inst.pgSuperUser);
      applyDbNameDiscovery(inst, server, pgDatabases);
      instances.push(inst);
    }
  }

  if (instances.length === 0) {
    const bareProbe = await execRemote(server, BARE_PROBE_SCRIPT, {
      timeoutMs: 60000,
    });
    if (bareProbe.code === 0) {
      const confs = (bareProbe.stdout.match(/FOUND:(\S+)/g) ?? []).map((s) =>
        s.replace('FOUND:', ''),
      );
      for (const c of confs) {
        const inst = await probeBareInstance(server, c);
        if (inst) {
          applyDbNameDiscovery(inst, server, []);
          instances.push(inst);
        }
      }
    }
  }

  return {
    server: server.name ?? server.host,
    instances,
    found: instances.length > 0,
    ...(instances.length === 0
      ? { note: '未发现 Odoo 实例：确认容器在运行，或该部署方式不受支持' }
      : {}),
  };
}
