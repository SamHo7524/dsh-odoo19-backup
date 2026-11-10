import { test } from 'node:test';
import assert from 'node:assert';
import { normalizeRestorePath } from '../lib/restore-path.js';

const win = { platform: 'win32' };

test('PATH-1 带完整双引号路径：去引号', () => {
  assert.equal(normalizeRestorePath('"K:\\Backup\\odoo\\x.tar.enc"', win),
    'K:\\Backup\\odoo\\x.tar.enc');
});
test('PATH-2 无引号路径：原样保留', () => {
  assert.equal(normalizeRestorePath('K:\\Backup\\odoo\\x.tar.enc', win),
    'K:\\Backup\\odoo\\x.tar.enc');
});
test('PATH-3 带首尾空格：trim', () => {
  assert.equal(normalizeRestorePath('   K:\\Backup\\odoo\\x.tar.enc  ', win),
    'K:\\Backup\\odoo\\x.tar.enc');
});
test('PATH-4 引号+首尾空格：先 trim 再去引号', () => {
  assert.equal(normalizeRestorePath('  "K:\\Backup\\odoo\\x.tar.enc"  ', win),
    'K:\\Backup\\odoo\\x.tar.enc');
});
test('PATH-5 斜杠统一为反斜杠（Windows 场景）', () => {
  assert.equal(normalizeRestorePath('K:/Backup/odoo/x.tar.enc', win),
    'K:\\Backup\\odoo\\x.tar.enc');
  assert.equal(normalizeRestorePath('"K:/Backup/odoo/x.tar.enc"', win),
    'K:\\Backup\\odoo\\x.tar.enc');
});
test('PATH-6 非 Windows 场景保留正斜杠', () => {
  assert.equal(normalizeRestorePath('/backup/x.tar.enc', { platform: 'linux' }),
    '/backup/x.tar.enc');
});
test('PATH-7 单侧前引号不删除', () => {
  const r = normalizeRestorePath('"K:\\Backup\\odoo\\x.tar.enc', win);
  assert.ok(r.startsWith('"'), '单侧前引号必须保留');
});
test('PATH-8 单侧后引号不删除', () => {
  const r = normalizeRestorePath('K:\\Backup\\odoo\\x.tar.enc"', win);
  assert.ok(r.endsWith('"'), '单侧后引号必须保留');
});
test('PATH-9 不匹配的引号（双引号+单引号）不动', () => {
  assert.equal(normalizeRestorePath('"K:\\x.tar.enc\'', win), '"K:\\x.tar.enc\'');
});
test('PATH-10 空值/null/undefined 返回空串', () => {
  assert.equal(normalizeRestorePath('', win), '');
  assert.equal(normalizeRestorePath(null, win), '');
  assert.equal(normalizeRestorePath(undefined, win), '');
});
test('PATH-11 幂等：规范化两次结果不变', () => {
  const once = normalizeRestorePath('  "K:/Backup/x.tar.enc" ', win);
  assert.equal(normalizeRestorePath(once, win), once);
});
