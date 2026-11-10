/**
 * v0.1.14 收尾：恢复后中立化状态管理（保持/解除）。
 *
 * 真机实证（2026-11-09 全面对比）：
 *  - 恢复机 toogel：database.is_neutralized=true / cron 1 enabled 42 disabled /
 *    占位邮件服务器 smtp_host=invalid / payment_provider 全 disabled / 原邮件凭据被清空
 *  - 源机 tg-odoo：无 neutralize 标记 / cron 36 enabled 7 disabled /
 *    邮件 active=true 且带凭据 / payment alipay+airwallex enabled
 *  - Odoo base neutralize.sql 只做 4 件事；payment/data/neutralize.sql 把非 test/disabled
 *    的支付全置 disabled，且**不记录**哪些原本 enabled ⇒ 解除绝不猜支付。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import {
  buildStatusScript, parseStatus,
  buildApplyScript, parseApplyResult,
  NEUTRALIZE_STATUS_SQL, APPLY_NEUTRALIZE_SQL,
} from '../lib/neutralize.js';

// ---------------- 状态判定 ----------------

// 真实输出格式：psql -AtF'|' → key|value
const STATUS_OUT = [
  '===NEU_STATUS===',
  'flag|true',
  'cron_active|1',
  'cron_disabled|42',
  'mail_placeholder|1',
  'mail_real_active|0',
  'mail_real_with_creds|0',
  'payment_enabled|0',
  'payment_disabled|26',
  'webhook_neutralized|0',
  '===NEU_STATUS_END===',
].join('\n');

test('NEU-1 状态脚本含四类探针且只查目标库', () => {
  const s = buildStatusScript();
  assert.match(NEUTRALIZE_STATUS_SQL, /database\.is_neutralized/);
  assert.match(NEUTRALIZE_STATUS_SQL, /ir_cron/);
  assert.match(NEUTRALIZE_STATUS_SQL, /ir_mail_server/);
  assert.match(NEUTRALIZE_STATUS_SQL, /payment_provider/);
  assert.match(s, /read -r DB/);
  assert.match(s, /psql -U "\$PG_SUPER" -d "\$DB"/);
  assert.ok(!/\\c |CONNECT |dblink/.test(s), '不得跨库');
});

test('NEU-2 parseStatus 中立化状态', () => {
  const r = parseStatus(STATUS_OUT);
  assert.equal(r.ok, true);
  assert.equal(r.neutralized, true);
  assert.equal(r.flag, true);
  assert.equal(r.cronActive, 1);
  assert.equal(r.cronDisabled, 42);
  assert.equal(r.mailPlaceholder, 1);
  assert.equal(r.paymentEnabled, 0);
  assert.equal(r.paymentDisabled, 26);
});

test('NEU-3 parseStatus 已解除状态', () => {
  const out = [
    '===NEU_STATUS===',
    'flag|false',
    'cron_active|36',
    'cron_disabled|7',
    'mail_placeholder|0',
    'mail_real_active|1',
    'mail_real_with_creds|1',
    'payment_enabled|2',
    'payment_disabled|24',
    'webhook_neutralized|0',
    '===NEU_STATUS_END===',
  ].join('\n');
  const r = parseStatus(out);
  assert.equal(r.ok, true);
  assert.equal(r.neutralized, false);
  assert.equal(r.cronActive, 36);
  assert.equal(r.paymentEnabled, 2);
});

test('NEU-4 坏输出 → ok:false（不静默成功）', () => {
  assert.equal(parseStatus('').ok, false);
  assert.equal(parseStatus('boom').ok, false);
  const r = parseStatus('===NEU_STATUS===\nerror=psql: FATAL\n===NEU_STATUS_END===');
  assert.equal(r.ok, false);
  assert.match(r.reason ?? '', /psql|FATAL/);
});

// ---------------- 解除 SQL ----------------

test('NEU-5 解除 SQL 覆盖 base neutralize 可还原项', () => {
  assert.match(APPLY_NEUTRALIZE_SQL, /DELETE FROM ir_config_parameter/);
  assert.match(APPLY_NEUTRALIZE_SQL, /database\.is_neutralized/);
  assert.match(APPLY_NEUTRALIZE_SQL, /UPDATE ir_cron\s+SET active = true/);
  assert.match(APPLY_NEUTRALIZE_SQL, /DELETE FROM ir_mail_server/);
  assert.match(APPLY_NEUTRALIZE_SQL, /UPDATE ir_mail_server\s+SET active = true/);
  assert.match(APPLY_NEUTRALIZE_SQL, /DELETE FROM mail_mail/);
  assert.match(APPLY_NEUTRALIZE_SQL, /exception/);
  assert.match(APPLY_NEUTRALIZE_SQL, /webhook_url/);
});

test('NEU-6 默认不含启用支付的语句（绝不猜）', () => {
  const s = buildApplyScript();
  assert.ok(!/UPDATE payment_provider/.test(s), '未显式给 code 时不得启用任何支付');
  assert.ok(!/state = 'enabled'/.test(s));
});

test('NEU-7 显式传 enablePaymentCodes 才启用，且逐项校验合法性', () => {
  const s = buildApplyScript({ enablePaymentCodes: ['alipay', 'airwallex'] });
  assert.match(s, /UPDATE payment_provider/);
  assert.match(s, /alipay/);
  assert.match(s, /airwallex/);
  assert.match(s, /code IN/);
  // 非法 code 一律剔除，不进 SQL
  const bad = buildApplyScript({ enablePaymentCodes: ["evil'); DROP TABLE x;--", 'ok_code'] });
  assert.ok(!/DROP TABLE/.test(bad));
  assert.ok(!/evil/.test(bad));
  assert.match(bad, /ok_code/);
});

test('NEU-8 解除脚本绝不跨库 / 不删库 / 不含其它库名', () => {
  const s = buildApplyScript();
  assert.ok(!/DROP DATABASE/.test(s));
  assert.ok(!/\\c |CONNECT |dblink/.test(s));
  assert.match(s, /psql -U "\$PG_SUPER" -d "\$DB"/);
});

test('NEU-9 parseApplyResult 正常 → applied + 重启提示 + 凭据警告', () => {
  const out = [
    '===NEU_APPLY===',
    'rc=0',
    'flag_deleted=1',
    'cron_enabled=42',
    'placeholder_deleted=1',
    'mail_reactivated=1',
    'pending_mail_deleted=22',
    'payment_enabled=0',
    'webhook_cleared=0',
    '===NEU_APPLY_END===',
  ].join('\n');
  const r = parseApplyResult(out);
  assert.equal(r.ok, true);
  assert.equal(r.applied, true);
  assert.equal(r.cronEnabled, 42);
  assert.equal(r.restartRequired, true);
  assert.ok(r.warnings.some((w) => /SMTP|凭据|重填/.test(w)), '必须警告凭据需人工重填');
  assert.ok(r.warnings.some((w) => /支付|disabled|禁用/.test(w)), '必须告知支付保持禁用');
});

test('NEU-10 parseApplyResult 失败 → applied=false 带原因', () => {
  assert.equal(parseApplyResult('').applied, false);
  const r = parseApplyResult('===NEU_APPLY===\nrc=1\nerror=permission denied\n===NEU_APPLY_END===');
  assert.equal(r.applied, false);
  assert.match(r.reason ?? '', /permission|rc=1/);
});

test('NEU-11 解除脚本带 docker restart（使配置生效）', () => {
  const s = buildApplyScript();
  assert.match(s, /docker restart/);
});

test('NEU-12 解除脚本不触碰 web.base.url / website.domain / Compose', () => {
  const s = buildApplyScript();
  assert.ok(!/web\.base\.url|website\.domain|docker-compose|compose/i.test(s));
});
