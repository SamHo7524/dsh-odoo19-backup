/**
 * 保存服务器的真实链路回归（2026-11-06 16:05 截图：能输入但保存不了）。
 *
 * 根因：前端靠 configForms 的 namespace 猜测绑 scope，一旦没绑上，
 * saveServers 直接走「配置服务未就绪」分支，用户点了保存毫无效果。
 *
 * 修复方向：Host 半侧提供写配置路由（Host 有官方 ctx.settings.update），
 * 前端优先走该路由保存；configForms 只作为可选增强，不再是保存的前置条件。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const hostSrc = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const clientSrc = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

// ---------------------------------------------------------------- Host 侧

test('HOST-1 index.js 必须提供写 servers 的路由（不依赖前端 configForms）', () => {
  assert.match(hostSrc, /save-servers|\/servers\/save|'saveServers'/,
    'Host 半侧应暴露保存服务器的路由，让前端不依赖 configForms 也能保存');
});

test('HOST-2 该路由通过 ctx.settings.update 写配置（官方设置服务）', () => {
  assert.match(hostSrc, /settings\.update\s*\(/, '应调用 ctx.settings.update(ns, patch)');
  assert.match(hostSrc, /servers/, 'patch 应包含 servers 字段');
});

test('HOST-3 写配置失败时必须返回可读错误，不能静默', () => {
  // 路由 handler 必须把异常转成 { ok:false, error } 响应
  assert.match(hostSrc, /ok:\s*false/);
});

// ---------------------------------------------------------------- Client 侧

test('CLIENT-1 saveServers 必须优先走 Host 路由，而不是把 configForms 当唯一通道', () => {
  // 允许两种通道，但必须存在 fetch 到 /odoo-backup 的保存路径
  assert.match(clientSrc, /\/odoo-backup\/save-servers|\/save-servers/,
    '前端应调用 Host 的保存路由');
});

test('CLIENT-2 未绑定 scope 时点保存不得静默失败（要么保存成功，要么给明确错误）', () => {
  // 旧实现：if (!scope?.set) { setSaveErr(...); return; }
  // 修复后：即使 scope 缺失也要走 Host 路由尝试保存
  const hasEarlyReturnOnly = /if\s*\(!scope\?\.set\)\s*\{\s*setSaveErr\([^)]*\);\s*return;/.test(clientSrc);
  assert.ok(!hasEarlyReturnOnly,
    '不能在 scope 缺失时直接 return —— 应改走 Host 路由');
});
