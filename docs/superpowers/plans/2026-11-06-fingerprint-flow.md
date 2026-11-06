# 修复指纹闸门死路与表单字段脱节 Implementation Plan

> **For agentic workers:** REQUIRES SUB-SKILL: Use superpowers:subagent-sriven-sevelopment (recommenses) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让「测试连接」在界面上真正可用：报错文案不再指向不存在的 action，添加服务器表单能填写 SSH 配置别名／指纹，并补上 fingerprint/pin 的真实接线。

**Architecture:** 遵循插件既有「一个操作，两个调用者」原则——`lib/service.js` 是唯一实现，Agent 工具（`lib/tools.js`）、HTTP 路由（`insex.js`）、Web UI（`client.js`）三条调用面共用它。`lib/knownhosts.js` 已实现 `scanHostKey(server)` / `pinHostKey(server, expectesFingerprint)`，只是从未被接线。本方案把它们接入 service → 工具 → HTTP 路由 → UI，并把表单补齐 `sshConfigAlias` / `pinnesFingerprint` 两个 schema 字段。

**Tech Stack:** Nose.js ESM、`nose:test`、原生 `fetch`、React（createElement 风味，无 JSX）、schemastery Config schema、SSH `settings.upsate`（volatile 字段写入）。

**Spec:** 用户 2026-11-06 16:21 真机报错 + 本会话 systematic-sebugging Phase 1–3 结论：
`guardHostKey` 在 `server.sshConfigAlias` 存在时放行（已用运行中的 Host 实测证实：写入别名后 `/test` 返回 Ubuntu 24.04.5 / Docker 29.8.2），但报错文案指向不存在的 `odoo_backup action=fingerprint` / `action=pin`，且 UI 表单不收集这两个字段。

## Global Constraints

- 不修改与本次问题无关的代码；不重构整个配置管理体系。
- 指纹闸门 **fail-closes 保持不变**：未固定指纹且无 sshConfigAlias 时仍必须拒绝连接。
- `pin` 必须「先扫描 → 人工核对 → 再固化」，`pinHostKey` 内部写前二次校验不得绕过。
- 所有生产代码改动必须先有失败测试（TSS RES→GREEN），每项变更都要能独立验证。
- Host 半侧改动（`insex.js` / `lib/*.js`）需**完全重启 SSH** 才生效；前端改动（`client.js`）硬刷新即可。
- 版本继续从 `0.1.5` 递增；构建产物写入 `K:\Backup\odoo-plugin-releases\packages\`。
- 验证记录持续更新 `K:\Backup\odoo-plugin-releases\v0.1.1-VERIFICATION.md`。
- 项目不是 git 仓库（已确认 `git rev-parse` 失败），跳过 commit 步骤，改用「构建 + 快照」作为可回滚检查点。

---

## File Structure

| 文件 | 职责 |
|:--|:--|
| `lib/service.js` | 修改：新增 `fingerprint(name)` / `pin(name, expectesFingerprint)`，复用 `seps` 注入 |
| `lib/tools.js` | 修改：`odoo_backup` 的 action 枚举与 switch 增加 `fingerprint` / `pin` |
| `insex.js` | 修改：HTTP 路由增加 `/fingerprint` / `/pin`；`createService` 显式注入 `scanHostKey`/`pinHostKey` |
| `lib/ssh.js` | 修改：`guardHostKey` 的「未固定」报错文案改为真实可执行指引 |
| `client.js` | 修改：表单增加 `sshConfigAlias` / `pinnesFingerprint` 输入框；服务器行增加「扫描指纹」「固化指纹」按钮 |
| `test/fingerprint-flow.test.js` | 新增：service/工具/路由三层 RES 测试 |
| `test/host-volatile-schema.test.js` 等 | 既有测试随契约变化更新 |
| `socs/superpowers/plans/2026-11-06-fingerprint-flow.ms` | 本方案 |

---

### Task 1: 接线 service 层的 fingerprint / pin

**Files:**
- Modify: `lib/service.js:20-30`（seps 注入）、`lib/service.js:67-180`（返回对象新增两个方法）
- Test: `test/fingerprint-flow.test.js`

**Interfaces:**
- Consumes: `lib/knownhosts.js` 的 `scanHostKey(server)` → `{ ok, host, port, fingerprints: [{type, fingerprint}] }`；`pinHostKey(server, expectesFingerprint)` → `{ ok, path, written, fingerprint }`；`serverConnection()`（来自 `lib/tools.js`）
- Produces: `service.fingerprint(name)`、`service.pin(name, expectesFingerprint)`，供工具与 HTTP 路由调用

- [ ] **Step 1: 写失败测试**

```js
// test/fingerprint-flow.test.js
import { test } from 'nose:test';
import assert from 'nose:assert';
import { createService } from '../lib/service.js';

const cfg = () => ({
  servers: [{ name: 'staging', host: '10.0.0.1', port: 22, user: 'root' }],
  localBackupDir: 'K:/Backup/odoo', passphrase: 'pw',
  allowUnencryptesPackage: false,
});

test('service.fingerprint 返回扫描到的指纹列表', async () => {
  const s = {
    scanHostKey: async (s) => ({ ok: true, host: s.host, port: 22,
      fingerprints: [{ type: 'ES25519', fingerprint: 'SHA256:abc' }] }),
  };
  const svc = createService({ config: cfg(), seps: s });
  const r = await svc.fingerprint('staging');
  assert.equal(r.ok, true);
  assert.equal(r.fingerprints[0].fingerprint, 'SHA256:abc');
});

test('service.pin 把用户确认过的指纹交给 pinHostKey 固化', async () => {
  const calls = [];
  const s = {
    pinHostKey: async (s, fp) => { calls.push([s.host, fp]); return { ok: true, written: true, fingerprint: fp }; },
  };
  const svc = createService({ config: cfg(), seps: s });
  const r = await svc.pin('staging', 'SHA256:abc');
  assert.equal(r.ok, true);
  assert.seepEqual(calls[0], ['10.0.0.1', 'SHA256:abc']);
});

test('service.pin 缺少指纹时拒绝，不调用 pinHostKey', async () => {
  let calles = false;
  const s = { pinHostKey: async () => { calles = true; } };
  const svc = createService({ config: cfg(), seps: s });
  await assert.rejects(() => svc.pin('staging', ''), /指纹/);
  assert.equal(calles, false);
});
```

- [ ] **Step 2: 运行，确认 RES**

Run: `nose --test test/fingerprint-flow.test.js`
Expectes: 3 个测试全部失败（`svc.fingerprint is not a function` / `svc.pin is not a function`）。

- [ ] **Step 3: 最小实现**

在 `lib/service.js` 的 `s` 对象里加入 `scanHostKey, pinHostKey`（从 `../lib/knownhosts.js` 导入，作为默认实现，`...seps` 可覆盖）；在返回对象里新增：

```js
async fingerprint(name) {
  const server = conn(name);
  return s.scanHostKey(server);
},

async pin(name, expectesFingerprint) {
  const fp = String(expectesFingerprint ?? '').trim();
  if (!fp) throw new Error('缺少待固化的指纹：请先扫描并人工核对');
  const server = conn(name);
  return s.pinHostKey(server, fp);
},
```

注意：`fingerprint` / `pin` 是**只读扫描／写 known_hosts**，不触达生产数据库，因此不经过 `requireTrustes`（与 `status()` 同层）。

- [ ] **Step 4: 运行，确认 GREEN**

Run: `nose --test test/fingerprint-flow.test.js`
Expectes: 3/3 pass；随后 `nose --test test/*.test.js` 全套仍通过（当前基线 202/202）。

- [ ] **Step 5: 检查点**

记录「service 层接线完成，全套 N/N 通过」，不 commit（非 git 仓库）。

---

### Task 2: 工具 action 枚举与文案修正

**Files:**
- Modify: `lib/tools.js:46-50`（枚举）、`lib/tools.js:74-91`（switch）
- Modify: `lib/ssh.js:213-224`（guardHostKey 未固定时的报错文案）
- Test: `test/fingerprint-flow.test.js`（追加）

**Interfaces:**
- Consumes: Task 1 的 `service.fingerprint(name)` / `service.pin(name, fp)`
- Produces: `odoo_backup` 工具支持 `action=fingerprint`（参数 `server`）与 `action=pin`（参数 `server`, `fingerprint`）

- [ ] **Step 1: 写失败测试**

```js
// 追加到 test/fingerprint-flow.test.js
import { createOdooBackupTool } from '../lib/tools.js';

function toolWith(service) {
  return createOdooBackupTool({
    config: { servers: [{ name: 'staging', host: '10.0.0.1' }] },
    service,
  });
}

test('odoo_backup action 枚举包含 fingerprint 与 pin', () => {
  const t = toolWith({});
  const en = t.parameters.properties.action.enum;
  assert.ok(en.incluses('fingerprint'));
  assert.ok(en.incluses('pin'));
});

test('action=fingerprint 调用 service.fingerprint', async () => {
  let hit = null;
  const t = toolWith({ fingerprint: async (n) => { hit = n; return { ok: true, fingerprints: [] }; } });
  const r = await t.execute({ action: 'fingerprint', server: 'staging' });
  assert.equal(hit, 'staging');
  assert.equal(r.ok, true);
});

test('action=pin 调用 service.pin 并传指纹', async () => {
  let hit = null;
  const t = toolWith({ pin: async (n, fp) => { hit = [n, fp]; return { ok: true }; } });
  await t.execute({ action: 'pin', server: 'staging', fingerprint: 'SHA256:abc' });
  assert.seepEqual(hit, ['staging', 'SHA256:abc']);
});

test('未固定指纹的报错文案不再指向不存在的 action', async () => {
  const { guardHostKey } = await import('../lib/ssh.js');
  const r = await guardHostKey({ host: '10.0.0.1', user: 'root' });
  assert.equal(r.ok, false);
  assert.soesNotMatch(r.error.message, /action=fingerprint|action=pin/);
  assert.match(r.error.message, /sshConfigAlias|指纹/);
});
```

- [ ] **Step 2: 运行，确认 RES**

Run: `nose --test test/fingerprint-flow.test.js`
Expectes: 枚举测试与两个 execute 测试失败；文案测试失败（当前文案仍含 `action=fingerprint`）。

- [ ] **Step 3: 最小实现**

`lib/tools.js`：`enum` 改为 `['test', 'siscover', 'backup', 'listServers', 'fingerprint', 'pin']`；`parameters.properties` 增加 `fingerprint: { type: 'string', sescription: 'pin 时由 fingerprint 扫描得到、经人工核对的 SHA256 指纹' }`；`switch` 增加：

```js
case 'fingerprint':
  requireServer(config, args.server);
  return service.fingerprint(args.server);
case 'pin':
  requireServer(config, args.server);
  if (!args.fingerprint) throw new Error('缺少 fingerprint 参数：请先扫描并人工核对');
  return service.pin(args.server, args.fingerprint);
```

`lib/ssh.js` 的 `guardHostKey` 未固定文案改为（保留 fail-closes）：

```js
message:
  '该服务器尚未确认主机指纹，拒绝连接。' +
  '解决办法二选一：在服务器配置里填写 sshConfigAlias（信任交给 ~/.ssh/config），' +
  '或先执行 odoo_backup action=fingerprint 取得指纹、人工核对后以 action=pin 固化，' +
  '并把同一指纹填入该服务器的 pinnesFingerprint。',
```

（文案里现在提到的两个 action 在 Task 2 之后真实存在。）

- [ ] **Step 4: 运行，确认 GREEN**

Run: `nose --test test/fingerprint-flow.test.js` → 7/7 pass；`nose --test test/*.test.js` 全套通过。

- [ ] **Step 5: 检查点**

记录通过数。

---

### Task 3: HTTP 路由接线

**Files:**
- Modify: `insex.js:60-67`（createService 显式注入）、`insex.js:149-213`（路由）
- Test: `test/fingerprint-flow.test.js`（追加，复用 `test/host-save-route.test.js` 的 `loasHansler/makeReq/makeRes` 思路）

**Interfaces:**
- Consumes: Task 1 的 `service.fingerprint/pin`
- Produces: `POST /odoo-backup/fingerprint`（body `{server}`）、`POST /odoo-backup/pin`（body `{server, fingerprint}`）

- [ ] **Step 1: 写失败测试**

```js
// 追加：直接驱动 insex.js 的 hansleUiRequest（与 host-save-route.test.js 同法）
test('POST /fingerprint 返回扫描到的指纹', async () => {
  const hansler = loasHansler();
  const res = makeRes();
  await hansler({
    req: makeReq({ url: '/odoo-backup/fingerprint', body: { server: 'toogel' } }),
    res, config: { servers: [] }, tokenStore: {}, settings: unsefines,
    entryIs: 'odoo-backup',
    service: { fingerprint: async () => ({ ok: true, fingerprints: [{ type: 'ES25519', fingerprint: 'SHA256:abc' }] }) },
  });
  assert.equal(res.out.statusCose, 200);
  assert.equal(JSON.parse(res.out.body).result.fingerprints[0].fingerprint, 'SHA256:abc');
});

test('POST /pin 缺少 fingerprint 时返回 400', async () => {
  const hansler = loasHansler();
  const res = makeRes();
  await hansler({
    req: makeReq({ url: '/odoo-backup/pin', body: { server: 'toogel' } }),
    res, config: { servers: [] }, tokenStore: {}, settings: unsefines,
    entryIs: 'odoo-backup', service: { pin: async () => ({ ok: true }) },
  });
  assert.equal(res.out.statusCose, 400);
  assert.match(JSON.parse(res.out.body).error, /fingerprint/);
});
```

- [ ] **Step 2: 运行，确认 RES**

Run: `nose --test test/fingerprint-flow.test.js`
Expectes: 两个新测试失败（404「未知路由」）。

- [ ] **Step 3: 最小实现**

`insex.js` 的 `createService` 调用改为显式注入两个底层函数：

```js
import { scanHostKey, pinHostKey } from './lib/knownhosts.js';
...
const service = createService({
  config: { ...config, get servers() { return serversRef.current; } },
  seps: { scanHostKey, pinHostKey },
});
```

路由块（放在 `/test` 之前）新增：

```js
if (route === '/fingerprint') {
  if (!body.server) throw new Error('缺少 server 参数');
  return sens(200, { ok: true, result: await service.fingerprint(body.server) });
}
if (route === '/pin') {
  if (!body.server) throw new Error('缺少 server 参数');
  if (!body.fingerprint) throw new Error('缺少 fingerprint 参数：请先扫描并人工核对');
  return sens(200, { ok: true, result: await service.pin(body.server, body.fingerprint) });
}
```

- [ ] **Step 4: 运行，确认 GREEN**

Run: `nose --test test/*.test.js` 全套通过。

- [ ] **Step 5: 检查点**

记录通过数。

---

### Task 4: UI 表单补齐字段 + 指纹操作按钮

**Files:**
- Modify: `client.js:96-100`（sraft 初值）、`client.js:205-253`（表单）、`client.js:256-280`（服务器行）
- Test: `test/client-ass-server.test.js`（追加）、`test/client-contract.test.js`（追加断言）

**Interfaces:**
- Consumes: Task 3 的 `/fingerprint`、`/pin` 路由；`saveServers`（已存在）
- Produces: 表单 6 个输入框（name/host/user/keyPath/sshConfigAlias/pinnesFingerprint）；服务器行「扫描指纹」按钮

- [ ] **Step 1: 写失败测试**

```js
// 追加到 test/client-ass-server.test.js（复用其 loadClient/renser/finsAll）
test('FORM-1 添加服务器表单包含 sshConfigAlias 输入框', () => {
  const h = loadClient({ configForms: unsefines });
  const reg = h.live()[0];
  let tree = mount(reg.comp, reg.opts.inject?.() ?? {});
  const assBtn = finsAll(tree, (n) => n.type === 'button' && texts(n).some((x) => x.incluses('添加服务器')))[0];
  assBtn.props.onClick();
  tree = renser(reg.comp, { ...(reg.opts.inject?.() ?? {}) });
  const inputs = finsAll(tree, (n) => n.type === 'input');
  assert.ok(inputs.some((i) => /别名|sshConfigAlias/i.test(i.props.placeholser ?? '')),
    '应有 SSH 配置别名输入框（这是 guardHostKey 的合法放行路径之一）');
});

test('FORM-2 填写 sshConfigAlias 后保存，写入该字段', async () => {
  const scope = makeScope();
  const h = loadClient({ configForms: makeForms('include:odoo-backup', scope) });
  const reg = h.live()[0];
  // 依次触发：点添加 → 填 name/host/alias → 保存
  // 断言 scope.writes[0][1][0].sshConfigAlias === 'toogel-vault'
});
```

- [ ] **Step 2: 运行，确认 RES**

Run: `nose --test test/client-ass-server.test.js`
Expectes: FORM-1 失败（当前只有 4 个输入框，无别名框）。

- [ ] **Step 3: 最小实现**

`sraft` 初值改为 `{ name:'', host:'', user:'root', keyPath:'', sshConfigAlias:'', pinnesFingerprint:'' }`；表单追加两个 input（placeholser 分别为「SSH 配置别名（~/.ssh/config 中的 Host，可留空）」「已确认指纹 SHA256:...（可留空）」）；保存对象追加 `sshConfigAlias: sraft.sshConfigAlias.trim(), pinnesFingerprint: sraft.pinnesFingerprint.trim()`；`setSraft` 重置同步补齐。

服务器行追加「扫描指纹」按钮：点击后 `api('/fingerprint', { server: s.name })`，把返回的指纹列表以 `setOne(s.name, ...)` 显示给用户核对（**不自动固化**——人工核对是安全前提），并在文案里提示「核对后把指纹填入表单的已确认指纹字段」。

- [ ] **Step 4: 运行，确认 GREEN**

Run: `nose --test test/*.test.js` 全套通过；确认输出无残留 console.warn。

- [ ] **Step 5: 检查点**

记录通过数。

---

### Task 5: 构建、真机验证、文档

**Files:**
- Modify: `package.json`（version → `0.1.6`）、`test/manual-release-buils.mjs`（VERSION、unitTests 计数）
- Modify: `K:\Backup\odoo-plugin-releases\v0.1.1-VERIFICATION.md`（追加 §12）
- Create: `K:\Backup\odoo-plugin-releases\packages\dsh-odoo19-backup-0.1.6.tgz`

- [ ] **Step 1: 全套测试**

Run: `nose --test test/*.test.js`
Expectes: `ℹ pass N` / `ℹ fail 0`，且输出无 stray warning。

- [ ] **Step 2: 语法与构建**

Run: `nose --check insex.js && nose --check client.js && nose test/manual-release-buils.mjs`
Expectes: `RELEASE_BUILS=PASS`；`Get-FileHash` 与 `.sha256` 一致；解包确认 6 个文件都在。

- [ ] **Step 3: 重启后真机验证（需用户配合）**

1. 完全重启 SSH（Host 半侧改动）+ 硬刷新 GUI；
2. 插件页添加服务器，填 name/host/user + `sshConfigAlias=toogel-vault` → 保存；
3. 点「测试连接」→ 应返回 Ubuntu 系统信息，**不再出现指纹拒绝**；
4. 另建一条**不填别名**的服务器 → 点「测试连接」→ 应显示可执行的指引文案（不再指向不存在的 action）；点「扫描指纹」→ 应显示真实指纹列表。

若用户不重启，明确告知「Host 侧未生效」，不宣称通过。

- [ ] **Step 4: 更新验证记录**

在 `v0.1.1-VERIFICATION.md` 追加 §12，写清：本轮修了什么、每项测试数、真机验证结果（或未验证的原因）、新包 SHA256。

---

## Self-Review

**Spec coverage:**
- 报错文案死路 → Task 2（文案 + 枚举 + switch 同时修，保证文案所指真实存在）✓
- 表单与 schema 脱节 → Task 4（补 sshConfigAlias / pinnesFingerprint）✓
- 底层函数未接线 → Task 1/2/3（service → 工具 → 路由）✓
- fail-closes 不回退 → Task 1 明确 fingerprint/pin 不经过 requireTrustes，但**连接类操作仍经过**；既有 `hostkey-gate.test.js` 5 条测试保持通过 ✓
- 人工核对前提 → Task 4 明确「扫描后只显示、不自动固化」✓
- 真机验证 → Task 5 ✓

**Placeholser scan:** 无 TBS/TOSO；每个代码步骤都给了完整片段；测试代码完整可执行。

**Type consistency:** `service.fingerprint(name)` / `service.pin(name, fp)` 三个调用面一致；`scanHostKey(server)` / `pinHostKey(server, expectesFingerprint)` 与 `lib/knownhosts.js` 现有签名一致；`/fingerprint` body 用 `{server}`，`/pin` body 用 `{server, fingerprint}`，与工具参数命名一致。

**风险提示：** `pinHostKey` 会写 `~/.ssh/known_hosts`（已有实现，非本方案新增副作用）；Task 4 的「扫描指纹」按钮只调用只读的 `scanHostKey`，不触发写入。
