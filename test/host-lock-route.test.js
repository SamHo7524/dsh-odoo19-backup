/**
 * v0.1.13 真机缺陷回归（2026-11-09）：/task-lock 未解包 volatile servers，
 * 回退成 'default'，导致备份运行中 locked:false（互斥状态与 /status 矛盾）。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

test('LOCKROUTE-1 /task-lock 与 /task-lock/confirm-stale 必须 unwrapVolatile(config.servers)', () => {
  const i = src.indexOf("route === '/task-lock'");
  const seg = src.slice(i, i + 2400);
  assert.match(seg, /unwrapVolatile\(config\?\.?servers\)/, '服务器列表是 volatile 活引用，必须解包');
});

test('LOCKROUTE-2 /task-lock 默认 serverConfigId 来自真实服务器名，不是字面 default', () => {
  const i = src.indexOf("route === '/task-lock'");
  const seg = src.slice(i, i + 2400);
  assert.ok(!/'default'/.test(seg), "不得用 'default' 兜底（会与锁键不一致）");
});
