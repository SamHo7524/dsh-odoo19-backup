import { test } from 'node:test';
import assert from 'node:assert';
import { parseDbFilter, parseInspect } from '../lib/discover.js';

test('parseDbFilter 正确处理 ^tg-odoo$', () => {
  // 关键：不能用 sed -E 's/.*\^?([A-Za-z0-9_-]+)\$?.*/\1/'
  // 因为 ERE 里 \$ 是行尾锚点，会得到单字符
  assert.equal(parseDbFilter('dbfilter = ^tg-odoo$'), 'tg-odoo');
  assert.equal(parseDbFilter('dbfilter=^mydb$'), 'mydb');
});

test('parseDbFilter 处理 .* 通配', () => {
  assert.equal(parseDbFilter('dbfilter = .*'), '');
  assert.equal(parseDbFilter('dbfilter=.*'), '');
});

test('parseDbFilter 空输入返回空', () => {
  assert.equal(parseDbFilter(''), '');
  assert.equal(parseDbFilter(null), '');
  assert.equal(parseDbFilter(undefined), '');
});

test('parseDbFilter 无 dbfilter 行返回空', () => {
  assert.equal(parseDbFilter('admin_passwd = x\ndb_host = pg\n'), '');
});

test('parseDbFilter 忽略注释行', () => {
  assert.equal(parseDbFilter('# dbfilter = ^commented$\ndbfilter = ^real$'), 'real');
});

test('parseDbFilter 处理带引号的值', () => {
  assert.equal(parseDbFilter('dbfilter = "^quoted$"'), 'quoted');
  assert.equal(parseDbFilter("dbfilter = '^single$'"), 'single');
});

test('parseDbFilter 处理带连字符与下划线的库名', () => {
  assert.equal(parseDbFilter('dbfilter = ^my-db_name$'), 'my-db_name');
});

test('parseInspect 提取容器关键信息', () => {
  const inspect = [
    'HOST=postgresql',
    'USER=toogel',
    'PASSWORD=secret',
    'ODOO_RC=/etc/odoo/odoo.conf',
    '---MOUNTS---',
    '/opt/app/data/addons=>/mnt/extra-addons',
    '/opt/app/data/data=>/var/lib/odoo',
    '---IMAGE---',
    'sha256:abc123',
  ].join('\n');

  const r = parseInspect(inspect);
  assert.equal(r.dbHost, 'postgresql');
  assert.equal(r.dbUser, 'toogel');
  assert.equal(r.addonsPath, '/opt/app/data/addons');
  assert.equal(r.dataPath, '/opt/app/data/data');
  assert.equal(r.imageId, 'sha256:abc123');
});

test('parseInspect 绝不泄露密码', () => {
  const inspect = [
    'HOST=pg',
    'USER=u',
    'PASSWORD=supersecret123',
    '---MOUNTS---',
    '---IMAGE---',
    'sha256:x',
  ].join('\n');

  const r = parseInspect(inspect);
  assert.ok(!JSON.stringify(r).includes('supersecret123'), '解析结果不得含密码');
});

test('parseInspect 容忍缺失的段', () => {
  const r = parseInspect('HOST=h\nUSER=u');
  assert.equal(r.dbHost, 'h');
  assert.equal(r.dbUser, 'u');
  assert.equal(r.addonsPath, '');
  assert.equal(r.dataPath, '');
});

test('parseInspect 空输入不抛异常', () => {
  const r = parseInspect('');
  assert.equal(r.dbHost, '');
  assert.equal(r.imageId, '');
});
