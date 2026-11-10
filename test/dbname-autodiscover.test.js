/**
 * v0.1.14：目标服务器数据库名自动发现。
 *
 * 概念隔离（用户明确要求）：
 *  - dbfilter（Odoo 库过滤规则）与 db_name（Odoo 默认库名）是两种配置，分别解析；
 *  - pgSuperUser（如 pgsql）是 PostgreSQL 角色，**绝不是数据库名**，
 *    它所在的系统库也不得作为恢复目标候选；
 *  - sourceDbName 来自备份包元数据，绝不参与目标库名推断。
 *
 * 自动识别不可靠时 fail-closed：不猜，返回 ok:false 让人工填写。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import {
  parseConfValue, resolveDiscoveredDbName, SYSTEM_DATABASES,
} from '../lib/dbname-autodiscover.js';

// ---------------- 配置解析 ----------------

test('AUTO-1 parseConfValue 读取 dbfilter / db_name，忽略注释行', () => {
  const conf = [
    '# dbfilter = ^commented$',
    '; db_name = commented_db',
    'dbfilter = ^tg-odoo$',
    'db_name = my_default_db',
    'addons_path = /mnt/extra-addons',
  ].join('\n');
  assert.equal(parseConfValue(conf, 'dbfilter'), '^tg-odoo$');
  assert.equal(parseConfValue(conf, 'db_name'), 'my_default_db');
});

test('AUTO-2 parseConfValue 去掉引号与首尾空白', () => {
  assert.equal(parseConfValue('db_name = "  quoted_db  "', 'db_name'), 'quoted_db');
  assert.equal(parseConfValue("dbfilter = '^single$'", 'dbfilter'), '^single$');
});

test('AUTO-3 parseConfValue 未找到返回空串', () => {
  assert.equal(parseConfValue('addons_path = /a', 'db_name'), '');
  assert.equal(parseConfValue('', 'dbfilter'), '');
});

// ---------------- 优先级 ----------------

test('AUTO-4 显式配置优先于一切自动发现结果', () => {
  const r = resolveDiscoveredDbName({
    configuredDbName: 'toogel',
    confDbFilter: '^other$',
    confDbName: 'third',
    pgDatabases: ['one', 'two'],
  });
  assert.equal(r.ok, true);
  assert.equal(r.dbName, 'toogel');
  assert.equal(r.source, 'config');
  assert.equal(r.confidence, 'explicit');
});

test('AUTO-5 dbfilter 优先于 db_name，且剥离 ^...$', () => {
  const r = resolveDiscoveredDbName({
    confDbFilter: '^tg-odoo$',
    confDbName: 'other_db',
    pgDatabases: [],
  });
  assert.equal(r.dbName, 'tg-odoo');
  assert.equal(r.source, 'dbfilter');
  assert.equal(r.confidence, 'high');
});

test('AUTO-6 dbfilter=.* 不算有效（等于没配），回退 db_name', () => {
  const r = resolveDiscoveredDbName({
    confDbFilter: '.*',
    confDbName: 'default_db',
    pgDatabases: [],
  });
  assert.equal(r.dbName, 'default_db');
  assert.equal(r.source, 'db_name');
});

test('AUTO-7 db_name 可用时直接用', () => {
  const r = resolveDiscoveredDbName({ confDbName: 'default_db', pgDatabases: [] });
  assert.equal(r.dbName, 'default_db');
  assert.equal(r.source, 'db_name');
  assert.equal(r.confidence, 'high');
});

// ---------------- PG 列表兜底 ----------------

test('AUTO-8 无配置时，PG 列表恰一个非系统库 → medium 置信度采用', () => {
  const r = resolveDiscoveredDbName({
    pgDatabases: ['postgres', 'template0', 'template1', 'pgsql', 'toogel'],
    pgSuperUser: 'pgsql', // 角色名排除，剩 toogel 唯一
  });
  assert.equal(r.ok, true);
  assert.equal(r.dbName, 'toogel');
  assert.equal(r.source, 'pg-list');
  assert.equal(r.confidence, 'medium');
});

test('AUTO-9 pgSuperUser(pqsql) 所在库绝不能被当成库名', () => {
  const r = resolveDiscoveredDbName({
    pgDatabases: ['pgsql', 'toogel'],
    pgSuperUser: 'pgsql',
  });
  assert.equal(r.ok, true);
  assert.equal(r.dbName, 'toogel', 'pgsql 是 PG 角色名，不是目标库');
  assert.equal(r.source, 'pg-list');
});

test('AUTO-9b 只有超级用户同名库 → 不能自动识别', () => {
  const r = resolveDiscoveredDbName({ pgDatabases: ['pgsql'], pgSuperUser: 'pgsql' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'none');
});

test('AUTO-9c 不预设排除 odoo 等业务库名（避免凭猜测逼用户手填）', () => {
  assert.ok(!SYSTEM_DATABASES.includes('odoo'));
  const r = resolveDiscoveredDbName({ pgDatabases: ['odoo'], pgSuperUser: 'pgsql' });
  assert.equal(r.ok, true);
  assert.equal(r.dbName, 'odoo');
});

test('AUTO-10 多个候选 → ambiguous，不猜，要求人工', () => {
  const r = resolveDiscoveredDbName({ pgDatabases: ['toogel', 'toogel-old-20261109'] });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'ambiguous');
  assert.deepEqual(r.candidates.sort(), ['toogel', 'toogel-old-20261109'].sort());
});

test('AUTO-11 无候选 → none，不猜', () => {
  const r = resolveDiscoveredDbName({ pgDatabases: ['postgres'] });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'none');
});

test('AUTO-12 PG 列表本身为空/无效 → none（不抛异常）', () => {
  assert.equal(resolveDiscoveredDbName({ pgDatabases: null }).ok, false);
  assert.equal(resolveDiscoveredDbName({}).ok, false);
});

test('AUTO-13 自动识别结果始终不含 sourceDbName（源/目标隔离）', () => {
  const r = resolveDiscoveredDbName({
    confDbFilter: '^toogel$',
    sourceDbName: 'tg-odoo', // 故意传入，实现必须忽略
  });
  assert.equal(r.dbName, 'toogel');
  assert.equal(r.sourceDbName, undefined);
});
