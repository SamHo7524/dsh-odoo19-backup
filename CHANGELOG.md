# Changelog

[中文更新日志](./CHANGELOG.zh-CN.md) · [README](./README.md) · [中文 README](./README.zh-CN.md)

All notable changes to `dsh-odoo19-backup` are documented here. Versions `0.1.0`–`0.1.6` were internal snapshots (uppercase package name `@local/DSH-ODOO19-Backup`); `0.1.7` is the first public GitHub release with the fully lowercased name.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Dates are in Asia/Shanghai (UTC+8).

## [0.1.23] — 2026-11-11

**Restore now restarts Odoo after deploying addons/pydeps — otherwise the just-deployed modules are never imported.**

### Background (real failure on `new.toogel.cn`, fresh deployment)
The restore reached the temp-database verification and failed with `临时环境验证失败：V6 站点可访问`. Evidence from the target:

- `GET /` and `/web/login` returned **500** with
  `QWebError: AttributeError: 'website' object has no attribute 'clarity_project_id'`.
- The DB references module `website_clarity` (installed, `19.0.1.0.0`) and its field.
- `/mnt/extra-addons/website_clarity` **was present on disk** (23 modules deployed) — so deployment worked.
- But Odoo only imports module Python **at process start**; the container started at 11:59 and the deploy happened at 12:04, so the running process had no `website_clarity` models → template render failed.

The 0.1.14 fix got the ordering right (deploy addons *before* the DB) but missed that the Odoo **process** must be restarted to see new code. On the long-lived target this never surfaced; a freshly created container exposes it immediately.

### Added
- `lib/restore.js`: `buildRestartOdooScript()`, `parseRestartResult()`, `shouldRestartAfterDeploy()` and stage A0b `phaseRestartOdoo()` — `docker restart` the Odoo container, then poll `/web/login` (60 × 2 s) until it answers. Runs **only when the deploy actually placed addons or pydeps** (no pointless downtime) and fails closed with a clear message if the container does not come back.
- Progress messages say it plainly: "正在重启 Odoo 以载入新部署的模块（期间站点短暂不可访问）".
- `lib/diagnose.js`: new pattern for `object has no attribute` / `QWebError` / `Some modules are not loaded` → explains the "code deployed after start" cause and points at the restart.

### Tests
**605 / 605** (baseline 599 + 6: `RS-1..5` restart script/parse/gating, `DIAG-9` for the missing-module signature).

### Security / unchanged
No change to authorization, encryption, tokens, the switch/rollback state machine or DB handling. The restart happens after deployment and before the DB is touched.

---
## [0.1.22] — 2026-11-11

**Fix a regression 0.1.21 introduced: re-attaching credentials threw on a getter-only property.**

### Background (hit by the user on the first real restore after 0.1.21)
Starting a restore failed instantly with:

```
失败：Cannot set property credentials of #<Object> which has only a getter
```

0.1.21 restored the live `credentials` getter onto the dependency bag (so late `ctx.inject(['credentials'])` becomes visible), but that property has **no setter**. The Host routes call `service.attachCredentials(credentials)` at the start of every request, which does `d.credentials = credentials` — illegal on a getter-only property in strict mode (ESM is always strict). So every UI request through `/precheck`, `/restore`, `/backup` … threw before touching anything.

This is the third occurrence of the same underlying mistake (0.1.15 `.volatile()` snapshot, 0.1.21 getter snapshot, now a write to a getter): **treating a live reference as a plain value at a boundary — this time in the write direction.**

### Fixed
- `lib/service.js`: a getter-only dependency is installed with a companion setter that writes to a shadow slot; the getter returns the live reference when present and falls back to the shadow value otherwise. `attachCredentials()` therefore works without weakening late binding.

### Tests
**599 / 599** (baseline 597 + 2: `SVC-CRED-3` attaches credentials on a getter-only dep and then proves the attached credential is actually used; `SVC-CRED-4` ignores null/invalid arguments without disturbing the existing reference). `SVC-CRED-3` reproduces the exact production message before the fix.

### Security / unchanged
No change to credential storage, encryption, host-key gating, tokens or the restore state machine. This only makes the injection channel writable again.

---
## [0.1.21] — 2026-11-11

**Fix: a `deps` getter was snapshotted at service creation, so credentials injected later were invisible to the agent tools.**

### Background (found while verifying 0.1.20 on the real machine)
0.1.20's version gate reported `源（备份包）：(未知)` for a package whose `MANIFEST.source.odooVersion` is `19.0-20260619` — read straight from the same file it printed `19.0-20260619`. The gate fell back to "unknown → allow with warning" instead of refusing the 19→20 pair.

Root cause: `createService()` builds its dependency bag as `{ ...defaults, ...deps }`. Spreading **evaluates getters immediately**, so `index.js`'s `get credentials() { return credsRef.current; }` — the deliberate late-binding channel for `ctx.inject(['credentials'])` — was frozen to `undefined` at creation time. The UI routes were unaffected because they call `service.attachCredentials(credentials)` on every request; the agent-tool path has no such hook, so `requirePassphrase()` threw "凭证服务不可用" and every package the tools read came back version-less.

This is the same class of bug as the 0.1.15 `.volatile()` snapshot: **a live reference silently became a frozen value at a spread boundary.**

### Fixed
- `lib/service.js`: after the spread, own-property getters/setters from `deps` are re-installed with their original descriptors, so late injection is visible. Plain values behave exactly as before.

### Tests
**597 / 597** (baseline 595 + 2: `SVC-CRED-1` injects credentials *after* creation and asserts the very next call sees them; `SVC-CRED-2` re-reads after the value changes, and also covers a getter defined after the spread). `SVC-CRED-1` fails with the production message "凭证服务不可用（ctx.credentials 未注入）" before the fix.

### Security / unchanged
No change to credential storage, R10 encryption, host-key gating, tokens or the restore state machine. The fix only makes an existing lazily-injected service actually reach the code that needs it.

---
## [0.1.20] — 2026-11-11

**Restore is now gated by the Odoo version *before* any remote work, and every failure explains itself.**

### Background (real failure, reported by the user)
A restore of an Odoo-19 backup (`tg-odoo`, from `toogel` / `19.0-20260619`) onto `new.toogel.cn` failed with a raw, opaque dump:

```
odoo db load 失败 (rc=1)：... neutralize.py", line 47 ... 
psycopg2.errors.UndefinedColumn: column "is_live" of relation "payment_provider" does not exist
```

Two independent defects were behind it:

1. **The version gate was dead code.** `lib/verify.js`'s `checkVersionCompatible()` existed and was unit-tested, but **nothing in the restore path ever called it**. The README promised "cross-major restore (19 → 20) is refused by design"; in reality nothing refused it. The target turned out to be **Odoo 20** (`20.0-20261102`, image `odoo:20.0`), so Odoo 20's own `payment/data/neutralize.sql` (`UPDATE payment_provider SET is_live = False`) ran against an Odoo-19 schema that has no such column, and `odoo db load -n` died mid-restore.
2. **Failures were black-box.** The user's words: "当备份或者恢复过程中有问题，应该有提示，然后再报失败，不能直接报失败" — a raw stack trace tells the operator nothing about what to do next.

### Added
- `lib/version-gate.js`: compares the backup's `MANIFEST.source.odooVersion` with the target's discovered `odooVersion`. Cross-major → **refused before any remote write**, with both versions, the reason, and two concrete options (same-major target, or treat 19→20 as an upgrade project). Unknown version → allowed **with an explicit warning** (an old package without `odooVersion` must not be permanently un-restorable).
- `lib/diagnose.js`: pattern-based failure explanation. Known failure modes (neutralize/schema mismatch, DB already exists, disk full, SSH host-key vs SSH auth, DB unreachable, timeout) are rendered as `原始错误 + 【诊断】原因 + 【建议】下一步`; unknown errors pass through **verbatim** (never disguised as a known cause).
- Precheck now surfaces the verdict: `GET /precheck` returns `sourceVersion` / `targetVersion` / `versionCheck` / `versionWarning`, and answers **409** when the versions are provably incompatible (no `confirmToken` is issued, so a doomed restore cannot be confirmed). The `odoo_restore` agent tool does the same and prints `源（备份包）：… 目标机：…` in its render.
- Restore tab shows the version line before starting (`19.0-20260619 → 19.0-20261102（同大版本）`).

### Fixed
- `lib/service.js` `runGuarded` (and the no-stateDir branch) stores the explained text in the task state and rethrows it, so both the UI and the agent tool show cause + suggestion on failure.
- `lib/server-lock.js` `saveAll`: a concurrent `rename` could throw `ENOENT` when the state directory is removed mid-write (surfaced as a flaky concurrency test). The lock is a pointer, not the source of truth, so this now degrades gracefully instead of failing the operation.

### Tests
**595 / 595** (baseline 577 + 18: `DIAG-1..8`, `VG-1..6`, `SVC-VG-1/2`, `SVC-DIAG-3/4`). `SVC-VG-1` asserts `runRestore` is **never called** on a cross-major pair; `SVC-DIAG-3` asserts the exact production text now carries `【诊断】` and `【建议】`; `SVC-DIAG-4` asserts unknown errors stay verbatim.

### Security / unchanged
No change to `guardHostKey` / `pinnedFingerprint`, R10 encryption, passphrase credentials, `confirmToken` semantics, the restore state machine, or any authorization boundary. This release only adds a pre-flight refusal and human-readable explanations.

---

## [0.1.19] — 2026-11-11

**Safety convergence: tool output must be lossless-JSON safe, and the neutralize card no longer offers actions while the target state is unknown.**

### Background
Live troubleshooting on 2026-11-11 exposed three independent defects around the agent-tool output
contract and the neutralize card:

1. `discover()` assembled `note: undefined` whenever instances were found. DSH's lossless-JSON
   validation rejects `undefined` values, so a **successful** discovery died with
   "value is not lossless JSON" while a failed connection (string note) returned normally —
   "failure works, success errors". `lib/imports.js` had the same `error: ... : undefined` pattern.
2. The neutralize card rendered for every configured server (production included), and its two
   action buttons rendered regardless of whether the neutralize status could be read. Production
   stayed safe only because status reads happened to fail — an accident, not a design.
3. `/neutralize-status` answered `send(200, { ok: true, ...status })`; a failed parse
   (`{ ok: false, reason }`) overwrote `ok` and carried no `error` field, so the client could only
   show the useless "HTTP 200".

### Fixed
- `lib/discover.js` / `lib/imports.js`: optional `note`/`error` keys are provided via conditional
  spread — no key when there is nothing to say. Lossless-JSON safe by construction.
- `client.js`: the neutralize action buttons are wrapped in `statusKnown`
  (`!st.err && stat && stat.ok !== false`). With an unknown state the card shows only the error and
  a refresh button — no "Keep neutralize", no "Release (take over production)".
- `index.js` `/neutralize-status`: an unreadable status is now a 400 carrying the real reason,
  instead of a 200 with a swallowed `ok:false`.
- `index.js` `/neutralize-apply` (release): re-validates `status.ok` after token verification,
  closing the precheck→apply window in which a degraded status previously still allowed the SQL.

### Tests
**577 / 577**. New: `LOSSJSON-1..4` (output-contract suite incl. helper self-check),
`NEUROUTE-9/10` (unreadable-status gates on status/apply), `NEUUI-9` (no action buttons while
state is unknown).

### Known limits (documented, deliberately not bundled here)
- "Restore-target" semantics are currently approximated by "status readable". A persistent
  restore-task record as an explicit server-side authorization boundary is planned for 0.1.20.
- `serverConnection()` still strips `dbName`, so a configured fallback db name never reaches
  auto-discovery (pre-existing, tracked separately).

---

## [0.1.18] — 2026-11-11

**Fixes a regression that 0.1.17's own runtime verification exposed: after a restart, a page refresh no longer showed the most recent terminal state.**

### Background
With the per-server `transfer-state.json` layout introduced in 0.1.17, the parameterless `/status`
(the settings card's default poll) returned only **active** states (`running`/`paused`) and
`taskId: null` once everything had finished. Inside the same Host process this was invisible
(the in-memory pointer still named that server), but after a DSH restart plus a page refresh the
previous `completed` could never be shown again — violating spec §6.1 ("after a refresh the UI reads
that file and correctly restores the final state; completed/failed/cancelled are persisted and never
fall back to 0% or 'in progress'").

### Fixed
- `lib/service.js`'s parameterless `status()`: take the active state with the newest `updatedAt`
  first (so a just-finished terminal state cannot mask a running task), then fall back to the newest
  terminal state when nothing is active. `running` is still strictly `status === 'running'`, so a
  terminal state is never reported as in progress.
- Legacy global-file ownership filtering is unchanged (`serverConfigId` mismatches are skipped).

### Tests
**570 / 570**. `V17-S3` now asserts that a parameterless `status()` after a restart returns some
server's real terminal state with `running === false` — the direct guard for this regression.
---

## [0.1.17] — 2026-11-11

**Task-status polling fix + per-server state isolation.**

### Background (real-machine defect)
Backups ran fine, yet the UI showed **no progress bar** after clicking "start backup"; leaving the plugin settings page and re-entering was the only way to make it appear.

Two client defects combined, both resting on one premise: `transfer-state.json` is never cleaned up (terminal states linger).

1. **Polling stopped at terminal state**: the first poll after mount read the stale `completed` from disk and immediately cleared the interval, so `/status` was never fetched again — while the new task's `running`/`percent` sat unread on disk.
2. **Stale terminal state blocked the new task**: even with polling alive, the takeover guard (`prev.taskId === data.taskId || !terminal.includes(prev.status)`) refused to accept the new taskId because the previous round was terminal.

The server side was always correct: `progressReporter` atomically persists every progress event. The defect lived purely in the client's consumption of that state.

### Fixed (scope per the user's ruling)
- **Removed the terminal-state polling stop**: polling now stops only on unmount; a 1.5 s local request is cheap and self-healing.
- **Fixed cross-taskId takeover**: a new task takes over after comparing parseable `updatedAt`; when timestamps are missing/invalid, a stale terminal state no longer suppresses a new task indefinitely.
- **Out-of-order guard**: a monotonically increasing request sequence number (`pollSeq`) discards late responses so they can never overwrite confirmed newer data.
- **Clear stale terminal display on start**: clicking backup/restore immediately drops the previous terminal bar.
- **Per-server state isolation**: `<stateDir>/<serverConfigId>/transfer-state.json` replaces the single global file. Two concurrent server backups no longer overwrite each other's state. The lock key is upgraded to the stable `serverConfigId` (digest over `host/port/user/sshConfigAlias`, **excluding the renameable `name`**), so renaming a server keeps its task ownership, lock and state directory.
- **Legacy global state file read for compatibility only**: it is read back only when its `serverConfigId` matches the requester (or the field is absent, i.e. unclaimed); it is never copied into every server's state, never deleted, and never auto-migrated.

### Explicitly out of scope (deferred by the ruling)
- HTTP 202 async execution, WebSocket/SSE push: deferred.
- Automatic cleanup of terminal state files: not done (a lingering terminal state is harmless now that polling no longer depends on it).

### Tests
**570 / 570** (559 baseline + 11 new: `V17-C1..C4` for client polling/takeover/ordering, `V17-S1..S7` for per-server isolation, two-server concurrency, rename stability, legacy-file compatibility, and `status(server)` restart recovery). The existing `SVC-1..SVC-6` now read the per-server directory and all pass.
---

## [0.1.16] — 2026-11-10

**Agent-tool output contract fix: `listServers` returned a bare array while `output.schema` declares `type: object`.**

### Background (real-machine defect, released minutes after 0.1.15)
With the volatile fix in place, `odoo_backup { action: "listServers" }` got past the crash but then failed one layer later:

```
Error: tool "odoo_backup" returned invalid output: "value" must be an object
```

The Host validates a tool result against its own `output.schema`, and `odoo_backup` declares `type: object` — but the `listServers` branch returned a plain array. The crash in 0.1.14 had masked this: the code never got as far as the output validator. Every other action already returned an object (the service results), so `listServers` was the only offender.

### Fixed
- `lib/tools.js`: `listServers` now returns `{ ok: true, servers: [...] }` — same shape as the other actions and consistent with the declared schema.
- `render` for `listServers` reads `value.servers` (still tolerates a legacy bare array) and keeps the empty-state text.

### Tests
**559 / 559** (baseline 557 + `TOOLVOL-7` object-shape contract against `output.schema.type`, `TOOLVOL-8` render over the object shape and the empty list). `TOOLVOL-1/5/6` and `odoo_backup: listServers 只暴露非敏感字段` were updated to the object shape and failed first, which is what made the contract violation visible. `node --check` 30/30 files.

### Security / unchanged
No change to authorization, encryption, `confirmToken`, the restore state machine, or any Host route.

---

## [0.1.15] — 2026-11-10

**Agent-tool crash fix: `Config.servers` is a `.volatile()` live reference (`{ get() }`) at runtime, and `lib/tools.js` read it as a plain array.**

### Background (real-machine defect)
Right after v0.1.14 was installed from its GitHub pin, both Agent tools failed on their first real call:
- `odoo_backup { action: "listServers" }` → `((intermediate value) ?? []).map is not a function`
- `odoo_backup { action: "test", server: "toogel" }` → `list.find is not a function`

Root cause: `Config.servers` carries `.volatile()` (it is the only kind of field `dsh-settings` allows to be written at runtime), so at runtime the value is a `{ get(): T }` live reference, not an array. The Host route layer already unwrapped it everywhere (`v0.1.13` fixed exactly this class of bug in `/precheck`), but `lib/tools.js` — `findServer()` and the `listServers` branch — still did `config?.servers ?? []` and then called `.find()` / `.map()` on the wrapper. Every action of both tools goes through `requireServer()`, so **the whole Agent-tool path was unusable** while the Settings page kept working fine (it goes through HTTP routes).

Why the suite stayed green: unit tests injected plain arrays, so the volatile wrapper was never exercised.

### Fixed
- `lib/config-value.js` (new): `unwrapVolatile()` moved out of `index.js` (so the tool layer can import it without a circular dependency) plus `unwrapVolatileList()`, which guarantees an array.
- `lib/tools.js`: `findServer()` and the `listServers` branch now go through `unwrapVolatileList(config?.servers)`; a missing/empty field still yields `[]` instead of throwing.
- `index.js`: imports `unwrapVolatile` from `lib/config-value.js` and re-exports it, so every existing call site and source-matching test is unchanged.

### Tests
**557 / 557** (baseline 551 + 6 new `TOOLVOL-1..6`: volatile `listServers`, volatile server resolution for other actions, unknown server still rejected, `odoo_restore precheck` under a volatile config, plain-array regression, and missing/empty `servers`). The new tests reproduce the production messages verbatim (`list.find is not a function`, `((intermediate value) ?? []).map is not a function`) before the fix, and pass after it. `node --check` 30/30 files.

### Security / unchanged
No change to `requireTrusted`/`guardHostKey`/`pinnedFingerprint`, R10 encryption, Passphrase Credentials, `confirmToken` semantics, the restore state machine, or any Host route. Only how the tool layer reads a config field changed.

---

## [0.1.14] — 2026-11-09

**Restore-package path usability fix: a pasted quoted path no longer fails with "package does not exist", and the verified final `.tar.enc` path is backfilled after a successful backup.**

**UI host migration: the whole operation UI moved from the installed-plugin config card to a dedicated page in DSH's native Settings.**

### Settings host migration
- Registration host changed from `plugins.bundle.config` (config card inside Installed Plugins) to `settings.section` (native Settings page, `id: odoo-backup`, `order: 210`), plus a matching `settings.section.icon` navigation icon.
- The old entry is gone: `apply` no longer registers `plugins.bundle.config`, so one feature has exactly one entrance.
- The page keeps the original three tabs (Servers / Backup / Restore) and every existing capability: server CRUD, SSH fingerprint trust, connection test, Passphrase Credentials, local backup directory, backup with real progress, resumable chunked transfer, task cancel, server mutex, restore precheck and execution, last-backup backfill.
- Zero backend change: `lib/service.js`, `lib/backup.js`, `lib/restore.js`, `lib/task-state.js`, `lib/server-lock.js`, `lib/crypto.js`, `lib/knownhosts.js` and every `index.js` route are untouched.
- Interface basis (verified against the installed build): `settings.section` is a list-kind, root-scope slot whose registrations take `{ id, order, label }` and whose components receive `{ close }`; both `slots.inject` and `register` return disposers, and re-mounting disposes first so a refresh never duplicates the entry.
- Added the `settings.nav` locale keys (zh: Odoo19 备份与恢复 / en: Odoo19 Backup & Restore).

### Background (real-machine defect)
Copying a path out of logs/JSON brings its surrounding quotes (`"K:\Backup\odoo\...\odoo-backup-202609.tar"`), or users pick the plaintext `.tar` intermediate inside the chunk working directory. Restore then fails with `备份包不存在："K:\..."`. Root cause: all four entries passed the input straight to `stat()` — quotes were never stripped, and nothing told the user which artifact is the final one.

### Added
- `lib/restore-path.js`: `normalizeRestorePath()` pure helper — trims surrounding whitespace, removes **exactly one** fully matched pair of ASCII double quotes, converts `/` to `\` on Windows. One-sided or mismatched quotes are preserved; the path is never guessed.
- `lib/completed-package.js`: `resolveLastBackup()` reads the on-disk `completed.json` and returns the authoritative `localPath` only when `completed===true`, the path ends in `.tar.enc`, the file exists and is non-empty, and `detectFormat()` confirms encryption. Otherwise backfill is refused (**the plaintext `.tar` in the chunk directory is never backfilled**).
- Host route `GET /odoo-backup/last-backup`: derives the path from disk plus server-side validation only, never from a client-supplied path.
- Restore tab explicitly states the correct format (`.tar.enc`), warns against the chunk-directory intermediate `.tar`, and asks the user to confirm the backup time point and target database; the placeholder now shows a real `.tar.enc` example.

### Changed
- Restore entries normalize uniformly: `service.restore`, the `odoo_restore` Agent tool, Host `/precheck` and `/restore`, and the Client restore button all reuse the same rule (the Client keeps an inline equivalent because the two halves have isolated module scopes).
- The `confirmToken` binding now uses the normalized path, so a quoted `precheck` pairs with an unquoted `restore` — while switching to a **different package is still rejected**.
- After a successful backup the UI calls `/last-backup` to backfill the restore input; it is called only when the backend confirms success, never on failure/cancel, and never overwrites a user-entered path.
- The original existence, format and encryption checks still run after normalization, in the same order.

### Security / unchanged
`requireTrusted`/`guardHostKey`/`pinnedFingerprint`, R10 `encryptFile`/`decryptFile`, Passphrase Credentials, the one-time 5-minute target-bound `confirmToken`, plaintext-package refusal, and the `runRestore()` verify-then-switch state machine are **all unchanged**. Path normalization only changes the string representation, never the checks.

### Tests
**410 / 410** (baseline 377 + 33 new: `PATH-1..11` normalization edges, `CP-1..9` `completed.json` validation and backfill refusal, `FLOW-1..12` cross-entry consistency and security invariants, `FILL-1..3` behavior-level backfill). `FILL-1` was proven effective by temporarily removing the backfill (fails) and restoring it (passes); the full suite shows no regressions.

---

## [0.1.13] — 2026-11-09

**SCP chunked transfer, resumable downloads, unified task state, P0 server mutex, real progress bars.**

### Added
- `lib/chunks.js`: planChunks (100 MiB chunks, ≥100 MiB threshold), Manifest, SHA-256 chunk/full verification, assemble-order guards.
- `lib/chunk-transfer.js`: remote `split` → per-part SCP via `buildScpArgs` → tmp → size+SHA verify → atomic rename → resume by re-verifying real files → assemble → full SHA check. Only after all checks does the existing `encryptFile` run (R10 timing/format/restore entry unchanged).
- `lib/chunk-control.js`: real pause/resume/retry/cancel (SCP child termination, single active executor per taskId).
- `lib/task-state.js`: `transfer-state.json` as the single persisted state source; six-state lifecycle (pending/running/paused/completed/failed/cancelled); taskId/kind isolation; atomic writes; `completed` only after backend confirmation.
- `lib/server-lock.js`: **P0 server-level mutex** — one backup/restore task per server; atomic acquire; lock tied to taskId/kind/status; released on terminal states; stale/corrupt locks on restart stay fail-closed until explicit confirmation. All execution entries (UI + Agent tools) go through it.
- `lib/backup-directory.js` + `backupDirectory` config: validate/create/writable probe, fail-closed, old tasks keep their recorded directory.
- Frontend: real progress bars for **backup and restore**, polling `/status` (disk state, not localStorage), network interruption ≠ failure, terminal-state stop, paused freeze, mutex-disabled buttons with reason, directory panel.
- `/status`, `/task-lock`, `/task-lock/confirm-stale`, `/backup-directory` routes.

### Security / unchanged
`guardHostKey`, `pinnedFingerprint`, `requireTrusted`, `buildScpArgs` safety options, R10 `encryptFile`/`decryptFile`, Passphrase Credentials, backup format, `detectFormat()`, `runRestore()` state machine, fail-closed. No password auth, no `accept-new`. SHA-256 verifies integrity only, not Manifest origin authenticity.

### Tests
**364 / 364** (70+ new v0.1.13 cases covering the 37-item spec matrix). Real-machine acceptance (≥500 MB, manual interrupt, DSH restart, no re-download of verified parts, restore entry) is recorded separately and is NOT claimed as passed by unit tests alone.

### Spec/source adjustments (recorded, minimum necessary for data safety)
1. `completed` uses the backend's `result.ok === true` as confirmation; chunk/encryption evidence is written by chunk-transfer and tightened in follow-up — no fake integrity flags.
2. `chunk-transfer` does **not** write its own `transfer-state.json`; state is returned to `service.progressReporter`, which writes the single disk state (avoids two contradictory sources).
3. On failure the remote tar/parts are **kept** for resume (old code deleted them), matching §13.
4. `backupDirectory` is `.volatile()` so the existing `settings.update` path can persist it (same mechanism as `servers`).

---

## [0.1.12] — 2026-11-07

**scp supports `sshConfigAlias`, and transfer progress is real.**

### Problem
A real backup of `toogel` (authenticated by `sshConfigAlias: toogel-vault`) succeeded over SSH but failed at the scp stage with `Permission denied (publickey,password)` — `scpDownload`/`scpUpload` only used `keyPath`, while `buildSshArgs` already supported aliases. Also the 563.8MB transfer showed `transferring 60%` for ~24 minutes with no progress.

### Added / Fixed
- `lib/ssh.js`: `buildScpArgs(server, {direction, remotePath, localPath})` — alias hosts use `<alias>:<path>` so `~/.ssh/config` supplies HostName/User/IdentityFile; `BatchMode=yes` and `StrictHostKeyChecking=yes` are always kept. `parseScpProgress()` and `computeTransferPercent(localBytes, expectedBytes)`.
- `backup.js` / `restore.js`: both scp paths now use `buildScpArgs` (no more hand-built `user@host`).
- `backup.js` `scpDownload`: progress comes from **polling the local file size** against the remote `outerSize` (OpenSSH's `%` meter only prints on a tty; our `spawn` uses pipes, so it would never fire). Percentage maps into the `transferring` phase (60–80%) with a `正在下载备份单元 N%` message; the timer/interval are cleaned up on success, error and timeout.

### Security
- No password auth, no `accept-new`, no changes to `guardHostKey`, fail-closed, R10, encryption, or the restore state machine. Alias trust still flows through the user's own `~/.ssh/config`.
- 12 new tests (SCP-1..12); **293 / 293** total.

---

## [0.1.11] — 2026-11-07

**Backup passphrase moves to the official DSH Credentials service.**

### Problem
"开始备份" was refused with "未配置加密口令…请先在插件设置页填写" — but that entry point **did not exist**: the custom card had no passphrase input, and the native settings page only renders `.volatile()` fields (`servers` only), so the passphrase was unfillable anywhere.

### Added
- `lib/service.js`: `requirePassphrase()` resolves `ODOO_BACKUP_PASSPHRASE` from the injected `credentials` service **on every execution** (no caching); backup and restore both use it; caller-supplied `opts.passphrase` no longer silently overrides the unified credential; leftover `config.passphrase` values are ignored.
- `index.js`: `POST /passphrase-status` (returns `{configured, source}` only — never the value), `POST /set-passphrase` (empty refused; response never echoes the value), `POST /unset-passphrase` (re-reads status after delete); `ctx.inject(['webServer','settings','credentials'])`.
- `client.js`: backup tab passphrase block (status line + `type="password"` input + 保存/更新/清除), loaded via `useEffect`; success clears the input only after the credential service confirms; failure keeps the input and shows the error; restore tab shows the shared status; offline-custody warning (losing the passphrase makes historical backups undecryptable).

### Security
- Passphrase never enters `cordis.patch.yml`, `/servers`, any status response, or logs (CRED-8/13/14 assertions). DSH Credentials store is `$DSH_HOME/.credentials.yaml` at `0600/0700` with owner-only checks — accepted explicitly as a permission-protected plaintext store, **not** an encrypted vault.
- R10 mandatory encryption, the encryption format, the restore state machine, `guardHostKey` and the `volatile` mechanism are unchanged. Fingerprint gate still refuses before any remote access; the passphrase check now runs first (it touches nothing remote).
- 14 new tests (CRED-1..14); **278 / 278** total.

---

## [0.1.10] — 2026-11-07

**Pick the private key with a file browser instead of typing its path.**

### Changed
- The trust panel's 「本机私钥路径」 manual text input is replaced by a **「选择私钥文件」** button backed by a hidden `<input type="file">`.
- On selection, the real absolute path is obtained through the official desktop bridge `globalThis.__DSH_HOST_PATHS__.pathFor(file)` (Electron `webUtils.getPathForFile`), then written back to the panel's `keyPath` state. The path is shown in a **read-only** display field.
- A **「手动输入路径」** fallback remains for non-desktop/browser environments where `getPathForFile` is unavailable; a clear inline message explains why.
- The hidden input is scoped with `data-trust-file-input="<server name>"` so multiple expanded panels never target the wrong input.

### Security
- **Only the path is taken.** The private key file is never read, uploaded, or placed in any API body — no `FileReader`, no `readAsText`, no file object in requests (asserted by `PICK-3`).
- `guardHostKey`'s three allow paths, fail-closed, `requireTrusted`, `/trust-host`, `/client-pubkey` (reads only `keyPath + '.pub'`) and the `volatile` config mechanism are **unchanged**.
- `PICK-1..6` regression tests; **265 / 265** total.

---

## [0.1.9] — 2026-11-07

**Self-service keyPath inside the trust panel** — fixes the onboarding dead end for every newly added host.

### Problem
On a fresh host (`new.toogel.cn` / `154.21.201.22`), the trust panel's **读取本机公钥 (Load local public key)** failed with "未配置 keyPath…请先填写私钥路径", but the panel had **no keyPath field** — users had to close the panel, click 编辑, fill the private-key path elsewhere, and reopen. This would recur for every new host.

### Fixed
- `TrustHostPanel` now has an inline **本机私钥路径 (local private key path)** input, pre-filled from the server's existing `keyPath` when any.
- `doLoadPubkey` uses the panel's `keyPath` value; when empty it shows an **inline** hint pointing at the field above instead of sending a failing API call.
- Panel copy now explicitly distinguishes the two opposite-direction public keys: the scan result is **服务器主机公钥** (server proves itself), while the key sent to the owner is **本插件客户端公钥** (we prove we hold the private key). No more confusion between the two.

### Security
- No changes to `guardHostKey`'s three allow paths, fail-closed, `requireTrusted`, `/trust-host`, `/client-pubkey` or the `volatile` config mechanism.
- `/client-pubkey` still reads **only** `keyPath + '.pub'`; the private key is never read, returned or logged.
- `UI-8..12` regression tests (incl. an explicit "security logic unchanged" assertion); **258 / 258** total.

### Verified
- Full suite 258/258; syntax clean; `RELEASE_BUILD=PASS`.
- `dsh-odoo19-backup-0.1.9.tgz` built with SHA256 recorded below.

---

## [0.1.8] — 2026-11-07

**SSH host secure onboarding experience** — first-time host trust and public-key authentication are now two clearly separated, self-service flows in the UI.

### Added
- `lib/trust.js`: `normalizeFp`, `verifyFingerprint` (SHA256 + key-type comparison), `confirmTrust` (re-checks host/port/user against the scan, rejects copy-of-scan-value), `applyTrust` (writes **only** `pinnedFingerprint`), `isTrustValid` (trust does not migrate to a changed target), `validatePublicKey`, `publicKeyPathOf` (only `.pub`), `fingerprintCommand`, and an **idempotent** `authorizedKeysCommand` (no overwrite, dedupe, chmod 700/600, self-check).
- Host routes: `POST /client-pubkey` (returns **only** the public key from `keyPath + '.pub'`; never reads/returns/logs the private key), `POST /trust-host` (re-scan → identity re-check → fingerprint/type comparison → update only `pinnedFingerprint` via `/save-servers`), and incremental fields on `/servers` (`keyPath` / `sshConfigAlias` / `pinnedFingerprint`).
- Client `TrustHostPanel`: per-server **信任主机 / 编辑 / 重新扫描** buttons, separate **主机身份** and **登录认证** status lines, the local public key, the idempotent install command, `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`, an "owner-returned fingerprint" input, and a confirm button enabled only when the returned value matches the scan.

### Fixed
- Removed the misleading `action=pin` guidance: pinning `known_hosts` never wrote `pinnedFingerprint`, so following it could never establish trust. The refusal message now distinguishes host-identity verification from login authentication.
- `classifySshError` messages now separately describe auth failure (`Permission denied`), host-key failure, timeout and refused connections.

### Security
- Host-key verification and client public-key authentication remain **two independent mechanisms**; no automatic trust, no `known_hosts` as trust source, no private key in any API response or log.
- `guardHostKey`'s three allow paths, fail-closed, `requireTrusted` and the `volatile` config mechanism are **unchanged**.
- 27 new tests (TRUST-1..14, API-1..6, UI-1..7); **253 / 253** total.
- `/pin` route kept for old Agent callers but no longer exposed in the UI.

### Verified (real host)
- Correct fingerprint + correct public key → `/test` 200 `ok=true`; wrong fingerprint → 400 "host key mismatch, possible MITM"; wrong/unauthorized key → `Permission denied`/`Identity file not accessible` (auth error, not fingerprint error); existing `toogel` (sshConfigAlias) still 200 `ok=true`.

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
