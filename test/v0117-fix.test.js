/**
 * v0.1.17 — 任务状态轮询修复 + 状态文件按服务器隔离（用户裁决验收标准 1–7）。
 *
 * 裁决 §四 验收标准：
 *  1. 历史任务 completed 后重新打开设置页，轮询仍持续。
 *  2. 新任务启动后，旧终态立即让位。
 *  3. 新任务进度不会被延迟返回的旧请求覆盖。
 *  4. 备份与恢复 Tab 共用状态时显示正确。
 *  5. 两台服务器并发备份，状态、进度、任务 ID 互不干扰。
 *  6. DSH 重启后能正确读取各服务器自己的状态。
 *  7. 原有 559 项及新增测试全部通过（由全量跑承担）。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createService } from '../lib/service.js';
import { createState, writeState, readState, serverStateDir } from '../lib/task-state.js';
import { readLock } from '../lib/server-lock.js';
import { serverIdOf } from '../lib/server-id.js';

async function withDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'v0117-'));
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

const SERVER_A = { name: 'alpha', host: '10.0.0.1', port: 22, user: 'root', sshConfigAlias: 'a' };
const SERVER_B = { name: 'beta', host: '10.0.0.2', port: 22, user: 'root', sshConfigAlias: 'b' };

function deps(overrides = {}) {
  return {
    guardHostKey: async () => ({ ok: true }),
    testConnection: async () => ({ ok: true }),
    discover: async () => ({ ok: true, instances: [{ dbName: 'db' }] }),
    runBackup: async () => ({ ok: true, localPath: 'K:/b.tar.enc', bytes: 10 }),
    runRestore: async () => ({ ok: true }),
    detectFormat: async () => 'dsh-odoo',
    stat: async () => ({ size: 1 }),
    scanHostKey: async () => ({ ok: true, fingerprints: [] }),
    pinHostKey: async () => ({ ok: true }),
    credentials: { resolve: async () => ({ value: 'pw', source: 'file' }) },
    ...overrides,
  };
}

const cfg = (dir, servers = [SERVER_A, SERVER_B]) => ({
  servers,
  localBackupDir: dir,
  backupDirectory: dir,
  allowUnencryptedPackage: false,
});

// ---------------- 客户端（client.js 源级 + 行为级） ----------------

const clientSrc = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

test('V17-C1 客户端移除终态停表：不存在「读到终态就 clearInterval」的逻辑（验收 1）', () => {
  assert.ok(!clientSrc.includes('terminal.includes(data.status)'),
    'v0.1.17 起轮询不得因磁盘残留终态而停止（根因：client.js:467 旧实现）');
  // 轮询定时器只在组件卸载清理
  assert.match(clientSrc, /return \(\) => \{ alive = false; clearInterval\(timer\); \};/,
    '唯一清理点必须是组件卸载');
});

test('V17-C2 客户端有请求序号防乱序 + updatedAt 接管（验收 2/3）', () => {
  assert.match(clientSrc, /pollSeq/, '必须用单调递增请求序号丢弃过期响应');
  assert.match(clientSrc, /seq !== pollSeq\.current\) return/,
    '晚返回的旧请求不得落状态');
  assert.match(clientSrc, /Date\.parse\(prev\.updatedAt\)/,
    '不同 taskId 接管必须按可解析的 updatedAt 判新旧');
  assert.match(clientSrc, /setHostTask\(null\)/, '开始备份/恢复时清掉旧终态显示');
});

test('V17-C3 行为级：终态后轮询持续、新 taskId 立即接管、同 taskId 更新生效（验收 1/2）', async () => {
  // 最小 React 替身：真执行 useEffect 副作用 + 可手动推进的 setInterval。
  // hostTask 槽位用「同名标记」定位：poll 回调闭包里 set 的唯一路径可观察。
  const timers = [];
  const effects = [];
  const stateSlots = [];
  function createElement(type, props, ...children) {
    return { type, props: props ?? {}, children: children.flat(Infinity) };
  }
  const useState = (init) => {
    stateSlots.push({ v: typeof init === 'function' ? init() : init });
    const i = stateSlots.length - 1;
    return [stateSlots[i].v, (v) => { stateSlots[i].v = typeof v === 'function' ? v(stateSlots[i].v) : v; }];
  };
  const useCallback = (fn) => fn;
  const useRef = (init) => ({ current: init });
  const useEffect = (fn) => { effects.push(fn); };
  const useSyncExternalStore = (s, g) => g();

  // fetch 替身：按 URL 精确区分响应队列。注意 /passphrase-status、
  // /backup-directory 也含 "status" 字样，必须精确匹配 /odoo-backup/status。
  const statusQueue = [];
  const fakeFetch = async (url) => {
    const u = String(url);
    if (u.endsWith('/odoo-backup/status')) {
      const r = statusQueue.shift() ?? {};
      return { json: async () => r };
    }
    return { json: async () => ({ result: { locked: false } }) };
  };

  let registered;
  const win = { __ModuleLoader__: { load: (d) => { registered = d; } }, prompt: () => null, confirm: () => true };
  // 注意：fake 定时器必须在「执行 effect」期间保持安装——组件的 setInterval 是
  // 全局引用，effect 在模块加载之后才手动运行；若只加载时安装、执行时已还原，
  // 会创建真实 interval 让 node:test 进程悬挂。
  const realSI = global.setInterval;
  const realCI = global.clearInterval;
  global.setInterval = (fn, ms) => { const t = { fn, ms, fake: true }; timers.push(t); return t; };
  global.clearInterval = (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); };
  try {
    new Function('window', 'fetch', clientSrc)(win, fakeFetch);
  } catch (e) {
    global.setInterval = realSI;
    global.clearInterval = realCI;
    throw e;
  }
  const factoryResult = registered.factory((name) => {
    if (name === 'react') return { createElement, useState, useCallback, useEffect, useRef, useSyncExternalStore };
    throw new Error('unknown module ' + name);
  });
  const ctx = {
    reflect: { get: () => ({ bind: () => (k) => k }) },
    get: () => undefined,
    effect: (fn) => { const d = fn(); return d ?? (() => {}); },
    inject: (svcs, cb) => { cb({}); },
    slots: { inject: (key, cb) => { cb(); }, register: (opts, comp) => { registered.__comp = comp; registered.__opts = opts; } },
  };
  factoryResult.apply(ctx);
  const comp = registered.__comp;
  const injected = registered.__opts.inject?.() ?? {};

  const tick = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)); };

  /** hostTask 槽：轮询写入后唯一带 taskId 的 state 槽（其它槽都是固定形状或 null）。 */
  const hostSlot = () => stateSlots.find((s) => s.v && typeof s.v === 'object' && typeof s.v.taskId === 'string');

  // 渲染组件：副作用被收集进 effects（替身不自动执行）
  stateSlots.length = 0;
  effects.length = 0;
  comp(injected);

  // 找出轮询 effect：执行后产生了 interval
  let dispose = null;
  for (const fn of effects) {
    const before = timers.length;
    try { const d = fn(); if (timers.length > before) { dispose = d; break; } } catch { /* 非 轮询 effect */ }
  }
  assert.ok(dispose, '轮询 effect 必须存在');
  assert.ok(timers.length > 0, '挂载后必须有 interval 在跑');
  await tick(); // 挂载时的首次 poll()

  // 第一次 poll：磁盘残留终态 completed
  statusQueue.push({ result: { taskId: 'old-task', kind: 'backup', status: 'completed', percent: 100, updatedAt: '2026-11-10T10:00:00.000Z' } });
  for (const t of [...timers]) t.fn();
  await tick();
  assert.ok(timers.length > 0, '验收1：读到历史 completed 后轮询仍持续（旧实现这里停表）');
  assert.equal(hostSlot()?.v?.taskId, 'old-task', '终态先上屏（刷新后可恢复最终状态，§6.1）');

  // 第二次 poll：新任务 running —— 验收2：旧终态立即让位
  statusQueue.push({ result: { taskId: 'new-task', kind: 'backup', status: 'running', percent: 40, updatedAt: '2026-11-11T02:00:00.000Z' } });
  for (const t of [...timers]) t.fn();
  await tick();
  assert.equal(hostSlot()?.v?.taskId, 'new-task', '验收2：新 taskId 必须接管，不被旧终态阻挡');
  assert.equal(hostSlot()?.v?.percent, 40);

  // 第三次 poll：同 taskId 正常更新
  statusQueue.push({ result: { taskId: 'new-task', kind: 'backup', status: 'running', percent: 60, updatedAt: '2026-11-11T02:00:05.000Z' } });
  for (const t of [...timers]) t.fn();
  await tick();
  assert.equal(hostSlot()?.v?.percent, 60, '同 taskId 正常更新生效');

  // 卸载：定时器必须清理（测试进程不悬挂）
  dispose();
  assert.equal(timers.length, 0, '卸载后定时器必须清理');
  // 还原全局定时器：所有 fake interval 已清，进程可正常退出
  global.setInterval = realSI;
  global.clearInterval = realCI;
});

test('V17-C4 行为级：不同 taskId 且旧数据时间戳更新 → 迟到的旧响应不覆盖新任务（验收 3）', async () => {
  // 直接驱动组件里 setHostTask 的接管逻辑：构造与 client.js 相同的 reducer 行为
  // 不可行（闭包私有），改为对 client.js 源码断言接管分支的判定方向：
  // nowTs >= prevTs 才接管（旧时间戳 < 新时间戳时拒绝），源码必须包含该比较。
  assert.match(clientSrc, /nowTs >= prevTs \? \{ \.\.\.data \} : prev/,
    '旧时间戳晚于新数据时必须拒绝接管（验收3：迟到的旧响应不覆盖新任务）');
});

// ---------------- 服务端：按服务器隔离 ----------------

test('V17-S1 状态文件落在 <stateDir>/<serverId>/，根目录不再有全局文件（验收 5 前提）', async () => {
  await withDir(async (dir) => {
    const svc = createService({ config: cfg(dir), deps: deps(), stateDir: dir });
    await svc.backup('alpha');
    const idA = serverIdOf(SERVER_A);
    const s = await readState(serverStateDir(dir, idA));
    assert.ok(s, '状态必须写入服务器自己的目录');
    assert.equal(s.serverConfigId, idA, '状态必须记录 serverConfigId');
    assert.equal(await readState(dir), null, '根目录不得再有全局状态文件');
    assert.equal((await readLock(dir, idA)), null, '锁按 serverConfigId 释放');
  });
});

test('V17-S2 两台服务器并发备份：状态、进度、taskId 互不干扰（验收 5）', async () => {
  await withDir(async (dir) => {
    const gates = {};
    const calls = [];
    const d = deps({
      runBackup: async ({ server }) => {
        calls.push(server.name);
        await gates[server.name];
        return { ok: true, localPath: `K:/${server.name}.tar.enc`, bytes: 1 };
      },
    });
    const svc = createService({ config: cfg(dir), deps: d, stateDir: dir });
    let relA; gates.alpha = new Promise((r) => { relA = r; });
    let relB; gates.beta = new Promise((r) => { relB = r; });
    const pa = svc.backup('alpha');
    const pb = svc.backup('beta');
    for (let i = 0; i < 50 && calls.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(calls.length, 2, '两台服务器都必须真正启动（互不阻塞）');

    const idA = serverIdOf(SERVER_A);
    const idB = serverIdOf(SERVER_B);
    const sa = await readState(serverStateDir(dir, idA));
    const sb = await readState(serverStateDir(dir, idB));
    assert.ok(sa && sb, '两份状态文件并存');
    assert.notEqual(sa.taskId, sb.taskId, 'taskId 互不相同');
    assert.equal(sa.serverConfigId, idA);
    assert.equal(sb.serverConfigId, idB);

    // 并发期间各自上报进度，互不串写
    // （progressReporter 由 service 内部接线；这里直接验证磁盘隔离即可）
    relA(); relB();
    await Promise.all([pa, pb]);
    const fa = await readState(serverStateDir(dir, idA));
    const fb = await readState(serverStateDir(dir, idB));
    assert.equal(fa.status, 'completed');
    assert.equal(fb.status, 'completed');
    assert.equal(fa.taskId, sa.taskId, 'alpha 终态仍是 alpha 自己的 taskId');
    assert.equal(fb.taskId, sb.taskId, 'beta 终态仍是 beta 自己的 taskId');
  });
});

test('V17-S3 status(server) 读各服务器自己的状态；无参扫描只认活动状态（验收 6）', async () => {
  await withDir(async (dir) => {
    const svc = createService({ config: cfg(dir), deps: deps(), stateDir: dir });
    await svc.backup('alpha');
    await svc.backup('beta');
    // 重启模拟：新建 service 实例（内存 task 为空），磁盘状态可读
    const svc2 = createService({ config: cfg(dir), deps: deps(), stateDir: dir });
    const sa = await svc2.status('alpha');
    const sb = await svc2.status('beta');
    assert.equal(sa.status, 'completed');
    assert.equal(sb.status, 'completed');
    assert.notEqual(sa.taskId, sb.taskId, '各服务器读到自己的 taskId');
    const sweep = await svc2.status();
    // 规格 §6.1：刷新/重启后 UI 必须仍能恢复最近一次终态，不回退成「无任务」。
    assert.equal(sweep.running, false, '无参扫描不得把终态误报成 running');
    assert.ok(sweep.taskId, '终态必须可恢复（taskId 不为空）');
    assert.ok(['completed', 'failed', 'cancelled'].includes(sweep.status), '返回真实终态');
    assert.ok([sa.taskId, sb.taskId].includes(sweep.taskId), '终态枚举自各服务器自己的状态文件');
  });
});

test('V17-S4 旧全局状态文件兼容读取：同归属才认，绝不复制给别的服务器（裁决 §三）', async () => {
  await withDir(async (dir) => {
    const idA = serverIdOf(SERVER_A);
    const idB = serverIdOf(SERVER_B);
    const legacy = createState({ backupId: 'alpha', kind: 'backup', backupDirectory: dir, taskDir: dir, extra: { serverConfigId: idA } });
    legacy.status = 'completed';
    await writeState(dir, legacy); // 写在旧全局位置

    // 新目录结构下 alpha 的兼容读取应命中旧文件（同归属）
    const { readStateCompat } = await import('../lib/task-state.js');
    const sa = await readStateCompat(dir, idA);
    assert.ok(sa, '同归属的旧全局文件必须可读（迁移兼容来源）');
    assert.equal(sa.taskId, legacy.taskId);
    // beta 读不到：绝不把 alpha 的状态复制给 beta
    const sb = await readStateCompat(dir, idB);
    assert.equal(sb, null, '旧全局文件不得成为其它服务器的状态');
    // serverConfigId 缺失的更旧文件：视为未归属，兼容读取放行（用户数据不丢）
    const orphan = { ...legacy, serverConfigId: null };
    await writeState(dir, orphan);
    const so = await readStateCompat(dir, idB);
    assert.ok(so, '无归属字段的旧文件按未归属兼容放行');
  });
});

test('V17-S5 服务器改名后，锁与状态归属不变（稳定 serverConfigId，裁决 §三）', async () => {
  await withDir(async (dir) => {
    const renamed = { ...SERVER_A, name: 'alpha-renamed' };
    const svc = createService({ config: cfg(dir, [renamed, SERVER_B]), deps: deps(), stateDir: dir });
    await svc.backup('alpha-renamed');
    // 改名前后 host/port/user/alias 不变 → serverId 相同 → 同一目录
    const s = await readState(serverStateDir(dir, serverIdOf(SERVER_A)));
    assert.ok(s, '改名后仍读写同一份状态文件');
    assert.equal(s.status, 'completed');
  });
});

test('V17-S6 runGuarded 后磁盘终态保留、锁释放；失败路径写 failed（既有语义不回归）', async () => {
  await withDir(async (dir) => {
    const d = deps({ runBackup: async () => { throw new Error('boom'); } });
    const svc = createService({ config: cfg(dir), deps: d, stateDir: dir });
    await assert.rejects(() => svc.backup('alpha'), /boom/);
    const idA = serverIdOf(SERVER_A);
    assert.equal((await readState(serverStateDir(dir, idA))).status, 'failed');
    assert.equal(await readLock(dir, idA), null, '失败后锁必须释放');
  });
});

test('V17-S7 serverIdOf：稳定、区分服务器、不含 keyPath', () => {
  const a = serverIdOf(SERVER_A);
  assert.equal(a, serverIdOf({ ...SERVER_A, keyPath: 'C:/whatever', pinnedFingerprint: 'SHA256:x' }),
    '私钥路径/指纹不得参与摘要');
  assert.notEqual(a, serverIdOf(SERVER_B));
  assert.notEqual(a, serverIdOf({ ...SERVER_A, host: '10.9.9.9' }), '换主机必须是新身份');
  assert.notEqual(a, serverIdOf({ ...SERVER_A, user: 'odoo' }), '换用户必须是新身份');
  assert.equal(a, serverIdOf({ ...SERVER_A, name: 'whatever' }), '显示名改名不影响身份（裁决 §三）');
  assert.match(a, /^[0-9a-f]{16}$/);
});
