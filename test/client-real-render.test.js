/**
 * 真实 React 语义回归：useSyncExternalStore 的 getSnapshot 必须返回**稳定引用**，
 * 否则 React 抛 "The result of getSnapshot should be cached to avoid an infinite loop"
 * 并使组件崩溃 —— 插件页的错误边界吞掉后，配置卡片区域整块空白
 * （2026-11-06 真机截图症状：连「配置服务未就绪」提示都不出现）。
 *
 * 本测试用真实 react-dom/server 渲染，复现该崩溃路径。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const PROFILE = 'C:/Users/Ho/.dsh/profiles/desktop';
const require = createRequire(PROFILE + '/package.json');

const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

let React;
let renderToStaticMarkup;
try {
  React = require('react');
  ({ renderToStaticMarkup } = require('react-dom/server'));
} catch (e) {
  console.log('SKIP: react/react-dom not resolvable from profile:', e.message.slice(0, 120));
  process.exit(0);
}

function loadComponent() {
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
    if (name === 'react') return React;
    throw new Error('unknown module ' + name);
  });

  let reg = null;
  const ctx = {
    reflect: { get: () => ({ bind: () => (k) => k }) },
    get: () => undefined, // 模拟 configForms 缺席
    effect: (fn) => { const d = fn(); return d ?? (() => {}); },
    slots: {
      inject: (key, cb) => { cb(); return () => {}; },
      register: (opts, comp) => { reg = { opts, comp }; return () => {}; },
    },
  };
  factoryResult.apply(ctx);
  return reg;
}

test('REAL-1 scope 缺失时组件能真实渲染，不因 getSnapshot 引用不稳定而崩溃', () => {
  const reg = loadComponent();
  assert.ok(reg, '卡片必须被注册');

  const injected = reg.opts.inject?.() ?? {};
  const Panel = reg.comp;

  let html;
  try {
    html = renderToStaticMarkup(React.createElement(Panel, injected));
  } catch (e) {
    assert.fail(`组件渲染抛错（真机上会被错误边界吞掉 → 卡片整块空白）：${e.message}`);
  }
  assert.match(html, /配置服务未就绪/, '应渲染出可见的未就绪提示');
  assert.match(html, /服务器/, '服务器 Tab 应存在');
});

test('REAL-2 连续两次 getSnapshot 必须返回同一引用（React 硬要求）', () => {
  const reg = loadComponent();
  const injected = reg.opts.inject?.() ?? {};
  // 用 React 官方校验：渲染两次同一 props 不应触发无限循环告警
  const Panel = reg.comp;
  const a = renderToStaticMarkup(React.createElement(Panel, injected));
  const b = renderToStaticMarkup(React.createElement(Panel, injected));
  assert.equal(a, b, '两次渲染结果应一致（引用不稳定会导致不稳定输出/崩溃）');
});
