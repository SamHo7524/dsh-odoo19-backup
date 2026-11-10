import { normalizeRestorePath } from './restore-path.js';

/**
 * Agent 工具定义（Task 9）。
 *
 * 设计原则（user-actions.md「一个操作，两个调用者」）：
 *  - 工具只做「参数校验 + 授权闸门 + 路由」，真实操作在 service 里实现一次
 *  - UI 与 Agent 共用同一个 service，避免两套逻辑漂移
 *  - 破坏性恢复必须持 confirmToken：绑定目标、5 分钟有效、一次性
 */

function findServer(config, name) {
  const list = config?.servers ?? [];
  return list.find((s) => s.name === name);
}

function requireServer(config, name) {
  if (!name) throw new Error('缺少 server 参数');
  const server = findServer(config, name);
  if (!server) throw new Error(`未找到服务器: ${name}`);
  return server;
}

/** 从配置里取完整 SSH 连接参数（工具层不需要，服务层需要）。 */
export function serverConnection(server) {
  return {
    name: server.name,
    host: server.host,
    port: server.port ?? 22,
    user: server.user ?? 'root',
    keyPath: server.keyPath,
    sshConfigAlias: server.sshConfigAlias,
    pinnedFingerprint: server.pinnedFingerprint,
  };
}

// ---------------- odoo_backup（只读 + 备份） ----------------

export function createOdooBackupTool({ config, service }) {
  return {
    name: 'odoo_backup',
    description:
      'Odoo 19 备份与检查：测试连接、扫描实例、执行备份、列出配置的服务器。' +
      '该工具不修改生产数据，可安全重复调用。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['test', 'discover', 'backup', 'listServers', 'fingerprint', 'pin'],
          description: 'test=测连接 / discover=扫描实例 / backup=执行备份 / listServers=列出配置的服务器 / fingerprint=扫描主机指纹（只读，供人工核对） / pin=把人工核对过的指纹固化进 known_hosts',
        },
        server: { type: 'string', description: '配置里的服务器名' },
        fingerprint: { type: 'string', description: 'action=pin 时必填：由 fingerprint 扫描得到、经人工核对的 SHA256 指纹' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {},
      },
      render: (args, value) => {
        if (args?.action === 'listServers' && Array.isArray(value)) {
          if (!value.length) return [{ type: 'text', text: '尚未配置服务器。' }];
          return [{
            type: 'text',
            text: value.map((s) => `${s.name} → ${s.user}@${s.host}:${s.port}`).join('\n'),
          }];
        }
        return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
      },
    },
    async execute(args) {
      const action = args?.action;
      switch (action) {
        case 'listServers':
          return (config?.servers ?? []).map((s) => ({
            name: s.name, host: s.host, port: s.port ?? 22, user: s.user ?? 'root',
          }));
        case 'test':
          requireServer(config, args.server);
          return service.test(args.server);
        case 'discover':
          requireServer(config, args.server);
          return service.discover(args.server);
        case 'backup':
          requireServer(config, args.server);
          return service.backup(args.server);
        case 'fingerprint':
          requireServer(config, args.server);
          return service.fingerprint(args.server);
        case 'pin':
          requireServer(config, args.server);
          if (!args.fingerprint) throw new Error('缺少 fingerprint 参数：请先扫描并人工核对');
          return service.pin(args.server, args.fingerprint);
        default:
          throw new Error(`未知 action: ${action}`);
      }
    },
  };
}

// ---------------- odoo_restore（破坏性，需 confirmToken） ----------------

export function createOdooRestoreTool({ config, service, tokenStore }) {
  return {
    name: 'odoo_restore',
    description:
      'Odoo 19 恢复：会覆盖目标数据库。流程为安全备份→临时恢复→验证→停机切换→验证，失败自动回滚。' +
      '必须先调 action=precheck 获取 confirmToken，用户确认后再调 action=restore。' +
      'confirmToken 绑定服务器与备份包，5 分钟内有效且只能使用一次。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['precheck', 'restore', 'status'],
          description: 'precheck=预检并生成 token / restore=执行恢复 / status=查看任务状态',
        },
        server: { type: 'string', description: '目标服务器名' },
        packagePath: { type: 'string', description: '本地备份包完整路径' },
        neutralize: { type: 'boolean', description: '是否中立化（防误发邮件），默认 false' },
        confirmToken: { type: 'string', description: 'restore 时必填，由 precheck 返回' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {},
      },
      render: (args, value) => {
        if (args?.action === 'precheck' && value?.confirmToken) {
          return [{
            type: 'text',
            text:
              `confirmToken: ${value.confirmToken}\n` +
              `有效期：${value.expiresInSeconds} 秒（一次性，绑定服务器与备份包）\n\n` +
              `${value.warning ?? ''}`,
          }];
        }
        return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
      },
    },
    async execute(args) {
      const action = args?.action;
      // 规范化与 Host UI 路由一致；token 绑定与 restore 校验都使用同一规范值。
      const packagePath = normalizeRestorePath(args?.packagePath);

      if (action === 'precheck') {
        requireServer(config, args.server);
        if (!packagePath) throw new Error('缺少 packagePath 参数');
        const neutralize = Boolean(args.neutralize);
        const token = tokenStore.create({
          server: args.server,
          packagePath,
          neutralize,
        });
        return {
          ok: true,
          confirmToken: token,
          expiresInSeconds: 300,
          boundTo: { server: args.server, packagePath, neutralize },
          warning:
            '确认后将覆盖目标数据库。请核对：服务器、备份包路径、neutralize 选项。' +
            '切换成功后正式环境将回到备份包对应的业务时间点。',
        };
      }

      if (action === 'restore') {
        if (!args.confirmToken) throw new Error('缺少 confirmToken，请先调 action=precheck');
        requireServer(config, args.server);
        if (!packagePath) throw new Error('缺少 packagePath 参数');
        const neutralize = Boolean(args.neutralize);

        // 授权闸门：不匹配/过期/已用过都会抛错，绝不会走到 service.restore。
        tokenStore.verify(args.confirmToken, {
          server: args.server,
          packagePath,
          neutralize,
        });

        return service.restore(args.server, null, packagePath, { neutralize });
      }

      if (action === 'status') {
        return service.status();
      }

      throw new Error(`未知 action: ${action}`);
    },
  };
}
