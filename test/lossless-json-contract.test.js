/**
 * v0.1.19 收敛：工具出口 lossless-JSON 契约（真机 2026-11-11 教训）。
 *
 * 背景：DSH 对 Agent 工具返回值做 lossless-JSON 校验，undefined 值会被整包拒绝
 * （报 "value is not lossless JSON"）。v0.1.17 的 discover() 在 found:true 时
 * 组装 note: undefined → 发现成功反而报错；连接失败时 note 是字符串反而正常。
 * 这是「失败能用、成功报错」误导签名的根因。imports.js 的 error 键同款。
 *
 * 覆盖范围分层（诚实标注）：
 *  - A) 源码契约：discover.js / imports.js 出口组装不得含 `: undefined,`
 *       模式，必须条件展开。精确锁住两个历史缺陷点（在未修复基线上 RED）。
 *  - B) 工具出口抽样：mock service 层跑真实 tools.execute()，断言返回值逐键
 *       无 undefined。测的是工具出口链路、防未来回归；因 discover 内部组装
 *       不可注入（execRemote 模块级依赖），该层不直接覆盖 discover.js 组装段。
 *  - C) helper 自证：构造历史缺陷模式对象，断言 helper 必报错（防 helper 失效）。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { createOdooBackupTool } from '../lib/tools.js';

/** 递归断言每个自有属性的值都可无损 JSON 化（undefined 是唯一必拦项）。 */
function assertNoUndefinedValues(value, path = 'result') {
  if (value === undefined) throw new Error(`${path} 为 undefined（lossless JSON 校验会整包拒绝）`);
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoUndefinedValues(v, `${path}[${i}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) assertNoUndefinedValues(v, `${path}.${k}`);
  }
}

test('LOSSJSON-1 helper 自证：历史缺陷模式 note:undefined 必被拦截', () => {
  assert.throws(
    () => assertNoUndefinedValues({ ok: true, found: true, note: undefined }),
    /undefined/,
    'helper 必须能拦住 discover.js 曾经的 note: undefined 模式',
  );
  // 对照：合法对象不误报
  assertNoUndefinedValues({ ok: true, found: true, note: '未发现实例' });
  assertNoUndefinedValues({ ok: true, found: true, instances: [{ dbName: 'x', tags: [] }] });
});

test('LOSSJSON-2 discover.js 出口组装不得含 note: undefined 模式（源码契约）', () => {
  const src = readFileSync(new URL('../lib/discover.js', import.meta.url), 'utf8');
  // 锚定返回值组装段（found 字段前后），禁止三元 undefined 出口
  const i = src.indexOf('found: instances.length > 0');
  assert.ok(i > 0, 'discover.js 应包含 found 组装行');
  const seg = src.slice(Math.max(0, i - 300), i + 300);
  assert.ok(!/:\s*undefined,?\s*/.test(seg), 'discover 出口组装段不得出现 ": undefined" 模式');
  assert.match(seg, /\.\.\.\(instances\.length === 0/, 'note 必须以条件展开提供，无值不出键');
});

test('LOSSJSON-3 imports.js 出口组装不得含 error: undefined 模式（源码契约）', () => {
  const src = readFileSync(new URL('../lib/imports.js', import.meta.url), 'utf8');
  const i = src.indexOf('checked: results.map');
  assert.ok(i > 0, 'imports.js 应包含 checked 组装行');
  const seg = src.slice(Math.max(0, i - 200), i + 400);
  assert.ok(!/:\s*undefined,?\s*/.test(seg), 'imports 出口组装段不得出现 ": undefined" 模式');
  assert.match(seg, /\.\.\.\(missing\.length > 0/, 'error 必须以条件展开提供，无值不出键');
});

test('LOSSJSON-4 工具出口抽样：odoo_backup 各 action 返回值无 undefined（真实 execute 链路）', async () => {
  const service = {
    test: async () => ({ ok: true, system: { os: 'Ubuntu 24.04', kernel: '6.8', arch: 'x86_64', cpuCores: 2, memTotalMb: 1935, memAvailableMb: 1101, diskFreeMb: 6492, hostname: 'h' }, tools: { docker: 'Docker 29', zstd: true, gzip: true } }),
    discover: async () => ({
      server: 's',
      instances: [{ kind: 'docker', odooContainer: 'c', dbName: 'd', state: 'running' }],
      found: true,
    }),
    backup: async () => ({ ok: true, applied: true }),
    fingerprint: async () => ({ ok: true, host: 'h', fingerprint: 'SHA256:x' }),
  };
  const tool = createOdooBackupTool({
    config: { servers: [{ name: 's', host: 'h', port: 22, user: 'root', keyPath: 'k', sshConfigAlias: '', pinnedFingerprint: 'f' }] },
    service,
  });
  for (const action of ['test', 'discover', 'fingerprint', 'backup']) {
    const r = await tool.execute({ action, server: 's' });
    assertNoUndefinedValues(r, `odoo_backup.${action}`);
  }
});
