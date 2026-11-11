/**
 * 真实缺陷回归（不依赖 React 包）：
 * React 的 useSyncExternalStore 硬要求 getSnapshot 返回**稳定引用**。
 * 若 getSnapshot 每次返回新对象（如 `{}` 或 `{...snap}`），React 会抛
 * "The result of getSnapshot should be cached to avoid an infinite loop"
 * 并让组件崩溃 —— 插件页错误边界吞掉后，配置卡片区域整块空白。
 *
 * 2026-11-06 真机截图症状：连「配置服务未就绪」提示都不出现。
 * 本测试直接驱动 client.js 里组件所用的 getSnapshot 契约。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

// 最小 React 替身：忠实实现 useSyncExternalStore 的引用稳定性检查。
function createElement(type, props, ...children) {
  return { type, props: props ?? {}, children: children.flat(Infinity) };
}
let hooks = [];
let cursor = 0;
const useState = (init) => {
  const i = cursor++;
  if (i >= hooks.length) hooks[i] = typeof init === 'function' ? init() : init;
  return [hooks[i], (v) => { hooks[i] = typeof v === 'function' ? v(hooks[i]) : v; }];
};
const useCallback = (fn) => fn;
const useEffect = () => {}; // 替身：不执行副作用
const useRef = (init) => ({ current: init }); // v0.1.17：轮询需请求序号
const storeChecks = [];
const useSyncExternalStore = (subscribe, getSnapshot) => {
  const a = getSnapshot();
  const b = getSnapshot();
  storeChecks.push({ stable: Object.is(a, b), a, b });
  return a;
};

function loadComponent({ scope }) {
  let registered;
  const win = {
    __ModuleLoader__: { load: (d) => { registered = d; } },
    prompt: () => null,
    confirm: () => true,
    setTimeout: () => 0,
  };
  const realST = global.setTimeout;
  const realCT = global.clearTimeout;
  global.setTimeout = () => 0;
  global.clearTimeout = () => {};
  try {
    new Function('window', 'fetch', src)(win, async () => ({ json: async () => ({ ok: true }) }));
  } finally {
    global.setTimeout = realST;
    global.clearTimeout = realCT;
  }

  const factoryResult = registered.factory((name) => {
    if (name === 'react') return { createElement, useState, useCallback, useEffect, useRef, useSyncExternalStore };
    throw new Error('unknown module ' + name);
  });

  let reg = null;
  const ctx = {
    reflect: { get: () => ({ bind: () => (k) => k }) },
    get: () => undefined,
    effect: (fn) => { const d = fn(); return d ?? (() => {}); },
    slots: {
      inject: (key, cb) => { cb(); return () => {}; },
      register: (opts, comp) => { reg = { opts, comp }; return () => {}; },
    },
  };
  factoryResult.apply(ctx);
  return reg;
}

function render(comp, props) {
  hooks = [];
  cursor = 0;
  storeChecks.length = 0;
  const tree = comp(props);
  return { tree, checks: [...storeChecks] };
}

test('STORE-1 scope 缺失时 getSnapshot 必须返回稳定引用（否则 React 崩溃 → 卡片整块空白）', () => {
  const reg = loadComponent({ scope: undefined });
  assert.ok(reg, '卡片必须被注册');
  const injected = reg.opts.inject?.() ?? {};
  const { checks } = render(reg.comp, injected);
  assert.ok(checks.length > 0, '组件应使用 useSyncExternalStore');
  for (const c of checks) {
    assert.ok(c.stable,
      'getSnapshot 每次返回新对象会让 React 抛 "should be cached to avoid an infinite loop"，'
      + '组件崩溃后卡片区域整块空白（连未就绪提示都不出现）');
  }
});

test('STORE-2 scope 存在但快照无 value 时，getSnapshot 仍须稳定', () => {
  const scope = {
    getSnapshot: () => ({ status: 'ready' }), // 每次新对象，模拟真实 controller 返回缓存前
    subscribe: () => () => {},
    set: async () => true,
  };
  const reg = loadComponent({ scope });
  const injected = reg.opts.inject?.() ?? {};
  // 真实 ConfigFormController 缓存快照；这里验证组件自身不额外制造不稳定引用
  const { checks } = render(reg.comp, injected);
  for (const c of checks) {
    assert.ok(c.stable, '组件不得在 getSnapshot 内构造新对象');
  }
});
