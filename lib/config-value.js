/**
 * volatile 配置值的解包（v0.1.15）。
 *
 * `Config` 里带 `.volatile()` 的字段（servers / backupDirectory / localBackupDir /
 * restoreDomain）在 Host 运行时被解析成 `{ get(): T }` 活引用——这是 dsh-settings
 * 唯一允许运行时写入的路径（普通字段写会被 "has no volatile fields" 拒绝）。
 *
 * 因此**任何**读取这些字段的地方都必须先解包；直接把它当数组/字符串用会在真机
 * 报 `xxx.map is not a function` / `xxx.find is not a function`（v0.1.14 的
 * agent 工具就踩了这个坑：路由层解包了，lib/tools.js 没解包）。
 *
 * 放在 lib/ 里而不是 index.js，是为了让工具层能直接 import 而不会与 index.js
 * 形成循环依赖。
 */
export function unwrapVolatile(value) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') return value.get();
  return value;
}

/** 取 volatile 数组字段（servers 等），保证返回数组。 */
export function unwrapVolatileList(value) {
  const v = unwrapVolatile(value);
  return Array.isArray(v) ? v : [];
}
