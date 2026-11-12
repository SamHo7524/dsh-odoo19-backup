import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTempRestoreScript } from '../lib/restore.js';

// ---------------- v0.1.27：neutralize 必须是选项，不是默认行为 ----------------

test('NEU-1 默认（未传 neutralize）load 命令不得带 -n', () => {
  const s = buildTempRestoreScript();
  assert.ok(/load "\$TMPDB"/.test(s), 'load 命令仍应指向临时库');
  assert.ok(!/load -n /.test(s), '默认不得中立化：-n 会禁 cron/邮件/支付，且销毁 SMTP 凭据');
});

test('NEU-2 显式 neutralize=true 时 load 带 -n（演练场景）', () => {
  const s = buildTempRestoreScript({ neutralize: true });
  assert.ok(/load -n "\$TMPDB"/.test(s), '演练场景应保留 -n 防误发邮件');
});

test('NEU-3 注释说明演练后需取消中立化', () => {
  const s = buildTempRestoreScript({ neutralize: true });
  assert.match(s, /取消中立化|转正式/);
});
