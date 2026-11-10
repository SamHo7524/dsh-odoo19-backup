/**
 * v0.1.14 — 恢复包路径规范化（纯函数，无 IO）。
 *
 * 规则（逐条固定，见 docs/superpowers/plans/2026-11-09-v0.1.14-restore-path-usability.md）：
 *  1. trim 首尾空白；
 *  2. 仅当首尾各有一个英文双引号时，去掉这一对（单侧/不匹配的引号保留）；
 *  3. Windows 场景下把 / 统一为 \；
 *  4. 不校验存在性、不猜测路径。
 */
export function normalizeRestorePath(raw, opts = {}) {
  let s = String(raw ?? '').trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    s = s.slice(1, -1);
  }
  const platform = opts.platform ?? process.platform;
  if (platform === 'win32') s = s.replace(/\//g, '\\');
  return s;
}
