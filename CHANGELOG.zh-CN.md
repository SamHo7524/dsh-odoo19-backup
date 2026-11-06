# 更新日志

[English Changelog](./CHANGELOG.md) · [README](./README.md) · [中文 README](./README.zh-CN.md)

`dsh-odoo19-backup` 的全部重要变更记录于此。`0.1.0`–`0.1.6` 为内部快照版本（大写包名 `@local/DSH-ODOO19-Backup`）；`0.1.7` 是首个公开 GitHub 版本，标识已全量小写。

格式参考 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)。日期均为 Asia/Shanghai（UTC+8）。

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
