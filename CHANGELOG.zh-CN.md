# 更新日志

[English Changelog](./CHANGELOG.md) · [README](./README.md) · [中文 README](./README.zh-CN.md)

`dsh-odoo19-backup` 的全部重要变更记录于此。`0.1.0`–`0.1.6` 为内部快照版本（大写包名 `@local/DSH-ODOO19-Backup`）；`0.1.7` 是首个公开 GitHub 版本，标识已全量小写。

格式参考 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)。日期均为 Asia/Shanghai（UTC+8）。

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
