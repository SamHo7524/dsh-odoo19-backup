import { test } from 'node:test';
import assert from 'node:assert';
import { parseCommDiff, checkVersionCompatible } from '../lib/verify.js';

test('parseCommDiff 计算缺失数', () => {
  const db = 'a/1\nb/2\nc/3\n';
  const fs = 'a/1\nc/3\n';
  assert.equal(parseCommDiff(db, fs).missing, 1);
  assert.equal(parseCommDiff(db, fs).extra, 0);
});

test('parseCommDiff 计算多缺失与多余', () => {
  const db = 'a\nb\nc\n';
  const fs = 'a\nb\nx\n';
  const r = parseCommDiff(db, fs);
  assert.equal(r.missing, 1); // c
  assert.equal(r.extra, 1); // x
  assert.equal(r.dbCount, 3);
  assert.equal(r.fsCount, 3);
});

test('parseCommDiff 空输入不产生误报', () => {
  const r = parseCommDiff('', '');
  assert.equal(r.missing, 0);
  assert.equal(r.extra, 0);
  assert.equal(r.dbCount, 0);
  assert.equal(r.fsCount, 0);
});

test('parseCommDiff 忽略空白行与首尾空格', () => {
  const db = ' a \n\n  b\n';
  const fs = 'a\nb\n';
  const r = parseCommDiff(db, fs);
  assert.equal(r.missing, 0);
  assert.equal(r.extra, 0);
});

test('checkVersionCompatible 同大版本通过', () => {
  const r = checkVersionCompatible('19.0-20260619', '19.0-20261102');
  assert.equal(r.ok, true);
  assert.equal(r.level, 'same-major');
});

test('checkVersionCompatible 跨大版本拒绝', () => {
  const r = checkVersionCompatible('19.0-20260619', '20.0-20261102');
  assert.equal(r.ok, false);
  assert.equal(r.level, 'cross-major');
  assert.ok(r.reason.includes('跨大版本'));
});

test('checkVersionCompatible 版本缺失时拒绝', () => {
  const r = checkVersionCompatible('', '19.0-20261102');
  assert.equal(r.ok, false);
});

test('checkVersionCompatible 源版本缺失也拒绝', () => {
  const r = checkVersionCompatible('19.0-x', '');
  assert.equal(r.ok, false);
});

test('checkVersionCompatible 无法解析时拒绝', () => {
  const r = checkVersionCompatible('dev', '19.0-1');
  assert.equal(r.ok, false);
  assert.equal(r.level, 'unknown');
});

// ---------------- v0.1.25：V6/V7 改由 Odoo 自身验证 ----------------
import { parseModuleCodeCheck, parseAttachmentCheck } from '../lib/verify.js';

test('V6-P1 全部模块代码可载入 = 通过', () => {
  const r = parseModuleCodeCheck('MODCHECK_TOTAL=167\nMODCHECK_BAD=none');
  assert.equal(r.ok, true);
  assert.match(r.detail, /167/);
});

test('V6-P2 有模块代码没载入必须判失败并点名（website_clarity 同款）', () => {
  const r = parseModuleCodeCheck('MODCHECK_TOTAL=167\nMODCHECK_BAD=website_clarity,tugou_blog_seo');
  assert.equal(r.ok, false);
  assert.match(r.detail, /website_clarity/);
  assert.equal(r.bad.length, 2);
});

test('V6-P3 没拿到结果就是失败（不能默认通过）', () => {
  assert.equal(parseModuleCodeCheck('garbage').ok, false);
  assert.equal(parseModuleCodeCheck('').ok, false);
});

test('V7-P1 sha1 与 filestore 文件名一致 = 通过', () => {
  const r = parseAttachmentCheck('V7_SHA=abc123\nV7_NAME=abc123\nV7_BYTES=42');
  assert.equal(r.ok, true);
  assert.match(r.detail, /匹配/);
});

test('V7-P2 不一致必须判失败', () => {
  const r = parseAttachmentCheck('V7_SHA=aaa\nV7_NAME=bbb\nV7_BYTES=42');
  assert.equal(r.ok, false);
  assert.match(r.detail, /不一致/);
});

test('V7-P3 无 public 图片附件时跳过且不算失败', () => {
  const r = parseAttachmentCheck('V7_NONE');
  assert.equal(r.ok, true);
  assert.equal(r.skipped, true);
});

test('V7-P4 没返回结果不得默认通过', () => {
  assert.equal(parseAttachmentCheck('garbage').ok, false);
});
