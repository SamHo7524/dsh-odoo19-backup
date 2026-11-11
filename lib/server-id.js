/**
 * v0.1.17 — 稳定的服务器标识（serverConfigId）。
 *
 * 规格 §5.1 原文：serverConfigId = 服务器配置标识的稳定摘要，不含私钥。
 * 用户裁决 §三：以稳定的 serverConfigId 作为目录键，而不是可修改的服务器显示名称。
 * 因此摘要只含连接身份（host/port/user/sshConfigAlias），**不含 name**：
 * 服务器显示名改名后任务归属、锁与状态目录不变；换了主机/端口/用户才是新身份。
 */
import { createHash } from 'node:crypto';

/** 计算稳定 serverConfigId：host/port/user/sshConfigAlias 的 sha256 前 16 hex。 */
export function serverIdOf(server) {
  const parts = [
    String(server?.host ?? ''),
    String(server?.port ?? 22),
    String(server?.user ?? 'root'),
    String(server?.sshConfigAlias ?? ''),
  ];
  return createHash('sha256')
    .update(parts.join('\u0000'), 'utf8')
    .digest('hex')
    .slice(0, 16);
}
