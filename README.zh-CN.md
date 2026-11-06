# dsh-odoo19-backup

[English README](./README.md) · [Changelog](./CHANGELOG.md) · [中文更新日志](./CHANGELOG.zh-CN.md)

[DeepSeek Harness](https://github.com/)（DSH）插件，提供 **Odoo 19 远程备份与安全恢复**。

通过 SSH 备份数据库、filestore、addons、运行时依赖与配置；恢复采用「临时库验证 → 停机切换 → 失败自动回滚」状态机。主机密钥信任 **fail-closed**：未固定或指纹变化一律拒绝连接。

- 包名：`@local/dsh-odoo19-backup`
- 当前版本：`0.1.7`
- 安装源：`github:SamHo7524/dsh-odoo19-backup#v0.1.7`
- 许可：内部使用（`package.json` 中 `private: true`）

> 本插件**仅支持 Odoo 19**。跨大版本恢复（如 19 → 20）按设计直接拒绝。

---

## 从 GitHub 安装

在 DSH 中直接从本仓库安装 bundle：

```
github:SamHo7524/dsh-odoo19-backup#v0.1.7
```

或从 [Releases 页面](https://github.com/SamHo7524/dsh-odoo19-backup/releases/tag/v0.1.7) 下载安装包：

```
dsh-odoo19-backup-0.1.7.tgz
```

安装后请**完全重启 DSH**（Host 半侧 `index.js` / `lib/*.js` 改动需重启才生效；Client 半侧硬刷新即可）。

验证安装：

```
plugin_manager list_plugins   # include:odoo-backup -> @local/dsh-odoo19-backup, fiberPhase: active
GET /odoo-backup/servers      # 200 {"ok":true,"servers":[...]}
```

---

## 功能

| 模块 | 说明 |
|:--|:--|
| 备份 | 远程环境发现（Docker / 裸机）→ 导出 → 打包（数据库 + filestore + addons + `.local` 依赖 + 配置）→ 加密下载 |
| 恢复 | R1 状态机：安全备份 → 临时恢复 → V1–V7 验证 → 停机切换 → 验证 → 提交 / 自动回滚 |
| Agent 工具 | `odoo_backup`（`test` / `discover` / `backup` / `listServers` / `fingerprint` / `pin`）与 `odoo_restore`（`precheck` / `restore` / `status`） |
| 设置界面 | 三个 Tab（服务器 / 备份 / 恢复），内联表单、指纹扫描、服务器管理 |
| 安全 | 不存 SSH 密码；主机指纹 fail-closed；一次性 5 分钟 `confirmToken`（绑定目标 + 包）；UI 路由同源守卫；备份强制加密 |

---

## 配置

打开 **设置 → 插件 → dsh-odoo19-backup** 添加服务器。每台服务器支持：

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

## 安全模型

- **主机密钥**：`guardHostKey` 只放行 `sshConfigAlias` 或与 `pinnedFingerprint` 匹配的连接；`scanHostKey` 只**读取**指纹，`pin` 要求人工确认值并在写 `known_hosts` 前二次校验。
- **确认令牌**：`odoo_restore action=precheck` 生成绑定 `server + packagePath + neutralize` 的令牌，5 分钟有效、一次性；无有效令牌绝不触达 `service.restore`。
- **同源守卫**：`/odoo-backup/*` UI 路由拒绝跨站请求（403）。这不是鉴权边界，真正的授权由 DSH 会话承担。
- **加密**：`DSHODOO1` 格式，AES-256-GCM + scrypt；明文恢复包默认拒绝。
- **生产安全**：插件不会自动部署；真实 R1 切换 / 生产上线须单独授权 + 维护窗口。

---

## 开发

```bash
node --test test/*.test.js          # 226 条测试
node --check index.js client.js
node test/manual-release-build.mjs  # 构建发布包 + 源码快照
```

目录结构：

```
index.js            Host 入口：Config schema、工具、UI JSON 路由
client.js           Client UI（plugins.bundle.config 槽）
lib/                ssh / knownhosts / discover / backup / restore / verify / crypto / dbguard / service / tools / tokens
locale/             zh / en 字典
test/               node:test 单测 + manual 验证脚本
```

开发期工作区不是 git checkout；版本通过 GitHub tag 发布。版本历史见 [CHANGELOG.md](./CHANGELOG.md)。

---

## 状态与限制

- 226 / 226 单测通过；语法检查干净；构建 `RELEASE_BUILD=PASS`。
- 运行中 Host 实测：`/servers`、`/test`、`/fingerprint`、`/save-servers` 均 200 且返回真实数据。
- **未执行 / 未授权**：生产主库真实 R1 停机切换、agent 浏览器内点击验证、生产部署。开发全程生产服务器只读。
- Host 半侧改动需**完全重启 DSH**；Client 半侧硬刷新即可。

完整 0.1.0 → 0.1.7 历史（含七轮根因排查链）见 [CHANGELOG.md](./CHANGELOG.md)。
