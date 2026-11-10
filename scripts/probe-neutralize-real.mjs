import { parseStatus } from '../lib/neutralize.js';

const raw = `===NEU_STATUS===
flag|true
cron_active|1
cron_disabled|42
mail_placeholder|1
mail_real_active|0
mail_real_with_creds|0
payment_enabled|0
payment_disabled|26
webhook_neutralized|0
===NEU_STATUS_END===`;

const s = parseStatus(raw);
console.log(JSON.stringify({
  ok: s.ok,
  neutralized: s.neutralized,
  flag: s.flag,
  cronActive: s.cronActive,
  cronDisabled: s.cronDisabled,
  mailPlaceholder: s.mailPlaceholder,
  paymentDisabled: s.paymentDisabled,
  credentialsLost: s.credentialsLost,
}, null, 1));
