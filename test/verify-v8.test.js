import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildVerifyScript, parseFinalSite } from '../lib/verify.js';

// ---------------- v0.1.27：V8 正式站点检查（防「恢复成功但站点落库管理器」） ----------------

test('V8-S1 默认（临时验证阶段）脚本不含 V8 段', () => {
  const s = buildVerifyScript();
  assert.ok(!s.includes('===V8==='), '临时库阶段不该跑正式站点检查');
});

test('V8-S2 finalSite=true 时脚本含 V8 段且跟随重定向取最终 URL', () => {
  const s = buildVerifyScript({ finalSite: true });
  assert.ok(s.includes('===V8==='));
  // v0.1.27 实现用 `curl -sL`（-sL 含 -L）；断言应匹配「跟随重定向」而非字面 "-L" 单开关。
  assert.match(s, /curl[^\n]*-[a-zA-Z]*L/, 'curl 必须跟随重定向（-L 或 -sL）');
  assert.match(s, /url_effective/);
});

test('V8-P1 最终 200 且不在库管理器 = 通过', () => {
  const r = parseFinalSite('200|http://127.0.0.1:8069/');
  assert.equal(r.ok, true);
});

test('V8-P2 落到 /web/database/selector = 失败（真机事故：恢复成功但访客看到库管理器）', () => {
  const r = parseFinalSite('200|http://127.0.0.1:8069/web/database/selector');
  assert.equal(r.ok, false);
  assert.match(r.detail, /库管理器|database/);
});

test('V8-P3 5xx / 探测失败 = 失败', () => {
  assert.equal(parseFinalSite('500|http://127.0.0.1:8069/').ok, false);
  assert.equal(parseFinalSite('000|-').ok, false);
});

test('V8-P4 空输出 = 失败，不默认通过', () => {
  assert.equal(parseFinalSite('').ok, false);
});
