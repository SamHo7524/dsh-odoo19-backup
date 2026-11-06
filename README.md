# dsh-odoo19-backup

[中文文档](./README.zh-CN.md) · [Changelog](./CHANGELOG.md) · [中文更新日志](./CHANGELOG.zh-CN.md)

A [DeepSeek Harness](https://github.com/) (DSH) plugin for **Odoo 19 remote backup and safe restore**.

It backs up the database, filestore, addons, runtime dependencies and configuration over SSH, and restores through a temp-database verification, downtime switch and rollback-on-failure state machine. Host-key trust is **fail-closed** — an unpinned or changed host key is refused.

- Bundle package name: `@local/dsh-odoo19-backup`
- Current version: `0.1.7`
- Install source: `github:SamHo7524/dsh-odoo19-backup#v0.1.7`
- License: private / internal use (`private: true` in `package.json`)

> This plugin supports **Odoo 19 only**. Cross-major-version restore (e.g. 19 → 20) is refused by design.

---

## Install from GitHub

In DSH, install the bundle directly from this repository:

```
github:SamHo7524/dsh-odoo19-backup#v0.1.7
```

Or install the release tarball from the [Releases page](https://github.com/SamHo7524/dsh-odoo19-backup/releases/tag/v0.1.7):

```
dsh-odoo19-backup-0.1.7.tgz
```

After installing, **restart DSH** (Host-side `index.js` / `lib/*.js` changes require a full restart; the Client half needs only a hard refresh).

Verify the installation:

```
plugin_manager list_plugins   # include:odoo-backup -> @local/dsh-odoo19-backup, fiberPhase: active
GET /odoo-backup/servers      # 200 {"ok":true,"servers":[...]}
```

---

## Features

| Area | What it does |
|:--|:--|
| Backup | Remote discovery (Docker / bare metal) → dump → package (DB + filestore + addons + `.local` deps + config) → encrypted download |
| Restore | R1 state machine: safety backup → temp restore → V1–V7 verification → downtime switch → verify → commit / automatic rollback |
| Agent tools | `odoo_backup` (`test` / `discover` / `backup` / `listServers` / `fingerprint` / `pin`) and `odoo_restore` (`precheck` / `restore` / `status`) |
| Settings UI | Three tabs (Servers / Backup / Restore) with inline forms, fingerprint scanning and server management |
| Security | No SSH passwords; fail-closed host-key pinning; one-time 5-minute `confirmToken` bound to target + package; same-origin guard on UI routes; mandatory backup encryption |

---

## Configuration

Open **Settings → Plugins → dsh-odoo19-backup** and add servers. Each server supports:

| Field | Meaning |
|:--|:--|
| `name` / `host` / `port` / `user` | SSH connection identity |
| `keyPath` | Private key path; empty = SSH agent / ssh config alias |
| `sshConfigAlias` | A `Host` in `~/.ssh/config` — **fastest way to trust a host** (delegates key trust to your SSH config) |
| `pinnedFingerprint` | A manually verified `SHA256:...` host key |

**First-use checklist**

1. Add a server and fill `host` / `user` / `keyPath`.
2. Trust the host key — either set `sshConfigAlias`, or click **扫描指纹 (Scan fingerprint)**, verify the fingerprint out-of-band, then paste it into `pinnedFingerprint`. Without one of these, `guardHostKey` refuses the connection (fail-closed, by design).
3. Click **测试连接 (Test connection)** — should return real system info (OS / CPU / memory / Docker).
4. Set **`passphrase`** — backups are **rejected** without it (R10 mandatory encryption, fail-closed).

---

## Security model

- **Host keys**: `guardHostKey` allows only `sshConfigAlias` or a matching `pinnedFingerprint`; anything else is refused. `scanHostKey` only *reads* fingerprints — `pin` requires a manually confirmed value and re-verifies before writing `known_hosts`.
- **Confirm token**: `odoo_restore action=precheck` issues a token bound to `server + packagePath + neutralize`, valid 5 minutes and single-use. `restore` without a valid token never reaches `service.restore`.
- **Same-origin guard**: `/odoo-backup/*` UI routes reject cross-origin requests (403). This is not an authentication boundary — DSH's own session/authorization is.
- **Encryption**: `DSHODOO1` format, AES-256-GCM + scrypt. Plaintext restore packages are refused by default.
- **Production safety**: the plugin never auto-deploys; real R1 switch / production rollout require explicit authorization and a maintenance window.

---

## Development

```bash
node --test test/*.test.js          # 226 tests
node --check index.js client.js
node test/manual-release-build.mjs  # build release tarball + source snapshot
```

Layout:

```
index.js            Host entry: Config schema, tools, UI JSON routes
client.js           Client UI (plugins.bundle.config slot)
lib/                ssh, knownhosts, discover, backup, restore, verify, crypto, dbguard, service, tools, tokens
locale/             zh / en dictionaries
test/               node:test suites + manual verification scripts
```

The project is **not** a local git checkout during development; releases are published to GitHub by tag. See [CHANGELOG.md](./CHANGELOG.md) for version history.

---

## Status & limitations

- 226 / 226 unit tests pass; syntax checks clean; build `RELEASE_BUILD=PASS`.
- Verified on a real running Host: `/servers`, `/test`, `/fingerprint`, `/save-servers` all return 200 with real data.
- **Not executed / not authorized**: real R1 downtime switch on the production primary database, agent-driven browser click-through, production deployment. Production servers were read-only throughout development.
- Host-side changes require a **full DSH restart**; the Client half only needs a hard refresh.

See [CHANGELOG.md](./CHANGELOG.md) for the full 0.1.0 → 0.1.7 history, including the seven-round root-cause debugging chain.
