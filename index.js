import z from '@deepseek-ai/schemastery';
import { readFile } from 'node:fs/promises';
import { createTokenStore, NEUTRALIZE_BOUND_KEYS } from './lib/tokens.js';
import { readState, patchState, serverStateDir, readStateCompat } from './lib/task-state.js';
import { readLock, inspectLock, confirmStaleLock, releaseLock } from './lib/server-lock.js';
import { serverIdOf } from './lib/server-id.js';
import { resolveBackupDirectory, validateDirectory, DEFAULT_BACKUP_DIRECTORY } from './lib/backup-directory.js';
import { createService } from './lib/service.js';
import { normalizeRestorePath } from './lib/restore-path.js';
import { resolveLastBackup } from './lib/completed-package.js';
import { isHostname } from './lib/site-domain.js';
import { createOdooBackupTool, createOdooRestoreTool } from './lib/tools.js';
import { unwrapVolatile } from './lib/config-value.js';
import { scanHostKey, pinHostKey } from './lib/knownhosts.js';
import {
  normalizeFp, verifyFingerprint, confirmTrust, applyTrust,
  publicKeyPathOf, validatePublicKey, fingerprintCommand, authorizedKeysCommand,
} from './lib/trust.js';

export const name = 'odoo-backup';
export const inject = ['tools'];
// webServer/settings/credentials 在 apply 内用 ctx.inject([...]) 按需注入
// （UI 路由需要全部三个；credentials 用于备份加密口令的官方存储）。

/**
 * 插件配置 schema。schemastery 会填充默认值，DSH 设置页据此自动渲染表单，
 * 因此「参数在插件界面设置」由框架满足，无需自写配置 UI。
 */
export const Config = z.object({
  servers: z
    .array(
      z.object({
        name: z.string().required().description('服务器唯一名称'),
        host: z.string().description('主机地址；留空则用 sshConfigAlias'),
        port: z.number().default(22).description('SSH 端口'),
        user: z.string().default('root').description('SSH 用户名'),
        keyPath: z.string().description('私钥路径；留空则用 Agent 或 ssh config'),
        sshConfigAlias: z.string().description('~/.ssh/config 中的别名'),
        pinnedFingerprint: z
          .string()
          .description('已确认的主机指纹（SHA256:...）；留空则连接前必须先执行 fingerprint 确认'),
        odooContainer: z.string().description('Odoo 容器名；留空则自动扫描'),
        pgContainer: z.string().description('PostgreSQL 容器名'),
        dbName: z.string().description('数据库名；留空则从 dbfilter 解析'),
        dbPort: z.number().default(5432).description('数据库端口'),
        dataPath: z.string().description('宿主机上的 odoo data 目录（filestore 父目录）'),
        addonsPath: z.string().description('宿主机上的 addons 目录'),
      }),
    )
    .default([])
    .description('服务器列表')
    // 运行时可写标记：DSH 的 settings.update 只允许写 volatile 路径
    // （dsh-settings write()：volatileForm(schema) 为空 → "has no volatile fields"）。
    // 与 dsh-connect-workbuddy 的 asVolatile() 一致；读回时 volatile 值是
    // { get() } 活引用，必须 unwrap 后再读（见下方 unwrapVolatile）。
    .volatile(),
  localBackupDir: z.string().default('K:/Backup/odoo').description('本机备份目录（兼容旧配置，v0.1.13 起以 backupDirectory 为准）'),
  backupDirectory: z.string().default('K:/Backup/odoo')
    .description('本机备份根目录（v0.1.13：分片/Manifest/任务状态/锁统一归属；只影响新建任务）')
    .volatile(),
  keepDays: z.number().default(30).description('本地备份保留天数'),
  passphrase: z
    .string()
    .default('')
    .description('备份加密口令（aes-256-gcm）。必填：未配置时备份将被拒绝（R10 强制加密，不生成明文包）'),
  sshTimeoutMs: z.number().default(30000).description('SSH 连接超时（毫秒）'),
  transferTimeoutMs: z.number().default(3600000).description('传输超时（毫秒）'),
  allowUnencryptedPackage: z
    .boolean()
    .default(false)
    .description('允许恢复未加密的旧版备份包（不推荐；每次恢复仍需显式确认）'),
  restoreDomain: z
    .string()
    .default('')
    .description('恢复后使用的站点域名；留空=自动使用服务器名（仅当其为主机名）')
    .volatile(),
});

/**
 * volatile 字段解析为 { get(): T } 活引用；读取时解包为普通值。
 * v0.1.15：实现移到 lib/config-value.js，供工具层（lib/tools.js）共用，
 * 这里 re-export 保持既有调用点与测试口径不变。
 */
export { unwrapVolatile };

export function apply(ctx, config) {
  // volatile 的 servers 字段是活引用：保证读到的是最新值（settings.update 写入后立即生效）。
  const serversRef = { get current() { return unwrapVolatile(config.servers) ?? []; } };
  ctx.logger?.info?.(
    'odoo-backup: %d server(s), local dir %s',
    serversRef.current.length,
    config.localBackupDir,
  );

  // v0.1.11：官方凭证服务（备份加密口令）。service 创建在 web inject 之外，
  // 因此 credentials 必须独立 inject 后经 refs 透传给 service（CRED-15）。
  const credsRef = { current: undefined };
  ctx.inject(['credentials'], (cctx) => { credsRef.current = cctx.credentials; });

  // 一个操作，两个调用者：service 是唯一实现，工具与 UI 都走它。
  // 显式注入 scanHostKey / pinHostKey：让 fingerprint / pin 与既有操作共用同一
  // service，测试也能通过 deps 覆盖，不引入第二套逻辑。
  // credentials 用 getter 透传：inject 完成后 requirePassphrase 动态拿到服务。
  const service = createService({
    config: { ...config, get servers() { return serversRef.current; } },
    stateDir: stateDirOf(config),
    deps: {
      scanHostKey,
      pinHostKey,
      get credentials() { return credsRef.current; },
    },
  });
  const tokenStore = createTokenStore();
  // v0.1.14 收尾：解除中立化用独立绑定维度（server + action + dbName），与恢复 token 互不串用。
  const neutralizeTokenStore = createTokenStore({ boundKeys: NEUTRALIZE_BOUND_KEYS });

  const backupTool = createOdooBackupTool({ config, service });
  const restoreTool = createOdooRestoreTool({ config, service, tokenStore });

  // 注册 Agent 工具；返回的 disposer 交给 ctx.effect 管理生命周期。
  ctx.effect(() => ctx.tools.register(backupTool), 'odoo-backup: odoo_backup tool');
  ctx.effect(() => ctx.tools.register(restoreTool), 'odoo-backup: odoo_restore tool');

  // UI 数据面：设置页的服务器列表/备份/恢复按钮调用这些路由。
  ctx.inject(['webServer', 'settings', 'credentials'], (webCtx) => {
    webCtx.effect(
      () => webCtx.webServer.register({
        kind: 'prefix',
        path: '/odoo-backup',
        handler: (req, res) => handleUiRequest({
          req, res, config, service, tokenStore, neutralizeTokenStore,
          // Host 侧的官方设置服务：写入 profile patch，volatile 字段运行时可写。
          settings: webCtx.settings,
          // Host 侧的官方凭证服务：备份加密口令只存 Credentials（v0.1.11）。
          credentials: webCtx.credentials,
          entryId: 'odoo-backup',
          readPublicKey: (p) => readFile(p, 'utf8'),
        }),
      }),
      'odoo-backup: settings UI routes',
    );
  });
}

/**
 * 设置页 UI 的最小 JSON 接口。
 * 与 Agent 工具共用同一 service 与 tokenStore，因此授权语义完全一致。
 *
 * 安全边界说明：该路由不是鉴权边界——它只服务同源设置页。
 * 因此：
 *  - 只接受同源请求（校验 Origin/Referer 与 Host 一致），阻断外部直接调用
 *  - 破坏性恢复仍需 confirmToken（绑定目标 + 5 分钟 + 一次性）
 *  - 真正的授权由 Agent 工具链与用户确认承担
 */
/** v0.1.13：统一状态源根目录（transfer-state.json / server-lock.json 同处，§6.3 / §17.1）。 */
function stateDirOf(config) {
  return unwrapVolatile(config?.backupDirectory) ?? unwrapVolatile(config?.localBackupDir) ?? DEFAULT_BACKUP_DIRECTORY;
}

/**
 * v0.1.17：服务器的稳定锁键与隔离状态目录。
 * 锁键从「可改名的 server.name」升级为 serverConfigId 摘要（规格 §5.1）；
 * 状态文件写 `<stateDir>/<serverId>/transfer-state.json`。
 * 返回 null 表示配置里找不到该服务器（调用方按缺参处理）。
 */
function serverKeyOf(config, name) {
  const list = unwrapVolatile(config?.servers) ?? [];
  const server = (Array.isArray(list) ? list : []).find((s) => s?.name === name);
  if (!server) return null;
  const id = serverIdOf(server);
  return { id, dir: serverStateDir(stateDirOf(config), id) };
}

/** /task-lock 的默认服务器标识必须与 service 的锁键（server.name）一致；servers 是 volatile 活引用。 */
function defaultServerId(config) {
  const list = unwrapVolatile(config?.servers) ?? [];
  return Array.isArray(list) && list[0]?.name ? list[0].name : null;
}

/** 恢复目标域名：空值合法（= 自动用服务器名），非空必须是主机名。 */
function isValidRestoreDomain(value) {
  const v = String(value ?? '').trim();
  if (!v) return true;
  return isHostname(v);
}

async function handleUiRequest({ req, res, config, service, tokenStore, neutralizeTokenStore, settings, entryId, readPublicKey, credentials }) {
  const send = (status, body) => {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(body));
  };

  // 同源校验：浏览器同源 fetch 会带 Origin；缺失或不匹配一律拒绝。
  const host = req.headers?.host;
  const origin = req.headers?.origin;
  const referer = req.headers?.referer;
  const sameOrigin = (() => {
    if (origin) {
      try { return new URL(origin).host === host; } catch { return false; }
    }
    if (referer) {
      try { return new URL(referer).host === host; } catch { return false; }
    }
    // 无 Origin/Referer：只允许本机回环地址（供本机 curl 调试），其余拒绝。
    const remote = req.socket?.remoteAddress ?? '';
    return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  })();
  if (!sameOrigin) {
    return send(403, { ok: false, error: '仅允许同源设置页访问' });
  }

  let body = {};
  if (req.method === 'POST') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    try {
      body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    } catch {
      return send(400, { ok: false, error: '请求体不是合法 JSON' });
    }
  }

  const url = new URL(req.url ?? '/', 'http://localhost');
  const route = url.pathname.replace(/^\/odoo-backup/, '') || '/';

  /**
   * 自动识别成功且该服务器还没手工填库名时，把目标库名写回配置。
   * 只接受发现结果里的目标库名；调用方不得把备份包源库名传进来。
   */
  async function persistAutoDbName(serverName, discovery) {
    if (!settings || !discovery?.ok || !discovery.dbName) return null;
    if (discovery.source === 'config' || discovery.confidence === 'explicit') return null;
    const list = unwrapVolatile(config.servers) ?? [];
    const current = list.find((s) => s.name === serverName);
    if (!current || String(current.dbName ?? '').trim()) return null;
    const next = list.map((s) => (
      s.name === serverName ? { ...s, dbName: discovery.dbName } : s
    ));
    await settings.update(entryId, { servers: next });
    return discovery.dbName;
  }

  try {
    if (route === '/passphrase-status') {
      // 只回状态，绝不回口令值（CRED-8）。
      if (!credentials || typeof credentials.describe !== 'function') {
        throw new Error('凭证服务不可用（ctx.credentials 未注入）');
      }
      const info = await credentials.describe('ODOO_BACKUP_PASSPHRASE');
      return send(200, { ok: true, configured: Boolean(info?.configured), source: info?.source ?? null });
    }
    if (route === '/set-passphrase') {
      // 转调官方凭证服务；空值直接拒绝；成功后不回显口令（CRED-9）。
      if (!credentials || typeof credentials.set !== 'function') {
        throw new Error('凭证服务不可用（ctx.credentials 未注入）');
      }
      const value = typeof body.passphrase === 'string' ? body.passphrase : '';
      if (value.length === 0) throw new Error('口令不能为空；如需移除请使用清除口令');
      await credentials.set('ODOO_BACKUP_PASSPHRASE', value);
      return send(200, { ok: true, configured: true });
    }
    if (route === '/unset-passphrase') {
      if (!credentials || typeof credentials.unset !== 'function') {
        throw new Error('凭证服务不可用（ctx.credentials 未注入）');
      }
      await credentials.unset('ODOO_BACKUP_PASSPHRASE');
      const info = credentials.describe ? await credentials.describe('ODOO_BACKUP_PASSPHRASE') : null;
      return send(200, { ok: true, configured: Boolean(info?.configured) });
    }
    if (route === '/save-servers') {
      // 保存服务器列表：走 Host 官方 settings 服务，前端无需猜 configForms namespace。
      // volatile 标记 + settings.update 组合保证写入真正落盘（profile patch）且
      // 运行中的 config（活引用）立即读到新值 —— 无需也不应手工改 config.servers。
      const servers = Array.isArray(body.servers) ? body.servers : null;
      if (!servers) throw new Error('缺少 servers 数组');
      for (const s of servers) {
        if (!s || typeof s.name !== 'string' || !s.name.trim()) {
          throw new Error('每个服务器都需要非空 name');
        }
      }
      if (!settings || typeof settings.update !== 'function') {
        throw new Error('Host 设置服务不可用，无法保存配置');
      }
      await settings.update(entryId, { servers });
      return send(200, { ok: true, servers });
    }
    if (route === '/servers') {
      // 增量返回信任相关字段，供 UI 分别显示「主机身份」与「登录认证」状态。
      // 只回传公钥路径/指纹（非秘密），绝不回传私钥内容。
      return send(200, {
        ok: true,
        servers: (unwrapVolatile(config.servers) ?? []).map((s) => ({
          name: s.name, host: s.host, port: s.port ?? 22, user: s.user ?? 'root',
          keyPath: s.keyPath ?? '', sshConfigAlias: s.sshConfigAlias ?? '',
          pinnedFingerprint: s.pinnedFingerprint ?? '',
        })),
      });
    }
    if (route === '/client-pubkey') {
      // 只读取 .pub 公钥文件；绝不读取、返回或记录私钥内容。
      const kp = String(body.keyPath ?? '').trim();
      if (!kp) throw new Error('未配置 keyPath（本地私钥路径），无法读取对应公钥；请先在信任面板上方的「本机私钥路径」输入框填写路径，无需退出面板到别处编辑。');
      const pubPath = publicKeyPathOf(kp);
      const reader = readPublicKey ?? ((p) => readFile(p, 'utf8'));
      const text = String(await reader(pubPath) ?? '').trim();
      const v = validatePublicKey(text);
      if (!v.ok) throw new Error(`公钥文件无效：${v.reason}（路径 ${pubPath}）`);
      return send(200, { ok: true, publicKey: text, path: pubPath });
    }
    if (route === '/trust-host') {
      // 主机信任确认：重新扫描 → 三方核对身份 → 比对回传指纹与类型 →
      // 一致才只更新 pinnedFingerprint（不覆盖 keyPath / 其他服务器配置）。
      if (!body.server) throw new Error('缺少 server 参数');
      const current = (unwrapVolatile(config.servers) ?? []).find((s) => s.name === body.server);
      if (!current) throw new Error(`未找到服务器: ${body.server}`);
      const rawScan = await service.fingerprint(body.server);
      const scan = { ...rawScan, user: current.user ?? 'root' };
      if (!scan.ok) throw new Error(`扫描失败：${scan.error?.message ?? '未取得主机公钥'}`);
      const verdict = confirmTrust({
        server: current, scan,
        answerFp: body.answerFingerprint, answerType: body.answerType,
        answerFromScanResult: false,
      });
      if (!verdict.ok) throw new Error(verdict.reason);
      // 额外防线：核对 UI 扫描时记录的期望身份，防止核验后配置被替换。
      if (body.expectedHost && body.expectedHost !== current.host) {
        throw new Error('服务器 host 在核验后被修改，拒绝保存信任（请重新扫描）');
      }
      if (body.expectedPort && Number(body.expectedPort) !== Number(current.port ?? 22)) {
        throw new Error('服务器 port 在核验后被修改，拒绝保存信任（请重新扫描）');
      }
      if (body.expectedUser && body.expectedUser !== (current.user ?? 'root')) {
        throw new Error('服务器 user 在核验后被修改，拒绝保存信任（请重新扫描）');
      }
      const next = (unwrapVolatile(config.servers) ?? []).map((s) =>
        s.name === body.server ? applyTrust(s, `SHA256:${verdict.fingerprint}`) : s);
      await settings.update(entryId, { servers: next });
      return send(200, { ok: true, servers: next });
    }
    if (route === '/fingerprint') {
      if (!body.server) throw new Error('缺少 server 参数');
      return send(200, { ok: true, result: await service.fingerprint(body.server) });
    }
    if (route === '/pin') {
      if (!body.server) throw new Error('缺少 server 参数');
      if (!body.fingerprint) throw new Error('缺少 fingerprint 参数：请先扫描并人工核对');
      return send(200, { ok: true, result: await service.pin(body.server, body.fingerprint) });
    }
    if (route === '/test') {
      return send(200, { ok: true, result: await service.test(body.server) });
    }
    if (route === '/discover') {
      const result = await service.discover(body.server);
      const discovery = result?.instances?.[0]?.dbNameDiscovery ?? null;
      const autoPersistedDbName = await persistAutoDbName(body.server, discovery);
      return send(200, { ok: true, result, autoPersistedDbName });
    }
    if (route === '/backup') {
      // 自愈通道：handler 每次请求都有 webCtx.credentials，补挂给 service
      // （防独立 inject 的时序问题；幂等，CRED-16/17）。
      if (credentials) service.attachCredentials?.(credentials);
      return send(200, { ok: true, result: await service.backup(body.server) });
    }
    if (route === '/status') {
      // v0.1.17：可带 server 参数读取该服务器自己的隔离状态目录；
      // 不带时由 service 决定（内存活动任务 → 扫描活动状态）。
      return send(200, { ok: true, result: await service.status(body.server ?? undefined) });
    }
    if (route === '/restore-domain') {
      // v0.1.14：恢复后使用的站点域名（留空=自动用服务器名）。
      // 只存配置，域名在恢复执行时由 Host 侧读取，绝不由前端请求体直接注入。
      if (req.method === 'POST') {
        const domain = String(body.domain ?? '').trim();
        if (!isValidRestoreDomain(domain)) {
          throw new Error(`域名不合法：${domain}（只接受形如 odoo.example.com 的主机名；留空表示自动使用服务器名）`);
        }
        if (!settings || typeof settings.update !== 'function') {
          throw new Error('Host 设置服务不可用，无法保存恢复目标域名');
        }
        await settings.update(entryId, { restoreDomain: domain });
        return send(200, { ok: true, domain, mode: domain ? 'fixed' : 'auto' });
      }
      const domain = String(unwrapVolatile(config?.restoreDomain) ?? '').trim();
      return send(200, { ok: true, domain, mode: domain ? 'fixed' : 'auto' });
    }
    if (route === '/last-backup') {
      // v0.1.14：回填恢复输入框用的权威最终包路径。
      // 只依据磁盘 completed.json + 文件存在 + 加密格式校验，绝不信任前端传入路径。
      const r = await resolveLastBackup(stateDirOf(config));
      return send(200, r.ok
        ? { ok: true, localPath: r.localPath }
        : { ok: false, reason: r.reason });
    }
    if (route === '/backup-directory') {
      // v0.1.13 §3.1 / §14.1：显示/验证/修改本地备份目录。
      const path = stateDirOf(config);
      if (req.method === 'POST') {
        const next = String(body.path ?? '').trim();
        const check = await validateDirectory(next, { create: true });
        if (!check.ok) return send(400, { ok: false, error: check.reason, ...check });
        if (!settings || typeof settings.update !== 'function') {
          throw new Error('Host 设置服务不可用，无法保存目录配置');
        }
        await settings.update(entryId, { backupDirectory: next });
        return send(200, { ok: true, ...check, saved: true, fullPath: next });
      }
      const check = await validateDirectory(path, { create: false });
      return send(200, { ok: true, path, fullPath: path, ...check });
    }
    if (route === '/task-lock') {
      // v0.1.13 §17.1：服务器级互斥状态（前端按钮禁用的依据，后端锁才是裁决）。
      // 未指定 server 时检查所有已配置服务器：任一处于活动锁即视为 locked。
      // v0.1.17：锁键 = 稳定 serverConfigId（不再用可改名的 server.name）。
      const dir = stateDirOf(config);
      const list = unwrapVolatile(config?.servers) ?? [];
      const targets = body.server
        ? [serverKeyOf(config, body.server)?.id].filter(Boolean)
        : (Array.isArray(list) ? list.map((s) => serverIdOf(s)).filter(Boolean) : []);
      let found = null;
      for (const id of targets) {
        const lock = await readLock(dir, id);
        if (lock && lock.taskId && lock.status !== 'completed') { found = { serverConfigId: id, ...lock }; break; }
      }
      const locked = Boolean(found);
      return send(200, { ok: true, result: { serverConfigId: body.server ?? found?.serverConfigId ?? null, locked, taskId: found?.taskId ?? null, kind: found?.kind ?? null, status: found?.status ?? null } });
    }
    if (route === '/task-cancel') {
      // §9 取消 / §17.1 重启恢复：明确确认后把遗留任务置 cancelled 并释放锁。
      // 只有状态仍属「活动」的任务可取消；终态任务不允许被改成 cancelled。
      // v0.1.17：按 server 参数定位该服务器自己的隔离状态目录与锁。
      if (body.confirm !== true) throw new Error('取消任务需要明确确认（confirm:true）');
      if (!body.server) throw new Error('缺少 server 参数');
      const key = serverKeyOf(config, body.server);
      if (!key) throw new Error(`未找到服务器: ${body.server}`);
      const dir = key.dir;
      const st = await readStateCompat(stateDirOf(config), key.id);
      if (!st) throw new Error('当前无持久化任务状态');
      if (['completed', 'failed', 'cancelled'].includes(st.status)) {
        return send(200, { ok: true, alreadyTerminal: st.status });
      }
      const ok = await patchState(dir, st.taskId, { status: 'cancelled', phaseMessage: '用户已取消' });
      if (!ok) throw new Error('任务状态已变更，取消失败（taskId 不匹配）');
      await releaseLock(stateDirOf(config), key.id, st.taskId).catch(() => {});
      return send(200, { ok: true, status: 'cancelled', taskId: st.taskId });
    }
    if (route === '/task-lock/confirm-stale') {
      const serverConfigId = body.server ?? defaultServerId(config);
      if (!serverConfigId) throw new Error('缺少 server 参数');
      if (body.confirm !== true) throw new Error('缺少明确确认（confirm:true）');
      const key = serverKeyOf(config, serverConfigId);
      if (!key) throw new Error(`未找到服务器: ${serverConfigId}`);
      const r = await confirmStaleLock(stateDirOf(config), key.id, async (taskId) => {
        const st = await readStateCompat(stateDirOf(config), key.id);
        return st && st.taskId === taskId ? st.status : null;
      });
      if (!r.ok) throw new Error(r.reason ?? '无法释放遗留锁');
      return send(200, { ok: true });
    }
    if (route === '/precheck') {
      if (!body.server) throw new Error('缺少 server 参数');
      const packagePath = normalizeRestorePath(body.packagePath);
      if (!packagePath) throw new Error('缺少 packagePath 参数');
      const serverList = unwrapVolatile(config.servers) ?? [];
      if (!serverList.some((s) => s.name === body.server)) {
        throw new Error(`未找到服务器: ${body.server}`);
      }
      const neutralize = Boolean(body.neutralize);
      if (credentials) service.attachCredentials?.(credentials);
      const preview = await service.inspectRestore(body.server, packagePath);
      const autoPersistedDbName = await persistAutoDbName(body.server, preview?.discovery);
      const token = tokenStore.create({
        server: body.server, packagePath, neutralize,
      });
      return send(200, {
        ok: true,
        confirmToken: token,
        expiresInSeconds: 300,
        sourceDbName: preview?.sourceDbName ?? null,
        targetDbName: preview?.targetDbName ?? null,
        conflict: preview?.conflict ?? null,
        sourceReason: preview?.sourceReason ?? null,
        targetReason: preview?.targetReason ?? null,
        dbNameSource: preview?.discovery?.source ?? null,
        autoPersistedDbName,
      });
    }
    if (route === '/restore') {
      if (credentials) service.attachCredentials?.(credentials);
      if (!body.confirmToken) throw new Error('缺少 confirmToken，请先预检');
      const packagePath = normalizeRestorePath(body.packagePath);
      tokenStore.verify(body.confirmToken, {
        server: body.server,
        packagePath,
        neutralize: Boolean(body.neutralize),
      });
      return send(200, {
        ok: true,
        result: await service.restore(body.server, null, packagePath, {
          neutralize: Boolean(body.neutralize),
          // 默认开启；显式传 false 才关闭（保留备份原密钥）。
          rotateSecret: body.rotateSecret !== false,
        }),
      });
    }
    // ---- v0.1.14 收尾：中立化状态管理（保持 / 解除）----
    if (route === '/neutralize-status') {
      if (!body.server) throw new Error('缺少 server 参数');
      return send(200, { ok: true, ...(await service.neutralizeStatus(body.server)) });
    }
    if (route === '/neutralize-precheck') {
      if (!body.server) throw new Error('缺少 server 参数');
      if (body.action !== 'release') throw new Error('预检仅用于解除中立化（action=release）');
      const status = await service.neutralizeStatus(body.server);
      if (!status?.ok) throw new Error(status?.reason ?? '无法读取目标库中立化状态');
      if (!status.neutralized) {
        return send(200, {
          ok: true,
          alreadyReleased: true,
          confirmToken: null,
          status,
          warnings: ['目标库当前未处于中立化状态，无需解除。'],
        });
      }
      const token = neutralizeTokenStore.create({
        server: body.server, action: 'release', dbName: status.dbName,
      });
      return send(200, {
        ok: true,
        alreadyReleased: false,
        confirmToken: token,
        expiresInSeconds: 300,
        status,
        warnings: [
          `将启用 ${status.cronDisabled} 个当前停用的定时任务（解除后 cron 会立即开始运行，含自动发信）。`,
          '中立化时已清空原邮件服务器的 SMTP 用户名与密码，且无法从数据库还原——解除后必须到 Odoo 后台「设置 → 邮件服务器」重新填写。',
          status.paymentDisabled > 0
            ? `支付提供商当前全部禁用（${status.paymentDisabled} 个）。如未指定启用名单，解除后仍保持禁用；在线收款请先核对凭据再手动启用。`
            : '支付提供商无需处理。',
          '中立化期间产生的未发邮件（state=exception/outgoing）将被清除，避免恢复后批量外发。',
          '解除后需确认 Odoo 配置 max_cron_threads ≥ 1，否则定时任务不会真正执行；本插件不修改 conf。',
          '该操作不可逆。请确认此环境确需接管生产（对外服务、收款、发信）。',
        ],
      });
    }
    if (route === '/neutralize-apply') {
      if (!body.server) throw new Error('缺少 server 参数');
      const action = String(body.action ?? '');
      if (action !== 'keep' && action !== 'release') {
        throw new Error('action 必须是 keep 或 release');
      }
      if (action === 'release') {
        if (!body.confirmToken) throw new Error('缺少 confirmToken，请先预检解除中立化');
        // 绑定维度：server + action + dbName，一次性 5 分钟。
        const status = await service.neutralizeStatus(body.server);
        neutralizeTokenStore.verify(body.confirmToken, {
          server: body.server, action: 'release', dbName: status?.dbName,
        });
      }
      const codes = Array.isArray(body.enablePaymentCodes)
        ? body.enablePaymentCodes
        : (typeof body.enablePaymentCodes === 'string'
          ? body.enablePaymentCodes.split(',').map((s) => s.trim()).filter(Boolean)
          : []);
      return send(200, {
        ok: true,
        result: await service.applyNeutralize(body.server, action, { enablePaymentCodes: codes }),
      });
    }
    return send(404, { ok: false, error: `未知路由: ${route}` });
  } catch (err) {
    return send(400, { ok: false, error: err?.message ?? String(err) });
  }
}
