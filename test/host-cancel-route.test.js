/**
 * v0.1.13 真机验收缺口回归：遗留任务需要可经 API 明确取消（§9 cancel / §17.1 重启恢复）。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

test('CANCELROUTE-1 提供 /task-cancel 路由且要求明确确认', () => {
  assert.match(src, /route === '\/task-cancel'/, '应有取消路由');
  const i = src.indexOf("route === '/task-cancel'");
  assert.match(src.slice(i, i + 1200), /confirm/, '取消必须明确确认');
});

test('CANCELROUTE-2 取消把状态置 cancelled 并释放服务器锁（按 taskId）', () => {
  const i = src.indexOf("route === '/task-cancel'");
  const seg = src.slice(i, i + 1600);
  assert.match(seg, /patchState/, '写回磁盘状态');
  assert.match(seg, /cancelled/, '终态 cancelled');
  assert.match(seg, /releaseLock/, '释放锁');
});
