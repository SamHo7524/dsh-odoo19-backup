/**
 * v0.1.13 真机缺陷回归（2026-11-09）：/precheck 未解包 volatile servers，
 * 导致恢复入口 400 "(config.servers ?? []).some is not a function"。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

test('PRECHECK-1 /precheck 必须 unwrapVolatile(config.servers) 再 .some()', () => {
  const i = src.indexOf("route === '/precheck'");
  const seg = src.slice(i, i + 1200);
  assert.match(seg, /unwrapVolatile\(config[^)]*servers\)/, 'servers 是活引用，必须解包');
  assert.ok(!/\(config\.servers \?\? \[\]\)\.some/.test(seg), '不得直接对活引用调用 .some');
});
