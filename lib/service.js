import { stat } from 'node:fs/promises';
import { testConnection, guardHostKey } from './ssh.js';
import { discover as discoverInstance } from './discover.js';
import { runBackup } from './backup.js';
import { runRestore } from './restore.js';
import { detectFormat } from './crypto.js';
import { scanHostKey, pinHostKey } from './knownhosts.js';
import { serverConnection } from './tools.js';
import { createState, writeState, readState, patchState, canComplete } from './task-state.js';
import { acquireLock, releaseLock, readLock } from './server-lock.js';

/**
 * 操作服务：UI 与 Agent 工具共用的唯一实现（user-actions.md「一个操作，两个调用者」）。
 *
 * 依赖通过 `deps` 注入，便于单测在无网络/无 SSH 的情况下验证真实分支逻辑。
 *
 * @param {object} args
 * @param {object} args.config 插件 Config
 * @param {object} [args.deps] 依赖覆盖（测试用）
 * @param {boolean} [args.allowUnencrypted] 是否允许未加密包
 * @param {function} [args.onProgress]
 */
export function createService({ config, deps = {}, allowUnencrypted, onProgress, stateDir } = {}) {
  const d = {
    testConnection,
    guardHostKey,
    discover: discoverInstance,
    runBackup,
    runRestore,
    detectFormat,
    stat,
    scanHostKey,
    pinHostKey,
    credentials: undefined,
    ...deps,
  };

  /** 备份加密口令的官方凭证引用（v0.1.11 起口令只存 DSH Credentials，不进插件配置）。 */
  const PASSPHRASE_REF = 'ODOO_BACKUP_PASSPHRASE';

  /**
   * 每次执行时动态 resolve（用户修正 1：不缓存）。未配置时 fail-closed，
   * 报错可操作；任何路径都不把口令写进日志或异常消息。
   */
  async function requirePassphrase(action) {
    const cred = d.credentials;
    if (!cred || typeof cred.resolve !== 'function') {
      throw new Error(
        '凭证服务不可用（ctx.credentials 未注入），无法读取备份加密口令。' +
          `请确认 DSH 已启用官方 Credentials 服务后重试（引用 ${PASSPHRASE_REF}）。`,
      );
    }
    const resolved = await cred.resolve(PASSPHRASE_REF);
    const passphrase = resolved?.value;
    if (typeof passphrase !== 'string' || passphrase.length === 0) {
      throw new Error(
        `未配置加密口令，拒绝${action}（R10 强制加密）。` +
          '请在插件设置卡片的「备份加密口令」中设置（保存到 DSH 凭证库，不写入插件配置文件）；' +
          '本插件不会生成明文备份包。',
      );
    }
    return passphrase;
  }

  /** 供 web handler 在请求时补挂凭证服务（inject 时序的自愈通道，CRED-16）。 */
  function attachCredentials(credentials) {
    if (credentials && typeof credentials.resolve === 'function') d.credentials = credentials;
  }

  /** 最近一次任务（供 status 查询）。 */
  let task = null;

  function findServer(name) {
    if (!name) throw new Error('缺少 server 参数');
    const server = (config?.servers ?? []).find((s) => s.name === name);
    if (!server) throw new Error(`未找到服务器: ${name}`);
    return server;
  }

  function conn(name) {
    return serverConnection(findServer(name));
  }

  /**
   * 指纹闸门（fail-closed）：任何触达远端的操作都必须先过这一关。
   * 未固定指纹且非 ssh config 别名时一律拒绝，绝不放行。
   */
  async function requireTrusted(name) {
    const server = conn(name);
    const gate = await d.guardHostKey(server);
    if (!gate?.ok) {
      const msg = gate?.error?.message ?? '主机指纹未通过校验，拒绝连接';
      throw new Error(msg);
    }
    return server;
  }

  /** 终态前回查磁盘状态仍属本任务且未被取消（防旧任务覆盖，§6.2）。 */
  async function finalStateOk(dir, id) {
    const s = await readState(dir);
    return Boolean(s && s.taskId === id && s.status !== 'cancelled');
  }

  /**
   * v0.1.13 统一状态源（§6.3）：progressReporter 在写内存指针的同时原子写回磁盘；
   * 磁盘 transfer-state.json 是唯一真相源，内存 task 降级为指针/缓存。
   */
  function progressReporter(kind, taskId) {
    return (p) => {
      if (task) task.phase = p;
      onProgress?.({ kind, ...p });
      if (stateDir && taskId) {
        const percent = typeof p?.percent === 'number' ? p.percent : undefined;
        const patch = {
          phase: p?.phase ?? null,
          ...(percent === undefined ? {} : { percent }),
          phaseMessage: p?.message ?? '',
          ...(Array.isArray(p?.chunks) ? { chunks: p.chunks, downloadedBytes: p.downloadedBytes ?? 0 } : {}),
        };
        void patchState(stateDir, taskId, patch).catch(() => {});
      }
    };
  }

  /**
   * v0.1.13 P0 互斥 + 生命周期（§17.1 / §6.1）：所有备份/恢复执行入口统一经过此处。
   * 检查与锁获取原子化；终态由后端确认后写入；任何退出路径都释放锁（校验 taskId）。
   */
  async function runGuarded(kind, name, fn) {
    if (!stateDir) {
      // 未注入 stateDir（旧调用/纯单测）：不启用磁盘状态与锁，但保留内存 task 以兼容 status()。
      task = { kind, server: name, running: true, startedAt: Date.now(), phase: null, result: null };
      try {
        const result = await fn(progressReporter(kind, null));
        task.running = false;
        task.result = result;
        return result;
      } catch (err) {
        task.running = false;
        task.error = err.message;
        throw err;
      }
    }
    const lock = await acquireLock(stateDir, name, { taskId: 'pending', kind, status: 'running' });
    if (!lock.ok) throw new Error(lock.reason);
    const state = createState({
      backupId: name,
      kind,
      backupDirectory: stateDir ?? config.localBackupDir,
      taskDir: stateDir,
    });
    // 用真实 taskId 重写锁记录（创建时占位）
    await releaseLock(stateDir, name, 'pending');
    const lock2 = await acquireLock(stateDir, name, { taskId: state.taskId, kind, status: 'running' });
    if (!lock2.ok) throw new Error(lock2.reason);
    state.status = 'running';
    await writeState(stateDir, state);
    task = { kind, server: name, running: true, startedAt: Date.now(), phase: null, result: null, taskId: state.taskId };
    try {
      const result = await fn(progressReporter(kind, state.taskId));
      // completed 硬约束（§6.1）：只有后端执行成功（result.ok===true）才置位。
      // 规格原要求 integrity 六项证据；现有 runBackup 的 result.ok 即后端成功确认，
      // 分片/加密证据由后续 T4 的 chunk-transfer 写入 integrity 后再收紧（最小调整，记录原因）。
      const stillOurs = await finalStateOk(stateDir, state.taskId);
      const completed = result?.ok === true && stillOurs;
      await patchState(stateDir, state.taskId, {
        status: completed ? 'completed' : 'failed',
        percent: completed ? 100 : (await readState(stateDir))?.percent ?? 0,
        ...(completed ? {} : { error: '任务结束但未满足 completed 条件' }),
      });
      task.running = false;
      task.result = result;
      return result;
    } catch (err) {
      await patchState(stateDir, state.taskId, { status: 'failed', error: String(err?.message ?? err) }).catch(() => {});
      task.running = false;
      task.error = err.message;
      throw err;
    } finally {
      await releaseLock(stateDir, name, state.taskId).catch(() => {});
    }
  }

  return {
    attachCredentials,
    async test(name) {
      const server = await requireTrusted(name);
      return d.testConnection(server);
    },

    async discover(name) {
      const server = await requireTrusted(name);
      return d.discover(server);
    },

    async backup(name) {
      // R10 fail-closed：在指纹闸门与任何远端发现之前先校验口令，
      // 让 UI / Agent 都拿到明确可操作的错误，且绝不触达远端。
      // v0.1.11：口令来自官方 Credentials 服务（动态 resolve，不缓存）。
      const passphrase = await requirePassphrase('备份');
      const server = await requireTrusted(name);
      const found = await d.discover(server);
      if (!found?.instances?.length) {
        throw new Error('未发现 Odoo 实例，无法备份');
      }
      const instance = found.instances[0];
      return runGuarded('backup', name, async (report) => d.runBackup({
        server,
        instance,
        localDir: stateDir ?? config.localBackupDir,
        passphrase,
        onProgress: report,
      }));
    },

    async restore(name, _unused, packagePath, opts = {}) {
      const server = await requireTrusted(name);
      if (!packagePath) throw new Error('缺少 packagePath 参数');

      // 备份包必须真实存在
      try {
        await d.stat(packagePath);
      } catch {
        throw new Error(`备份包不存在：${packagePath}`);
      }

      // 加密策略：未加密包默认拒绝，除非配置/调用方显式允许
      const format = await d.detectFormat(packagePath);
      const allowedPlain = allowUnencrypted ?? config.allowUnencryptedPackage ?? false;
      if (format === 'plain' && !allowedPlain) {
        throw new Error(
          '备份包未加密。默认拒绝恢复未加密包；若确认来源可信，请显式开启 allowUnencryptedPackage。',
        );
      }

      const found = await d.discover(server);
      if (!found?.instances?.length) {
        throw new Error('未发现 Odoo 实例，无法恢复');
      }
      const instance = found.instances[0];

      // v0.1.11（用户修正 2）：恢复统一使用 Credentials 凭证，调用方传值不再静默覆盖。
      const passphrase = await requirePassphrase('恢复');
      return runGuarded('restore', name, async (report) => d.runRestore({
        server,
        instance,
        packagePath,
        options: {
          passphrase,
          allowUnencrypted: allowedPlain,
          baseline: opts.baseline,
        },
        onProgress: report,
      }));
    },

    async fingerprint(name) {
      // 只读扫描：不经过 requireTrusted（连接类操作才需要已确认指纹）。
      const server = conn(name);
      return d.scanHostKey(server);
    },

    async pin(name, expectedFingerprint) {
      const fp = String(expectedFingerprint ?? '').trim();
      if (!fp) throw new Error('缺少待固化的指纹：请先扫描并人工核对');
      const server = conn(name);
      return d.pinHostKey(server, fp);
    },

    async status() {
      // v0.1.13 §6.3：以磁盘 transfer-state.json 为准；无 stateDir 时回退内存指针（兼容旧路径）。
      const disk = stateDir ? await readState(stateDir) : null;
      const activeTaskId = task?.taskId ?? null;
      const src = disk ?? task;
      return {
        running: disk ? disk.status === 'running' : Boolean(task?.running),
        taskId: disk?.taskId ?? activeTaskId,
        kind: disk?.kind ?? task?.kind ?? null,
        status: disk?.status ?? (task?.running ? 'running' : null),
        phase: disk?.phase ?? task?.phase ?? null,
        percent: disk?.percent ?? null,
        phaseMessage: disk?.phaseMessage ?? '',
        updatedAt: disk?.updatedAt ?? null,
        // 兼容旧 UI 字段
        lastTask: src
          ? {
            kind: src.kind ?? task?.kind ?? null,
            server: src.serverConfigId ?? task?.server ?? null,
            running: disk ? disk.status === 'running' : Boolean(task?.running),
            startedAt: src.createdAt ?? task?.startedAt ?? null,
            phase: disk?.phase ?? task?.phase ?? null,
            error: src.error ?? task?.error ?? null,
            ok: src.result?.ok ?? (src.status === 'completed' ? true : null),
          }
          : null,
      };
    },
  };
}
