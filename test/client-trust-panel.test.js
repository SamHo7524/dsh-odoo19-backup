/**
 * v0.1.8 RED — 前端信任面板。
 * 复用 client-add-server.test.js 同款 React 替身（真实契约：不依赖 prompt）。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
function createElement(type, props, ...children) { return { type, props: props ?? {}, children: children.flat(Infinity) }; }
let hooks = []; let cursor = 0;
const useState = (init) => { const i = cursor++; if (i >= hooks.length) hooks[i] = typeof init === 'function' ? init() : init; return [hooks[i], (v) => { hooks[i] = typeof v === 'function' ? v(hooks[i]) : v; }]; };
const useCallback = (fn) => fn;
const useSyncExternalStore = (_s, getSnapshot) => getSnapshot();
function expand(node) {
  if (node == null || node === false) return node;
  if (Array.isArray(node)) return node.map(expand);
  if (typeof node === 'string' || typeof node === 'number') return node;
  if (typeof node.type === 'function') return expand(node.type({ ...node.props, children: node.children }));
  return { ...node, children: expand(node.children ?? []) };
}
function findAll(node, pred, out = []) {
  if (node == null || node === false) return out;
  if (Array.isArray(node)) { node.forEach((n) => findAll(n, pred, out)); return out; }
  if (node.type && pred(node)) out.push(node);
  if (node.type) findAll(node.children, pred, out);
  return out;
}
function texts(node, out = []) {
  if (node == null || node === false) return out;
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out; }
  if (Array.isArray(node)) { node.forEach((n) => texts(n, out)); return out; }
  if (node.type) texts(node.children, out);
  return out;
}
function makeScope(servers) {
  const snap = { status: 'ready', writable: true, value: { servers } };
  return { getSnapshot: () => snap, subscribe: () => () => {}, set: async () => true };
}
const SERVERS = [
  { name: 'odoo.toogel.cn', host: '134.175.51.9', port: 22, user: 'root', keyPath: 'C:/k/id', pinnedFingerprint: '', sshConfigAlias: '' },
];
function loadClient() {
  let registered;
  const win = { __ModuleLoader__: { load: (d) => { registered = d; } }, prompt: () => { throw new Error('no prompt'); }, confirm: () => true, setTimeout: () => 0 };
  const st = global.setTimeout; const ct = global.clearTimeout;
  global.setTimeout = () => 0; global.clearTimeout = () => {};
  try { new Function('window', 'fetch', src)(win, async () => ({ json: async () => ({ ok: true }) })); }
  finally { global.setTimeout = st; global.clearTimeout = ct; }
  const f = registered.factory((n) => { if (n === 'react') return { createElement, useState, useCallback, useSyncExternalStore }; throw new Error('unknown ' + n); });
  let reg = null;
  const scope = makeScope(SERVERS);
  f.apply({
    reflect: { get: () => ({ bind: () => (k) => k }) },
    get: (n) => (n === 'configForms' ? { describe: () => ({ getSnapshot: () => ({ view: { namespaces: [{ ns: 'include:odoo-backup' }] } }) }), get: () => scope, whileServed: () => () => {} } : undefined),
    effect: (fn) => { const d = fn(); return d ?? (() => {}); },
    inject: () => {},
    slots: { inject: (_k, cb) => { cb(); return () => {}; }, register: (o, c) => { reg = { opts: o, comp: c }; return () => {}; } },
  });
  return reg;
}
function mount(props) { hooks = []; cursor = 0; return expand(props); }
function render(props) { cursor = 0; return expand(props); }

test('UI-1 未信任服务器行有「信任主机」按钮，不再只有扫描/测试/删除', () => {
  const reg = loadClient();
  const tree = mount(reg.comp(reg.opts.inject?.() ?? {}));
  const btn = findAll(tree, (n) => n.type === 'button' && texts(n).some((x) => x.includes('信任主机')))[0];
  assert.ok(btn, '以后新主机必须能在界面内完成信任，无需手工调 API');
});

test('UI-2 服务器行有「编辑」与「重新扫描」入口', () => {
  const reg = loadClient();
  const tree = mount(reg.comp(reg.opts.inject?.() ?? {}));
  const all = findAll(tree, (n) => n.type === 'button').map((b) => texts(b).join(''));
  assert.ok(all.some((t) => t.includes('编辑')), '缺编辑入口');
  assert.ok(all.some((t) => t.includes('重新扫描')), '缺重新扫描入口');
});

test('UI-3 面板区分「主机身份」与「登录认证」双状态，不混为一谈', () => {
  const reg = loadClient();
  const tree = mount(reg.comp(reg.opts.inject?.() ?? {}));
  const txt = texts(tree).join('\n');
  assert.match(txt, /主机身份|主机指纹/);
  assert.match(txt, /登录认证|认证/);
});

test('UI-4 信任面板提供指纹核验命令（服务器所有者侧，不含私钥）', () => {
  // 面板由用户点击展开；React 替身不模拟跨渲染的 setState 闭包，
  // 故用源码级静态断言验证面板内容与命令常量（真实点击见真机验收）。
  assert.match(src, /ssh-keygen -lf/);
  assert.match(src, /ssh_host_ed25519_key\.pub/);
  assert.match(src, /不要直接复制|独立可信渠道/);
  assert.match(src, /TrustHostPanel/, '信任面板组件应存在');
});

test('UI-5 报错文案不再指向 action=pin（该操作不写配置字段）', () => {
  assert.ok(!/action=pin/.test(src), '误导性指引必须移除');
  assert.ok(!/action=fingerprint\s*取得/.test(src));
});

test('UI-6 认证失败与指纹失败提示不同（分类文案存在）', () => {
  const s = readFileSync(new URL('../lib/ssh.js', import.meta.url), 'utf8');
  assert.match(s, /Permission denied|认证失败/);
  assert.match(s, /Connection refused|连接被拒绝/);
  assert.match(s, /Connection timed out|连接超时/);
});

test('UI-7 面板明确要求「粘贴服务器所有者回传值」，不允许复制扫描值自证', () => {
  const reg = loadClient();
  const tree = mount(reg.comp(reg.opts.inject?.() ?? {}));
  const txt = texts(tree).join('\n');
  assert.match(txt, /所有者|回传|独立/);
});
