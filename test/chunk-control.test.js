/**
 * v0.1.13 T7a RED — 暂停/继续/重试/取消的真实控制（规格 §9 / §17.2）。
 * 不是只加路由：必须能登记/终止 SCP 子进程、清理 .tmp、按 taskId 保护同一执行者。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'node:events';

const K = await import('../lib/chunk-control.js');

function fakeChild() {
  const c = new EventEmitter();
  c.killed = false;
  c.kill = (sig) => { c.killed = true; c.signal = sig; return true; };
  return c;
}

test('CTRL-1 登记子进程后 pause 会真实终止它（SIGTERM）', () => {
  const ctl = K.createController();
  const child = fakeChild();
  ctl.register('task-1', child);
  const r = ctl.pause('task-1');
  assert.equal(r.ok, true);
  assert.equal(child.killed, true);
  assert.equal(child.signal, 'SIGTERM');
});

test('CTRL-2 cancel 需明确确认，未确认不得取消', () => {
  const ctl = K.createController();
  const child = fakeChild();
  ctl.register('task-1', child);
  assert.equal(ctl.cancel('task-1', false).ok, false, '缺少确认');
  assert.equal(child.killed, false);
  const r = ctl.cancel('task-1', true);
  assert.equal(r.ok, true);
  assert.equal(child.killed, true);
});

test('CTRL-3 同一 taskId 同一时刻只能一个活动执行者', () => {
  const ctl = K.createController();
  assert.equal(ctl.claim('task-1').ok, true);
  assert.equal(ctl.claim('task-1').ok, false, '第二个执行者被拒');
  ctl.release('task-1');
  assert.equal(ctl.claim('task-1').ok, true, '释放后可重新占用');
});

test('CTRL-4 resume 从「第一个缺失/损坏片」开始（由调用方传入的实际校验结果）', () => {
  const ctl = K.createController();
  const chunks = [
    { index: 1, status: 'verified' }, { index: 2, status: 'failed' },
    { index: 3, status: 'pending' }, { index: 4, status: 'verified' },
  ];
  assert.equal(K.firstIncomplete(chunks), 2);
  assert.equal(K.firstIncomplete([{ index: 1, status: 'verified' }]), null);
});

test('CTRL-5 retry 只针对指定失败片，不动已校验片', () => {
  const chunks = [
    { index: 1, status: 'verified' }, { index: 2, status: 'failed' }, { index: 3, status: 'pending' },
  ];
  const next = K.retryPlan(chunks, 2);
  assert.deepEqual(next.map((c) => c.index), [2, 3]);
  assert.equal(next[0].status, 'pending');
  assert.equal(chunks[0].status, 'verified');
});

test('CTRL-6 子进程结束后注销句柄，pause 对未知任务返回 false', () => {
  const ctl = K.createController();
  const child = fakeChild();
  ctl.register('task-1', child);
  ctl.unregister('task-1');
  assert.equal(ctl.pause('task-1').ok, false);
});
