# 更新日志

[English Changelog](./CHANGELOG.md) · [README](./README.md) · [中文 README](./README.zh-CN.md)

`dsh-odoo19-backup` 的全部重要变更记录于此。`0.1.0`–`0.1.6` 为内部快照版本（大写包名 `@local/DSH-ODOO19-Backup`）；`0.1.7` 是首个公开 GitHub 版本，标识已全量小写。

格式参考 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)。日期均为 Asia/Shanghai（UTC+8）。

## [0.1.23] — 2026-11-11

**恢复在部署 addons/pydeps 之后现在会重启 Odoo——否则刚部署的模块永远不会被导入。**

### 背景（new.toogel.cn 全新部署的真机失败）
恢复到临时库验证阶段失败：`临时环境验证失败：V6 站点可访问`。目标机取证：

- `GET /` 与 `/web/login` 返回 **500**：`QWebError: AttributeError: 'website' object has no attribute 'clarity_project_id'`
- 备份库引用了模块 `website_clarity`（已安装，`19.0.1.0.0`）及其字段
- 磁盘上 `/mnt/extra-addons/website_clarity` **确实存在**（23 个模块已部署）——部署本身是成功的
- 但 Odoo 只在**进程启动时**导入模块 Python：容器 11:59 启动、部署 12:04 才发生，运行中的进程里没有 `website_clarity` 的模型 → 模板渲染 500

0.1.14 的修复把顺序做对了（先部署 addons 再碰数据库），但漏了一点：**Odoo 进程必须重启才能看到新代码**。在老的长生命周期容器上这一点被掩盖，全新容器立刻暴露。

### 新增
- `lib/restore.js`：`buildRestartOdooScript()`、`parseRestartResult()`、`shouldRestartAfterDeploy()`，以及阶段 A0b `phaseRestartOdoo()`——`docker restart` Odoo 容器后轮询 `/web/login`（60×2 秒）直到响应。**只在本次真的部署了 addons/pydeps 时执行**（不制造无谓停机），容器起不来时 fail-closed 并给出明确消息。
- 进度提示说人话：「正在重启 Odoo 以载入新部署的模块（期间站点短暂不可访问）」。
- `lib/diagnose.js`：新增 `object has no attribute` / `QWebError` / `Some modules are not loaded` 模式 → 解释「代码在启动后才部署」的原因并指向重启。

### 测试
**605 / 605**（基线 599 + 6：`RS-1..5` 重启脚本/解析/触发条件，`DIAG-9` 缺模块签名）。

### 安全 / 未变
授权、加密、令牌、切换/回滚状态机、数据库处理全部未改。重启发生在部署之后、数据库被触碰之前。

---
## [0.1.22] — 2026-11-11

**修复 0.1.21 引入的回归：重新挂载凭证时对只读 getter 赋值抛错。**

### 背景（用户在 0.1.21 后第一次真实恢复时命中）
点恢复立刻失败：

```
失败：Cannot set property credentials of #<Object> which has only a getter
```

0.1.21 把 `credentials` 的活引用 getter 装回了依赖袋（让 `ctx.inject(['credentials'])` 的延迟注入可见），但这个属性**没有 setter**。Host 路由每次请求都会调 `service.attachCredentials(credentials)`，内部执行 `d.credentials = credentials` —— 对只读 getter 属性赋值在严格模式（ESM 恒为严格）下是非法的。于是 `/precheck`、`/restore`、`/backup` 等所有 UI 请求都在动手前就抛错。

这是同一个底层错误的第三次出现（0.1.15 的 `.volatile()` 快照、0.1.21 的 getter 快照、这一次是**向 getter 写入**）：**在边界上把活引用当成普通值——这次发生在写方向。**

### 修复
- `lib/service.js`：只读 getter 依赖改为「getter + 影子槽 setter」成对安装——getter 优先返回活引用，活引用为空时回落到影子值。`attachCredentials()` 因此可用，同时不削弱延迟绑定。

### 测试
**599 / 599**（基线 597 + 2：`SVC-CRED-3` 在只读 getter 依赖上挂载凭证并证明挂载值确实被使用；`SVC-CRED-4` 忽略 null/非法参数且不破坏既有引用）。修复前 `SVC-CRED-3` 复现的正是线上原文。

### 安全 / 未变
凭据存储、加密、主机指纹闸门、令牌、恢复状态机全部未改。本修复只是让注入通道重新可写。

---
## [0.1.21] — 2026-11-11

**修复：`deps` 的 getter 在创建 service 时被快照，导致后注入的凭证服务对 Agent 工具永远不可见。**

### 背景（0.1.20 真机验收时发现）
0.1.20 的版本闸门对同一个备份包报 `源（备份包）：(未知)`，但直接读该包的 `MANIFEST.source.odooVersion` 明明是 `19.0-20260619`。闸门于是退化成「未知 → 放行 + 警告」，没有拦住 19→20 这一对。

根因：`createService()` 用 `{ ...defaults, ...deps }` 组装依赖。**展开会立刻求值 getter**，而 `index.js` 里 `get credentials() { return credsRef.current; }` 正是为 `ctx.inject(['credentials'])` 设计的延迟绑定通道——它在创建瞬间被冻结成 `undefined`。UI 路由没受影响是因为每次请求都显式 `service.attachCredentials(credentials)`；Agent 工具路径没有这个钩子，于是 `requirePassphrase()` 直接抛「凭证服务不可用」，工具读到的每个备份包都成了「无版本」。

这与 0.1.15 的 `.volatile()` 快照是同一类缺陷：**活引用在展开边界上被静默冻结成了值。**

### 修复
- `lib/service.js`：展开之后，把 `deps` 上自有属性的 getter/setter 按原描述符装回，后注入立即可见。普通值行为完全不变。

### 测试
**597 / 597**（基线 595 + 2：`SVC-CRED-1` 创建后才注入凭证，断言下一次调用即可读到；`SVC-CRED-2` 值变化后仍读到新值，并覆盖「展开后才定义 getter」的写法）。修复前 `SVC-CRED-1` 报的正是线上原文「凭证服务不可用（ctx.credentials 未注入）」。

### 安全 / 未变
凭据存储、R10 加密、主机指纹闸门、令牌、恢复状态机全部未改。本修复只是让「本来就存在的延迟注入」真正到达需要它的代码。

---
## [0.1.20] — 2026-11-11

**恢复前先用 Odoo 版本做闸门，且每次失败都必须自带解释。**

### 背景（用户实测的真实失败）
把 Odoo 19 的备份（`tg-odoo`，来自 `toogel` / `19.0-20260619`）恢复到 `new.toogel.cn` 失败，界面上只有一段原始堆栈：

```
odoo db load 失败 (rc=1)：… neutralize.py", line 47 …
psycopg2.errors.UndefinedColumn: column "is_live" of relation "payment_provider" does not exist
```

背后其实是两个独立缺陷：

1. **版本闸门是死代码。** `lib/verify.js` 的 `checkVersionCompatible()` 存在、也有单测，但**恢复链路从未调用它**。README 写着「跨大版本（19 → 20）按设计拒绝」，实际没有任何地方拒绝。目标机实测是 **Odoo 20**（`20.0-20261102`，镜像 `odoo:20.0`），于是 Odoo 20 自带的 `payment/data/neutralize.sql`（`UPDATE payment_provider SET is_live = False`）打在 Odoo 19 的表结构上——该表没有 `is_live` 列，`odoo db load -n` 在恢复中途崩掉。
2. **失败是黑盒。** 用户原话：「当备份或者恢复过程中有问题，应该有提示，然后再报失败，不能直接报失败」。一段堆栈不会告诉操作者下一步该做什么。

### 新增
- `lib/version-gate.js`：把备份包 `MANIFEST.source.odooVersion` 与目标机 `discover()` 到的 `odooVersion` 对比。跨大版本 → **在任何远端写操作之前拒绝**，并给出两个版本、原因和两条可选路径（换同大版本目标机 / 把 19→20 当升级项目做）。版本未知 → **放行但显式警告**（很早的备份包没有 `odooVersion`，不能因此永远无法恢复）。
- `lib/diagnose.js`：按模式解释失败。已知故障（neutralize/表结构不匹配、库已存在、磁盘满、SSH 指纹失败 vs SSH 认证失败、数据库连不上、超时）统一渲染成「原始错误 + 【诊断】原因 + 【建议】下一步」；未命中规则的错误**原样透出**，绝不伪装成已知原因。
- 预检给出结论：`GET /precheck` 返回 `sourceVersion` / `targetVersion` / `versionCheck` / `versionWarning`；版本可证明不兼容时返回 **409** 且**不发行 `confirmToken`**（注定失败的恢复无法被确认执行）。`odoo_restore` Agent 工具同样处理，并在渲染里打印「源（备份包）：… 目标机：…」。
- 恢复 Tab 在开始前显示版本行（`19.0-20260619 → 19.0-20261102（同大版本）`）。

### 修复
- `lib/service.js` 的 `runGuarded`（含无 stateDir 分支）把解释后的文本写入任务状态并重新抛出，UI 与 Agent 工具都能看到原因 + 建议。
- `lib/server-lock.js` 的 `saveAll`：状态目录在异步写途中被删除时，`rename` 会抛 `ENOENT`（表现为并发测试偶发失败）。锁只是指针而非真相源，改为优雅退化，不再让清理动作把正常流程判失败。

### 测试
**595 / 595**（基线 577 + 18：`DIAG-1..8`、`VG-1..6`、`SVC-VG-1/2`、`SVC-DIAG-3/4`）。`SVC-VG-1` 断言跨大版本时 `runRestore` **一次都不许被调用**；`SVC-DIAG-3` 断言真实失败文本现在必须带【诊断】与【建议】；`SVC-DIAG-4` 断言未知错误原样保留。

### 安全 / 未变
`guardHostKey` / `pinnedFingerprint`、R10 加密、口令凭据、`confirmToken` 语义、恢复状态机、任何授权边界**全部未改**。本版只增加了「动手前拒绝」与「人话解释」。

---
## [0.1.19] — 2026-11-11

**安全收敛：工具出口必须可无损 JSON 化；目标状态未知时，中立化卡片不再提供任何操作按钮。**

### 背景
2026-11-11 真机排障暴露三个互相独立的缺陷：

1. `discover()` 在发现实例时组装 `note: undefined`。DSH 对工具返回值做 lossless-JSON 校验，
   `undefined` 值会被整包拒绝——于是**发现成功**反而报 "value is not lossless JSON"，
   连接失败（note 为字符串）反而正常，出现「失败能用、成功报错」的误导签名。
   `lib/imports.js` 的 `error: ... : undefined` 同款。
2. 中立化卡片对**每一台**配置的服务器渲染（含生产机），且两个操作按钮不管状态是否
   读得出来都照样渲染。生产机没被误操作，只是因为状态读取恰好失败——是偶然防线，
   不是设计防线。
3. `/neutralize-status` 响应 `send(200, { ok: true, ...status })`：解析失败返回的
   `{ ok: false, reason }` 展开后覆盖 `ok`，且没有 `error` 字段，客户端只能显示
   无用的 "HTTP 200"。

### 修复
- `lib/discover.js` / `lib/imports.js`：可选的 `note`/`error` 键改为条件展开——没话可说就
  不出键，从构造上保证可无损 JSON 化。
- `client.js`：两个中立化操作按钮整体包裹进 `statusKnown`
  （`!st.err && stat && stat.ok !== false`）。状态未知时卡片只剩错误提示 + 刷新按钮——
  没有「保持中立化」，也没有「解除中立化（接管生产）」。
- `index.js` `/neutralize-status`：状态不可读改为 400 并携带真实原因，不再是 200 吞掉
  `ok:false`。
- `index.js` `/neutralize-apply`（release）：token 校验后追加 `status.ok` 复核，堵住
  precheck→apply 之间状态恶化仍放行 SQL 的窗口。

### 测试
**577 / 577**。新增：`LOSSJSON-1..4`（出口契约套件，含 helper 自证）、`NEUROUTE-9/10`
（status/apply 的状态不可读闸门）、`NEUUI-9`（状态未知不出操作按钮）。

### 已知边界（如实记录，本次刻意不捆绑）
- 「恢复目标机」语义目前用「状态可读」近似表达。持久化恢复任务记录作为显式的服务端
  授权边界，计划于 0.1.20 落地。
- `serverConnection()` 仍会剥掉 `dbName`，配置兜底库名传不进自动发现（既有问题，单独跟踪）。

---

## [0.1.18] — 2026-11-11

**修复 0.1.17 在真实运行验证中暴露的回归：重启后刷新页面看不到最近一次终态。**

### 背景
0.1.17 把 `transfer-state.json` 按服务器隔离后，无参 `/status`（设置页默认轮询口径）
只返回**活动**状态（`running`/`paused`）；全部任务结束后返回 `taskId: null`。
同一 Host 进程内不会暴露问题（内存指针仍指向该服务器），但只要 DSH 重启再刷新页面，
上一次 `completed` 就再也显示不出来 —— 违反规格 §6.1「刷新后 UI 从该文件读取并正确恢复
最终状态（completed/failed/cancelled 均持久化，不回退成 0% 或『进行中』）」。

### 修复
- `lib/service.js` 的无参 `status()`：先取 `updatedAt` 最新的活动状态（避免刚完成的旧终态
  盖住正在跑的任务）；无活动任务时回落到 `updatedAt` 最新的终态。`running` 仍严格由
  `status === 'running'` 决定，终态绝不误报为进行中。
- 旧全局文件的归属过滤保持不变（`serverConfigId` 与已配置服务器不符时跳过）。

### 测试
**570 / 570**。`V17-S3` 改为断言「重启后无参 `status()` 必须能返回某个服务器的真实终态，
且 `running === false`」——这条断言正是本次回归的直接护栏。
---

## [0.1.17] — 2026-11-11

**任务状态轮询修复 + 状态文件按服务器隔离。**

### 背景（真机缺陷）
备份跑得很正常，但界面在「点击开始备份」后**看不到进度条**；必须退出插件设置页再重新进入，进度条才出现。

根因是客户端两个缺陷叠加，且都有一个共同前提：`transfer-state.json` 从未被清理（终态会长期残留）。

1. **终态停表**：组件首次轮询读到磁盘残留的 `completed`，立刻 `clearInterval`，此后不再请求 `/status`。新任务开始后，磁盘里的 `running` 与 `percent` 再也没有人读。
2. **旧终态阻挡新任务**：即使轮询继续，接管条件 `prev.taskId === data.taskId || !terminal.includes(prev.status)` 也会因为「上一轮是终态」而拒绝写入新 taskId。

服务端写入一直是正常的（`progressReporter` 每次进度事件都原子落盘）——故障只在客户端消费环节。

### 修复（用户裁决范围）
- **移除终态停表**：轮询只在组件卸载时清理；1.5s 本地请求成本极低且天然自愈。
- **修复不同 taskId 的状态接管**：新任务按可解析的 `updatedAt` 判新旧后接管；时间戳缺失/无效时不以旧终态无限期压制新任务。
- **防旧请求乱序覆盖**：轮询加入单调递增请求序号（`pollSeq`），晚返回的旧响应直接作废，不落状态。
- **开始任务时清旧终态**：点「开始备份/恢复」立即清除上一次的终态显示。
- **状态文件按服务器隔离**：`<stateDir>/<serverConfigId>/transfer-state.json`，取代全局单文件 `transfer-state.json`。两台服务器并发备份不再互相覆盖状态；锁键同步升级为稳定的 `serverConfigId`（摘要只含 `host/port/user/sshConfigAlias`，**不含可改名的 `name`**），服务器改名后任务归属、锁与状态目录不变。
- **旧全局状态文件兼容读取**：仅当旧文件的 `serverConfigId` 与请求者一致（或无该字段、视为未归属）时才回读，绝不把旧全局文件复制成所有服务器的状态；旧文件保留在磁盘，不自动删除、不自动迁移。

### 明确不做（裁决保留项）
- HTTP 202 异步化、WebSocket/SSE 实时推送：暂缓。
- 终态状态文件自动清理：不做（残留终态本身无害，轮询已不再依赖它停止）。

### 测试
**570 / 570**（基线 559 + 新增 11：`V17-C1..C4` 客户端轮询/接管/乱序，`V17-S1..S7` 按服务器隔离、两服务器并发、改名后归属不变、旧全局文件兼容读取、`status(server)` 重启恢复）。既有 `SVC-1..SVC-6` 改为按服务器目录读取后全部通过。

---

## [0.1.16] — 2026-11-10

**Agent 工具输出契约修复：`listServers` 返回裸数组，而 `output.schema` 声明的是 `type: object`。**

### 背景（真机缺陷，距 0.1.15 发布仅数分钟）
volatile 修复到位后，`odoo_backup { action: "listServers" }` 越过了崩溃，却在下一层被拦住：

```
Error: tool "odoo_backup" returned invalid output: "value" must be an object
```

Host 会用工具自己声明的 `output.schema` 校验返回值，而 `odoo_backup` 声明的是 `type: object`，但 `listServers` 分支返回的是普通数组。这个缺陷被 0.1.14 的崩溃**掩盖**了：代码根本走不到输出校验那一步。其他 action 返回的都是对象（service 的结果），只有 `listServers` 例外。

### 修复
- `lib/tools.js`：`listServers` 改为返回 `{ ok: true, servers: [...] }`，与其他 action 及声明的 schema 一致。
- `listServers` 的 `render` 改为读 `value.servers`（仍兼容旧的裸数组），空列表提示保留。

### 测试
**559 / 559**（基线 557 + 新增 `TOOLVOL-7` 对照 `output.schema.type` 的对象形态契约、`TOOLVOL-8` 对象形态与空列表的 `render`）。`TOOLVOL-1/5/6` 与「`listServers` 只暴露非敏感字段」先改为对象形态并**先失败**，正是这一步让契约不一致暴露出来。`node --check` 30/30 文件通过。

### 安全边界 / 未变
授权、加密、`confirmToken`、恢复状态机与全部 Host 路由均未改动。

---

## [0.1.15] — 2026-11-10

**Agent 工具崩溃修复：`Config.servers` 在运行时是 `.volatile()` 的 `{ get() }` 活引用，而 `lib/tools.js` 把它当普通数组读了。**

### 背景（真机缺陷）
v0.1.14 按 GitHub pin 装好、重启后，两个 Agent 工具第一次真实调用就报错：
- `odoo_backup { action: "listServers" }` → `((intermediate value) ?? []).map is not a function`
- `odoo_backup { action: "test", server: "toogel" }` → `list.find is not a function`

根因：`Config.servers` 带 `.volatile()`（`dsh-settings` 只允许运行时写 volatile 字段），所以运行时读到的是 `{ get(): T }` 活引用而不是数组。Host 路由层早就处处解包（`v0.1.13` 就修过同类问题：`/precheck`），但 `lib/tools.js` 的 `findServer()` 与 `listServers` 分支仍是 `config?.servers ?? []` 后直接 `.find()` / `.map()`。两个工具的**每个**动作都要过 `requireServer()`，所以 **Agent 工具整条路径都不可用**，而设置页因为走 HTTP 路由一直正常。

测试为什么没测出来：单测注入的是普通数组，从未经过 volatile 包装。

### 修复
- 新增 `lib/config-value.js`：把 `unwrapVolatile()` 从 `index.js` 移出（工具层可直接 import，不产生循环依赖），并新增 `unwrapVolatileList()` 保证返回数组。
- `lib/tools.js`：`findServer()` 与 `listServers` 分支改为 `unwrapVolatileList(config?.servers)`；字段缺失/为空时返回 `[]` 而不是抛错。
- `index.js`：改为从 `lib/config-value.js` 导入并 re-export，所有既有调用点与按源码断言的测试口径不变。

### 测试
**557 / 557**（基线 551 + 新增 `TOOLVOL-1..6`：volatile 下的 `listServers`、其他动作按 volatile 配置解析服务器、未知服务器仍按「未找到」拒绝、`odoo_restore precheck` 在 volatile 配置下可用、普通数组回归、`servers` 缺失/为空返回空数组）。新增测试在修复前**逐字复现**真机报错（`list.find is not a function`、`((intermediate value) ?? []).map is not a function`），修复后全绿。`node --check` 30/30 文件通过。

### 安全边界 / 未变
`requireTrusted` / `guardHostKey` / `pinnedFingerprint`、R10 加密、Passphrase Credentials、`confirmToken` 语义、恢复状态机与全部 Host 路由**均未改动**；只是工具层读取配置字段的方式变了。

---

## [0.1.14] — 2026-11-09

**恢复包路径易用性修复：粘贴带引号路径不再报「备份包不存在」，备份成功后自动回填最终 `.tar.enc` 路径。**

**界面宿主迁移：整个操作界面从「已安装插件」的配置卡片，迁到 DSH 原生设置页的独立页面。**

### 恢复后中立化状态管理：保持 / 解除（用户裁决 2026-11-10）
- **背景**：恢复出来的库若在 Odoo 里做过 neutralize（或恢复时勾选中立化），邮件外发、定时任务、支付提供商全被停掉并写入 `database.is_neutralized`。此前要接管生产必须登服务器手改数据库，闭环断在最后一公里。
- **能力**：设置页「恢复」页新增**中立化状态卡片**——展示目标库名、是否中立化、cron 启用/停用数、占位与真实邮件服务器数、支付启用/禁用数，并提供**「保持中立化」与「解除中立化（接管生产）」两个按钮**。
- **安全边界（关键）**：
  - **解除必须过 confirmToken 闸门**（绑定 `server` + `action` + `dbName`，一次性、5 分钟有效）。「保持」不写库、不触达远端，因此不需要 token。
  - **解除前先预检**，把全部不可逆事项逐条列在 UI 上，用户再点独立的「确认解除」才提交。不使用 `window.confirm`（Electron 不实现）。
  - **绝不猜支付提供商**：Odoo 的 `payment/data/neutralize.sql` 只做 `UPDATE payment_provider SET state='disabled'`，不记录原本哪些 enabled，恢复库无法推知。因此**默认全部保持禁用**，只有用户在输入框显式给出 code（逐项 `^[a-z0-9_]{1,64}$` 校验）才启用。
  - **SMTP 凭据不可还原**：中立化时 `smtp_user`/`smtp_pass` 已被清空，解除后必须人工到 Odoo 后台重填，UI 明确告出。
  - **启用全部 cron 是既定行为**：`UPDATE ir_cron SET active=true` 会连同原本就 disabled 的一起启用（真机源库 36 启用 / 7 停用），UI 展示将启用的数量并由用户确认。
  - 解除后自动 `docker restart` 目标 Odoo 容器，并提示确认 `max_cron_threads ≥ 1`（该值在未挂载的 conf 里，插件不改 conf）。
- **真机验证（只读）**：目标机 `toogel` 状态探针实测 `flag=true`、cron 1/42、占位邮件 1、真实邮件启用 0、支付 0/26，`parseStatus` 解析全对。
- **测试**：NEU-1..12、NEUSVC-1..7、NEUROUTE-1..8、NEUUI-1..8 全部经 RED→GREEN；全量 551/551。

### 恢复必须部署 addons / pydeps（真机缺陷修复，2026-11-09 第二次恢复失败）
- **现象**：恢复报 `临时环境验证失败：V6 站点可访问`。数据库已恢复（133 MB）、filestore 已建立，但站点返回 500。
- **根因**：恢复流程**只检查 addons 权限，从不部署 addons/pydeps**。备份包内明明有 `addons-*.tar.zst`（45 MB）与 `pydeps-*.tar.zst`，却被丢弃。目标机 addons 目录为空 → `website_clarity` 等自建模块缺失 → registry 加载时字段不存在 → `website.layout` 渲染报
  `AttributeError: 'website' object has no attribute 'clarity_project_id'` → 首页 500。
- **修复**：
  - `extractBundle()` 同时抽出 `dump.zip` / `addons-*.tar.zst` / `pydeps-*.tar.zst` 三个组件（原先只抽 dump.zip）。
  - 新增**阶段 A0 部署组件**，严格位于数据库恢复之前（registry 加载时扫描 addons，代码不在的模块被静默跳过，只在渲染时才 500）。
  - `detectAddonsPrefix()` 按包内首项判定是否 `--strip-components`：备份用 `tar -C "$ADDONS" -cf - .` → `./` 前缀 → **不 strip**；若为 `addons/` 前缀则 strip 1。
  - 部署后 `chown -R <容器 uid>:<gid>`、补齐目录执行位（缺执行位会让 Odoo 静默跳过整个模块目录）。
  - 校验模块数：**为 0 判失败**并中止，绝不带着空 addons 继续做数据库恢复。
  - zstd 缺失、解压失败、包不存在 → 明确报错，不静默跳过。
- **真机验证**：真实 45 MB addons 包上传后部署 → 23 个模块、`website_clarity` 就位、`clarity_project_id` 定义存在；重启后 `/`=200(68456) `/shop`=200(292458) `/web/login`=200(39224)，日志无 error。

### 恢复后数据库签名密钥隔离（用户裁决 2026-11-09）
- **问题**：备份包把来源库的 `database.secret` 一并带到目标库，恢复后两套环境共用同一签名密钥（用于 CSRF token、Portal 访问令牌、退订链接、附件签名）。Odoo 的 `neutralize.sql` **不会**重签它。
- **能力**：新增「恢复后重新生成数据库签名密钥」，**默认开启**，允许用户主动取消。
- **作用范围**：只改目标库那一个 `database.secret` 行；生产库不读不写，其已发出的链接照常有效。失效的仅是目标库中少量用旧密钥签发的令牌——这正是环境隔离的目的。
- **随机性**：用 PostgreSQL `gen_random_uuid()`（PG13+ 内建强随机），**不用**时间戳/`random()`/库名派生。
- **时机**：阶段 D 停机切换之后、阶段 E 最终验证之前（目标库已是正式库、站点对外开放前）。
- **失败处理**：`rc≠0`、`changed=f`、密钥为空、无 `database.secret` 行，一律判失败并抛出 → 走既有回滚，恢复结果如实反映，绝不静默显示成功。
- **不记录明文**：脚本只回报 `before_len`/`after_len`/`changed`；结果对象、状态文件、UI 均不含密钥。
- **未做**（按裁决）：不重生成 `database.uuid`、不改 1Panel Compose、不做其他环境中和。

### 数据库名自动化：源库名读包、目标库名自动发现（2026-11-09）
- **源库名不必手填**：备份包内 `MANIFEST.json` 本就记录了 `source.dbName`（实测该包为 `tg-odoo`）。新增 `lib/package-meta.js` 只读抽取该成员（加密包先解密），**未新增任何元数据格式**。
- **目标库名自动发现**：新增 `lib/dbname-autodiscover.js`，按 `server.dbName`（显式，最高优先）→ `dbfilter` → `db_name` → PostgreSQL 库列表（排除系统库与超级用户同名库，恰一个才采用）逐级解析。
- **概念严格分离**：`pgSuperUser`（实测该机为 `pgsql`）是 PostgreSQL 角色，不是数据库名，其同名库被排除；`dbfilter` 与 `db_name` 是两种配置，分别解析。
- **源/目标边界**：`sourceDbName` 只说明备份来自哪里、仅用于展示与同名提示；`targetDbName` 才决定覆盖哪个库。两者同名也**不会**用源库名去决定覆盖位置。
- **自动持久化**：`/discover` 与 `/precheck` 在自动识别成功且该服务器未手填库名时，把**目标**库名写回服务器配置；人工已填写的值绝不被覆盖；歧义（多候选）时 fail-closed 不写，并给出可操作提示。
- **预检展示**：`/precheck` 返回 `sourceDbName` / `targetDbName` / `conflict` / 原因；恢复页先展示「来源库 / 目标库」，目标库无法可靠确定时**不发起** `/restore`。token 仍只绑定服务器与包路径，库名不进绑定。

### 目标库名解析（真机缺陷修复，2026-11-09）
- **根因**：目标机 `odoo.conf` 的 `dbfilter` 被注释掉 → `parseDbFilter()` 返回空串；而 `discover()` **从不读取服务器配置里的 `dbName`**（该字段声明了却从未被使用）。于是恢复带着空库名进入执行阶段，报出无法定位的 `不安全的数据库名：（空值或过长）`。
- **修复**：
  - 新增 `resolveDbName({ configured, confText })`：**显式配置优先**，其次 `dbfilter`；两者都没有返回空串，**绝不猜测**要覆盖哪个库。
  - `discover()` 的 Docker/裸机两条路径都改走它。
  - 恢复入口新增 `requireTargetDbName()` 前置校验：库名为空时在解密/上传/动库**之前**就失败，错误明确指向「服务器页填写数据库名」并解释 `dbfilter` 缺失。
  - 服务器表单新增「数据库名」输入框（留空=从 dbfilter 解析）。
- **顺带修复配置丢失**：编辑服务器时 `nextServer` 改为先展开既有配置，避免「只想填库名」却把 `odooContainer`/`pgContainer`/`dataPath` 等未展示字段清空。

### 恢复健壮性（真机缺陷修复，2026-11-09）
- **空白目标机不再 `DUMP_FAIL`**：阶段 A「安全备份」原先无条件对目标库执行 `odoo db dump`，而全新服务器的库是空壳库（0 张表、无 `ir_module_module`），`dump_db_manifest` 必然 `UndefinedTable` 失败，导致整单恢复中止。
- **「缺 Odoo 系统表」不等于「库为空」**（边界修正）：安全备份现在区分四种情况，只在前两种跳过——
  1. 库不存在 → 跳过（`no_db`）；
  2. 库存在且 **0 张用户表** → 跳过（`empty_db`）；
  3. **库存在、有表、但没有 Odoo 系统表** → 这是真实数据，**绝不跳过**，改用 `pg_dump -Fc` 做逻辑备份（`format=pgdump`，无 filestore 语义）；
  4. 正常 Odoo 库 → `odoo db dump`（zip，含 filestore）。
  
  判定空库只认「用户表数量确实为 0」；探测失败（空值）绝不等于空库，会继续走备份让真实错误暴露。
- **不再吞掉 dump 的 stderr**：原实现 `2>/dev/null` 只留一个 `DUMP_FAIL`，无法诊断；现在把 stderr 落盘并在失败时回传尾部若干行。
- **恢复后自动切换站点域名**：备份来自生产库，`website.domain` / `web.base.url` 仍是 `www.toogel.cn`，原样恢复到另一台服务器会与生产抢同一域名。新增阶段 D2：把目标站点域名改为**设置页配置的「恢复目标域名」**（留空则自动用服务器名，仅当服务器名形如 `odoo.toogel.cn`）；同时改 `web.base.url` 并写入 `web.base.url.freeze=True`，随后重启容器使缓存失效。域名切换失败**不触发回滚**（数据已切换成功，域名可人工更正），只在结果与进度里明确报告。
- **设置页新增可编辑「恢复目标域名」**：留空 = 自动用服务器名；填写值必须是主机名（前端与 Host 双侧校验，非法值不落盘、不发送）。域名在恢复执行时由 Host 读取配置，**不从前端请求体注入**。对应路由 `GET/POST /odoo-backup/restore-domain`，写入 `restoreDomain`（volatile）。
- 新增 `lib/site-domain.js`：`isHostname` / `resolveTargetDomain`（显式 override 需通过主机名校验，防注入）/ `buildDomainPatchScript` / `parseDomainPatch`。

### 界面宿主迁移（Settings Host Migration）
- 注册宿主由 `plugins.bundle.config`（已安装插件里的配置卡片）改为 `settings.section`（DSH 原生设置页，`id: odoo-backup`、`order: 210`），并注册同 id 的 `settings.section.icon` 导航图标。
- 旧入口移除：`apply` 内不再出现 `plugins.bundle.config` 注册，避免同一功能两处入口。
- 页面内仍是原有三个 tab（服务器 / 备份 / 恢复）与全部既有能力：服务器增删改、SSH 指纹信任、连接测试、Passphrase Credentials、本地备份目录、备份与真实进度条、断点续传、取消任务、互斥锁、恢复预检与执行、最近备份回填。
- 后端零改动：`lib/service.js`、`lib/backup.js`、`lib/restore.js`、`lib/task-state.js`、`lib/server-lock.js`、`lib/crypto.js`、`lib/knownhosts.js` 与 `index.js` 全部路由未改。
- 接口依据（安装源码实证）：`settings.section` 为 list 型 root 作用域插槽，注册项 `{ id, order, label }`，组件收 `{ close }`；`slots.inject` 与 `register` 均返回 disposer，重挂前先 dispose 保证刷新不重复注册。
- 新增 `locale/*.json` 的 `settings.nav` 文案（zh: Odoo19 备份与恢复 / en: Odoo19 Backup & Restore）。

### 背景（真机缺陷）
用户从日志/JSON 复制路径时连引号一起粘贴（`"K:\Backup\odoo\...\odoo-backup-202609.tar"`），或误选分片工作目录中的**明文 `.tar`** 中间产物，恢复直接报 `备份包不存在："K:\..."`。根因：四处入口都只把输入原样传给 `stat()`，既不去引号，也没有把「最终加密产物」明确告知用户。

### 新增
- `lib/restore-path.js`：`normalizeRestorePath()` 纯函数——`trim` 首尾空白、**仅**移除一对完整匹配的英文双引号、Windows 场景把 `/` 统一为 `\`；单侧/不匹配引号一律保留，不猜路径。
- `lib/completed-package.js`：`resolveLastBackup()` 只读解析磁盘 `completed.json`，返回权威 `localPath`；必须同时满足 `completed===true`、路径以 `.tar.enc` 结尾、文件存在且非空、`detectFormat()` 确认加密，否则拒绝回填（**绝不回填分片目录中的明文 `.tar`**）。
- Host 路由 `GET /odoo-backup/last-backup`：只依据磁盘状态与服务端校验，不信任前端传入路径。
- 恢复页明确提示：正确格式 `.tar.enc`、不要选分片目录中间文件、执行前确认备份时间点与目标数据库；placeholder 改为真实 `.tar.enc` 示例。

### 变更
- 恢复入口统一规范化：`service.restore`、Agent 工具 `odoo_restore`、Host `/precheck` 与 `/restore`、Client 恢复按钮，全部复用同一规则（Client 侧内联同语义实现，因两侧模块作用域隔离）。
- `odoo_restore` 的 `confirmToken` 绑定值改为规范化后的路径，因此「引号版 precheck + 无引号版 restore」也能正确配对，而**换包仍被拒绝**。
- 备份成功后由 UI 调用 `/last-backup` 回填恢复输入框；仅在备份后端确认成功时调用，失败/取消分支不调用、不覆盖用户已填路径。
- 规范化之后仍执行原有存在性、格式与加密检查，顺序不变。

### 安全 / 保持不变
`requireTrusted`/`guardHostKey`/`pinnedFingerprint`（SSH 主机指纹）、R10 `encryptFile`/`decryptFile`、Passphrase Credentials、`confirmToken` 一次性+5 分钟+绑定目标、明文备份拒绝、`runRestore()` 状态机与 verify-then-switch 流程**全部未改**。路径规范化只改变字符串表示，不降低任何校验。

### 测试
**410 / 410**（基线 377 + 新增 33：`PATH-1..11` 规范化边界、`CP-1..9` completed.json 校验与拒绝回填、`FLOW-1..12` 四入口一致性与安全不变量、`FILL-1..3` 行为级回填）。`FILL-1` 经「临时移除回填 → 失败 → 恢复 → 通过」验证测试有效；全量套件无回归。

---

## [0.1.13] — 2026-11-09

**SCP 大文件分片、断点续传、统一任务状态、P0 服务器互斥、真实进度条。**

### 新增
- `lib/chunks.js`：分片计划（100 MiB 片、≥100 MiB 阈值）、Manifest、分片/全量 SHA-256 校验、组装顺序守卫。
- `lib/chunk-transfer.js`：远端 `split` → 逐片 SCP（复用 `buildScpArgs`）→ 临时片 → 大小+SHA 校验 → 原子 rename → 重验真实文件续传 → 组装 → 全量 SHA；全部通过后**才**走现有 `encryptFile`（R10 时机/格式/恢复入口不变）。
- `lib/chunk-control.js`：真实暂停/继续/重试/取消（终止 SCP 子进程、同 taskId 单活动执行者）。
- `lib/task-state.js`：`transfer-state.json` 唯一持久化状态源；六态生命周期；taskId/kind 隔离；原子写；`completed` 仅后端确认后置位。
- `lib/server-lock.js`：**P0 服务器级互斥**——同一服务器一个备份/恢复任务；原子获取；锁关联 taskId/kind/status；终态释放；重启遗留/损坏锁 fail-closed，未经确认不判空闲。UI 与 Agent 工具全部入口经过。
- `lib/backup-directory.js` + `backupDirectory` 配置：验证/创建/可写探测、fail-closed、旧任务绑定原目录。
- 前端：备份与恢复**真实进度条**、轮询 `/status`（磁盘状态、非 localStorage）、网络中断≠失败、终态停轮询、暂停冻结、互斥按钮禁用+原因、目录面板。
- `/status`、`/task-lock`、`/task-lock/confirm-stale`、`/backup-directory` 路由。

### 安全 / 保持不变
`guardHostKey`、`pinnedFingerprint`、`requireTrusted`、`buildScpArgs` 安全参数、R10 `encryptFile`/`decryptFile`、Passphrase Credentials、备份格式、`detectFormat()`、`runRestore()` 状态机、fail-closed 全部未改。不引入密码认证、不 `accept-new`。SHA-256 只验证完整性，不证明 Manifest 来源真实性。

### 测试
**364 / 364**（70+ 条 v0.1.13 新用例覆盖规格 37 项矩阵）。真机验收（≥500 MB、人为中断、DSH 重启、已校验片不重复下载、恢复入口）单独记录，**不以单测通过冒充验收通过**。

### 规格与源码的最小调整（记录原因，以保护数据安全为前提）
1. `completed` 以 `result.ok === true` 作为后端确认；分片/加密证据由 chunk-transfer 写入后再收紧，不伪造 integrity 标记。
2. `chunk-transfer` **不**自行写 `transfer-state.json`；状态返回给 `service.progressReporter` 统一写盘（避免两套状态源互相矛盾）。
3. 失败时**保留**远端 tar/分片供续传（旧代码会删除），符合 §13。
4. `backupDirectory` 标记 `.volatile()`，复用既有 `settings.update` 机制持久化（与 `servers` 相同）。

---

## [0.1.12] — 2026-11-07

**scp 支持 sshConfigAlias，传输进度真实可见。**

### 问题
真机备份 `toogel`（靠 `sshConfigAlias: toogel-vault` 认证）SSH 命令能连上，但 scp 阶段 `Permission denied (publickey,password)`——`scpDownload`/`scpUpload` 只用 `keyPath`，而 `buildSshArgs` 早已支持别名。另外 563.8MB 传输期间进度卡在 `transferring 60%` 约 24 分钟。

### 新增 / 修复
- `lib/ssh.js`：`buildScpArgs(server, {direction, remotePath, localPath})`——别名机型用 `<alias>:<path>`，由 `~/.ssh/config` 提供 HostName/User/IdentityFile；`BatchMode=yes` 与 `StrictHostKeyChecking=yes` 始终保留。`parseScpProgress()`、`computeTransferPercent(localBytes, expectedBytes)`。
- `backup.js` / `restore.js`：两处 scp 都改用 `buildScpArgs`，不再手工拼 `user@host`。
- `backup.js` 的 `scpDownload`：进度以**轮询本地文件大小**对比远端 `outerSize` 为准（OpenSSH 的 `%` 进度条只在 tty 输出，我们 spawn 用 pipe 时静默）；百分比映射到 transferring 阶段 60–80%，显示「正在下载备份单元 N%」；成功/失败/超时均清理定时器。

### 安全
- 不引入密码认证、不 `accept-new`；`guardHostKey`、fail-closed、R10、加密、恢复状态机全部未改。别名信任仍由用户自己的 `~/.ssh/config` 承担。
- 新增 12 条测试（SCP-1..12）；全套 **293 / 293**。

---

## [0.1.11] — 2026-11-07

**备份加密口令迁移到 DSH 官方 Credentials 服务。**

### 问题
「开始备份」被拒「未配置加密口令…请先在插件设置页填写」——但该入口**不存在**：自定义卡片没有口令输入框，原生设置页只渲染 `.volatile()` 字段（仅 `servers`），口令无处可填。

### 新增
- `lib/service.js`：`requirePassphrase()` 每次执行时从注入的 `credentials` 服务解析 `ODOO_BACKUP_PASSPHRASE`（不缓存）；备份与恢复共用；调用方 `opts.passphrase` 不再静默覆盖统一凭证；遗留 `config.passphrase` 值被忽略。
- `index.js`：`POST /passphrase-status`（只回 `{configured, source}`，绝不回值）、`POST /set-passphrase`（空值拒绝、响应不回显）、`POST /unset-passphrase`（删除后重读状态）；注入扩展为 `['webServer','settings','credentials']`。
- `client.js`：备份 Tab 口令区块（状态行 + `type="password"` 输入 + 保存/更新/清除），`useEffect` 加载状态；**成功后才清空输入**，失败保留并报错；恢复 Tab 显示共用状态；离线保管警告（口令丢失则历史备份无法解密）。

### 安全
- 口令不进 `cordis.patch.yml`、不出现在 `/servers`、状态响应或日志（CRED-8/13/14 断言）。DSH Credentials 存储为 `$DSH_HOME/.credentials.yaml`（0600/0700、所有者校验）——明确接受为「权限保护的明文存储」，**不是加密保险库**。
- R10 强制加密、加密格式、恢复状态机、`guardHostKey`、`volatile` 机制不变。指纹闸门仍在任何远端访问前拒绝；口令检查现在最先执行（不触达任何远端）。
- 新增 14 条测试（CRED-1..14）；全套 **278 / 278**。

---

## [0.1.10] — 2026-11-07

**本机私钥路径改为文件浏览器选择，不再需要自己输入路径。**

### 变更
- 信任面板的「本机私钥路径」手输框改为**「选择私钥文件」**按钮 + 隐藏 `<input type="file">`。
- 选中后用桌面端官方桥 `globalThis.__DSH_HOST_PATHS__.pathFor(file)`（Electron `webUtils.getPathForFile`）取得**真实绝对路径**，回写面板 `keyPath` 状态；路径显示在**只读**框里。
- 保留**「手动输入路径」**降级入口：非桌面/浏览器环境拿不到真实路径时给出明确内联提示。
- 隐藏 input 用 `data-trust-file-input="<服务器名>"` 精确归属，多台服务器同时展开不会点错。

### 安全
- **只取路径**：私钥文件绝不读取、绝不上传、绝不进入任何请求体——无 `FileReader`、无 `readAsText`、无文件对象入 body（`PICK-3` 断言）。
- `guardHostKey` 三放行、fail-closed、`requireTrusted`、`/trust-host`、`/client-pubkey`（只读 `keyPath + '.pub'`）、`.volatile()` 机制**全部未改**。
- `PICK-1..6` 回归测试；全套 **265 / 265**。

---

## [0.1.9] — 2026-11-07

**信任面板内自助填写 keyPath** —— 修掉「以后每台新主机都会卡住」的引导断点。

### 问题
新主机 `new.toogel.cn` / `154.21.201.22` 上，信任面板的「读取本机公钥」报「未配置 keyPath…请先填写私钥路径」，
但**面板里没有 keyPath 输入框**——用户得关掉面板、点「编辑」、在别处填私钥路径、再重新打开。每台新主机都会重演。

### 修复
- `TrustHostPanel` 内联新增「本机私钥路径」输入框，打开面板时自动带入该服务器已有的 `keyPath`。
- `doLoadPubkey` 改用面板里的 `keyPath`；为空时给出**面板内**引导（指向上方输入框），不再发注定失败的 API 请求。
- 面板文案明确区分两个方向相反的公钥：扫描值是**服务器主机公钥**（服务器证明自己是谁），
  发给所有者的是**本插件客户端公钥**（我们证明自己持有私钥），不再混为一谈。

### 安全
- `guardHostKey` 三放行、fail-closed、`requireTrusted`、`/trust-host`、`/client-pubkey`、`volatile` 机制**一行未改**。
- `/client-pubkey` 仍只读 `keyPath + '.pub'`；私钥绝不读取、返回或记录。
- `UI-8..12` 回归测试（含「安全逻辑未改动」断言）；全套 **258 / 258**。

### 验证
- 全套 258/258；语法干净；`RELEASE_BUILD=PASS`；产出 `dsh-odoo19-backup-0.1.9.tgz`。

---

## [0.1.8] — 2026-11-07

**SSH 主机安全接入体验完善** —— 首次主机信任与公钥认证在界面内成为两套清晰分离、可自助完成的流程。

### 新增
- `lib/trust.js`：`normalizeFp`、`verifyFingerprint`（SHA256 + 公钥类型双重比对）、`confirmTrust`（重新核对 host/port/user 与扫描时一致、拒绝复制扫描值自证）、`applyTrust`（**只**写 `pinnedFingerprint`）、`isTrustValid`（信任不迁移到变更后的目标）、`validatePublicKey`、`publicKeyPathOf`（只构造 `.pub` 路径）、`fingerprintCommand`，以及**幂等**的 `authorizedKeysCommand`（不覆盖、去重、chmod 700/600、执行后自查）。
- Host 路由：`POST /client-pubkey`（只从 `keyPath + '.pub'` 读公钥，**绝不读取/返回/记录私钥**）、`POST /trust-host`（重新扫描 → 身份重核 → 指纹/类型比对 → 只更新 `pinnedFingerprint`）、`/servers` 增量返回信任字段。
- Client `TrustHostPanel`：每台服务器「信任主机 / 编辑 / 重新扫描」按钮，分离显示**主机身份**与**登录认证**状态，给出本机公钥、幂等安装命令、`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`、所有者回传指纹输入框，且仅回传值与扫描值一致时才启用确认。

### 修复
- 删除误导性的 `action=pin` 指引：`pin` 只写 `known_hosts`，从不写 `pinnedFingerprint`，照做永远无法建立信任。拒绝文案现明确区分主机身份核验与登录认证。
- `classifySshError` 对认证失败 / 主机密钥失败 / 超时 / 拒绝连接分别给出提示。

### 安全
- 主机指纹核验与客户端公钥认证保持**两套独立机制**；不自动信任、不以 `known_hosts` 为信任依据、任何 API 响应与日志都不含私钥。
- `guardHostKey` 三条放行路径、fail-closed、`requireTrusted`、`volatile` 配置机制**均未改动**。
- 新增 27 条测试（TRUST-1..14、API-1..6、UI-1..7）；全套 **253 / 253**。
- `/pin` 路由保留兼容旧 Agent 调用，但不再从界面暴露。

### 真机验证
- 正确指纹 + 正确公钥 → `/test` 200 `ok=true`；错误指纹 → 400「主机密钥与固化值不一致，可能被中间人攻击」；错误/未授权公钥 → `Permission denied` / `Identity file not accessible`（认证错误，非指纹错误）；既有 `toogel`（sshConfigAlias）仍 200 `ok=true`。

---

## [0.1.7] — 2026-11-06

**首个公开 GitHub 版本。全量小写，可直接从 GitHub 安装。**

### 新增
- 公开仓库 `SamHo7524/dsh-odoo19-backup`，tag / Release `v0.1.7`，发布包 `dsh-odoo19-backup-0.1.7.tgz`（SHA256 `5adf7093929642aa3d129e99a9f1438503dee0e55ba0ace37d86bf5445dd2b97`），已验证匿名下载且哈希一致。
- 中英文 `README.md` / `README.zh-CN.md` 与 `CHANGELOG.md` / `CHANGELOG.zh-CN.md`。
- `LOWER-1..7` 回归测试：全库大写标识扫描 + 包名 / patch / client / locale / 构建脚本名称一致性。

### 变更
- 包名 `@local/DSH-ODOO19-Backup` → **`@local/dsh-odoo19-backup`**；locale 标题、界面标题、console 前缀、tgz 名、patch name、契约测试断言全部小写。
- profile 安装从 `link:` 切换为 **`github:SamHo7524/dsh-odoo19-backup#v0.1.7`**；重启后实测 `list_bundles` 为 `enabled=true, installed=true`、`list_plugins` 为 `fiberPhase: active`。
- `manual-release-build.mjs` 与发布校验脚本对齐到 `0.1.7`（见「修复」）。

### 修复
- **批量替换误伤**：PowerShell 数组展开导致 3 个文件发生 `d→s` 字符级误替换（`node:`→`nose:`、`mkdir`→`mksir` 等）。重写 `manual-release-build.mjs`，精确修复 `manual-release-verify.mjs` 与历史方案文档；语法检查 + 全套测试确认无损。
- **GitHub 安装三阻塞**：移除 `~/.gitconfig` 中失效的全局代理 `127.0.0.1:7890`（端口无服务，已备份）；用 `cmd /c rmdir` 删除 `node_modules/@local/` 下 3 个残留 junction（只删链接，工作区源码完好）；5 秒 github-spec 超时抖动通过重试解决；运行中 Loader 旧路径缓存通过**完全重启 DSH** 清除。

### 验证
- 226 / 226 单测通过、0 失败；语法检查干净；`RELEASE_BUILD=PASS`。
- 重启后运行中 Host：`/servers` 200（`toogel` 配置保留）、`/fingerprint` 200（真实指纹 `ssh-ed25519 SHA256:oSJdaZy…`）、`/test` 200（Ubuntu 24.04.5 LTS / Docker 29.8.2）。

---

## [0.1.6] — 2026-11-06

**指纹闸门死路与表单字段脱节。**

### 新增
- `service.fingerprint(name)` / `service.pin(name, fingerprint)` 接线到既有 `lib/knownhosts.js` 的 `scanHostKey` / `pinHostKey`（deps 注入；只读扫描不经过 `requireTrusted`）。
- `odoo_backup` 工具新增 `fingerprint` / `pin` 两个 action（含 `fingerprint` 参数）。
- Host 路由 `POST /fingerprint`、`POST /pin`（缺参数 400、不误触 service）。
- 设置表单补 `sshConfigAlias` / `pinnedFingerprint` 字段并随服务器保存；服务器行新增「扫描指纹」按钮，**只显示不自动固化**（人工核对是安全前提）。

### 修复
- `guardHostKey` 的拒绝文案指向**不存在**的 `action=fingerprint` / `action=pin`；改为给出两条真实可行路径：填 `sshConfigAlias`，或扫描 → 人工核对 → pin → 填入 `pinnedFingerprint`。**fail-closed 语义不变**。
- 按 `docs/superpowers/plans/2026-11-06-fingerprint-flow.md` 五任务方案逐任务 TDD 执行。

### 验证
- 219 / 219 测试；重启后 `/fingerprint` 路由生效。

---

## [0.1.5] — 2026-11-06

**`settings.update` 的 volatile 写入门禁。**

### 新增
- `unwrapVolatile()` 解包 `{ get(): T }` 活引用；`createService` 通过 getter 读 `servers`，`settings.update` 落盘后运行中立即生效、无需重启。

### 修复
- 运行中 Host 实测 `400 {"ok":false,"error":"Plugin entry \"odoo-backup\" has no volatile fields"}`。根因：`dsh-settings` `write()` 只放行 `volatile` 节点下的路径（`volatileForm(schema)` 为空即抛错）。为 `servers` 字段加 **`.volatile()`**（schemastery ≥ 3.18.3，对齐 `dsh-connect-workbuddy` 的 `asVolatile()` 模式）。
- 路由注入改为 `ctx.inject(['webServer','settings'], …)` 直接取官方 settings 服务；handler 不再手工赋值 `config.servers`（会破坏活引用）。
- `SCHEMA-1..3` + `HANDLER-2` 回归测试。

### 验证
- 202 / 202 测试；重启后 `POST /save-servers` 返回 200、`/servers` 反映已保存服务器。

---

## [0.1.4] — 2026-11-06

**可靠的写配置通道。**

### 新增
- Host 路由 `POST /save-servers` → `ctx.settings.update('odoo-backup', { servers })`，含数组 / 非空 `name` 校验，保留同源守卫（跨站仍 403）。
- `HOST-1..3`、`CLIENT-1..2`、`HANDLER-1..5` 回归测试。

### 变更
- 前端 `saveServers` 优先调 Host 路由，`configForms` 降为兜底；`scope` 缺失不再直接静默 return，而是显示可见的 `保存失败：…`。

### 修复
- 保存原先唯一押在前端 `configForms` 的 namespace 猜测上，猜不中则 scope 永远绑不上、保存无声失败。

---

## [0.1.3] — 2026-11-06

**Electron 不实现 `window.prompt`。**

### 新增
- 「添加服务器」内联表单（名称 / 主机 / 用户名 / 私钥 + 保存 / 取消），含必填与重名校验。
- 「恢复」内联路径输入框（替代 `prompt` + `confirm`；更严格的一次性 `confirmToken` 仍是确认闸门）。
- `ctx.inject(['configForms'], …)` 等待者：服务晚到仍能绑 scope并重挂卡片 —— 卡片注册**绝不**被它 gate。
- `ADD-1..3`、`SCOPE-1..2`、`FORM-1..4` 回归测试。

### 修复
- **代码层移除全部 `window.prompt` / `confirm` / `alert` 调用**。Electron 不实现 JS 对话框（调用恒返回 `null`），导致「添加服务器」`if (!name) return` 静默无反应。现在零调用，仅注释说明原因。

### 验证
- 189 / 189 测试。

---

## [0.1.2] — 2026-11-06

**React `useSyncExternalStore` 崩溃。**

### 修复
- `scope` 缺席时 `getSnapshot` 返回字面量 `{}`，违反 React 稳定引用硬要求 → 抛 `The result of getSnapshot should be cached to avoid an infinite loop` → 组件崩溃被错误边界吞掉 → **配置区整块空白（连「未就绪」提示都没有）**。
- 引入模块级 `EMPTY_SNAPSHOT = Object.freeze({})` 与 `NOOP_UNSUB`；卡片注册**前置**到所有配置服务交互之前，整段绑定包进 `try/catch`，任何服务异常只降级为可见提示。
- `STORE-1..2`、`REG-6..8` 回归测试。

### 验证
- 184 / 184 测试；真机上配置卡片重新出现。

---

## [0.1.1] — 2026-11-06

**配置卡片消失。**

### 修复
- 卡片注册被包进 `ctx.inject(['configForms'], …)`；服务缺席时子 inject fiber 回调永不执行、整卡静默消失。注册移出、`ctx.get('configForms')` 软取（缺席返回 undefined、不阻塞）、namespace 由 `describe()` / `whileServed()` 按运行时动态确认（不再硬编码 `odoo-backup`）、增加可见「配置服务未就绪」提示 + 5 秒点名 `configForms` 的诊断告警。
- 快照读取修正为 `snapshot.value.servers`（`ConfigFormController.getSnapshot()` 真实形状）。
- manifest `dsh.client.inject` 依赖逐项核实，移除无关的 `@deepseek-ai/dsh-client-ui-conversation`。
- `REG-1..5` 回归测试（RED 10 失败 / GREEN 20 通过 / 回退复现失败 / 恢复复现通过）。

### 验证
- 178 / 178 测试；`RELEASE_BUILD=PASS`。

---

## [0.1.0] — 2026-11-05

**内部首版**（大写包名 `@local/DSH-ODOO19-Backup`）。

- 完整插件：Host `index.js` + `lib/`（ssh、knownhosts、discover、backup、restore、verify、crypto、dbguard、service、tools、tokens），Client `client.js` 设置界面，`odoo_backup` / `odoo_restore` Agent 工具与 `confirmToken` 闸门。
- R1 恢复状态机、V1–V7 验证、备份强制加密（fail-closed，不生成明文包）、UI 路由同源守卫。
- 156 / 156 测试；独立源码快照 + SHA256 + 安装包（`DSH-ODOO19-Backup-0.1.0.tgz`），`private: true`，无 git / 不公开发布。
- staging 实测：SSH、指纹闸门、discover、包完整性、加密往返、沙箱临时库恢复、V1–V7、confirmToken 全生命周期。**未执行**：真实 R1 停机切换、浏览器视觉确认、生产部署。

---

## 跨版本备注

- **方法论教训**：前五轮反复猜 `configForms` 的 namespace；直到对运行中 Host **直接发 HTTP 请求**拿到真实报错（`400 has no volatile fields`）才定位。React / `prompt` / `scope` 的单测 mock 三次掩盖了平台真实行为。
- **平台事实**：Electron 无 `window.prompt`；React `useSyncExternalStore.getSnapshot` 必须返回稳定引用；DSH `settings.update` 只写 `volatile` 字段；Host 半侧改动必须完全重启 DSH。
- **生产**：所有版本全程只读。U1（真实 R1 切换）、U2（agent 浏览器点击验证）、U3（生产部署）仍未执行 / 未授权。
