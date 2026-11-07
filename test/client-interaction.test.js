/**
 * 行为级回归：用真实 DSH configForms 契约（scope.getSnapshot/subscribe/set）
 * 驱动 client.js 组件，模拟点击「添加服务器」，断言配置确实被写入。
 *
 * 这是对「按钮无反应」缺陷的直接复现测试：修复前组件调用不存在的 setConfig，
 * scope.set 永不被调用。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

// 最小 React 替身（含 useSyncExternalStore）
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
const useEffect = () => {}; // 替身：不执行副作用
const useSyncExternalStore = (subscribe, getSnapshot) => getSnapshot();

function loadClient({ scope, serveNamespace = true }) {
  let registered;
  const win = { __ModuleLoader__: { load: (d) => { registered = d; } }, prompt: () => null, confirm: () => true };
  global.window = win;
  const mod = { slots: {}, reflect: { get: () => ({ bind: () => (k) => k }) } };

  // 抑制 5 秒诊断定时器的实际触发，保持测试输出干净（定时器本身由契约测试覆盖）。
  const realSetTimeout = global.setTimeout;
  const realClearTimeout = global.clearTimeout;
  global.setTimeout = () => 0;
  global.clearTimeout = () => {};

  // factory 只登记闭包；apply 才执行并安排诊断定时器。
  new Function('window', 'fetch', src)(win, async () => ({ json: async () => ({ ok: true }) }));

  const factoryResult = registered.factory((name) => {
    if (name === 'react') return { createElement, useState, useCallback, useEffect, useSyncExternalStore };
    throw new Error('unknown module ' + name);
  });

  let slotReg = null;
  // 与真实 configForms 契约同形：describe() 暴露已服务命名空间，get() 绑定作用域。
  // 保留 inject 以兼容旧实现；新增 get/effect 以适配「软取 + 动态确认」修复后的实现。
  const configForms = {
    describe: () => ({
      getSnapshot: () => ({ view: { namespaces: serveNamespace ? [{ ns: 'odoo-backup' }] : [] } }),
    }),
    get: () => scope,
    whileServed: (candidates, register) => {
      register(new Set(serveNamespace ? ['odoo-backup'] : []));
      return () => {};
    },
  };
  const ctx = {
    ...mod,
    get: (name) => (name === 'configForms' ? configForms : undefined),
    inject: (services, cb) => { if (services.includes('configForms')) cb({ configForms }); },
    effect: (fn) => { const disposer = fn(); return disposer ?? (() => {}); },
    slots: {
      inject: (key, cb) => { cb(); },
      register: (opts, comp) => { slotReg = { opts, comp }; },
    },
  };
  factoryResult.apply(ctx);
  global.setTimeout = realSetTimeout;
  global.clearTimeout = realClearTimeout;
  return { slotReg, factoryResult };
}

function realScope(initial = {}) {
  let snap = initial;
  const writes = [];
  const listeners = new Set();
  return {
    writes,
    getSnapshot: () => snap,
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    set: async (field, value) => { writes.push([field, value]); snap = { ...snap, [field]: value }; listeners.forEach((f) => f()); },
    unset: async (field) => { const n = { ...snap }; delete n[field]; snap = n; },
  };
}

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

test('点击「添加服务器」→ 填表 → 保存，会调用 scope.set("servers", ...)（真实契约）', async () => {
  const scope = realScope({ servers: [] });
  const { slotReg } = loadClient({ scope });
  assert.ok(slotReg, '组件应被注册');

  const injected = slotReg.opts.inject?.() ?? {};
  assert.equal(injected.scope, scope, 'inject() 必须把 scope 作为 props 传入');

  state.length = 0;
  cursor = 0;
  let tree = expand(slotReg.comp(injected));
  const addBtn = findAll(tree, (n) => n.type === 'button' && texts(n).some((x) => x.includes('添加服务器')))[0];
  assert.ok(addBtn, '应渲染添加服务器按钮');

  // 内联表单（Electron 不支持 window.prompt）
  addBtn.props.onClick();
  cursor = 0;
  tree = expand(slotReg.comp(injected));
  let inputs = findAll(tree, (n) => n.type === 'input');
  assert.ok(inputs.length >= 2, '点击后应出现输入框');

  inputs[0].props.onChange({ target: { value: 'staging' } });
  cursor = 0;
  tree = expand(slotReg.comp(injected));
  inputs = findAll(tree, (n) => n.type === 'input');
  inputs[1].props.onChange({ target: { value: '119.29.10.202' } });

  cursor = 0;
  tree = expand(slotReg.comp(injected));
  const saveBtn = findAll(tree, (n) => n.type === 'button' && texts(n).some((x) => x === '保存'))[0];
  assert.ok(saveBtn, '应有保存按钮');
  await saveBtn.props.onClick();

  assert.equal(scope.writes.length, 1, '必须写入一次配置');
  assert.equal(scope.writes[0][0], 'servers');
  assert.equal(scope.writes[0][1].length, 1);
  assert.equal(scope.writes[0][1][0].name, 'staging');
  assert.equal(scope.writes[0][1][0].host, '119.29.10.202');
});

test('scope 未注入时保存仍会尝试 Host 路由，失败则给出明确错误（不静默）', async () => {
  const { slotReg } = loadClient({ scope: null, serveNamespace: false });
  state.length = 0;
  cursor = 0;
  const injected = slotReg.opts.inject?.() ?? {};
  let tree = expand(slotReg.comp(injected));
  const addBtn = findAll(tree, (n) => n.type === 'button' && texts(n).some((x) => x.includes('添加服务器')))[0];
  addBtn.props.onClick();
  cursor = 0;
  tree = expand(slotReg.comp(injected));
  let inputs = findAll(tree, (n) => n.type === 'input');
  inputs[0].props.onChange({ target: { value: 's' } });
  cursor = 0;
  tree = expand(slotReg.comp(injected));
  inputs = findAll(tree, (n) => n.type === 'input');
  inputs[1].props.onChange({ target: { value: 'h' } });
  cursor = 0;
  tree = expand(slotReg.comp(injected));
  const saveBtn = findAll(tree, (n) => n.type === 'button' && texts(n).some((x) => x === '保存'))[0];
  await saveBtn.props.onClick();
  // 关键：scope 缺失不再直接 return；应尝试 Host 路由，失败时给出可见错误。
  assert.ok(state.some((s) => typeof s === 'string' && s.includes('保存失败')),
    '保存失败必须给出可见错误，而不是静默无反应');
});
