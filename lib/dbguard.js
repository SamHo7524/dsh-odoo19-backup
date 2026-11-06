/**
 * 数据库名安全守卫（事故教训 2026-11-04）。
 *
 * 曾有一个清理探针用 `LIKE 'tg-odoo%'` 删"临时库"，结果匹配到主库 tg-odoo 自身并误删。
 * 本模块把这条教训固化进代码：插件构造的任何 SQL / 目标清单里的数据库名必须是
 * 「精确、合法、且在授权清单内」，禁止前缀通配、LIKE、% 和任何注入字符。
 *
 * 约定：
 *  - guardDbName(n)            校验单个库名，返回原串或抛错
 *  - buildTerminateSql(list)   终止连接，用精确 IN 列表（无 LIKE / %）
 *  - buildExactLookupSql(list) 只读探测，用精确 IN 列表
 *  - switchRenameSql / rollbackRenameSql 生成精确的 ALTER DATABASE ... RENAME
 *  - assertTargetsAllowed(targets, allowed) 目标必须全部落在授权清单内
 */

// 允许的库名：字母/数字/下划线/连字符/点，且必须含至少一个连字符（本插件命名约定）。
// 明确排除 %、'、"、;、空白、逗号、括号等——这些正是通配/注入的载体。
const SAFE_DB_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

export function guardDbName(name) {
  if (typeof name !== 'string' || name.length === 0 || name.length > 120) {
    throw new Error(`不安全的数据库名：${String(name)}（空值或过长）`);
  }
  if (name.includes('%') || name.includes('*') || /[\s'";,()\\]/.test(name)) {
    throw new Error(`不安全的数据库名：${name}（含通配符或非法字符）`);
  }
  if (!SAFE_DB_NAME.test(name)) {
    throw new Error(`不安全的数据库名：${name}`);
  }
  return name;
}

function sqlList(names) {
  return names.map((n) => `'${guardDbName(n)}'`).join(', ');
}

/** 终止指定库的连接：精确 IN 列表，绝不使用 LIKE '<db>%'。 */
export function buildTerminateSql(names) {
  const list = names.map(guardDbName);
  return `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname IN (${sqlList(list)}) AND pid <> pg_backend_pid()`;
}

/** 只读探测：精确 IN 列表。 */
export function buildExactLookupSql(names) {
  const list = names.map(guardDbName);
  return `select datname from pg_database where datname in (${sqlList(list)}) order by 1`;
}

function q(n) {
  return `"${guardDbName(n)}"`;
}

/** 切换：主库→旧库、临时库→主库。 */
export function switchRenameSql({ db, oldDb, tmpDb }) {
  return [
    `ALTER DATABASE ${q(db)} RENAME TO ${q(oldDb)}`,
    `ALTER DATABASE ${q(tmpDb)} RENAME TO ${q(db)}`,
  ];
}

/** 回滚：失败库→failed、旧库→主库。 */
export function rollbackRenameSql({ db, oldDb, failedDb }) {
  return [
    `ALTER DATABASE ${q(db)} RENAME TO ${q(failedDb)}`,
    `ALTER DATABASE ${q(oldDb)} RENAME TO ${q(db)}`,
  ];
}

/** 任何破坏性操作的目标必须全部落在显式授权清单内，且清单本身也合法。 */
export function assertTargetsAllowed(targets, allowed) {
  const cleanAllowed = allowed.map(guardDbName);
  for (const t of targets) {
    const clean = guardDbName(t);
    if (!cleanAllowed.includes(clean)) {
      throw new Error(`拒绝操作未在授权清单内的数据库：${clean}（授权：${cleanAllowed.join(', ')}）`);
    }
  }
  return true;
}
