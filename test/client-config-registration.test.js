/**
 * 配置卡片注册回归测试（对应「添加服务器菜单完全消失」缺陷）。
 *
 * 关键：模拟 Cordis 的真实语义 —— 服务缺失时 `ctx.inject(services, cb)`
 * 的回调**永不执行**，且 loader entry 保持 pending、不抛错。
 * 上一版把 `plugins.bundle.config` 卡片的注册放进
 * `ctx.inject(['configForms'], ...)`，部署未提供该服务时整张卡片静默消失。
 * 旧 harness 把 ctx.inject 无条件回调，因而测不出这个回归。
 *
 * 这些测试断言行为（卡片是否注册、渲染出什么、写到了哪里），
 * 不断言实现细节；源码层面的契约约束见 client-contract.test.js。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

// ---------------------------------------------------------------- React 替身
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
const useSyncExternalStore = (subscribe, getSnapshot) => getSnapshot();

function expand(node) {
  if (node == null || node === false) return node;
  if (Array.isArray(node)) return node.map(expand);
  if (typeof node === 'string' || typeof node === 'number') return node;
  if (typeof node.type === 'function') return expand(node.type({ ...node.props, children: node.children }));
  return { ...node, children: expand(node.children ?? []) };
}
function texts(node, out = []) {
  if (node == null || node === false) return out;
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out; }
  if (Array.isArray(node)) { node.forEach((n) => texts(n, out)); return out; }
  if (node.type) texts(node.children, out);
  return out;
}
function render(comp, props = {}) {
  hooks = [];
  cursor = 0;
  return expand(comp(props));
}

// ------------------------------------------------------------ 领域测试替身
/** 与 DSH ConfigFormController.getSnapshot() 同形的配置作用域。 */
function makeScope(snapshot) {
  let snap = snapshot;
  const listeners = new Set();
  const writes = [];
  return {
    writes,
    getSnapshot: () => snap,
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    set: async (field, value) => {
      writes.push([field, value]);
      snap = { ...snap, value: { ...(snap.value ?? {}), [field]: value } };
      listeners.forEach((f) => f());
      return true;
    },
    unset: async () => {},
  };
}

/** 只服务一个命名空间的 configForms 服务替身（记录被请求的 namespace）。 */
function makeConfigForms(servedNs, scope) {
  const gets = [];
  const mirror = {
    getSnapshot: () => ({
      status: 'ready',
      view: { writable: true, namespaces: [{ ns: servedNs }] },
    }),
    subscribe: () => () => {},
    namespace: (ns) => (ns === servedNs ? { ns } : undefined),
  };
  return {
    gets,
    describe: () => mirror,
    get: (ns) => { gets.push(ns); return scope; },
    whileServed: (candidates, register) => {
      const served = new Set(candidates.filter((c) => c === servedNs));
      const off = register(served);
      return () => { if (typeof off === 'function') off(); };
    },
  };
}

/**
 * 装载 client.js。configForms 缺省 = 该服务在运行时不存在，
 * 此时 ctx.inject 的回调不执行（Cordis 真实语义），ctx.get 返回 undefined。
 */
function loadClient({ configForms, getThrows = false } = {}) {
  let registered;
  const win = {
    __ModuleLoader__: { load: (d) => { registered = d; } },
    prompt: () => null,
    confirm: () => true,
  };
  global.window = win;

  const warns = [];
  const timers = [];
  const orig = {
    warn: console.warn,
    setTimeout: global.setTimeout,
    clearTimeout: global.clearTimeout,
  };
  console.warn = (...args) => warns.push(args.map(String).join(' '));
  global.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  global.clearTimeout = () => {};

  new Function('window', 'fetch', src)(win, async () => ({ json: async () => ({ ok: true }) }));

  const factoryResult = registered.factory((name) => {
    if (name === 'react') return { createElement, useState, useCallback, useEffect, useSyncExternalStore };
    throw new Error('unknown module ' + name);
  });

  const registrations = [];
  const ctx = {
    reflect: { get: (k) => (k === 'locale' ? { bind: () => (x) => x } : undefined) },
    // 服务缺席时回调永不执行
    inject: (services, cb) => (
      services.includes('configForms') && configForms ? cb({ configForms }) : undefined
    ),
    get: (name) => {
      if (getThrows) throw new Error('cannot get property "configForms" without inject');
      return name === 'configForms' ? configForms : undefined;
    },
    effect: (fn) => fn(),
    slots: {
      inject: (key, cb) => {
        const entry = cb(); // register 的 disposer
        return () => { if (typeof entry === 'function') entry(); };
      },
      register: (opts, comp) => {
        // 与真实 slot ledger 一致：注销后该条目不再 live。
        const entry = { opts, comp, live: true };
        registrations.push(entry);
        return () => { entry.live = false; };
      },
    },
  };
  factoryResult.apply(ctx);

  // 只把仍在服务的注册视为可见（rebind 会先注销旧条目）。
  const live = () => registrations.filter((r) => r.live);
  return {
    registrations: live(),
    // v0.1.14：页面与导航图标是两条条目，按槽名取设置页。
    page: () => live().find((r) => r.opts.name === 'settings.section'),
    warns,
    timers,
    fireTimers: () => timers.forEach((t) => t.fn()),
    restore: () => {
      console.warn = orig.warn;
      global.setTimeout = orig.setTimeout;
      global.clearTimeout = orig.clearTimeout;
    },
  };
}

// ------------------------------------------------------------------ 回归用例

test('REG-1 configForms 服务缺失时，仍无条件注册设置页（settings.section）', (t) => {
  const h = loadClient({ configForms: undefined });
  t.after(h.restore);
  assert.ok(h.page(),
    '设置页不能因为配置服务缺失而整页消失（服务缺失只能降级，不能隐藏）');
  assert.equal(h.page().opts.name, 'settings.section');
  assert.equal(h.page().opts.id, 'odoo-backup');
});

test('REG-2 服务缺失时，卡片首次渲染即显示明确的未就绪提示（无需点击）', (t) => {
  const h = loadClient({ configForms: undefined });
  t.after(h.restore);
  assert.ok(h.page(), '设置页应注册');
  const reg = h.page();
  const injected = reg.opts.inject?.() ?? {};
  const text = texts(render(reg.comp, injected)).join('\n');
  assert.match(text, /配置服务未就绪/, '应在渲染时直接给出可见提示');
  assert.match(text, /服务器/, 'Tab 结构仍应存在，卡片不能是空白');
});

test('REG-3 已有服务器从 ConfigFormController 快照的 value.servers 读取并显示', (t) => {
  const scope = makeScope({
    status: 'ready', writable: true,
    value: { servers: [{ name: 'prod', host: '10.0.0.1', port: 22, user: 'root' }] },
  });
  const forms = makeConfigForms('include:odoo-backup', scope);
  const h = loadClient({ configForms: forms });
  t.after(h.restore);
  assert.ok(h.page(), '设置页应注册');
  const reg = h.page();
  const injected = reg.opts.inject?.() ?? {};
  const text = texts(render(reg.comp, injected)).join('\n');
  assert.match(text, /prod/, '服务器名称应出现');
  assert.match(text, /10\.0\.0\.1/, '主机地址应出现');
  assert.ok(!/尚未配置服务器/.test(text), '有配置时不应误报为空');
});

test('REG-4 配置 namespace 由运行时实际服务的命名空间动态确认，不硬编码 odoo-backup', (t) => {
  const scope = makeScope({ status: 'ready', writable: true, value: { servers: [] } });
  const runtimeNs = 'include:odoo-backup';
  const forms = makeConfigForms(runtimeNs, scope);
  const h = loadClient({ configForms: forms });
  t.after(h.restore);
  assert.ok(h.page(), '设置页应注册');
  const reg = h.page();
  assert.ok(forms.gets.includes(runtimeNs),
    `应向 configForms 请求运行时实际服务的命名空间 ${runtimeNs}`);
  assert.ok(!forms.gets.includes('odoo-backup'),
    '不应再猜测并直接用裸 row id 作为 namespace');
  assert.equal(reg.opts.inject?.().scope, scope,
    '注入组件的 scope 必须绑定运行时确认的命名空间');
});

test('REG-6 ctx.get 自身抛错时，卡片仍然注册（任何配置服务异常都不得吞掉卡片）', (t) => {
  const h = loadClient({ configForms: undefined, getThrows: true });
  t.after(h.restore);
  assert.ok(h.page(),
    'ctx.get 抛错也必须降级，不能中断 apply 导致整卡消失');
});

test('REG-7 describe() 抛错时，卡片仍然注册并显示未就绪提示', (t) => {
  const brokenForms = {
    describe: () => { throw new Error('mirror unavailable'); },
    get: () => { throw new Error('mirror unavailable'); },
    whileServed: () => () => {},
  };
  const h = loadClient({ configForms: brokenForms });
  t.after(h.restore);
  assert.ok(h.page(), 'describe 抛错不得让卡片消失');
  const reg = h.page();
  const text = texts(render(reg.comp, reg.opts.inject?.() ?? {})).join('\n');
  assert.match(text, /配置服务未就绪/, '应降级为可见提示');
});

test('REG-8 whileServed 抛错时，卡片仍然注册', (t) => {
  const forms = {
    describe: () => ({ getSnapshot: () => ({ view: { namespaces: [] } }) }),
    get: () => undefined,
    whileServed: () => { throw new Error('boom'); },
  };
  const h = loadClient({ configForms: forms });
  t.after(h.restore);
  assert.ok(h.page(), 'whileServed 抛错不得让卡片消失');
});

test('REG-5 配置服务缺失 5 秒后输出点名 configForms 的诊断告警，而非静默消失', (t) => {
  const h = loadClient({ configForms: undefined });
  t.after(h.restore);
  assert.ok(h.page(), '设置页应注册');
  assert.ok(h.timers.some((t2) => t2.ms >= 5000), '应安排一个 5 秒诊断定时器');
  h.fireTimers();
  assert.ok(h.warns.some((w) => /configForms/.test(w)), '告警应点名 configForms 便于定位');
});
