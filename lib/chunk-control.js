/**
 * v0.1.13 — 分片任务控制（规格 §9 / §17.2）。
 * 真实终止 SCP 子进程、按 taskId 保护单一活动执行者、暂停/取消/重试的调度辅助。
 * 该文件只管「进程句柄与调度意图」；任务终态持久化由 task-state.js / service 统一负责。
 */
export function createController() {
  const children = new Map();   // taskId -> ChildProcess
  const claimed = new Set();    // taskId 单一活动执行者

  return {
    register(taskId, child) { if (taskId && child) children.set(taskId, child); },
    unregister(taskId) { children.delete(taskId); },

    claim(taskId) {
      if (!taskId || claimed.has(taskId)) return { ok: false, reason: '同一任务已有活动执行者' };
      claimed.add(taskId);
      return { ok: true };
    },
    release(taskId) { claimed.delete(taskId); },

    /** 暂停：终止当前分片下载的子进程（保留已校验分片）。 */
    pause(taskId) {
      const child = children.get(taskId);
      if (!child) return { ok: false, reason: '无活动 SCP 子进程' };
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      return { ok: true };
    },

    /** 取消：必须明确确认；终止子进程并注销。 */
    cancel(taskId, confirm) {
      if (confirm !== true) return { ok: false, reason: '取消需要明确确认（confirm:true）' };
      const child = children.get(taskId);
      if (child) { try { child.kill('SIGTERM'); } catch { /* ignore */ } }
      children.delete(taskId);
      claimed.delete(taskId);
      return { ok: true };
    },
  };
}

/** 从第一个缺失/校验失败的分片开始（§9 继续）。 */
export function firstIncomplete(chunks = []) {
  const bad = chunks.find((c) => c && c.status !== 'verified');
  return bad ? bad.index : null;
}

/** 重试：返回「指定片 + 其后所有未完成片」的待下载列表，已校验片不参与（§9 重试）。 */
export function retryPlan(chunks = [], index) {
  return chunks
    .filter((c) => c.status !== 'verified' || c.index === index)
    .map((c) => ({ ...c, status: 'pending' }));
}
