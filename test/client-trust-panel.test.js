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
const useEffect = () => {}; // 替身：不执行副作用
const useRef = (init) => ({ current: init }); // v0.1.17：轮询需请求序号
const useSyncExternalStore = (_s, getSnapshot) => getSnapshot();
function expand(node) {
  if (node == null || node === false) return node;
  if (Array.isArray(node)) return node.map(expand);
  if (typeof node === 'string' || typeof node === 'number') return node;
  if (typeof node.type === 'function') {
    try { return expand(node.type({ ...node.props, children: node.children })); }
    catch (e) { return { type: 'THREW', props: {}, children: [String(e && e.message).slice(0, 200)] }; }
  }
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
  const f = registered.factory((n) => { if (n === 'react') return { createElement, useState, useCallback, useEffect, useRef, useSyncExternalStore }; throw new Error('unknown ' + n); });
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
  if (!all.some((t) => t.includes('编辑'))) {
    console.log('[UI-2 DEBUG] buttons:', JSON.stringify(all), 'treeText:', JSON.stringify(texts(tree).join('|').slice(0, 400)));
  }
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

// ---------------------------------------------------------------- v0.1.9 方案 B

test('UI-8 信任面板内直接提供「本机私钥路径」入口（不用退出面板去点编辑）', () => {
  // v0.1.10 起改为文件浏览器选择 + 只读路径显示；仍保留 aria-label 与面板内入口
  assert.match(src, /['"]aria-label['"]:\s*'本机私钥路径'/, '面板内应有路径显示框');
  assert.match(src, /选择私钥文件|手动输入路径/, '面板内应有文件选择或降级入口');
});

test('UI-9 面板把 keyPath 作为信任状态的一部分，读取公钥使用该面板值', () => {
  assert.match(src, /onLoadPubkey:\s*\(\) => doLoadPubkey/);
  // doLoadPubkey 必须优先用面板状态里的 keyPath，而不是只读 server.keyPath
  assert.match(src, /doLoadPubkey[\s\S]{0,500}st\.keyPath/,
    'doLoadPubkey 应使用面板状态里的 keyPath');
  assert.match(src, /keyPath:\s*trust\[s\.name\]\?\.keyPath/,
    '展开面板时应把已有 keyPath 带进面板状态');
});

test('UI-10 面板文案明确区分两个方向的公钥（服务器主机公钥 vs 本插件客户端公钥）', () => {
  assert.match(src, /服务器主机公钥|主机公钥（扫描|服务器证明自己/,
    '必须说明扫描值是「服务器主机公钥」');
  assert.match(src, /本插件.*公钥|客户端公钥|本机公钥/, '必须说明发给所有者的是「本插件客户端公钥」');
  assert.match(src, /方向|不是同一|两件独立/, '必须点明两者方向不同、不是同一个东西');
});

test('UI-11 未配置 keyPath 时，面板内联提示用文件浏览器选择，不指向「服务器表单」外部', () => {
  assert.match(src, /请先点「选择私钥文件」|选择本机私钥/,
    '错误提示应引导点文件选择按钮，而不是让用户手写路径或去别处编辑');
  assert.ok(!/请先设置 keyPath（请先设置 keyPath）/.test(src));
});

test('UI-12 方案 B 不改动安全逻辑：guardHostKey 三放行与 fail-closed 保持', () => {
  const ssh = readFileSync(new URL('../lib/ssh.js', import.meta.url), 'utf8');
  const idx = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  assert.match(ssh, /if \(server.sshConfigAlias\)/);
  assert.match(ssh, /if \(!server.pinnedFingerprint\)/);
  assert.match(ssh, /fail-closed|绝不/);
  assert.match(idx, /route === '\/trust-host'/);
  assert.match(idx, /confirmTrust\(/);
});

// ---------------------------------------------------------------- v0.1.10 文件浏览器选择

test('PICK-1 信任面板提供「选择私钥文件」文件浏览器入口（input type=file），不再要求手输路径', () => {
  assert.match(src, /type:\s*'file'/, '必须有文件选择输入框');
  assert.match(src, /选择私钥文件|浏览.*私钥|选择.*文件/, '必须有文件选择按钮/标签');
});

test('PICK-2 选中文件后用 __DSH_HOST_PATHS__.pathFor(file) 取真实绝对路径', () => {
  assert.match(src, /__DSH_HOST_PATHS__/, '必须调用桌面端官方桥');
  assert.match(src, /pathFor\(/, '必须用 webUtils.getPathForFile 的封装取真实路径');
});

test('PICK-3 只取路径，绝不读取/上传私钥文件内容', () => {
  // 不允许 FileReader / readAsText / 把 File 对象塞进 API body
  assert.ok(!/FileReader|readAsText|readAsArrayBuffer/.test(src), '不得读取私钥内容');
  assert.ok(!/body:\s*JSON\.stringify\(\{\s*file:/.test(src), '不得把文件对象放入请求体');
});

test('PICK-4 桌面端桥不可用时降级：提示手动输入，不崩溃', () => {
  assert.match(src, /手动输入|浏览器.*不支持|无法获取.*路径/,
    '非桌面环境应给出可操作的降级提示');
});

test('PICK-5 选中的真实路径回写面板 keyPath 状态，供「读取本机公钥」使用', () => {
  assert.match(src, /pathFor[\s\S]{0,400}patch\(\{\s*keyPath/,
    'pathFor 的结果必须写回 keyPath 状态');
});

test('PICK-6 安全逻辑仍不变（回归护栏）', () => {
  const ssh = readFileSync(new URL('../lib/ssh.js', import.meta.url), 'utf8');
  assert.match(ssh, /if \(server.sshConfigAlias\)/);
  assert.match(ssh, /if \(!server.pinnedFingerprint\)/);
});
