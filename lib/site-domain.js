/**
 * v0.1.14 — 恢复后的站点域名切换。
 *
 * 背景（真机，2026-11-09）：备份包来自生产库，`website.domain` 与 `web.base.url`
 * 仍是 https://www.toogel.cn。若原样恢复到另一台服务器（如 odoo.toogel.cn），
 * 两个站点会抢同一域名，链接与回调也会指回生产。
 *
 * 规则：
 *  - 默认域名取「服务器名」，仅当它形如主机名时使用；否则返回 null（不猜域名）；
 *  - 显式 override 优先，但必须通过主机名校验（防注入）；
 *  - 只在目标库已装 website 模块时改动，且同时冻结 web.base.url 防 Odoo 自动改回。
 */

const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;

/** 是否为可用作站点域名的主机名（排除 IP 与单段名字）。 */
export function isHostname(value) {
  const s = String(value ?? '').trim();
  if (!s || s.length > 253) return false;
  if (IPV4_RE.test(s)) return false;
  return HOSTNAME_RE.test(s);
}

/**
 * 解析本次恢复要使用的站点域名。
 * @returns {string|null} 合法主机名，或 null（不切换）
 */
export function resolveTargetDomain({ server, override } = {}) {
  const explicit = String(override ?? '').trim();
  if (explicit) {
    if (!isHostname(explicit)) {
      throw new Error(`域名不合法：${explicit}（只接受形如 odoo.example.com 的主机名）`);
    }
    return explicit;
  }
  const name = String(server?.name ?? '').trim();
  return isHostname(name) ? name : null;
}

/**
 * 域名补丁脚本。参数经 stdin 传入（OC/PG/PG_SUPER/DB/DOMAIN），域名已在 JS 侧校验。
 */
export function buildDomainPatchScript() {
  return `
set -uo pipefail
read -r OC
read -r PG
read -r PG_SUPER
read -r DB
read -r DOMAIN

HAS=\$(docker exec "\$PG" psql -U "\$PG_SUPER" -d "\$DB" -Atc "select (to_regclass('public.website') is not null)" 2>/dev/null || echo "")
if [ "\$HAS" != "t" ]; then
  echo "===DOMAIN_SKIP==="
  echo "reason=no_website"
  echo "===END==="
  exit 0
fi

BEFORE=\$(docker exec "\$PG" psql -U "\$PG_SUPER" -d "\$DB" -Atc "select coalesce(max(domain),'') from website" 2>/dev/null || echo "")

docker exec "\$PG" psql -U "\$PG_SUPER" -d "\$DB" -c "UPDATE website SET domain = '\$DOMAIN'" >/dev/null 2>&1 || echo "UPDATE_WEBSITE_FAIL"
docker exec "\$PG" psql -U "\$PG_SUPER" -d "\$DB" -c "UPDATE ir_config_parameter SET value = 'https://\$DOMAIN' WHERE key = 'web.base.url'" >/dev/null 2>&1 || true
docker exec "\$PG" psql -U "\$PG_SUPER" -d "\$DB" -c "INSERT INTO ir_config_parameter (key, value) SELECT 'web.base.url.freeze', 'True' WHERE NOT EXISTS (SELECT 1 FROM ir_config_parameter WHERE key = 'web.base.url.freeze')" >/dev/null 2>&1 || true

AFTER=\$(docker exec "\$PG" psql -U "\$PG_SUPER" -d "\$DB" -Atc "select coalesce(max(domain),'') from website" 2>/dev/null || echo "")

echo "===DOMAIN_BEFORE==="
echo "\$BEFORE"
echo "===DOMAIN_AFTER==="
echo "\$AFTER"
echo "===DOMAIN_DONE==="
if [ "\$BEFORE" = "\$AFTER" ]; then echo "changed=0"; else echo "changed=1"; fi

# 配置与视图缓存需要重启才失效（odoo 有 registry 缓存）
docker restart "\$OC" >/dev/null 2>&1 || true

echo "===END==="
`;
}

/** 解析域名补丁脚本输出。 */
export function parseDomainPatch(stdout) {
  const out = String(stdout ?? '');
  if (out.includes('===DOMAIN_SKIP===')) {
    return { ok: true, skipped: true, reason: (out.match(/reason=(\S+)/)?.[1] ?? 'unknown').trim() };
  }
  if (!out.includes('===DOMAIN_DONE===')) {
    return { ok: false, reason: out.slice(-300) || '域名补丁未执行' };
  }
  const before = (out.match(/===DOMAIN_BEFORE===\n\s*([^\n]*)/)?.[1] ?? '').trim();
  const after = (out.match(/===DOMAIN_AFTER===\n\s*([^\n]*)/)?.[1] ?? '').trim();
  const changed = Number((out.match(/changed=(\d)/)?.[1] ?? '0')) || 0;
  return { ok: true, skipped: false, before, after, changed };
}
