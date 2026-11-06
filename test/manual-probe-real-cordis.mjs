/**
 * 诊断探针：用 profile 里真实的 @deepseek-ai/cordis + react 装载 client.js，
 * 观察 apply() 是否抛错、是否真的注册到 plugins.bundle.config。
 * 这是真实库语义的离线复现（不伪造浏览器）。
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const PROFILE = 'C:/Users/Ho/.dsh/profiles/desktop';
const require = createRequire(PROFILE + '/package.json');
const cordis = require('@deepseek-ai/cordis');
const React = require('react');

const SRC = 'C:/Users/Ho/.dsh/remote-workspaces/wmv8yhew3a4r8/dsh-odoo-backup/client.js';
const src = readFileSync(SRC, 'utf8');

console.log('cordis keys:', Object.keys(cordis).slice(0, 12).join(', '));
console.log('react version:', React.version);

// ---- 收集 window.__ModuleLoader__ 注册 ----
let registered;
globalThis.window = {
  __ModuleLoader__: { load: (d) => { registered = d; } },
  prompt: () => null,
  confirm: () => true,
  setTimeout: globalThis.setTimeout,
};
new Function('window', 'fetch', src)(globalThis.window, async () => ({ json: async () => ({ ok: true }) }));

const factoryResult = registered.factory((name) => {
  if (name === 'react') return React;
  throw new Error('unknown module ' + name);
});

console.log('\n=== 插件导出 ===');
console.log('inject:', JSON.stringify(factoryResult.inject));
console.log('apply 类型:', typeof factoryResult.apply);

// ---- 真实 cordis 根上下文 ----
const root = new cordis.Context();
const registrations = [];
const slotDisposers = [];

const slotsService = {
  register(opts, comp) {
    registrations.push({ opts, comp });
    console.log(`  [slots.register] name=${opts.name} key=${opts.key} view=${opts.view}`);
    return () => { console.log(`  [slots.register] disposer for ${opts.key}`); };
  },
  inject(key, cb) {
    console.log(`  [slots.inject] key=${key} (立即回调，模拟槽已声明)`);
    const r = cb();
    const d = typeof r === 'function' ? r : () => {};
    slotDisposers.push(d);
    return d;
  },
};

root.provide('slots', slotsService);

// 观察 ctx.get 行为
console.log('\n=== 探测真实 ctx API ===');
console.log('typeof ctx.get      :', typeof root.get);
console.log('typeof ctx.inject   :', typeof root.inject);
console.log('typeof ctx.effect   :', typeof root.effect);
console.log('typeof ctx.reflect  :', typeof root.reflect);
try { console.log('ctx.get("configForms") ->', String(root.get('configForms'))); }
catch (e) { console.log('ctx.get("configForms") THREW:', e.message); }

// ---- 执行 apply ----
console.log('\n=== 执行 apply(ctx) ===');
try {
  factoryResult.apply(root);
  console.log('apply 返回正常');
} catch (e) {
  console.log('apply THREW:', e && e.stack ? e.stack.split('\n').slice(0, 6).join('\n') : e);
}

console.log('\n=== 结果 ===');
console.log('注册数量:', registrations.length);
if (registrations.length === 0) console.log('>>> 未注册任何配置卡片（与截图一致：卡片区域为空）');
else {
  const r = registrations[0];
  const injected = r.opts.inject ? r.opts.inject() : {};
  console.log('inject() 结果键:', Object.keys(injected));
  console.log('scope:', String(injected.scope));
}

process.exit(0);
