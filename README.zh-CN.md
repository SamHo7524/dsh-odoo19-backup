# dsh-odoo19-backup

[English README](./README.md) · [Changelog](./CHANGELOG.md) · [中文更新日志](./CHANGELOG.zh-CN.md)

[DeepSeek Harness](https://github.com/)（DSH）插件，提供 **Odoo 19 远程备份与安全恢复**。

通过 SSH 备份数据库、filestore、addons、运行时依赖与配置；恢复采用「临时库验证 → 停机切换 → 失败自动回滚」状态机。主机密钥信任 **fail-closed**：未固定或指纹变化一律拒绝连接。

- 包名：`@local/dsh-odoo19-backup`
- 当前版本：`0.1.16`
- 安装源：`github:SamHo7524/dsh-odoo19-backup#v0.1.16`
- 许可：内部使用（`package.json` 中 `private: true`）

> 本插件**仅支持 Odoo 19**。跨大版本恢复（如 19 → 20）按设计直接拒绝。

---

## 从 GitHub 安装

在 DSH 中直接从本仓库安装 bundle：

```
github:SamHo7524/dsh-odoo19-backup#v0.1.16
```

或从 [Releases 页面](https://github.com/SamHo7524/dsh-odoo19-backup/releases/tag/v0.1.16) 下载安装包：

```
dsh-odoo19-backup-0.1.16.tgz
```

> 请用 `plugin_manager`（`install_bundle`）安装，不要手工往 `node_modules` 里拷文件：DSH 每次启动都会按 profile 的 `package.json` 重跑 `pnpm install`，只有持久的安装 spec 才能在重启后存活。

安装后请**完全重启 DSH**（Host 半侧 `index.js` / `lib/*.js` 改动需重启才生效；Client 半侧硬刷新即可）。

验证安装：

```
plugin_manager list_plugins    # include:odoo-backup -> @local/dsh-odoo19-backup, fiberPhase: active
GET /odoo-backup/servers       # 200 {"ok":true,"servers":[...]}
odoo_backup { "action": "listServers" }   # { ok: true, servers: [...] }
```

---

## 功能

| 模块 | 说明 |
|:--|:--|
| 备份 | 远程环境发现（Docker / 1Panel / 裸机）→ 导出 → 打包（数据库 + filestore + addons + `.local` 依赖 + 配置）→ 加密下载。≥100 MiB 走分块传输（100 MiB 一片）、SHA-256 校验、**可断点续传**（已校验分片绝不重下）。 |
| 恢复 | R1 状态机：安全备份 → 临时库恢复 → V1–V7 验证 → 停机切换 → 验证 → 提交 / 自动回滚。切换前先部署备份包里的 addons 与 pydeps，恢复出的站点直接带真实模块集。 |
| 恢复选项 | 目标数据库名（从服务器 `dbfilter` 自动识别，也可显式指定）与**恢复目标域名**：切换完成前把 `ir_config_parameter` / `website` 里的源站域名改写为目标域名（如 `www.toogel.cn` → `odoo.toogel.cn`）。 |
| Neutralize | 恢复后（或按需）把目标站置于可安全测试的状态：停用出站邮件服务器与定时任务、支付/测试提供方失效、站点重命名。UI 与工具提供 status → precheck → apply，并提供 **Keep / Release（保持 / 解除）** 按钮 —— 备份恢复闭环可以在插件端一次走完，不必上服务器敲命令。 |
| Agent 工具 | `odoo_backup`（`test` / `discover` / `backup` / `listServers` / `fingerprint` / `pin`）与 `odoo_restore`（`precheck` / `restore` / `status`）。状态查询只读、执行走真实 SSH、确认令牌一次性。 |
| 设置界面 | DSH 原生**设置**页里的独立分区（`settings.section`，id `odoo-backup`，自带导航图标）：服务器 / 备份 / 恢复 三个 Tab，含服务器增删改、SSH 指纹信任面板、连接测试、口令凭据、本地目录、真实备份/恢复进度条、任务取消、服务器级互斥、neutralize 卡片。 |
| 安全 | 不存 SSH 密码；主机指纹 fail-closed；一次性 5 分钟 `confirmToken`（绑定目标 + 包）；UI 路由同源守卫；备份强制加密（`DSHODOO1`，AES-256-GCM + scrypt）。 |

---

## 配置

打开 **DSH 设置 → Odoo19 备份与恢复**（插件注册独立设置分区，不再是「已安装插件」里的卡片）。

每台服务器支持：

| 字段 | 含义 |
|:--|:--|
| `name` / `host` / `port` / `user` | SSH 连接标识 |
| `keyPath` | 私钥路径；留空则用 SSH Agent / ssh config 别名 |
| `sshConfigAlias` | `~/.ssh/config` 里的 `Host` 别名 —— **最快的主机信任方式**（把密钥信任交给 SSH 配置） |
| `pinnedFingerprint` | 人工核对过的 `SHA256:...` 主机指纹 |

**首次使用顺序**

1. 添加服务器，填 `host` / `user` / `keyPath`。
2. 信任主机密钥：二选一 —— 填 `sshConfigAlias`；或点「扫描指纹」取得指纹，**带外人工核对**后填入 `pinnedFingerprint`。两者都没有时 `guardHostKey` 会拒绝连接（fail-closed，刻意设计，不是故障）。
3. 点「测试连接」—— 应返回真实系统信息（OS / CPU / 内存 / Docker）。
4. 设置 **`passphrase`** —— 未配置时备份**直接拒绝**（R10 强制加密，fail-closed）。

---

## 恢复流程

1. **备份** Tab → 执行备份；成功后插件把校验过的最终 `.tar.enc` 路径回填到恢复输入框（分块目录里的明文 `.tar` **绝不**回填）。
2. **恢复** Tab → 选择备份包（只接受 `.tar.enc`）、目标数据库、**恢复目标域名**；`precheck` 生成 5 分钟一次性令牌。
3. 执行恢复 → 目标库安全备份 → 临时库恢复 → V1–V7 验证 → 停机切换 → 域名改写 → 轮换 `database.secret` → 再验证 → 提交。任何一步失败自动回滚到恢复前状态。
4. 可选：在恢复出的站点上执行 **neutralize**，并用 **保持 / 解除** 按钮锁定或放开。

---

## 安全模型

- **主机密钥**：`guardHostKey` 只放行 `sshConfigAlias` 或与 `pinnedFingerprint` 匹配的连接；`scanHostKey` 只**读取**指纹，`pin` 要求人工确认值并在写 `known_hosts` 前二次校验。
- **确认令牌**：`odoo_restore action=precheck` 生成绑定 `server + packagePath + neutralize` 的令牌，5 分钟有效、一次性（令牌绑定用规范化后的路径，带引号的 `precheck` 可配不带引号的 `restore`，但换包仍会被拒）；无有效令牌绝不触达 `service.restore`。
- **同源守卫**：`/odoo-backup/*` UI 路由拒绝跨站请求（403）。这不是鉴权边界，真正的授权由 DSH 会话承担。
- **加密**：`DSHODOO1` 格式，AES-256-GCM + scrypt；明文恢复包默认拒绝。
- **口令**：存放在 DSH 凭据服务（`ODOO_BACKUP_PASSPHRASE`），绝不进入插件配置、状态响应或日志。
- **互斥**：每台服务器同一时刻只允许一个备份/恢复任务；陈旧锁保持 fail-closed，需显式确认才放行。
- **生产安全**：插件不会自动部署；真实 R1 切换 / 生产上线须单独授权 + 维护窗口。

---

## 开发

```bash
node --test "test/**/*.test.js"        # 559 条测试
node --check index.js client.js lib/*.js
node scripts/release-sync-check.mjs    # 校验 tag ↔ GitHub Release ↔ 中英文 CHANGELOG ↔ README
```

目录结构：

```
index.js            Host 入口：Config schema、工具、UI JSON 路由
client.js           Client UI（原生 settings.section 设置页）
lib/                ssh / knownhosts / discover / backup / chunk-* / restore / verify / crypto /
                    dbguard / service / tools / tokens / neutralize / site-domain / config-value …
locale/             zh / en 字典
test/               node:test 单测 + manual 验证脚本
scripts/            release-sync-check.mjs（发布一致性闸门）
```

---

## 发布流程（每次更新必须全部同步）

只有下列各项**全部一致**才算一次发布。少做任何一项都是残废发布：

1. `package.json` 的 `version` 已升级。
2. `CHANGELOG.md` **与** `CHANGELOG.zh-CN.md` 都有 `## [x.y.z]` 章节。
3. `README.md` **与** `README.zh-CN.md` 都写着新版本号 / 安装 spec。
4. `node --test` 全绿、`node --check` 干净。
5. 打包并作为 **GitHub Release 附件**上传 —— **只推 git tag 不算发布**；Releases 页面是独立的发布物列表（本项目 0.1.14–0.1.16 就曾因此只有 tag、没有下载包）。
6. tag 已推送，Release 说明里带安装行。

`scripts/release-sync-check.mjs` 会对着线上仓库逐项核对（tag、Release、Release 附件、中英文 CHANGELOG、中英文 README），有任何漂移就以非零退出。发布前后各跑一次。

开发期工作区不是 git checkout；版本通过 GitHub tag 发布。版本历史见 [CHANGELOG.md](./CHANGELOG.md)。

---

## 状态与限制

- 559 / 559 单测通过；`node --check` 30 个文件全干净。
- 真机验证：`odoo_backup` 的 `listServers` / `test`（真实 SSH）、`odoo_restore` 状态查询、原生设置分区及其 HTTP 路由。
- **未执行 / 未授权**：生产主库真实 R1 停机切换、agent 浏览器内点击验证、生产部署。开发全程生产服务器只读。
- Host 半侧改动需**完全重启 DSH**；Client 半侧硬刷新即可。

完整 0.1.0 → 0.1.16 历史（含路径、库名、addons 部署、volatile 配置、工具输出契约等缺陷的根因链）见 [CHANGELOG.md](./CHANGELOG.md)。