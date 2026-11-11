/**
 * v0.1.17 — 失败诊断层。
 *
 * 用户要求（2026-11-11）：备份/恢复出问题时要**先给提示再失败**，不能只甩一段原始报错
 * （"不然全部都黑盒子，使用体验不好"）。
 *
 * 设计原则：
 *  - 只做**模式识别 + 说明**，不改变任何执行语义、不吞错、不臆测；
 *  - 命中规则时，原始错误**原文保留**，在其后追加「诊断 / 建议」两段；
 *  - 未命中时原样返回，绝不把未知错误伪装成已知错误。
 */

/** 规则按顺序匹配，命中即止（越具体的放越前）。 */
const RULES = [
  {
    code: 'odoo-major-mismatch',
    test: (t) =>
      /neutralize\.py|neutralize_database/i.test(t) ||
      (/UndefinedColumn/i.test(t) && /payment_provider|is_live/i.test(t)),
    title: '目标机 Odoo 大版本与备份包不一致',
    cause:
      '恢复时 Odoo 会用自己的 neutralize 规则（来自目标机的 addons）去改写备份库，' +
      '而备份库的表结构来自较旧大版本，于是 neutralize 的 SQL 打在不存在或已改名的列上' +
      '（本次是 payment_provider.is_live 列缺失）。',
    suggestion:
      '这类恢复只能在**同大版本**之间做。请换一台与备份包同大版本的目标机；' +
      '若要跨大版本（如 19 → 20），那是**升级项目**（先升级数据库与模块，再切换），不是恢复。',
  },
  {
    code: 'module-not-loaded',
    test: (t) =>
      /object has no attribute/i.test(t) ||
      /QWebError/i.test(t) ||
      /Some modules are not loaded/i.test(t),
    title: '备份库依赖的模块代码没有被 Odoo 载入',
    cause:
      'Odoo 只在进程启动时扫描 addons 并导入模块 Python。自建模块是在容器启动之后才部署到 addons 目录的，' +
      '进程里没有这些模型/字段，模板渲染随即 500。',
    suggestion:
      '部署 addons/pydeps 后必须重启 Odoo 容器（本插件自 0.1.23 起自动执行）；' +
      '若为手工操作，请 docker restart 后重试。也请确认容器 addons_path 确实包含部署目录。',
  },
  {
    code: 'schema-mismatch',
    test: (t) => /Undefined(Table|Column)/i.test(t) || /relation ".*" does not exist/i.test(t),
    title: '数据库表结构与目标 Odoo 不匹配',
    cause: '备份库的表/列在目标 Odoo 的代码里不存在（通常是大版本不同，模块结构被重构）。',
    suggestion: '确认备份包与目标机的 Odoo 大版本一致；跨大版本需按升级流程处理，不能直接恢复。',
  },
  {
    code: 'db-exists',
    test: (t) => /database ".*" already exists/i.test(t),
    title: '目标数据库已存在',
    cause: '上一次失败的恢复留下了临时库，或目标库名被别的实例占用。',
    suggestion:
      '先清理残留库（DROP DATABASE "<库名>"），确认没有其它实例在用这个库名，然后重试。',
  },
  {
    code: 'disk-full',
    test: (t) => /No space left on device|ENOSPC/i.test(t),
    title: '磁盘空间不足',
    cause: '导出、打包、传输或解密过程中磁盘被写满。',
    suggestion: '用 df -h 查看目标与备份目录所在分区，清理出至少与备份包同等大小的空间后重试。',
  },
  {
    code: 'ssh-hostkey',
    test: (t) => /Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|host key mismatch/i.test(t),
    title: '主机指纹校验失败（fail-closed）',
    cause: '服务器主机密钥与已固定的指纹不一致，可能是重装、换机，也可能是中间人。',
    suggestion:
      '带外确认服务器真实性后重新扫描指纹并人工核对；不要为了「先跑通」而绕过指纹校验。',
  },
  {
    code: 'ssh-auth',
    test: (t) => /Permission denied \(publickey|no such identity|Identity file .* not accessible/i.test(t),
    title: 'SSH 登录认证失败',
    cause: '私钥不可用、未授权，或 sshConfigAlias 指向的配置不对。',
    suggestion: '检查 keyPath / sshConfigAlias、私钥权限，并把本插件客户端公钥装到目标机 authorized_keys。',
  },
  {
    code: 'db-connect',
    test: (t) => /could not connect to server|Connection refused|Is the server running/i.test(t),
    title: '数据库连不上',
    cause: 'PostgreSQL 容器未运行、端口不通，或连接参数（容器内 HOST/USER）与实际不一致。',
    suggestion: '确认 postgres 容器在运行，并从 Odoo 容器内验证 psql 能连上；再核对容器 env 里的连接参数。',
  },
  {
    code: 'timeout',
    test: (t) => /ETIMEDOUT|timed out|timeout/i.test(t),
    title: '操作超时',
    cause: '网络抖动、远端磁盘 IO 慢，或任务体量超过当前超时预算。',
    suggestion: '先确认网络与磁盘可用，再重试；大库建议分块传输与断点续传继续，而不是从头再来。',
  },
];

/**
 * 诊断一段错误文本。
 * @param {string} text 原始错误（可为多行）
 * @returns {{ok:true}|{ok:false,code:string,title:string,cause:string,suggestion:string}}
 */
export function diagnoseFailure(text) {
  const raw = String(text ?? '');
  if (!raw.trim()) return { ok: true };
  for (const rule of RULES) {
    try {
      if (rule.test(raw)) {
        return { ok: false, code: rule.code, title: rule.title, cause: rule.cause, suggestion: rule.suggestion };
      }
    } catch {
      // 规则异常绝不影响主流程
    }
  }
  return { ok: true };
}

/**
 * 把错误文本变成「原始错误 + 诊断 + 建议」。未命中规则时原样返回。
 * @param {string} text
 * @param {{where?:string}} [meta] where: '备份' | '恢复' 等，用于措辞
 */
export function explainFailure(text, meta = {}) {
  const raw = String(text ?? '');
  const d = diagnoseFailure(raw);
  if (d.ok) return raw;
  const where = meta.where ? `${meta.where}` : '本操作';
  return (
    `${raw.trim()}\n\n` +
    `【诊断】${where}失败原因：${d.title}。\n` +
    `${d.cause}\n` +
    `【建议】${d.suggestion}`
  );
}