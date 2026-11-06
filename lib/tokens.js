import { randomBytes } from 'node:crypto';

/** confirmToken 有效期：5 分钟。 */
export const TOKEN_TTL_MS = 5 * 60 * 1000;

/** Token 绑定的载荷字段——恢复目标与操作的全部判别维度。 */
const BOUND_KEYS = ['server', 'packagePath', 'neutralize'];

/**
 * 一次性确认令牌存储。
 *
 * 约束（R4）：
 *  - 绑定恢复目标与操作：server + packagePath + neutralize 三项任一不同即拒绝
 *  - 有效期 5 分钟
 *  - 一次性：兑换成功后立即标记 used，二次使用拒绝
 *  - 载荷不匹配时不消耗 token（避免误伤合法请求）
 *
 * @param {object} [opts]
 * @param {() => number} [opts.now] 可注入时钟（测试用）
 */
export function createTokenStore({ now = () => Date.now() } = {}) {
  /** @type {Map<string, {payload: object, expiresAt: number, used: boolean}>} */
  const store = new Map();

  function create(payload) {
    const token = randomBytes(24).toString('hex');
    const bound = {};
    for (const k of BOUND_KEYS) bound[k] = payload?.[k];
    store.set(token, { payload: bound, expiresAt: now() + TOKEN_TTL_MS, used: false });
    return token;
  }

  /** 只读查看（不校验、不消耗）。 */
  function peek(token) {
    return store.get(token);
  }

  function verify(token, payload) {
    const rec = store.get(token);
    if (!rec) throw new Error('confirmToken 无效');
    if (rec.used) throw new Error('confirmToken 已使用过');
    if (now() > rec.expiresAt) throw new Error('confirmToken 已过期（5 分钟）');

    for (const k of BOUND_KEYS) {
      if (rec.payload[k] !== payload?.[k]) {
        throw new Error(`confirmToken 与本次请求不匹配：${k} 不同`);
      }
    }
    rec.used = true;
    return true;
  }

  /** 清理过期记录，避免 Map 无限增长。 */
  function sweep() {
    const t = now();
    for (const [k, rec] of store) {
      if (t > rec.expiresAt) store.delete(k);
    }
  }

  return { create, verify, peek, sweep };
}
