# Changelog

[中文更新日志](./CHANGELOG.zh-CN.md) · [README](./README.md) · [中文 README](./README.zh-CN.md)

All notable changes to `dsh-odoo19-backup` are documented here. Versions `0.1.0`–`0.1.6` were internal snapshots (uppercase package name `@local/DSH-ODOO19-Backup`); `0.1.7` is the first public GitHub release with the fully lowercased name.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Dates are in Asia/Shanghai (UTC+8).

---

## [0.1.7] — 2026-11-06

**First public GitHub release. All identifiers lowercased; installable directly from GitHub.**

### Added
- Public repository `SamHo7524/dsh-odoo19-backup`, tag / Release `v0.1.7`, release tarball `dsh-odoo19-backup-0.1.7.tgz` (SHA256 `5adf7093929642aa3d129e99a9f1438503dee0e55ba0ace37d86bf5445dd2b97`), downloadable anonymously and hash-verified.
- Bilingual `README.md` / `README.zh-CN.md` and `CHANGELOG.md` / `CHANGELOG.zh-CN.md`.
- `LOWER-1..7` regression tests: full-repository scan for uppercase identifiers, package/patch/client/locale/build-script name consistency.

### Changed
- Package name `@local/DSH-ODOO19-Backup` → **`@local/dsh-odoo19-backup`**; locale titles, UI heading, console prefixes, tarball name, patch name and contract tests all lowercased.
- Profile installation switched from `link:` to **`github:SamHo7524/dsh-odoo19-backup#v0.1.7`**; verified `list_bundles` shows `enabled=true, installed=true` and `list_plugins` shows `fiberPhase: active` after a full DSH restart.
- Build script `manual-release-build.mjs` and release verifier rewritten/aligned to `0.1.7` after a batch-replace incident (see Fixed).

### Fixed
- **Batch-replace corruption**: a PowerShell array-expansion mistake applied a `d→s` substitution to three files (`node:`→`nose:`, `mkdir`→`mksir`, etc.). Rebuilt `manual-release-build.mjs`, precisely repaired `manual-release-verify.mjs` and the historical plan doc; syntax checks + full suite confirmed no damage.
- **GitHub install blockers**: removed a dead global git proxy (`127.0.0.1:7890`, port not listening) from `~/.gitconfig` (backup kept); removed three stale `node_modules/@local/` junctions with `cmd /c rmdir` (link only, workspace source intact); worked around a 5 s github-spec timeout by retrying; resolved the stale Loader path cache with a full DSH restart.

### Verified
- 226 / 226 unit tests, 0 failures; syntax checks clean; `RELEASE_BUILD=PASS`.
- Live Host after restart: `/servers` 200 (with `toogel` config preserved), `/fingerprint` 200 (real `ssh-ed25519 SHA256:oSJdaZy…`), `/test` 200 (Ubuntu 24.04.5 LTS / Docker 29.8.2).

---

## [0.1.6] — 2026-11-06

**Fingerprint-gate dead end and settings-form gap.**

### Added
- `service.fingerprint(name)` / `service.pin(name, fingerprint)` wired to the existing `lib/knownhosts.js` `scanHostKey` / `pinHostKey` (deps-injected; read-only scan bypasses `requireTrusted`).
- `odoo_backup` tool actions `fingerprint` / `pin` (+ `fingerprint` parameter).
- Host routes `POST /fingerprint` and `POST /pin` (400 on missing params, never mis-invokes service).
- Settings form fields `sshConfigAlias` / `pinnedFingerprint`, saved with the server; per-server **扫描指纹 (Scan fingerprint)** button that only displays fingerprints — no automatic pinning (manual verification is a security precondition).

### Fixed
- `guardHostKey`'s refusal message pointed at non-existent `action=fingerprint` / `action=pin`; rewritten to give two real paths: set `sshConfigAlias`, or scan → verify → pin → fill `pinnedFingerprint`. **Fail-closed behavior unchanged.**
- Five-task TDD plan (`docs/superpowers/plans/2026-11-06-fingerprint-flow.md`) executed task-by-task.

### Verified
- 219 / 219 tests; `/fingerprint` route live after restart.

---

## [0.1.5] — 2026-11-06

**`settings.update` volatile write gate.**

### Added
- `unwrapVolatile()` for reading `{ get(): T }` live references; `createService` now reads `servers` through a getter so a `settings.update` write takes effect immediately without restart.

### Fixed
- Live Host returned `400 {"ok":false,"error":"Plugin entry \"odoo-backup\" has no volatile fields"}`. Root cause: `dsh-settings` `write()` only permits paths under a `volatile` schema node (`volatileForm(schema) === undefined` → throw). Marked the `servers` field **`.volatile()`** (schemastery ≥ 3.18.3, matching `dsh-connect-workbuddy`'s `asVolatile()` pattern).
- Web route injection changed to `ctx.inject(['webServer','settings'], …)` to obtain the official settings service directly; handler no longer hand-assigns `config.servers` (would break the live reference).
- `SCHEMA-1..3` + `HANDLER-2` regression tests.

### Verified
- 202 / 202 tests; after restart `POST /save-servers` returned 200 and `/servers` reflected the saved server.

---

## [0.1.4] — 2026-11-06

**Reliable configuration write path.**

### Added
- Host route `POST /save-servers` → `ctx.settings.update('odoo-backup', { servers })` with array / non-empty-`name` validation and same-origin guard retained (cross-origin still 403).
- `HOST-1..3`, `CLIENT-1..2`, `HANDLER-1..5` regression tests.

### Changed
- Client `saveServers` now calls the Host route first; `configForms` is only a fallback. A missing `scope` no longer causes an early silent return — a visible `保存失败：…` is shown.

### Fixed
- Saving depended solely on guessing the front-end `configForms` namespace; a miss meant `scope` was never bound and the save silently did nothing.

---

## [0.1.3] — 2026-11-06

**Electron has no `window.prompt`.**

### Added
- Inline server form (name / host / user / keyPath + Save / Cancel) with required-field and duplicate-name checks.
- Inline restore-package path input (replacing `prompt` + `confirm`; the one-time `confirmToken` remains the stricter confirmation).
- A `ctx.inject(['configForms'], …)` waiter so a late-arriving service still binds `scope` and remounts the card — registration is never gated by it.
- `ADD-1..3`, `SCOPE-1..2`, `FORM-1..4` regression tests.

### Fixed
- **All `window.prompt` / `confirm` / `alert` calls removed.** Electron does not implement JS dialogs (they return `null`), so "Add server" silently did nothing — `if (!name) return`. Code now has zero such calls; only explanatory comments remain.

### Verified
- 189 / 189 tests.

---

## [0.1.2] — 2026-11-06

**React `useSyncExternalStore` crash.**

### Fixed
- `getSnapshot` returned a fresh `{}` when `scope` was absent, violating React's stable-reference requirement → `The result of getSnapshot should be cached to avoid an infinite loop` → component crash → error boundary swallowed it → **entire config area blank (no "not ready" hint at all)**.
- Introduced module-level `EMPTY_SNAPSHOT = Object.freeze({})` and `NOOP_UNSUB`; card registration moved **before** all config-service interaction, with the whole binding block wrapped in `try/catch` so any service exception only degrades to the visible hint.
- `STORE-1..2`, `REG-6..8` regression tests.

### Verified
- 184 / 184 tests; card became visible on the real GUI.

---

## [0.1.1] — 2026-11-06

**Config card disappeared.**

### Fixed
- Card registration was wrapped in `ctx.inject(['configForms'], …)`; when the service was absent the child inject fiber never fired and the whole card silently vanished. Registration moved out, `ctx.get('configForms')` soft-fetched (undefined is non-blocking), namespace resolved dynamically via `describe()` / `whileServed()` instead of a hardcoded `odoo-backup`, and a visible "配置服务未就绪" hint + 5 s diagnostic `console.warn` added.
- Snapshot read corrected to `snapshot.value.servers` (`ConfigFormController.getSnapshot()` real shape).
- Manifest `dsh.client.inject` dependencies verified one-by-one; removed the irrelevant `@deepseek-ai/dsh-client-ui-conversation`.
- `REG-1..5` regression tests (RED 10 fail / GREEN 20 pass / revert-fail / restore-pass).

### Verified
- 178 / 178 tests; `RELEASE_BUILD=PASS`.

---

## [0.1.0] — 2026-11-05

**Initial internal release** (uppercase name `@local/DSH-ODOO19-Backup`).

- Full plugin: Host `index.js` + `lib/` (ssh, knownhosts, discover, backup, restore, verify, crypto, dbguard, service, tools, tokens), Client `client.js` settings UI, `odoo_backup` / `odoo_restore` Agent tools with `confirmToken` gate.
- R1 restore state machine, V1–V7 verification, mandatory backup encryption (fail-closed, no plaintext packages), same-origin UI routes.
- 156 / 156 tests; independent source snapshot + SHA256 + tarball (`DSH-ODOO19-Backup-0.1.0.tgz`), `private: true`, no git / no public release.
- Verified on staging: SSH, fingerprint gate, discover, package integrity, encryption round-trip, sandbox temp-DB restore, V1–V7, confirmToken lifecycle. **Not executed**: real R1 downtime switch, browser visual confirmation, production deployment.

---

## Cross-version notes

- **Method lesson**: the first five rounds repeatedly guessed the `configForms` namespace; only a direct HTTP call to the running Host (`400 has no volatile fields`) located the real cause. Unit-test mocks for React / `prompt` / `scope` masked real platform behavior three times.
- **Platform facts**: Electron has no `window.prompt`; React `useSyncExternalStore.getSnapshot` must return a stable reference; DSH `settings.update` writes only `volatile` fields; Host-side changes need a full DSH restart.
- **Production**: read-only throughout all versions. U1 (real R1 switch), U2 (agent browser click-through) and U3 (production deployment) remain unexecuted / unauthorized.
