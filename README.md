# dsh-odoo19-backup

[中文文档](./README.zh-CN.md) · [Changelog](./CHANGELOG.md) · [中文更新日志](./CHANGELOG.zh-CN.md)

A [DeepSeek Harness](https://github.com/) (DSH) plugin for **Odoo 19 remote backup and safe restore**.

It backs up the database, filestore, addons, runtime dependencies and configuration over SSH, and restores through a temp-database verification, downtime switch and rollback-on-failure state machine. Host-key trust is **fail-closed** — an unpinned or changed host key is refused.

- Bundle package name: `@local/dsh-odoo19-backup`
- Current version: `0.1.19`
- Install source: `github:SamHo7524/dsh-odoo19-backup#v0.1.19`
- License: private / internal use (`private: true` in `package.json`)

> This plugin supports **Odoo 19 only**. Cross-major-version restore (e.g. 19 → 20) is refused by design.

---

## Install from GitHub

In DSH, install the bundle directly from this repository:

```
github:SamHo7524/dsh-odoo19-backup#v0.1.19
```

Or install the release tarball from the [Releases page](https://github.com/SamHo7524/dsh-odoo19-backup/releases/tag/v0.1.19):

```
dsh-odoo19-backup-0.1.19.tgz
```

> Use `plugin_manager` (`install_bundle`) rather than copying files into `node_modules`: DSH re-runs `pnpm install` from the profile's `package.json` on every start, so only a durable install spec survives a restart.

After installing, **restart DSH** (Host-side `index.js` / `lib/*.js` changes require a full restart; the Client half needs only a hard refresh).

Verify the installation:

```
plugin_manager list_plugins    # include:odoo-backup -> @local/dsh-odoo19-backup, fiberPhase: active
GET /odoo-backup/servers       # 200 {"ok":true,"servers":[...]}
odoo_backup { "action": "listServers" }   # { ok: true, servers: [...] }
```

---

## Features

| Area | What it does |
|:--|:--|
| Backup | Remote discovery (Docker / 1Panel / bare metal) → dump → package (DB + filestore + addons + `.local` deps + config) → encrypted download. Transfers ≥100 MiB are chunked (100 MiB parts), SHA-256 verified and **resumable** — a verified part is never re-downloaded. |
| Restore | R1 state machine: safety backup → temp restore → V1–V7 verification → downtime switch → verify → commit / automatic rollback. Bundles deploy addons and pydeps before the DB is switched, so a restored site starts with its real module set. |
| Restore options | Target database name (auto-discovered from the server's `dbfilter` or set explicitly) and **restore target domain** — rewrites `ir_config_parameter` / `website` domains from the source site to the target (e.g. `www.toogel.cn` → `odoo.toogel.cn`) before the switch completes. |
| Neutralize | After a restore (or on demand), `neutralize` puts the target site in a safe state for testing: it disables outgoing mail servers and cron jobs, keeps payment/test providers inert and rebrands the site. `odoo_backup`/UI expose status → precheck → apply, and the **Keep / Release neutralize** buttons let you complete the whole backup-restore loop without a shell. |
| Agent tools | `odoo_backup` (`test` / `discover` / `backup` / `listServers` / `fingerprint` / `pin`) and `odoo_restore` (`precheck` / `restore` / `status`). Read-only status, real SSH executions, single-use confirm token. |
| Settings UI | One dedicated page in DSH's native **Settings** (`settings.section`, id `odoo-backup`, with its own nav icon): Servers / Backup / Restore tabs, server CRUD, SSH fingerprint trust panel, connection test, passphrase credentials, local directory, real backup/restore progress bars, task cancel, server-level mutex, neutralize card. |
| Security | No SSH passwords; fail-closed host-key pinning; one-time 5-minute `confirmToken` bound to target + package; same-origin guard on UI routes; mandatory backup encryption (`DSHODOO1`, AES-256-GCM + scrypt). |

---

## Configuration

Open **DSH Settings → Odoo19 Backup & Restore** (the plugin registers its own settings section; it is no longer a card under Installed Plugins).

Each server supports:

| Field | Meaning |
|:--|:--|
| `name` / `host` / `port` / `user` | SSH connection identity |
| `keyPath` | Private key path; empty = SSH agent / ssh config alias |
| `sshConfigAlias` | A `Host` in `~/.ssh/config` — **fastest way to trust a host** (delegates key trust to your SSH config) |
| `pinnedFingerprint` | A manually verified `SHA256:...` host key |

**First-use checklist**

1. Add a server and fill `host` / `user` / `keyPath`.
2. Trust the host key — either set `sshConfigAlias`, or click **Scan fingerprint**, verify the fingerprint out-of-band, then paste it into `pinnedFingerprint`. Without one of these, `guardHostKey` refuses the connection (fail-closed, by design).
3. Click **Test connection** — should return real system info (OS / CPU / memory / Docker).
4. Set **`passphrase`** — backups are **rejected** without it (R10 mandatory encryption, fail-closed).

---

## Restore workflow

1. **Backup** tab → run a backup; when it completes the plugin backfills the verified final `.tar.enc` path into the restore input (the plaintext `.tar` inside the chunk working directory is **never** backfilled).
2. **Restore** tab → choose the package (`.tar.enc` only), target database and **target domain**; `precheck` issues a one-time token valid for 5 minutes.
3. Run restore → safety backup of the target → temp DB restore → V1–V7 verification → downtime switch → domain rewrite → `database.secret` rotation → verification → commit. Any failure rolls back to the pre-restore state automatically.
4. Optionally apply **neutralize** on the restored site and use **Keep / Release** to lock or lift it.

---

## Security model

- **Host keys**: `guardHostKey` allows only `sshConfigAlias` or a matching `pinnedFingerprint`; anything else is refused. `scanHostKey` only *reads* fingerprints — `pin` requires a manually confirmed value and re-verifies before writing `known_hosts`.
- **Confirm token**: `odoo_restore action=precheck` issues a token bound to `server + packagePath + neutralize`, valid 5 minutes and single-use (the path is normalized before binding, so a quoted `precheck` pairs with an unquoted `restore` — a different package is still rejected). `restore` without a valid token never reaches `service.restore`.
- **Same-origin guard**: `/odoo-backup/*` UI routes reject cross-origin requests (403). This is not an authentication boundary — DSH's own session/authorization is.
- **Encryption**: `DSHODOO1` format, AES-256-GCM + scrypt. Plaintext restore packages are refused by default.
- **Passphrase**: stored in the DSH Credentials service (`ODOO_BACKUP_PASSPHRASE`), never in plugin config, status responses or logs.
- **Mutex**: one backup/restore task per server; a stale lock stays fail-closed until explicitly confirmed.
- **Production safety**: the plugin never auto-deploys; real R1 switch / production rollout require explicit authorization and a maintenance window.

---

## Development

```bash
node --test "test/**/*.test.js"        # 570 tests
node --check index.js client.js lib/*.js
node scripts/release-sync-check.mjs    # verify tags ↔ GitHub Releases ↔ CHANGELOG ↔ README
```

Layout:

```
index.js            Host entry: Config schema, tools, UI JSON routes
client.js           Client UI (native settings.section page)
lib/                ssh, knownhosts, discover, backup, chunk-*, restore, verify, crypto,
                    dbguard, service, tools, tokens, neutralize, site-domain, config-value…
locale/             zh / en dictionaries
test/               node:test suites + manual verification scripts
scripts/            release-sync-check.mjs (release consistency gate)
```

---

## Release process (every update must sync everything)

A version is only "released" when **all** of these agree. A loop that skips any item is a broken release:

1. `package.json` `version` bumped.
2. `CHANGELOG.md` **and** `CHANGELOG.zh-CN.md` both have a `## [x.y.z]` section.
3. `README.md` and `README.zh-CN.md` both state the new version / install spec.
4. `node --test` green and `node --check` clean.
5. Tarball packed and uploaded as a **GitHub Release asset** — a git tag alone does not publish anything; the Releases page is a separate list.
6. Tag pushed and the release note carries the install line.

`scripts/release-sync-check.mjs` checks all of the above against the live repository (tags, Releases, release assets, both changelogs, both READMEs) and exits non-zero when something drifts. Run it before and after publishing.

The project is **not** a local git checkout during development; releases are published to GitHub by tag. See [CHANGELOG.md](./CHANGELOG.md) for version history.

---

## Status & limitations

- 570 / 570 unit tests pass; `node --check` clean across 30 files.
- Real-machine verified: `odoo_backup` `listServers` / `test` over SSH, `odoo_restore` status, the native settings section and its HTTP routes.
- **Not executed / not authorized**: real R1 downtime switch on the production primary database, agent-driven browser click-through, production deployment. Production servers were read-only throughout development.
- Host-side changes require a **full DSH restart**; the Client half only needs a hard refresh.

See [CHANGELOG.md](./CHANGELOG.md) for the full history (0.1.0 → 0.1.19), including the root-cause chains behind the path, DB-name, addons-deploy, volatile-config and tool-output defects.