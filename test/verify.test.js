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
