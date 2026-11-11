// v0.1.17 — 失败必须有诊断（用户要求：不能直接甩黑盒错误，要先给原因和建议）。
// 这些用例钉死「已知故障模式 → 人能读懂的说明」的映射。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diagnoseFailure, explainFailure } from '../lib/diagnose.js';

test('DIAG-1 真实失败文本：Odoo neutralize 的 is_live 列缺失 → 判定为大版本不一致', () => {
  const raw = `失败：odoo db load 失败 (rc=1)：ython3/dist-packages/odoo/modules/db.py", line 669, in restore
    odoo.modules.neutralize.neutralize_database(cr)
  File "/usr/lib/python3/dist-packages/odoo/modules/neutralize.py", line 47, in neutralize_database
psycopg2.errors.UndefinedColumn: column "is_live" of relation "payment_provider" does not exist
LINE 3:    SET is_live = False;`;
  const d = diagnoseFailure(raw);
  assert.equal(d.ok, false);
  assert.equal(d.code, 'odoo-major-mismatch');
  assert.match(d.cause, /payment_provider/);
  assert.match(d.suggestion, /Odoo 19|大版本|升级|同大版本/);
});

test('DIAG-2 一般 relation does not exist → 表结构不匹配', () => {
  const d = diagnoseFailure('psycopg2.errors.UndefinedTable: relation "ir_access" does not exist');
  assert.equal(d.ok, false);
  assert.equal(d.code, 'schema-mismatch');
  assert.match(d.suggestion, /大版本|同版本|schema/i);
});

test('DIAG-3 库已存在 → 提示残留库清理', () => {
  const d = diagnoseFailure('ERROR: database "tg-odoo-restore-1" already exists');
  assert.equal(d.code, 'db-exists');
  assert.match(d.suggestion, /DROP DATABASE|清理|遗留/);
});

test('DIAG-4 磁盘满', () => {
  const d = diagnoseFailure('tar: /tmp/odoo-backup.tar: Cannot write: No space left on device');
  assert.equal(d.code, 'disk-full');
  assert.match(d.suggestion, /空间|df -h|清理/);
});

test('DIAG-5 SSH 认证失败与主机指纹失败要分开说', () => {
  const auth = diagnoseFailure('Permission denied (publickey,password).');
  assert.equal(auth.code, 'ssh-auth');
  const host = diagnoseFailure('Host key verification failed.');
  assert.equal(host.code, 'ssh-hostkey');
  assert.notEqual(auth.suggestion, host.suggestion);
});

test('DIAG-6 数据库连不上', () => {
  const d = diagnoseFailure('psql: error: could not connect to server: Connection refused');
  assert.equal(d.code, 'db-connect');
  assert.match(d.suggestion, /postgres|容器|端口/);
});

test('DIAG-7 未命中规则时保持原样（绝不吞错、绝不臆测）', () => {
  const raw = 'something completely unexpected happened';
  const d = diagnoseFailure(raw);
  assert.equal(d.ok, true);
  assert.equal(explainFailure(raw), raw);
});

test('DIAG-8 explainFailure 在命中时追加「诊断」段且保留原始错误', () => {
  const raw = 'psycopg2.errors.UndefinedColumn: column "is_live" of relation "payment_provider" does not exist';
  const out = explainFailure(raw);
  assert.match(out, /is_live/);          // 原始错误保留
  assert.match(out, /诊断/);              // 追加诊断段
  assert.match(out, /建议/);
});