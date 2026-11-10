/**
 * v0.1.14 行为级回归：备份成功 → 恢复输入框自动回填最终 .enc 路径；备份失败不得覆盖。
 *
 * 用真实组件树（client.js）驱动，fetch 为路由感知替身，断言的是「用户看到的输入框值」，
 * 而不是源码字符串。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

// ---- 最小 React 替身（与 client-interaction.test.js 同构） ----
function createElement(type, props, ...children) {
  return { type, props: props ?? {}, children: children.flat(Infinity) };
}
const state = [];
let cursor = 0;
const useState = (init) => {
  const i = cursor++;
  if (i >= state.length) state[i] = typeof init === 'function' ? init() : init;
  return [state[i], (v) => { state[i] = typeof v === 'function' ? v(state[i]) : v; }];
};
const useCallback = (fn) => fn;
const useEffect = () => {};
const useSyncExternalStore = (subscribe, getSnapshot) => getSnapshot();

function realScope(initial = {}) {
  let snap = initial;
  const listeners = new Set();
  return {
    getSnapshot: () => snap,
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    set: async (field, value) => {
      snap = { ...snap, [field]: value };
      listeners.forEach((f) => f());
    },
    unset: async (field) => { const n = { ...snap }; delete n[field]; snap = n; },
  };
}

/** fetch 替身：按 URL 返回预设 JSON，并记录调用序列。 */
function makeFetch(routes) {
  const calls = [];
  const fn = async (url) => {
    const path = String(url).replace(/^\/odoo-backup/, '');
    calls.push(path);
    const handler = routes[path];
    const data = handler ? await handler(path) : { ok: true };
    return { ok: true, status: 200, json: async () => data };
  };
  fn.calls = calls;
  return fn;
}

function loadClient({ scope, fetchStub }) {
  let registered;
  const win = { __ModuleLoader__: { load: (d) => { registered = d; } }, prompt: () => null, confirm: () => true };
  global.window = win;
  const mod = { slots: {}, reflect: { get: () => ({ bind: () => (k) => k }) } };

  const realSetTimeout = global.setTimeout;
  const realClearTimeout = global.clearTimeout;
  global.setTimeout = () => 0;
  global.clearTimeout = () => {};

  new Function('window', 'fetch', src)(win, fetchStub);

  const factoryResult = registered.factory((name) => {
    if (name === 'react') return { createElement, useState, useCallback, useEffect, useSyncExternalStore };
    throw new Error('unknown module ' + name);
  });

  let slotReg = null;
  // 与真实 configForms 契约同形：describe() 暴露已服务命名空间，get() 绑定作用域。
  const configForms = {
    describe: () => ({
      getSnapshot: () => ({ view: { namespaces: [{ ns: 'odoo-backup' }] } }),
    }),
    get: () => scope,
    whileServed: (candidates, register) => {
      register(new Set(['odoo-backup']));
      return () => {};
    },
  };
  const ctx = {
    ...mod,
    get: (name) => (name === 'configForms' ? configForms : undefined),
    inject: (services, cb) => { if (services.includes('configForms')) cb({ configForms }); },
    effect: (fn) => { const d = fn(); return d ?? (() => {}); },
    slots: {
      inject: (key, cb) => { cb(); },
      register: (opts, comp) => { slotReg = { opts, comp }; },
    },
  };
  factoryResult.apply(ctx);
  global.setTimeout = realSetTimeout;
  global.clearTimeout = realClearTimeout;
  return { slotReg };
}

function expand(node) {
  if (node == null || node === false) return node;
  if (Array.isArray(node)) return node.map(expand);
  if (typeof node === 'string' || typeof node === 'number') return node;
  if (typeof node.type === 'function') return expand(node.type({ ...node.props, children: node.children }));
  return { ...node, children: expand(node.children ?? []) };
}
function findAll(node, pred, out = []) {
  if (node == null || node === false || typeof node === 'string') return out;
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
const byText = (label) => (n) => n.type === 'button' && texts(n).some((x) => x.includes(label));

/** 切到某 tab 并返回最新组件树。 */
function clickTab(injected, comp, label) {
  cursor = 0;
  let tree = expand(comp(injected));
  const tabBtn = findAll(tree, byText(label))[0];
  assert.ok(tabBtn, `应存在「${label}」tab`);
  tabBtn.props.onClick();
  cursor = 0;
  return expand(comp(injected));
}

test('FILL-1 备份成功 → 恢复输入框回填 Host 返回的最终 .enc 路径', async () => {
  const scope = realScope({ servers: [{ name: 's1', host: 'h' }] });
  const fetchStub = makeFetch({
    '/backup': async () => ({ ok: true, result: { ok: true, localPath: 'K:\\Backup\\odoo\\20261109\\x.tar.enc', bytes: 1024 } }),
    '/last-backup': async () => ({ ok: true, localPath: 'K:\\Backup\\odoo\\20261109\\x.tar.enc' }),
  });
  const { slotReg } = loadClient({ scope, fetchStub });
  const injected = slotReg.opts.inject?.() ?? {};
  const comp = slotReg.comp;

  state.length = 0; cursor = 0;
  const backupTree = clickTab(injected, comp, '备份');
  const startBtn = findAll(backupTree, byText('开始备份'))[0];
  assert.ok(startBtn, '备份 tab 应有开始备份按钮');
  await startBtn.props.onClick();
  await new Promise((r) => setImmediate(r));

  assert.ok(fetchStub.calls.includes('/last-backup'), '成功分支应请求权威路径');

  const restoreTree = clickTab(injected, comp, '恢复');
  const input = findAll(restoreTree, (n) => n.type === 'input' && String(n.props['aria-label'] ?? '').includes('恢复包路径'))[0];
  assert.ok(input, '恢复 tab 应有路径输入框');
  assert.equal(input.props.value, 'K:\\Backup\\odoo\\20261109\\x.tar.enc', '应回填最终 .enc 路径');
});

test('FILL-2 备份失败 → 不请求回填，且不覆盖用户已填写的恢复路径', async () => {
  const scope = realScope({ servers: [{ name: 's1', host: 'h' }] });
  const fetchStub = makeFetch({
    '/backup': async () => ({ ok: true, result: { ok: false, error: 'boom' } }),
    '/last-backup': async () => ({ ok: true, localPath: 'K:\\WRONG\\should-not-fill.tar.enc' }),
  });
  const { slotReg } = loadClient({ scope, fetchStub });
  const injected = slotReg.opts.inject?.() ?? {};
  const comp = slotReg.comp;

  state.length = 0; cursor = 0;
  // 用户先手填一个路径
  let tree = clickTab(injected, comp, '恢复');
  let input = findAll(tree, (n) => n.type === 'input' && String(n.props['aria-label'] ?? '').includes('恢复包路径'))[0];
  input.props.onChange({ target: { value: 'K:\\User\\Manual\\x.tar.enc' } });

  // 触发一次失败的备份
  const backupTree = clickTab(injected, comp, '备份');
  const startBtn = findAll(backupTree, byText('开始备份'))[0];
  await startBtn.props.onClick();
  await new Promise((r) => setImmediate(r));

  assert.ok(!fetchStub.calls.includes('/last-backup'), '失败分支不得请求回填');

  tree = clickTab(injected, comp, '恢复');
  input = findAll(tree, (n) => n.type === 'input' && String(n.props['aria-label'] ?? '').includes('恢复包路径'))[0];
  assert.equal(input.props.value, 'K:\\User\\Manual\\x.tar.enc', '失败不得覆盖用户原路径');
});

test('FILL-3 Host 拒绝回填（ok:false）→ 恢复框保持空/原值', async () => {
  const scope = realScope({ servers: [{ name: 's1', host: 'h' }] });
  const fetchStub = makeFetch({
    '/backup': async () => ({ ok: true, result: { ok: true, localPath: 'K:\\Backup\\odoo\\x.tar.enc', bytes: 1024 } }),
    '/last-backup': async () => ({ ok: false, reason: '最终加密产物不存在或格式校验未通过' }),
  });
  const { slotReg } = loadClient({ scope, fetchStub });
  const injected = slotReg.opts.inject?.() ?? {};
  const comp = slotReg.comp;

  state.length = 0; cursor = 0;
  const backupTree = clickTab(injected, comp, '备份');
  await findAll(backupTree, byText('开始备份'))[0].props.onClick();
  await new Promise((r) => setImmediate(r));

  const restoreTree = clickTab(injected, comp, '恢复');
  const input = findAll(restoreTree, (n) => n.type === 'input' && String(n.props['aria-label'] ?? '').includes('恢复包路径'))[0];
  assert.ok(!input.props.value, 'Host 拒绝回填时输入框应保持空');
});
