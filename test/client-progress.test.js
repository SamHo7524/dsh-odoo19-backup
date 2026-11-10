/**
 * v0.1.13 T6 RED — 前端真实进度条 + 轮询可靠性 + 互斥按钮禁用。
 * 规格 §14.3 / §17.1；根因：client.js 只有 h(Status,{text}) 静态文字。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

test('UI-PROG-1 备份 Tab 有真实进度条元素（width 由 percent 驱动，不是静态文字）', () => {
  assert.match(src, /progressBar|进度条|role:\s*'progressbar'/, '应有进度条组件/元素');
  assert.match(src, /width:\s*[`'"]?\$\{[^}]*percent/, '宽度必须由 percent 驱动');
  assert.match(src, /aria-valuenow|percent/, '应有百分比数值');
});

test('UI-PROG-2 恢复 Tab 也有真实进度条（不只备份）', () => {
  const restoreIdx = src.indexOf("tab === 'restore'");
  assert.ok(restoreIdx > 0);
  // 取到文件末尾：恢复 Tab 是最后一个 Tab 区块，避免固定字符窗口随新增内容失效。
  const seg = src.slice(restoreIdx);
  assert.match(seg, /TaskProgress|role:\s*'progressbar'/, '恢复 Tab 应渲染进度条');
  assert.match(seg, /kind === 'restore'/, '恢复进度条按 kind 隔离');
});

test('UI-PROG-3 前端轮询 /status 且按 taskId/kind 归属，不用 localStorage 假持久化', () => {
  assert.match(src, /\/status/, '应轮询 /status');
  assert.match(src, /setInterval|poll/, '应定期轮询');
  assert.match(src, /taskId/, '按 taskId 归属，丢弃旧响应');
  assert.match(src, /kind/, '按 kind 区分备份/恢复进度');
  assert.ok(!/localStorage/.test(src), '不得用 localStorage 假装持久化');
});

test('UI-PROG-4 轮询可靠性：组件卸载清除定时器、终态停止轮询', () => {
  assert.match(src, /clearInterval/, '卸载/结束必须清理定时器');
  assert.match(src, /completed|failed|cancelled/, '识别终态');
  assert.match(src, /status\s*===\s*['"](completed|failed|cancelled)/, '终态停止轮询');
});

test('UI-PROG-5 网络中断不置 failed，恢复后重取真实状态；无定时动画伪造', () => {
  assert.match(src, /连接中断|网络.*重试|retry/i, '网络中断提示');
  assert.ok(!/percent\s*\+\s*1|setInterval\([^)]*setPercent/.test(src), '不得定时自增伪造进度');
});

test('UI-PROG-6 暂停冻结进度（paused 不继续动画/累加）', () => {
  assert.match(src, /paused/, '识别 paused');
  assert.match(src, /已暂停/, '暂停文案');
});

test('UI-PROG-7 互斥：锁定期间备份与恢复两个按钮均禁用，显示任务类型与原因', () => {
  assert.match(src, /\/task-lock|serverLock|taskLocked/, '读取服务器锁状态');
  // 备份与恢复两个按钮都含 taskLocked 禁用条件（至少两处 disabled 引用）
  const disabledLines = (src.match(/disabled:[^\n]*taskLocked/g) ?? []);
  assert.ok(disabledLines.length >= 2, '锁定期间备份与恢复按钮均禁用');
  assert.match(src, /正在执行|已阻止并发/, '显示拒绝原因');
});

test('UI-PROG-8 进度条数据源为 Host 状态（percent 来自 /status，不自行推算）', () => {
  assert.match(src, /fetch\('\/odoo-backup\/status'\)/, '从 /status 取数据');
  assert.match(src, /\.\.\.data/, '把 Host 响应字段（含 percent）原样放入任务状态');
  assert.match(src, /Number\(task\.percent\)/, '进度条用 Host 的 percent');
});

test('UI-DIR-1 备份 Tab 显示当前备份目录与验证结果', () => {
  assert.match(src, /\/backup-directory/, '读取/修改目录接口');
  assert.match(src, /当前备份目录|本地备份目录/, '显示当前目录');
  assert.match(src, /fullPath|writable/, '显示验证结果与完整路径');
});
