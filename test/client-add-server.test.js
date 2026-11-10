/**
 * 真机两个缺陷的回归（2026-11-06 15:16 截图）：
 *  1. 点「添加服务器」无反应 —— 组件用 window.prompt() 收集输入，
 *     而 Electron 不支持 prompt（恒返回 null），于是 if (!name) return 静默退出。
 *  2. 卡片显示「配置服务未就绪」—— configForms 在 apply 时尚未提供时，
 *     旧实现从不订阅 whileServed，scope 永远绑不上。
 *
 * 这两条都必须用「真实契约」驱动：不得依赖 prompt，且服务晚到时能重绑。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

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

function makeScope(initial = { servers: [] }) {
  let snap = { status: 'ready', writable: true, value: initial };
  const listeners = new Set();
  const writes = [];
  return {
    writes,
    getSnapshot: () => snap,
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    set: async (field, value) => {
      writes.push([field, value]);
      snap = { ...snap, value: { ...snap.value, [field]: value } };
      listeners.forEach((f) => f());
      return true;
    },
    unset: async () => true,
  };
}

function makeForms(servedNs, scope) {
  const gets = [];
  return {
    gets,
    describe: () => ({ getSnapshot: () => ({ view: { namespaces: servedNs ? [{ ns: servedNs }] : [] } }) }),
    get: (ns) => { gets.push(ns); return scope; },
    whileServed: (candidates, register) => {
      const served = new Set(candidates.filter((c) => c === servedNs));
      const off = register(served);
      return () => { if (typeof off === 'function') off(); };
    },
  };
}

/**
 * @param configForms 立即存在的服务（可为 undefined 模拟「晚到」）
 * @param lateService 若为 true，configForms 只通过 ctx.inject 回调「稍后」提供
 */
function loadClient({ configForms, lateService = false } = {}) {
  let registered;
  const win = {
    __ModuleLoader__: { load: (d) => { registered = d; } },
    // Electron 里 prompt 不受支持：设为抛错，任何依赖都会立刻暴露
    prompt: () => { throw new Error('window.prompt is not supported in Electron'); },
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
    if (name === 'react') return { createElement, useState, useCallback, useEffect, useSyncExternalStore };
    throw new Error('unknown module ' + name);
  });

  const registrations = [];
  let injectCallbacks = [];
  const ctx = {
    reflect: { get: () => ({ bind: () => (k) => k }) },
    // 模拟「apply 时服务还没提供」：get 返回 undefined
    get: (name) => (name === 'configForms' && !lateService ? configForms : undefined),
    effect: (fn) => { const d = fn(); return d ?? (() => {}); },
    inject: (services, cb) => { if (services.includes('configForms')) injectCallbacks.push(cb); },
    slots: {
      inject: (key, cb) => { const e = cb(); return () => { if (typeof e === 'function') e(); }; },
      register: (opts, comp) => {
        const entry = { opts, comp, live: true };
        registrations.push(entry);
        return () => { entry.live = false; };
      },
    },
  };
  factoryResult.apply(ctx);

  return {
    live: () => registrations.filter((r) => r.live),
    // v0.1.14：页面与导航图标是两条独立条目，按槽名取页面，不依赖注册顺序。
    page: () => registrations.filter((r) => r.live && r.opts.name === 'settings.section')[0],
    all: registrations,
    // 模拟服务晚到：触发子 inject 回调
    deliverLateService: (service) => injectCallbacks.forEach((cb) => cb({ configForms: service })),
    hasInjectWaiter: () => injectCallbacks.length > 0,
  };
}

function render(comp, props) {
  // 不重置 hooks：真实 React 在重渲染间保留 state。
  // 仅重置游标，让同一组件按顺序复用同一批 hook 槽。
  cursor = 0;
  return expand(comp(props));
}
function mount(comp, props) {
  hooks = [];
  cursor = 0;
  return expand(comp(props));
}

// ------------------------------------------------------------------ 用例

test('ADD-1 点「添加服务器」不得依赖 window.prompt（Electron 不支持，恒返回 null）', () => {
  const scope = makeScope();
  const h = loadClient({ configForms: makeForms('include:odoo-backup', scope) });
  const reg = h.page();
  assert.ok(reg, '卡片应注册');

  const tree = mount(reg.comp, reg.opts.inject?.() ?? {});
  const addBtn = findAll(tree, (n) => n.type === 'button' && texts(n).some((x) => x.includes('添加服务器')))[0];
  assert.ok(addBtn, '应有「添加服务器」按钮');

  // prompt 被设为抛错：若实现仍调用它，这里会抛出
  assert.doesNotThrow(() => addBtn.props.onClick(), '点击不应因 prompt 抛错而失败');
});

test('ADD-2 点「添加服务器」后应出现可填写的内联表单（而非弹窗）', () => {
  const scope = makeScope();
  const h = loadClient({ configForms: makeForms('include:odoo-backup', scope) });
  const reg = h.page();

  // 模拟 React 重渲染：先点击，再用新 state 渲染
  let tree = mount(reg.comp, reg.opts.inject?.() ?? {});
  const addBtn = findAll(tree, (n) => n.type === 'button' && texts(n).some((x) => x.includes('添加服务器')))[0];
  addBtn.props.onClick();

  // 重渲染（hooks 保留）以观察表单是否出现
  tree = render(reg.comp, { ...(reg.opts.inject?.() ?? {}) });
  const inputs = findAll(tree, (n) => n.type === 'input');
  assert.ok(inputs.length >= 2, `应渲染出输入框（实际 ${inputs.length} 个），而不是依赖 prompt 弹窗`);
});

test('ADD-3 表单填写并保存后，写入 scope.set("servers", ...) 且含 name/host', async () => {
  const scope = makeScope();
  const h = loadClient({ configForms: makeForms('include:odoo-backup', scope) });
  const reg = h.page();

  let tree = mount(reg.comp, reg.opts.inject?.() ?? {});
  const addBtn = findAll(tree, (n) => n.type === 'button' && texts(n).some((x) => x.includes('添加服务器')))[0];
  addBtn.props.onClick();

  tree = render(reg.comp, { ...(reg.opts.inject?.() ?? {}) });
  let inputs = findAll(tree, (n) => n.type === 'input');
  assert.ok(inputs.length >= 2, '应有输入框');

  // 真实 React 每次 onChange 都会重渲染；这里每改一个字段就重取一次输入框，
  // 否则第二次 onChange 会用旧闭包里的 draft 覆盖第一次的值。
  inputs[0].props.onChange({ target: { value: 'prod' } });
  tree = render(reg.comp, { ...(reg.opts.inject?.() ?? {}) });
  inputs = findAll(tree, (n) => n.type === 'input');
  inputs[1].props.onChange({ target: { value: '10.0.0.9' } });

  tree = render(reg.comp, { ...(reg.opts.inject?.() ?? {}) });
  const saveBtn = findAll(tree, (n) => n.type === 'button'
    && texts(n).some((x) => x === '保存'))[0];
  assert.ok(saveBtn, '应有保存按钮');
  assert.ok(!saveBtn.props.disabled, '填好必填项后保存按钮应可点击');

  await saveBtn.props.onClick();

  assert.equal(scope.writes.length, 1, '必须写入一次配置');
  assert.equal(scope.writes[0][0], 'servers');
  assert.equal(scope.writes[0][1][0].name, 'prod');
  assert.equal(scope.writes[0][1][0].host, '10.0.0.9');
});

test('SCOPE-1 configForms 在 apply 时缺席，也必须注册等待者（否则永远绑不上 scope）', () => {
  const h = loadClient({ configForms: undefined });
  assert.ok(h.page(), '设置页仍应注册');
  assert.ok(h.hasInjectWaiter(),
    'apply 时服务缺席也必须通过 ctx.inject 等待它出现，否则 scope 永远为 undefined →「配置服务未就绪」');
});

test('SCOPE-2 服务晚到后，设置页重注册且 inject() 返回已绑定的 scope', () => {
  const scope = makeScope();
  const h = loadClient({ configForms: undefined });
  assert.ok(h.hasInjectWaiter(), '应有等待者');

  h.deliverLateService(makeForms('include:odoo-backup', scope));

  const reg = h.page();
  assert.ok(reg, '晚到后仍应有存活的设置页');
  const injected = reg.opts.inject?.() ?? {};
  assert.equal(injected.scope, scope, '服务晚到后必须把 scope 交给组件');
});

// ------------------------------------------------------------ Task 4

test('FORM-1 添加服务器表单包含 sshConfigAlias 输入框（guardHostKey 的合法放行路径）', () => {
  const h = loadClient({ configForms: undefined });
  const reg = h.page();
  let tree = mount(reg.comp, reg.opts.inject?.() ?? {});
  const addBtn = findAll(tree, (n) => n.type === 'button' && texts(n).some((x) => x.includes('添加服务器')))[0];
  addBtn.props.onClick();
  tree = render(reg.comp, { ...(reg.opts.inject?.() ?? {}) });
  const inputs = findAll(tree, (n) => n.type === 'input');
  assert.ok(inputs.some((i) => /别名|sshConfigAlias/i.test(i.props.placeholder ?? '')),
    '表单应能填 SSH 配置别名，否则从界面新增的服务器必然卡在指纹闸门');
});

test('FORM-2 添加服务器表单包含 pinnedFingerprint 输入框', () => {
  const h = loadClient({ configForms: undefined });
  const reg = h.page();
  let tree = mount(reg.comp, reg.opts.inject?.() ?? {});
  const addBtn = findAll(tree, (n) => n.type === 'button' && texts(n).some((x) => x.includes('添加服务器')))[0];
  addBtn.props.onClick();
  tree = render(reg.comp, { ...(reg.opts.inject?.() ?? {}) });
  const inputs = findAll(tree, (n) => n.type === 'input');
  assert.ok(inputs.some((i) => /指纹|fingerprint/i.test(i.props.placeholder ?? '')),
    '表单应能填已确认指纹，否则用户无法按报错提示完成固化');
});

test('FORM-3 填写 sshConfigAlias 后保存，写入该字段（不丢失）', async () => {
  const scope = makeScope();
  const h = loadClient({ configForms: makeForms('include:odoo-backup', scope) });
  const reg = h.page();

  let tree = mount(reg.comp, reg.opts.inject?.() ?? {});
  const addBtn = findAll(tree, (n) => n.type === 'button' && texts(n).some((x) => x.includes('添加服务器')))[0];
  addBtn.props.onClick();

  tree = render(reg.comp, { ...(reg.opts.inject?.() ?? {}) });
  let inputs = findAll(tree, (n) => n.type === 'input');
  const nameInput = inputs.find((i) => /名称|name/i.test(i.props.placeholder ?? ''));
  const hostInput = inputs.find((i) => /主机|host/i.test(i.props.placeholder ?? ''));
  const aliasInput = inputs.find((i) => /别名|sshConfigAlias/i.test(i.props.placeholder ?? ''));
  assert.ok(aliasInput, 'FORM-1 应已让别名输入框存在');

  // 逐字段 onChange + 重渲染（真实 React 语义）
  nameInput.props.onChange({ target: { value: 'prod' } });
  tree = render(reg.comp, { ...(reg.opts.inject?.() ?? {}) });
  inputs = findAll(tree, (n) => n.type === 'input');
  inputs.find((i) => /主机|host/i.test(i.props.placeholder ?? '')).props.onChange({ target: { value: '10.0.0.9' } });
  tree = render(reg.comp, { ...(reg.opts.inject?.() ?? {}) });
  inputs = findAll(tree, (n) => n.type === 'input');
  inputs.find((i) => /别名|sshConfigAlias/i.test(i.props.placeholder ?? '')).props.onChange({ target: { value: 'toogel-vault' } });

  tree = render(reg.comp, { ...(reg.opts.inject?.() ?? {}) });
  const saveBtn = findAll(tree, (n) => n.type === 'button' && texts(n).some((x) => x === '保存'))[0];
  await saveBtn.props.onClick();

  assert.equal(scope.writes.length, 1, '应写入一次配置');
  assert.equal(scope.writes[0][1][0].sshConfigAlias, 'toogel-vault',
    'sshConfigAlias 必须随服务器一起保存，否则 guardHostKey 仍会拒绝');
});

test('FORM-4 已有服务器行提供「重新扫描」按钮（v0.1.8 起并入信任主机面板）', () => {
  const scope = makeScope({ servers: [{ name: 'toogel', host: '47.121.205.143', port: 22, user: 'root' }] });
  const h = loadClient({ configForms: makeForms('include:odoo-backup', scope) });
  const reg = h.page();
  const tree = mount(reg.comp, reg.opts.inject?.() ?? {});
  const rescanBtn = findAll(tree, (n) => n.type === 'button' && texts(n).some((x) => x.includes('重新扫描')))[0];
  assert.ok(rescanBtn, '服务器行应有「重新扫描」按钮；扫描与信任确认统一在「信任主机」面板完成');
});
