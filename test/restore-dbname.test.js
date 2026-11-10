/**
 * v0.1.14 真机缺陷（2026-11-09，odoo.toogel.cn 恢复失败）：
 *   状态文件报「不安全的数据库名：（空值或过长）」
 *
 * 根因链：
 *   1. 目标机 odoo.conf 的 dbfilter 被注释掉 → parseDbFilter 返回 ''
 *   2. discover() 从不读取服务器配置里的 dbName（该字段声明了却从未被使用）
 *   3. 恢复直接带着空库名进入阶段 A → guardDbName 抛错，报错文案无法指导用户
 *
 * 期望行为：显式配置的库名优先；没有配置也没有 dbfilter 时，用可操作的错误
 * 在动手之前就停下（不猜库名），并让用户在服务器表单里填。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolveDbName } from '../lib/discover.js';
import { runRestore } from '../lib/restore.js';

const clientSrc = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

// ---------------- 库名解析 ----------------

test('DBN-1 显式配置的库名优先于 dbfilter', () => {
  assert.equal(resolveDbName({ configured: 'toogel', confText: 'dbfilter = ^other$' }), 'toogel');
});

test('DBN-2 未配置时回退到 dbfilter', () => {
  assert.equal(resolveDbName({ configured: '', confText: 'dbfilter = ^toogel$' }), 'toogel');
});

test('DBN-3 配置与 dbfilter 都没有 → 空串（不猜）', () => {
  assert.equal(resolveDbName({ configured: '', confText: '; dbfilter = .*\naddons_path = /mnt/extra-addons' }), '');
  assert.equal(resolveDbName({ configured: null, confText: '' }), '');
});

test('DBN-4 配置值两端空白被清理', () => {
  assert.equal(resolveDbName({ configured: '  toogel  ', confText: '' }), 'toogel');
});

test('DBN-5 discover 源码确实使用 resolveDbName（不再只是 dbfilter）', () => {
  const discoverSrc = readFileSync(new URL('../lib/discover.js', import.meta.url), 'utf8');
  assert.match(discoverSrc, /resolveDbName/, 'discover 必须走统一解析');
  assert.match(discoverSrc, /server\.dbName|server\?\.dbName/, '必须读取服务器配置的 dbName');
});

// ---------------- 恢复前置校验 ----------------

const baseInstance = {
  kind: 'docker',
  odooContainer: 'c',
  pgContainer: 'p',
  dbName: '',
  dataPath: '/data',
  addonsPath: '/addons',
};

test('DBN-6 库名为空时，恢复在动手之前就失败，且错误可操作', async () => {
  await assert.rejects(
    () => runRestore({
      server: { name: 'odoo.toogel.cn', host: 'h' },
      instance: baseInstance,
      packagePath: 'K:/definitely-missing-package.tar.enc',
      options: { passphrase: 'x' },
    }),
    (err) => {
      assert.match(err.message, /数据库名/, '必须指出是数据库名缺失');
      assert.match(err.message, /dbfilter/, '要解释为什么推不出来');
      assert.match(err.message, /服务器/, '要告诉用户去服务器配置里填');
      return true;
    },
  );
});

test('DBN-7 库名缺失时报错不能是「文件不存在」这类无关错误（前置校验优先）', async () => {
  await assert.rejects(
    () => runRestore({
      server: { name: 's', host: 'h' },
      instance: { ...baseInstance, dbName: '' },
      packagePath: 'K:/definitely-missing-package.tar.enc',
      options: {},
    }),
    (err) => {
      assert.ok(!/ENOENT|no such file/i.test(err.message), `不应先撞到文件错误：${err.message}`);
      return true;
    },
  );
});

// ---------------- 服务器表单 ----------------

test('DBN-8 服务器表单提供「数据库名」输入框（留空=从 dbfilter 解析）', () => {
  assert.match(clientSrc, /'aria-label':?\s*['"]数据库名|数据库名[^']*aria-label/, '需要可编辑输入框');
  assert.match(clientSrc, /draft\.dbName/, '表单状态需包含 dbName');
  assert.match(clientSrc, /dbName:\s*\(?\s*draft\.dbName/, '保存时必须提交 dbName');
});

test('DBN-9 编辑服务器时保留未在表单中展示的既有字段（不静默丢配置）', () => {
  const i = clientSrc.indexOf('const nextServer = {');
  assert.ok(i > 0, '应存在 nextServer 构造');
  const seg = clientSrc.slice(i, i + 700);
  assert.match(seg, /\.\.\.\(existing \?\? \{\}\)/, 'nextServer 必须先展开既有服务器，避免编辑丢字段');
});
