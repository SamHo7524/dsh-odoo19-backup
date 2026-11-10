/**
 * 中立化状态管理（v0.1.14 收尾）。
 *
 * 职责边界（严格遵守）：
 *  - 只构造 SQL / 解析输出，不做 IO、不读凭据、不碰其它库。
 *  - 只对调用方给出的单一目标库执行（脚本从 stdin 读 DB 名）。
 *  - 解除时**绝不猜**支付提供商：只有显式传入 enablePaymentCodes 才启用。
 *  - 不记录任何密钥/凭据明文。
 *
 * 依据：Odoo 19 `base/data/neutralize.sql`（4 件事）+ `payment/data/neutralize.sql`。
 */

/** 状态探针 SQL：一次会话取全部判定依据。 */
export const NEUTRALIZE_STATUS_SQL = `
SELECT 'flag', coalesce((SELECT value FROM ir_config_parameter WHERE key='database.is_neutralized'), 'absent')
UNION ALL
SELECT 'cron_active', (SELECT count(*)::text FROM ir_cron WHERE active)
UNION ALL
SELECT 'cron_disabled', (SELECT count(*)::text FROM ir_cron WHERE NOT active)
UNION ALL
SELECT 'mail_placeholder', (SELECT count(*)::text FROM ir_mail_server WHERE smtp_host='invalid')
UNION ALL
SELECT 'mail_real_active', (SELECT count(*)::text FROM ir_mail_server WHERE smtp_host<>'invalid' AND active)
UNION ALL
SELECT 'mail_real_with_creds', (SELECT count(*)::text FROM ir_mail_server WHERE smtp_host<>'invalid' AND smtp_user IS NOT NULL)
UNION ALL
SELECT 'payment_enabled', (SELECT count(*)::text FROM payment_provider WHERE state NOT IN ('disabled','test'))
UNION ALL
SELECT 'payment_disabled', (SELECT count(*)::text FROM payment_provider WHERE state='disabled')
UNION ALL
SELECT 'webhook_neutralized', (SELECT count(*)::text FROM ir_act_server WHERE webhook_url='neutralization - disable webhook')
`.trim();

/** 解除中立化 SQL：只还原 base neutralize 能还原的项。 */
export const APPLY_NEUTRALIZE_SQL = `
\\set ON_ERROR_STOP on
-- 1) 去掉中立化标记
DELETE FROM ir_config_parameter WHERE key='database.is_neutralized';
-- 2) 先清掉中立化期间堆积的未发邮件，避免 cron 一开就批量外发
DELETE FROM mail_mail WHERE state IN ('exception','outgoing','cancel');
-- 3) 删掉占位邮件服务器
DELETE FROM ir_mail_server WHERE smtp_host='invalid' AND name='neutralization - disable emails';
-- 4) 重新启用真实邮件服务器（凭据已被清空，需人工重填）
UPDATE ir_mail_server SET active = true WHERE smtp_host<>'invalid';
-- 5) 恢复被 neutralization 改写的 webhook
UPDATE ir_act_server SET webhook_url = NULL WHERE webhook_url='neutralization - disable webhook';
-- 6) 启用定时任务
UPDATE ir_cron SET active = true WHERE NOT active;
`.trim();

/** 合法支付 code 白名单形态：小写字母数字下划线，1..64 位。 */
const CODE_RE = /^[a-z0-9_]{1,64}$/;

function sanitizeCodes(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  for (const raw of list) {
    const code = String(raw ?? '').trim().toLowerCase();
    if (CODE_RE.test(code)) seen.add(code);
  }
  return [...seen];
}

/**
 * 状态查询脚本。stdin: PG_CONTAINER / PG_SUPER / DB（各一行）。
 */
export function buildStatusScript() {
  return [
    'set -u',
    'read -r PG_CONTAINER',
    'read -r PG_SUPER',
    'read -r DB',
    'echo "===NEU_STATUS==="',
    `docker exec -i "$PG_CONTAINER" psql -U "$PG_SUPER" -d "$DB" -AtF'|' -v ON_ERROR_STOP=1 -c ${shellQuote(NEUTRALIZE_STATUS_SQL)} 2>&1`,
    'echo "===NEU_STATUS_END==="',
  ].join('\n');
}

/**
 * 解除脚本。stdin: PG_CONTAINER / PG_SUPER / DB / ODOO_CONTAINER（各一行）。
 * 仅在显式 enablePaymentCodes 时追加启用支付的语句。
 */
export function buildApplyScript({ enablePaymentCodes } = {}) {
  const codes = sanitizeCodes(enablePaymentCodes);
  const paymentSql = codes.length
    ? `\n-- 7) 显式启用的支付提供商（用户指定）\nUPDATE payment_provider SET state='enabled' WHERE code IN (${codes
        .map((c) => `'${c}'`)
        .join(', ')});`
    : '\n-- 7) 支付提供商保持 disabled（未显式指定，绝不猜）';

  return [
    'set -u',
    'read -r PG_CONTAINER',
    'read -r PG_SUPER',
    'read -r DB',
    'read -r ODOO_CONTAINER',
    'echo "===NEU_APPLY==="',
    `OUT=$(docker exec -i "$PG_CONTAINER" psql -U "$PG_SUPER" -d "$DB" -AtF'|' -v ON_ERROR_STOP=1 -c ${shellQuote(
      APPLY_NEUTRALIZE_SQL + paymentSql,
    )} 2>&1)`,
    'RC=$?',
    'echo "rc=$RC"',
    '[ "$RC" -ne 0 ] && echo "error=$OUT"',
    `echo "flag_deleted=$(docker exec -i "$PG_CONTAINER" psql -U "$PG_SUPER" -d "$DB" -At -c "SELECT CASE WHEN count(*)=0 THEN 1 ELSE 0 END FROM ir_config_parameter WHERE key='database.is_neutralized'" 2>/dev/null)"`,
    `echo "cron_enabled=$(docker exec -i "$PG_CONTAINER" psql -U "$PG_SUPER" -d "$DB" -At -c 'SELECT count(*) FROM ir_cron WHERE active' 2>/dev/null)"`,
    `echo "placeholder_deleted=$(docker exec -i "$PG_CONTAINER" psql -U "$PG_SUPER" -d "$DB" -At -c "SELECT CASE WHEN count(*)=0 THEN 1 ELSE 0 END FROM ir_mail_server WHERE smtp_host='invalid'" 2>/dev/null)"`,
    `echo "mail_reactivated=$(docker exec -i "$PG_CONTAINER" psql -U "$PG_SUPER" -d "$DB" -At -c "SELECT count(*) FROM ir_mail_server WHERE smtp_host<>'invalid' AND active" 2>/dev/null)"`,
    `echo "payment_enabled=$(docker exec -i "$PG_CONTAINER" psql -U "$PG_SUPER" -d "$DB" -At -c "SELECT count(*) FROM payment_provider WHERE state NOT IN ('disabled','test')" 2>/dev/null)"`,
    `echo "webhook_cleared=$(docker exec -i "$PG_CONTAINER" psql -U "$PG_SUPER" -d "$DB" -At -c "SELECT CASE WHEN count(*)=0 THEN 1 ELSE 0 END FROM ir_act_server WHERE webhook_url='neutralization - disable webhook'" 2>/dev/null)"`,
    '[ "$RC" -eq 0 ] && docker restart "$ODOO_CONTAINER" >/dev/null 2>&1 && echo "restarted=1"',
    'echo "===NEU_APPLY_END==="',
  ].join('\n');
}

function shellQuote(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/`/g, '\\`').replace(/\$/g, '\\$')}"`;
}

/** 解析状态输出。失败一律 ok:false，不静默。 */
export function parseStatus(stdout) {
  const text = String(stdout ?? '');
  const start = text.indexOf('===NEU_STATUS===');
  const end = text.indexOf('===NEU_STATUS_END===');
  if (start < 0 || end < 0 || end <= start) {
    return { ok: false, reason: '未找到状态输出标记（远端可能未执行成功）' };
  }
  const body = text.slice(start + '===NEU_STATUS==='.length, end);
  if (/error=|FATAL|psql:/i.test(body)) {
    return { ok: false, reason: body.trim().split('\n').slice(0, 3).join(' ') };
  }

  const kv = new Map();
  for (const line of body.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const i = t.indexOf('|');
    if (i <= 0) continue;
    kv.set(t.slice(0, i).trim(), t.slice(i + 1).trim());
  }

  const num = (k, d = 0) => {
    const v = Number(kv.get(k));
    return Number.isFinite(v) ? v : d;
  };
  const flagRaw = (kv.get('flag') ?? 'absent').toLowerCase();
  const flag = flagRaw === 'true' || flagRaw === 't' || flagRaw === '1';

  const cronActive = num('cron_active');
  const cronDisabled = num('cron_disabled');
  const mailPlaceholder = num('mail_placeholder');
  const mailRealActive = num('mail_real_active');
  const mailRealWithCreds = num('mail_real_with_creds');
  const paymentEnabled = num('payment_enabled');
  const paymentDisabled = num('payment_disabled');
  const webhookNeutralized = num('webhook_neutralized');

  // 任一特征成立即视为中立化（flag 可能被人工删掉但其它项仍是停用状态）
  const neutralized = flag || mailPlaceholder > 0 || (cronActive === 0 && cronDisabled > 0);

  return {
    ok: true,
    neutralized,
    flag,
    cronActive,
    cronDisabled,
    mailPlaceholder,
    mailRealActive,
    mailRealWithCreds,
    paymentEnabled,
    paymentDisabled,
    webhookNeutralized,
    credentialsLost: mailRealActive > 0 && mailRealWithCreds === 0,
  };
}

/** 解析解除输出。 */
export function parseApplyResult(stdout) {
  const text = String(stdout ?? '');
  const start = text.indexOf('===NEU_APPLY===');
  const end = text.indexOf('===NEU_APPLY_END===');
  if (start < 0 || end < 0 || end <= start) {
    return { ok: false, applied: false, reason: '未找到解除输出标记（远端可能未执行成功）' };
  }
  const body = text.slice(start + '===NEU_APPLY==='.length, end);
  const kv = new Map();
  for (const line of body.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const i = t.indexOf('=');
    if (i <= 0) continue;
    kv.set(t.slice(0, i).trim(), t.slice(i + 1).trim());
  }

  const rc = Number(kv.get('rc'));
  if (!Number.isFinite(rc) || rc !== 0) {
    return {
      ok: false,
      applied: false,
      reason: kv.get('error') ?? `远端返回 rc=${kv.get('rc') ?? '未知'}`,
    };
  }

  const num = (k) => {
    const v = Number(kv.get(k));
    return Number.isFinite(v) ? v : 0;
  };

  const paymentEnabled = num('payment_enabled');
  const warnings = [
    '原邮件服务器的 SMTP 凭据在中立化时已被清空且无法从数据库还原，请在 Odoo 后台「设置 → 邮件服务器」重新填写后再启用。',
    paymentEnabled === 0
      ? '支付提供商全部保持禁用（未指定启用名单）。如确需在线收款，请先在后台核对凭据再手动启用，切勿在未验证时开放。'
      : `已启用 ${paymentEnabled} 个支付提供商（按你指定的名单）。请立即核对凭据与回调地址。`,
    '定时任务已恢复启用，会立即开始运行（含自动发信）。请确认 mail_mail 已清理、SMTP 可用。',
    '需确认 Odoo 配置 max_cron_threads ≥ 1，否则 cron 记录虽启用也不会执行。',
    '本操作不可逆：如需再次隔离，请重新执行中立化。',
  ];

  return {
    ok: true,
    applied: true,
    rc,
    flagDeleted: num('flag_deleted') === 1,
    cronEnabled: num('cron_enabled'),
    placeholderDeleted: num('placeholder_deleted') === 1,
    mailReactivated: num('mail_reactivated'),
    paymentEnabled,
    webhookCleared: num('webhook_cleared') === 1,
    restarted: kv.get('restarted') === '1',
    restartRequired: true,
    warnings,
  };
}
