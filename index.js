import z from '@deepseek-ai/schemastery';
import { readFile } from 'node:fs/promises';
import { createTokenStore } from './lib/tokens.js';
import { readState, patchState } from './lib/task-state.js';
import { readLock, inspectLock, confirmStaleLock, releaseLock } from './lib/server-lock.js';
import { resolveBackupDirectory, validateDirectory, DEFAULT_BACKUP_DIRECTORY } from './lib/backup-directory.js';
import { createService } from './lib/service.js';
import { createOdooBackupTool, createOdooRestoreTool } from './lib/tools.js';
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
});

/** volatile 字段解析为 { get(): T } 活引用；读取时解包为普通值。 */
export function unwrapVolatile(value) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') return value.get();
  return value;
}

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
          req, res, config, service, tokenStore,
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

/** /task-lock 的默认服务器标识必须与 service 的锁键（server.name）一致；servers 是 volatile 活引用。 */
function defaultServerId(config) {
  const list = unwrapVolatile(config?.servers) ?? [];
  return Array.isArray(list) && list[0]?.name ? list[0].name : null;
}

async function handleUiRequest({ req, res, config, service, tokenStore, settings, entryId, readPublicKey, credentials }) {
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
      return send(200, { ok: true, result: await service.discover(body.server) });
    }
    if (route === '/backup') {
      // 自愈通道：handler 每次请求都有 webCtx.credentials，补挂给 service
      // （防独立 inject 的时序问题；幂等，CRED-16/17）。
      if (credentials) service.attachCredentials?.(credentials);
      return send(200, { ok: true, result: await service.backup(body.server) });
    }
    if (route === '/status') {
      return send(200, { ok: true, result: await service.status() });
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
      const dir = stateDirOf(config);
      const list = unwrapVolatile(config?.servers) ?? [];
      const ids = (Array.isArray(list) ? list.map((s) => s?.name).filter(Boolean) : []);
      const targets = body.server ? [body.server] : ids;
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
      if (body.confirm !== true) throw new Error('取消任务需要明确确认（confirm:true）');
      const dir = stateDirOf(config);
      const st = await readState(dir);
      if (!st) throw new Error('当前无持久化任务状态');
      if (['completed', 'failed', 'cancelled'].includes(st.status)) {
        return send(200, { ok: true, alreadyTerminal: st.status });
      }
      const ok = await patchState(dir, st.taskId, { status: 'cancelled', phaseMessage: '用户已取消' });
      if (!ok) throw new Error('任务状态已变更，取消失败（taskId 不匹配）');
      const ids = (unwrapVolatile(config?.servers) ?? []).map((s) => s?.name).filter(Boolean);
      for (const id of ids) await releaseLock(dir, id, st.taskId).catch(() => {});
      return send(200, { ok: true, status: 'cancelled', taskId: st.taskId });
    }
    if (route === '/task-lock/confirm-stale') {
      const serverConfigId = body.server ?? defaultServerId(config);
      if (!serverConfigId) throw new Error('缺少 server 参数');
      if (body.confirm !== true) throw new Error('缺少明确确认（confirm:true）');
      const sd = stateDirOf(config);
      const r = await confirmStaleLock(sd, serverConfigId, async (taskId) => {
        const st = await readState(sd);
        return st && st.taskId === taskId ? st.status : null;
      });
      if (!r.ok) throw new Error(r.reason ?? '无法释放遗留锁');
      return send(200, { ok: true });
    }
    if (route === '/precheck') {
      if (!body.server) throw new Error('缺少 server 参数');
      if (!body.packagePath) throw new Error('缺少 packagePath 参数');
      if (!(config.servers ?? []).some((s) => s.name === body.server)) {
        throw new Error(`未找到服务器: ${body.server}`);
      }
      const neutralize = Boolean(body.neutralize);
      const token = tokenStore.create({
        server: body.server, packagePath: body.packagePath, neutralize,
      });
      return send(200, { ok: true, confirmToken: token, expiresInSeconds: 300 });
    }
    if (route === '/restore') {
      if (credentials) service.attachCredentials?.(credentials);
      if (!body.confirmToken) throw new Error('缺少 confirmToken，请先预检');
      tokenStore.verify(body.confirmToken, {
        server: body.server,
        packagePath: body.packagePath,
        neutralize: Boolean(body.neutralize),
      });
      return send(200, {
        ok: true,
        result: await service.restore(body.server, null, body.packagePath, {
          neutralize: Boolean(body.neutralize),
        }),
      });
    }
    return send(404, { ok: false, error: `未知路由: ${route}` });
  } catch (err) {
    return send(400, { ok: false, error: err?.message ?? String(err) });
  }
}
