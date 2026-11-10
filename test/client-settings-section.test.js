/**
 * v0.1.14 UI 宿主迁移（Settings Host Migration）：
 * 操作界面从「已安装插件」的 plugins.bundle.config 卡片，迁移到 DSH 原生设置页
 * settings.section，并注册同名导航图标；旧入口必须移除。
 *
 * 契约依据（P1 源码确认）：
 *  - settings.section：list、scope=root，注册项 { id, order, label }，组件收 ownerProps { close }
 *  - settings.section.icon：同 id/order/label，组件收 { size }
 *  - slots.inject(key, cb) → 幂等 disposer；register(...) → disposer
 *  先例：dsh-remote-ssh（id remote-ssh, order 200）、dsh-better-sidebar（id better-sidebar, order 100）
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

const sectionSeg = () => {
  const i = src.indexOf("slots.inject('settings.section'");
  assert.ok(i > 0, '应存在 settings.section 注入');
  return src.slice(i, i + 900);
};

test('SECTION-1 注册到原生设置页插槽 settings.section', () => {
  assert.match(src, /slots\.inject\('settings\.section'/, '必须向 settings.section 注册整页');
  assert.match(src, /name:\s*'settings\.section'/, '注册项 name 必须是 settings.section');
});

test('SECTION-2 使用自有 id + order + 本地化 label thunk', () => {
  const seg = sectionSeg();
  assert.match(seg, /id:\s*'odoo-backup'/, 'id 必须自有，避免顶替内置栏目');
  assert.match(seg, /order:\s*\d+/, 'order 决定导航位置');
  assert.match(seg, /label:\s*\(\s*\)\s*=>/, 'label 必须是 thunk，随 locale 变化');
});

test('SECTION-3 不再注册旧入口 plugins.bundle.config', () => {
  assert.ok(!src.includes("slots.inject('plugins.bundle.config'"),
    '不得再注入旧卡片插槽');
  assert.ok(!/name:\s*'plugins\.bundle\.config'/.test(src),
    '不得再注册旧卡片，避免双入口');
});

test('SECTION-4 注册自定义导航图标 settings.section.icon', () => {
  assert.match(src, /slots\.inject\('settings\.section\.icon'/,
    '应注册图标插槽，否则导航只有默认齿轮');
  assert.match(src, /name:\s*'settings\.section\.icon'/);
});

test('SECTION-5 注入面保留 scope 与 locale（配置读取与文案不变）', () => {
  const seg = sectionSeg();
  assert.match(seg, /inject:\s*\(\)\s*=>\s*\(\{[^}]*scope/, 'scope 仍需注入');
  assert.match(seg, /inject:\s*\(\)\s*=>\s*\(\{[^}]*locale/, 'locale 仍需注入');
});

test('SECTION-6 面板组件与三 tab 逻辑未被迁移破坏', () => {
  assert.match(src, /function OdooBackupPanel/, '面板组件保留');
  for (const k of ['tab.servers', 'tab.backup', 'tab.restore']) {
    assert.ok(src.includes(k), `保留 ${k} 文案键`);
  }
  // 操作面能力不得因迁移丢失
  for (const route of ['/backup', '/restore', '/precheck', '/last-backup', '/status', '/task-lock']) {
    assert.ok(src.includes(route), `页面仍调用既有接口 ${route}`);
  }
});

test('SECTION-7 locale 提供 settings.nav（zh/en）', () => {
  const zh = JSON.parse(readFileSync(new URL('../locale/zh.json', import.meta.url), 'utf8'));
  const en = JSON.parse(readFileSync(new URL('../locale/en.json', import.meta.url), 'utf8'));
  assert.equal(zh.ui['settings.nav'], 'Odoo19 备份与恢复');
  assert.equal(en.ui['settings.nav'], 'Odoo19 Backup & Restore');
});

test('SECTION-8 组件内 label 回退值非空（locale 服务缺席时仍可读）', () => {
  assert.match(src, /'settings\.nav':\s*'[^']+'/, 'dict 必须有回退文案');
});

test('SECTION-9 重挂前先释放旧注册，刷新不产生重复条目', () => {
  const seg = src.slice(src.indexOf('const mountSection'), src.indexOf('const mountSection') + 1200);
  assert.match(seg, /dispose\w*\?\.\(\)/, '重挂前必须 dispose 旧注册');
  assert.match(seg, /ctx\.slots\.inject\('settings\.section'/, '重挂走同一注入路径');
});
