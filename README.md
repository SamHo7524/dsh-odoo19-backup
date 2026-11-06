# dsh-odoo19-backup

DSH (DeepSeek Harness) plugin for **Odoo 19 remote backup and safe restore**.

Backs up database + filestore + addons + runtime deps + config over SSH, and restores through temp-DB verification, downtime switch, and rollback on failure. Host-key pinning is fail-closed.

## Install from GitHub

In DSH, install the bundle from this repository:

```
github:SamHo7524/dsh-odoo19-backup#v0.1.7
```

or install the release tarball:

```
K:/Backup/odoo-plugin-releases/packages/dsh-odoo19-backup-0.1.7.tgz
```

The bundle package name is `@local/dsh-odoo19-backup` and the patch row id is `odoo-backup`.

## Configuration

Add servers on the plugin's settings page. For each server either:

- set `sshConfigAlias` to a Host in `~/.ssh/config` (trust delegated to your SSH config), or
- click **扫描指纹** to obtain the host key fingerprint, verify it manually, then paste it into `pinnedFingerprint`.

Backups are encrypted (a `passphrase` is required); restore requires a one-time `confirmToken` from `precheck`.

## Development

```
node --test test/*.test.js
node test/manual-release-build.mjs
```

## Version

0.1.7 — all identifiers lowercased, installable from GitHub.
