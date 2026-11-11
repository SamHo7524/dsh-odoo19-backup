// v0.1.17 — 恢复前必须做版本闸门。
// 背景：checkVersionCompatible 早已存在但从未被调用（死代码），导致 19 备份恢复到 20 目标机
// 一直跑到 odoo db load 才炸在 Odoo 自己的 neutralize SQL 上。这些用例钉死「预检即拒绝」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sourceVersionOf, versionGate } from '../lib/version-gate.js';

test('VG-1 同大版本放行', () => {
  const g = versionGate({ sourceVersion: '19.0-20260619', targetVersion: '19.0-20261102' });
  assert.equal(g.ok, true);
  assert.equal(g.level, 'same-major');
});

test('VG-2 跨大版本拒绝，且消息里两个版本都要出现', () => {
  const g = versionGate({ sourceVersion: '19.0-20260619', targetVersion: '20.0-20261102' });
  assert.equal(g.ok, false);
  assert.equal(g.level, 'cross-major');
  assert.match(g.message, /19\.0-20260619/);
  assert.match(g.message, /20\.0-20261102/);
  assert.match(g.message, /升级|同大版本/);
});

test('VG-3 源版本缺失 → 放行但必须显式警告（旧备份包不能一票否决）', () => {
  const g = versionGate({ sourceVersion: '', targetVersion: '20.0-20261102' });
  assert.equal(g.ok, true);
  assert.equal(g.level, 'unknown');
  assert.match(g.warning, /无法预检版本|风险/);
  assert.match(g.warning, /odoo --version|重新备份/);
});

test('VG-4 目标版本缺失 → 同样放行并警告', () => {
  const g = versionGate({ sourceVersion: '19.0-x', targetVersion: '' });
  assert.equal(g.ok, true);
  assert.equal(g.level, 'unknown');
  assert.match(g.warning, /目标机/);
});

test('VG-5 sourceVersionOf 从备份包 MANIFEST 取 odooVersion', () => {
  assert.equal(sourceVersionOf({ source: { odooVersion: '19.0-20260619' } }), '19.0-20260619');
  assert.equal(sourceVersionOf({ source: {} }), '');
  assert.equal(sourceVersionOf(null), '');
  assert.equal(sourceVersionOf({ source: { odooVersion: '   ' } }), '');
});

test('VG-6 消息必须可操作：给出「换同大版本目标机」或「按升级项目处理」两条路', () => {
  const g = versionGate({ sourceVersion: '19.0-1', targetVersion: '20.0-2' });
  assert.match(g.message, /恢复/);
  assert.match(g.message, /建议/);
});