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
  if (typeof node.type === 'function') {
    try { return expand(node.type({ ...node.props, children: node.children })); }
    catch (e) { return { type: 'THREW', message: String(e && e.message).slice(0, 300) }; }
  }
  return { ...node, children: expand(node.children ?? []) };
}
let registered;
const win = { __ModuleLoader__: { load: (d) => { registered = d; } }, prompt: () => null, confirm: () => true, setTimeout: () => 0 };
const st = global.setTimeout; const ct = global.clearTimeout;
global.setTimeout = () => 0; global.clearTimeout = () => {};
try { new Function('window', 'fetch', src)(win, async () => ({ json: async () => ({ ok: true }) })); }
finally { global.setTimeout = st; global.clearTimeout = ct; }
const f = registered.factory((n) => { if (n === 'react') return { createElement, useState, useCallback, useSyncExternalStore }; throw new Error('unknown ' + n); });
let reg = null;
const snap = { status: 'ready', value: { servers: [{ name: 'a', host: 'h', port: 22, user: 'root' }] } };
f.apply({
  reflect: { get: () => ({ bind: () => (k) => k }) },
  get: (n) => (n === 'configForms' ? { describe: () => ({ getSnapshot: () => ({ view: { namespaces: [{ ns: 'x' }] } }) }), get: () => ({ getSnapshot: () => snap, subscribe: () => () => {}, set: async () => true }), whileServed: () => () => {} } : undefined),
  effect: (fn) => { const d = fn(); return d ?? (() => {}); },
  inject: () => {},
  slots: { inject: (_k, cb) => { cb(); return () => {}; }, register: (o, c) => { reg = { opts: o, comp: c }; return () => {}; } },
});
hooks = []; cursor = 0;
const tree = expand(reg.comp(reg.opts.inject?.() ?? {}));
function walk(n, d = 0) {
  if (n == null || typeof n !== 'object') return;
  if (n.type === 'THREW') { console.log('THREW at depth', d, ':', n.message); return; }
  if (Array.isArray(n)) { n.forEach((x) => walk(x, d + 1)); return; }
  if (n.children) walk(n.children, d + 1);
}
walk(tree);
console.log('DONE');
