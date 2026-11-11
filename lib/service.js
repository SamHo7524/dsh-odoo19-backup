import { stat } from 'node:fs/promises';
import { testConnection, guardHostKey } from './ssh.js';
import { discover as discoverInstance } from './discover.js';
import { runBackup } from './backup.js';
import { runRestore } from './restore.js';
import { detectFormat } from './crypto.js';
import { scanHostKey, pinHostKey } from './knownhosts.js';
import { serverConnection } from './tools.js';
import { normalizeRestorePath } from './restore-path.js';
import { readPackageMeta } from './package-meta.js';
import { explainFailure } from './diagnose.js';
import { versionGate, sourceVersionOf } from './version-gate.js';
import { createState, writeState, readState, patchState, canComplete, serverStateDir, readStateCompat } from './task-state.js';
import { acquireLock, releaseLock, readLock } from './server-lock.js';
import { serverIdOf } from './server-id.js';
import { execRemote } from './ssh.js';
import { buildStatusScript, parseStatus, buildApplyScript, parseApplyResult } from './neutralize.js';
import { guardDbName } from './dbguard.js';

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
    readPackageMeta,
    credentials: undefined,
    execRemote,
    ...deps,
  };

  // v0.1.21：deps 上的 getter 必须在展开后原样装回。
  // `{...deps}` 会**当场求值** getter，把「活引用」变成快照——index.js 正是用
  // `get credentials() { return credsRef.current; }` 延迟透传凭证服务的，一旦快照，
  // ctx.inject(['credentials']) 之后注入的服务就读不到（Agent 工具路径直接报「凭证服务不可用」）。
  for (const key of Object.keys(deps)) {
    const desc = Object.getOwnPropertyDescriptor(deps, key);
    if (desc && (desc.get || desc.set)) {
      Object.defineProperty(d, key, { ...desc, enumerable: true, configurable: true });
    }
  }

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

  /**
   * v0.1.17：读备份包 MANIFEST 里的源 Odoo 版本。
   * 读不到就返回空串 —— 由 versionGate 按 fail-closed 拒绝，绝不猜。
   */
  async function resolvePackageSourceVersion(pkg, passphrase) {
    try {
      const meta = await d.readPackageMeta(pkg, {}, { passphrase });
      return meta?.ok ? sourceVersionOf(meta) : '';
    } catch {
      return '';
    }
  }

  /**
   * v0.1.14：恢复目标域名。配置项是 volatile 活引用，读取时解包；
   * 空/未配置 → undefined（由 restore 侧按服务器名自动推断）。
   */
  function resolveWebsiteDomain() {
    const raw = config?.restoreDomain;
    const value = raw !== null && typeof raw === 'object' && typeof raw.get === 'function'
      ? raw.get()
      : raw;
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
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
   * v0.1.17：服务器的状态目录与锁键。锁键改用稳定 serverConfigId（规格 §5.1），
   * 服务器显示名改名后任务归属与互斥不受影响；状态文件写入
   * `<stateDir>/<serverId>/transfer-state.json`（按服务器隔离）。
   */
  function serverKeys(name) {
    const server = findServer(name);
    const id = serverIdOf(server);
    return { server, id, dir: stateDir ? serverStateDir(stateDir, id) : null };
  }

  /**
   * v0.1.13 统一状态源（§6.3）：progressReporter 在写内存指针的同时原子写回磁盘；
   * 磁盘 transfer-state.json 是唯一真相源，内存 task 降级为指针/缓存。
   * v0.1.17：磁盘写入落到该服务器自己的隔离目录。
   */
  function progressReporter(kind, taskId, serverDir) {
    return (p) => {
      if (task) task.phase = p;
      onProgress?.({ kind, ...p });
      if (serverDir && taskId) {
        const percent = typeof p?.percent === 'number' ? p.percent : undefined;
        const patch = {
          phase: p?.phase ?? null,
          ...(percent === undefined ? {} : { percent }),
          phaseMessage: p?.message ?? '',
          ...(Array.isArray(p?.chunks) ? { chunks: p.chunks, downloadedBytes: p.downloadedBytes ?? 0 } : {}),
        };
        void patchState(serverDir, taskId, patch).catch(() => {});
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
        const result = await fn(progressReporter(kind, null, null));
        task.running = false;
        task.result = result;
        return result;
      } catch (err) {
        task.running = false;
        const rawMessage = String(err?.message ?? err);
        const explained = explainFailure(rawMessage, { where: kind === 'backup' ? '备份' : '恢复' });
        task.error = explained;
        if (explained !== rawMessage) {
          const e = new Error(explained);
          e.cause = err;
          throw e;
        }
        throw err;
      }
    }
    // v0.1.17：锁键与状态目录均用稳定 serverConfigId（§5.1），显示名改名不影响归属。
    const { id, dir } = serverKeys(name);
    const lock = await acquireLock(stateDir, id, { taskId: 'pending', kind, status: 'running' });
    if (!lock.ok) throw new Error(lock.reason);
    const state = createState({
      backupId: name,
      kind,
      backupDirectory: stateDir ?? config.localBackupDir,
      taskDir: dir,
      extra: { serverConfigId: id },
    });
    // 用真实 taskId 重写锁记录（创建时占位）
    await releaseLock(stateDir, id, 'pending');
    const lock2 = await acquireLock(stateDir, id, { taskId: state.taskId, kind, status: 'running' });
    if (!lock2.ok) throw new Error(lock2.reason);
    state.status = 'running';
    await writeState(dir, state);
    task = { kind, server: name, running: true, startedAt: Date.now(), phase: null, result: null, taskId: state.taskId };
    try {
      const result = await fn(progressReporter(kind, state.taskId, dir));
      // completed 硬约束（§6.1）：只有后端执行成功（result.ok===true）才置位。
      // 规格原要求 integrity 六项证据；现有 runBackup 的 result.ok 即后端成功确认，
      // 分片/加密证据由后续 T4 的 chunk-transfer 写入 integrity 后再收紧（最小调整，记录原因）。
      const stillOurs = await finalStateOk(dir, state.taskId);
      const completed = result?.ok === true && stillOurs;
      await patchState(dir, state.taskId, {
        status: completed ? 'completed' : 'failed',
        percent: completed ? 100 : (await readState(dir))?.percent ?? 0,
        ...(completed ? {} : { error: '任务结束但未满足 completed 条件' }),
      });
      task.running = false;
      task.result = result;
      return result;
    } catch (err) {
      // v0.1.17：失败必须先给提示再失败（原始错误 + 诊断 + 建议），绝不只甩黑盒错误。
      const rawMessage = String(err?.message ?? err);
      const explainedText = explainFailure(rawMessage, { where: kind === 'backup' ? '备份' : '恢复' });
      await patchState(dir, state.taskId, { status: 'failed', error: explainedText }).catch(() => {});
      task.running = false;
      task.error = explainedText;
      if (explainedText !== rawMessage) {
        const e = new Error(explainedText);
        e.cause = err;
        throw e;
      }
      throw err;
    } finally {
      await releaseLock(stateDir, id, state.taskId).catch(() => {});
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

    /**
     * 恢复预检用：源库名（备份包）与目标库名（目标机）分开返回。
     * 源库名只说明备份来自哪里，绝不作为覆盖目标。
     */
    async inspectRestore(name, packagePath) {
      const server = await requireTrusted(name);
      const found = await d.discover(server);
      const inst = found?.instances?.[0] ?? null;
      const discovery = inst?.dbNameDiscovery ?? null;
      const targetDbName = discovery?.ok ? discovery.dbName : (inst?.dbName || null);
      let targetReason = null;
      if (!inst) {
        targetReason = '未发现 Odoo 实例，无法确定目标数据库';
      } else if (!discovery?.ok) {
        targetReason = discovery?.reason === 'ambiguous'
          ? `有多个候选库（${(discovery.candidates ?? []).join('、')}），请手工填写数据库名`
          : '未能从 dbfilter、db_name 或数据库列表确定唯一目标库，请手工填写数据库名';
      }

      let sourceDbName = null;
      let sourceReason = null;
      let sourceVersion = '';
      try {
        const passphrase = await requirePassphrase('读取备份元数据');
        const meta = await d.readPackageMeta(packagePath, {}, { passphrase });
        if (meta?.ok && meta.sourceDbName) sourceDbName = meta.sourceDbName;
        else sourceReason = meta?.reason ?? '无法读取备份元数据';
        sourceVersion = sourceVersionOf(meta);
      } catch (err) {
        sourceReason = err?.message ?? String(err);
      }

      // v0.1.17：版本闸门（预检阶段就给结论，绝不等到 load 才炸）
      const targetVersion = inst?.odooVersion ?? '';
      const gate = versionGate({ sourceVersion, targetVersion });

      return {
        sourceDbName,
        sourceReason,
        targetDbName: targetDbName || null,
        targetReason,
        conflict: sourceDbName && targetDbName && sourceDbName === targetDbName ? 'same-name' : null,
        sourceVersion,
        targetVersion,
        versionGate: gate,
        discovery,
      };
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
      const pkg = normalizeRestorePath(packagePath);
      if (!pkg) throw new Error('缺少 packagePath 参数');

      // 备份包必须真实存在（路径已规范化：去首尾空白与一对双引号，Windows 斜杠统一）
      try {
        await d.stat(pkg);
      } catch {
        throw new Error(`备份包不存在：${pkg}`);
      }

      // 加密策略：未加密包默认拒绝，除非配置/调用方显式允许
      const format = await d.detectFormat(pkg);
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

      // v0.1.17 版本闸门：在任何远端写操作之前拒绝跨大版本恢复。
      // 实证故障：19 备份 → 20 目标机，跑到 odoo db load -n 才崩在 Odoo 20 的 neutralize SQL。
      const sourceVersion = await resolvePackageSourceVersion(pkg, passphrase);
      const gate = versionGate({ sourceVersion, targetVersion: instance.odooVersion ?? '' });
      if (!gate.ok) {
        throw new Error(gate.message);
      }

      return runGuarded('restore', name, async (report) => d.runRestore({
        server,
        instance,
        packagePath: pkg,
        options: {
          passphrase,
          allowUnencrypted: allowedPlain,
          baseline: opts.baseline,
          websiteDomain: opts.websiteDomain ?? resolveWebsiteDomain(),
          // v0.1.14：默认开启；仅当调用方显式传 false 才保留备份原密钥。
          rotateSecret: opts.rotateSecret !== false,
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

    async status(serverName) {
      // v0.1.13 §6.3：以磁盘 transfer-state.json 为准；无 stateDir 时回退内存指针（兼容旧路径）。
      // v0.1.17：状态按服务器隔离（<stateDir>/<serverId>/transfer-state.json）。
      //   - 带 serverName：读该服务器目录（旧全局文件只作同归属兼容来源）；
      //   - 不带 serverName：优先跟随内存活动任务的服务器；否则扫所有服务器
      //     目录 + 旧全局文件，取 updatedAt 最新的**活动**状态（running/paused）。
      let disk = null;
      let serverId = null;
      if (stateDir) {
        if (serverName) {
          const k = serverKeys(serverName);
          serverId = k.id;
          disk = await readStateCompat(stateDir, serverId);
        } else if (task?.server) {
          try {
            const k = serverKeys(task.server);
            serverId = k.id;
            disk = await readStateCompat(stateDir, serverId);
          } catch { /* 配置里已删除该服务器：走扫描兜底 */ }
        }
        if (!disk) {
          const ids = new Set((config?.servers ?? []).map((s) => serverIdOf(s)));
          const candidates = [...ids].map((id) => serverStateDir(stateDir, id));
          candidates.push(stateDir); // 旧全局文件（迁移兼容来源）
          let bestActive = null;
          let bestTerminal = null;
          for (const d of candidates) {
            const s = await readState(d);
            if (!s || !s.status) continue;
            if (d === stateDir && s.serverConfigId && !ids.has(s.serverConfigId)) continue;
            const active = ['running', 'paused'].includes(s.status);
            if (active) {
              if (!bestActive || String(s.updatedAt ?? '') > String(bestActive.updatedAt ?? '')) bestActive = s;
            } else if (!bestTerminal || String(s.updatedAt ?? '') > String(bestTerminal.updatedAt ?? '')) {
              bestTerminal = s;
            }
          }
          // 活动任务优先（避免刚完成的旧终态盖住正在跑的任务）；
          // 无活动任务时回落到最近一次终态 —— 规格 §6.1 要求刷新后 UI
          // 仍能从磁盘恢复 completed/failed/cancelled，不回退成「无任务」。
          disk = bestActive ?? bestTerminal;
        }
      }
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
        server: serverName ?? task?.server ?? disk?.serverConfigId ?? null,
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

    /**
     * v0.1.14 收尾：查询目标库的中立化状态（只读）。
     * 只对 instance.dbName 指向的单一目标库执行，绝不跨库。
     */
    async neutralizeStatus(name) {
      const server = await requireTrusted(name);
      const found = await d.discover(server);
      const inst = found?.instances?.[0] ?? null;
      if (!inst) throw new Error('未发现 Odoo 实例，无法查询中立化状态');
      const dbName = guardDbName(inst.dbName);
      const r = await d.execRemote(server, buildStatusScript(), {
        stdin: [inst.pgContainer, inst.pgSuperUser, dbName].join('\n') + '\n',
        timeoutMs: 120000,
      });
      const parsed = parseStatus(r?.stdout ?? '');
      return { ...parsed, dbName };
    },

    /**
     * v0.1.14 收尾：保持 / 解除中立化。
     *
     * - keep：不写库、不触达远端（仅返回说明），无需 confirmToken。
     * - release：破坏性且不可逆（会启用 cron、恢复邮件服务器、清未发邮件、
     *   可选启用支付）。必须已过调用方 confirmToken 闸门。
     *   支付提供商默认全部保持 disabled —— 只有显式 enablePaymentCodes 才启用，绝不猜。
     */
    async applyNeutralize(name, action, opts = {}) {
      if (action !== 'keep' && action !== 'release') {
        throw new Error(`action 必须是 keep 或 release，收到：${String(action)}`);
      }
      if (action === 'keep') {
        return {
          ok: true,
          applied: false,
          action: 'keep',
          reason: '已保持中立化，未对目标数据库做任何改动。',
        };
      }

      const server = await requireTrusted(name);
      const found = await d.discover(server);
      const inst = found?.instances?.[0] ?? null;
      if (!inst) throw new Error('未发现 Odoo 实例，无法解除中立化');
      const dbName = guardDbName(inst.dbName);

      const script = buildApplyScript({ enablePaymentCodes: opts.enablePaymentCodes });
      const r = await d.execRemote(server, script, {
        stdin: [inst.pgContainer, inst.pgSuperUser, dbName, inst.odooContainer].join('\n') + '\n',
        timeoutMs: 600000,
      });
      const parsed = parseApplyResult(r?.stdout ?? '');
      return { ...parsed, action: 'release', dbName };
    },
  };
}
