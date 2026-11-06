import { test } from 'node:test';
import assert from 'node:assert';
import {
  guardDbName,
  buildTerminateSql,
  buildExactLookupSql,
  switchRenameSql,
  rollbackRenameSql,
  assertTargetsAllowed,
} from '../lib/dbguard.js';

// 事故教训：清理/回滚不得用 LIKE '<主库>%' 之类前缀通配——会误伤恢复目标之外的库。

test('guardDbName 接受本插件使用的精确库名', () => {
  assert.equal(guardDbName('tg-odoo'), 'tg-odoo');
  assert.equal(guardDbName('tg-odoo-old-20261104093000'), 'tg-odoo-old-20261104093000');
  assert.equal(guardDbName('tg-odoo-restore-20261104093000'), 'tg-odoo-restore-20261104093000');
});

test('guardDbName 拒绝通配符 / 前缀模式 / 注入 / 空值', () => {
  assert.throws(() => guardDbName('tg-odoo%'), /不安全的数据库名/);
  assert.throws(() => guardDbName('tg%'), /不安全的数据库名/);
  assert.throws(() => guardDbName('*'), /不安全的数据库名/);
  assert.throws(() => guardDbName('tg-odoo; DROP DATABASE postgres'), /不安全的数据库名/);
  assert.throws(() => guardDbName('tg-odoo" RENAME TO "x'), /不安全的数据库名/);
  assert.throws(() => guardDbName(''), /不安全的数据库名/);
  assert.throws(() => guardDbName(null), /不安全的数据库名/);
  assert.throws(() => guardDbName('tg odoo'), /不安全的数据库名/);
});

test('buildTerminateSql 用精确 IN 列表，绝不含 LIKE 或 %', () => {
  const sql = buildTerminateSql(['tg-odoo', 'tg-odoo-old-20261104093000']);
  assert.match(sql, /datname IN \('tg-odoo', 'tg-odoo-old-20261104093000'\)/);
  assert.ok(!/LIKE/i.test(sql), '不得出现 LIKE');
  assert.ok(!sql.includes('%'), '不得出现通配 %');
  assert.throws(() => buildTerminateSql(['tg-odoo%']), /不安全的数据库名/);
});

test('buildExactLookupSql 用精确 IN 列表做只读探测', () => {
  const sql = buildExactLookupSql(['tg-odoo', 'tg-odoo-old-20261104093000']);
  assert.match(sql, /datname in \('tg-odoo', 'tg-odoo-old-20261104093000'\)/);
  assert.ok(!/LIKE/i.test(sql));
  assert.ok(!sql.includes('%'));
});

test('switchRenameSql 生成两条精确 ALTER RENAME', () => {
  const [a, b] = switchRenameSql({
    db: 'tg-odoo',
    oldDb: 'tg-odoo-old-20261104093000',
    tmpDb: 'tg-odoo-restore-20261104093000',
  });
  assert.equal(a, 'ALTER DATABASE "tg-odoo" RENAME TO "tg-odoo-old-20261104093000"');
  assert.equal(b, 'ALTER DATABASE "tg-odoo-restore-20261104093000" RENAME TO "tg-odoo"');
  assert.ok(!`${a}${b}`.includes('%'));
});

test('rollbackRenameSql 生成两条精确 ALTER RENAME', () => {
  const [a, b] = rollbackRenameSql({
    db: 'tg-odoo',
    oldDb: 'tg-odoo-old-20261104093000',
    failedDb: 'tg-odoo-failed-20261104093000',
  });
  assert.equal(a, 'ALTER DATABASE "tg-odoo" RENAME TO "tg-odoo-failed-20261104093000"');
  assert.equal(b, 'ALTER DATABASE "tg-odoo-old-20261104093000" RENAME TO "tg-odoo"');
});

test('assertTargetsAllowed 放行授权库名，拒绝清单外的库', () => {
  const allowed = ['tg-odoo', 'tg-odoo-old-20261104093000', 'tg-odoo-restore-20261104093000'];
  assert.equal(assertTargetsAllowed(['tg-odoo', 'tg-odoo-old-20261104093000'], allowed), true);
  assert.throws(
    () => assertTargetsAllowed(['tg-odoo-backup-20261103'], allowed),
    /未在授权清单内的数据库/,
  );
});

test('assertTargetsAllowed 拒绝任何模式/注入作为目标或授权项', () => {
  assert.throws(() => assertTargetsAllowed(['tg-odoo%'], ['tg-odoo']), /不安全的数据库名/);
  assert.throws(() => assertTargetsAllowed(['tg-odoo'], ['tg-odoo%']), /不安全的数据库名/);
});
