/**
 * v0.1.14 — 目标服务器数据库名自动发现（纯函数，无 IO）。
 *
 * 概念隔离：dbfilter / db_name / pgSuperUser / sourceDbName 互不混用。
 *  - dbfilter：Odoo 用来过滤可访问库的正则，形如 ^tg-odoo$；
 *  - db_name：Odoo 默认连接的库；
 *  - pgSuperUser（如 pgsql）：PostgreSQL 角色，**不是数据库名**，其同名系统库也排除；
 *  - sourceDbName：备份包来源库，只用于展示，绝不参与目标推断。
 *
 * 不可靠时 fail-closed：ambiguous / none 都返回 ok:false，交给人工填写。
 */

/**
 * PostgreSQL 真正的系统库。除此之外一律不预设排除名：
 * 像 `odoo` 这种完全可能是合法业务库名，凭猜测排除会白白逼用户手工输入。
 * 超级用户同名库（实测 1Panel 部署里 POSTGRES_USER=pgsql，库里也有个 pgsql）
 * 通过 pgSuperUser 参数动态排除，见下方。
 */
export const SYSTEM_DATABASES = ['postgres', 'template0', 'template1'];

const SAFE_DB_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

/** 从 odoo.conf 文本读某个键（忽略 # / ; 注释行，去引号与首尾空白）。 */
export function parseConfValue(confText, key) {
  const lines = String(confText ?? '').split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const m = line.match(new RegExp(`^${key}\\s*=\\s*(.+)$`));
    if (!m) continue;
    return m[1].trim().replace(/^["']|["']$/g, '').trim();
  }
  return '';
}

/** dbfilter 值 → 库名；.* / 空 / 无效一律返回空（等于没配）。 */
export function dbFilterToName(value) {
  const raw = String(value ?? '').trim();
  if (!raw || raw === '.*') return '';
  const cleaned = raw.replace(/\^/g, '').replace(/\$/g, '').replace(/\s/g, '');
  if (!cleaned || !SAFE_DB_NAME.test(cleaned)) return '';
  return cleaned;
}

function validName(value) {
  const s = String(value ?? '').trim();
  return s && SAFE_DB_NAME.test(s) ? s : '';
}

/**
 * 解析目标库名。
 * @returns {{ok:boolean, dbName?:string, source?:string, confidence?:string,
 *            reason?:string, candidates?:string[]}}
 */
export function resolveDiscoveredDbName({
  configuredDbName,
  confDbFilter,
  confDbName,
  pgDatabases,
  pgSuperUser,
} = {}) {
  // 1. 人工显式配置：最高优先，绝不自动覆盖
  const explicit = validName(configuredDbName);
  if (explicit) {
    return { ok: true, dbName: explicit, source: 'config', confidence: 'explicit' };
  }

  // 2. dbfilter（^name$）
  const fromFilter = dbFilterToName(confDbFilter);
  if (fromFilter) {
    return { ok: true, dbName: fromFilter, source: 'dbfilter', confidence: 'high' };
  }

  // 3. db_name（与 dbfilter 是不同配置项，分别解析）
  const fromConfName = validName(confDbName);
  if (fromConfName) {
    return { ok: true, dbName: fromConfName, source: 'db_name', confidence: 'high' };
  }

  // 4. PG 列表兜底：排除系统库与超级用户同名库后，恰好一个才采用。
  //    pgSuperUser（如 pgsql）是角色名，绝不能被当作数据库名。
  const excluded = new Set(SYSTEM_DATABASES);
  const su = String(pgSuperUser ?? '').trim().toLowerCase();
  if (su) excluded.add(su);
  const list = Array.isArray(pgDatabases) ? pgDatabases : [];
  const candidates = list
    .map((d) => validName(d))
    .filter((d) => d && !excluded.has(d.toLowerCase()));
  const unique = [...new Set(candidates)];

  if (unique.length === 1) {
    return { ok: true, dbName: unique[0], source: 'pg-list', confidence: 'medium' };
  }
  if (unique.length > 1) {
    return { ok: false, reason: 'ambiguous', candidates: unique.sort() };
  }
  return { ok: false, reason: 'none' };
}
