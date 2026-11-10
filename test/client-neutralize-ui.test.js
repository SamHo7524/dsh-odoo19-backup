/**
 * v0.1.14 收尾 Task 4：设置页「中立化状态」卡片（NEUUI-1..6）。
 *
 * 手法：源码契约匹配（同 restore-secret-rotation.test.js），断言的是
 * 「用户能否在设置页完成 状态→预检→二次确认→解除 的闭环」以及安全文案。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

/** 取出中立化卡片那一段（UI 标题定位，避免命中 state 注释），避免全文件匹配产生假阳性。 */
const cardSeg = () => {
  const i = src.indexOf('中立化状态（恢复后是否接管生产）');
  assert.ok(i > 0, 'client.js 应包含「中立化状态」UI 卡片');
  return src.slice(i, i + 9000);
};

test('NEUUI-1 卡片存在并调用 /neutralize-status', () => {
  assert.ok(src.includes('中立化状态'), '应有「中立化状态」标题');
  assert.ok(src.includes('/neutralize-status'), '应调用状态接口');
});

test('NEUUI-2 两个按钮：保持中立化 / 解除中立化', () => {
  const seg = cardSeg();
  assert.match(seg, /保持中立化/, '应有「保持中立化」按钮');
  assert.match(seg, /解除中立化/, '应有「解除中立化」按钮');
});

test('NEUUI-3 解除前先预检并二次确认', () => {
  const seg = cardSeg();
  // 预检请求在卡片的 action 手柄里（渲染段之外），因此按全文件断言其存在
  assert.ok(src.includes('/neutralize-precheck'), '解除前必须走预检拿 warnings');
  assert.ok(src.includes('confirmToken'), '应保存并使用 confirmToken');
  // 二次确认：解除按钮只触发预检，真正的提交必须是卡片里独立的「确认解除」
  assert.match(seg, /解除中立化/, '应有解除入口');
  assert.match(seg, /确认解除/, '需要显式「确认解除」按钮');
  const releaseBtn = seg.indexOf('解除中立化（接管生产）');
  // onClick 在按钮文案之前（h(Btn, {onClick}, '文案')）
  const around = seg.slice(Math.max(0, releaseBtn - 240), releaseBtn);
  assert.match(around, /precheckRelease/, '解除按钮只做预检，不直接提交');
  assert.ok(!around.includes('confirmRelease'), '解除按钮不得直接提交');
});

test('NEUUI-4 明确提示 SMTP 凭据 / 不可逆 / 支付保持禁用', () => {
  const seg = cardSeg();
  assert.match(seg, /SMTP/, '必须提示 SMTP 凭据');
  assert.match(seg, /不可逆/, '必须提示不可逆');
  assert.match(seg, /支付/, '必须提示支付提供商处理方式');
});

test('NEUUI-5 展示 applied / restartRequired 结果', () => {
  const seg = cardSeg();
  assert.match(seg, /applied/, '应展示 applied');
  assert.match(seg, /restartRequired|重启/, '应展示重启要求');
});

test('NEUUI-6 不使用 window.confirm / window.prompt（Electron 不实现）', () => {
  assert.ok(!/window\.confirm\s*\(/.test(src), '不得使用 window.confirm');
  assert.ok(!/window\.prompt\s*\(/.test(src), '不得使用 window.prompt');
});

test('NEUUI-7 keep 不带 token、release 必须带 token', () => {
  const keepIdx = src.indexOf("action: 'keep'");
  const relIdx = src.indexOf("action: 'release'");
  assert.ok(keepIdx > 0, '保持操作发 action=keep');
  assert.ok(relIdx > 0, '解除操作发 action=release');

  const keepPayload = src.slice(keepIdx, keepIdx + 400);
  assert.ok(!keepPayload.includes('confirmToken'), 'keep 不得携带 confirmToken（保持不写库）');

  const relPayload = src.slice(relIdx, relIdx + 400);
  assert.ok(relPayload.includes('confirmToken'), 'release 必须携带 confirmToken');
});

test('NEUUI-8 提供可选的支付 code 输入（默认空 = 全部保持禁用）', () => {
  const seg = cardSeg();
  assert.match(seg, /支付提供商 code|支付 code/, '卡片应有支付 code 输入框');
  assert.ok(src.includes('enablePaymentCodes'), '应把 code 列表传给后端');
  assert.match(seg, /留空/, '必须说明留空语义（全部保持禁用）');
});
