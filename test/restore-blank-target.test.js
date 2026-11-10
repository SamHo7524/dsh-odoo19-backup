/**
 * v0.1.14 修复：空白目标机恢复 + 站点域名切换。
 *
 * 真机缺陷（2026-11-09，odoo.toogel.cn）：目标库 toogel 是空壳库（0 张表），
 * 阶段 A「安全备份」调用 `odoo db dump` 时因缺 ir_module_module 必然失败，
 * 报 DUMP_FAIL 并整单中止。空目标机没有需要保护的数据，应跳过安全备份并说明原因，
 * 而不是把「无可备份」当成故障。
 *
 * 同时：备份来自生产库，website.domain / web.base.url 仍是 www.toogel.cn，
 * 直接恢复会让两个站点抢同一域名。恢复后需把目标站点域名改为本机服务器名。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import {
  buildSafetyBackupScript, parseSafetyBackup,
} from '../lib/restore.js';
import {
  isHostname, resolveTargetDomain, buildDomainPatchScript, parseDomainPatch,
} from '../lib/site-domain.js';

// ---------------- 空白目标机：安全备份 ----------------

test('SAFE-1 安全备份脚本区分「库不存在 / 真空白 / 有表但无 Odoo 架构」', () => {
  const s = buildSafetyBackupScript();
  assert.match(s, /===SAFETY_SKIP===/, '跳过要有可识别标记');
  assert.match(s, /reason=no_db/, '库不存在要单独归类');
  assert.match(s, /reason=empty_db/, '真空白要单独归类');
  assert.match(s, /to_regclass\('public\.ir_module_module'\)/, '要探测 Odoo 架构');
  assert.match(s, /information_schema\.tables/, '要用用户表数量判断是否真的空库');
});

test('SAFE-2 缺 Odoo 系统表但库里有表 → 必须用 pg_dump 保护，不得跳过', () => {
  const s = buildSafetyBackupScript();
  assert.match(s, /pg_dump/, '有数据就必须做逻辑备份');
  assert.match(s, /FORMAT=pgdump/, '要标记备份格式，便于事后识别');
  // 跳过只能发生在「库不存在」或「0 张用户表」两个分支
  assert.match(s, /TBL" = "0"/, '只有确定 0 张用户表才跳过');
  assert.ok(!/HAS" = "f"[\s\S]{0,200}SAFETY_SKIP/.test(s),
    '不得仅凭 ir_module_module 缺失就跳过（会把有数据的库当空库）');
});

test('SAFE-3 不再把 dump 的 stderr 丢进 /dev/null（失败要可诊断）', () => {
  const s = buildSafetyBackupScript();
  assert.ok(!/dump[^\n]*2>\/dev\/null/.test(s), 'dump 的 stderr 不得被丢弃');
  assert.match(s, /DUMP_ERR/, '失败时要把真实错误带出来');
});

test('SAFE-4 parseSafetyBackup：空库标记 → skipped（不是失败）', () => {
  const r = parseSafetyBackup('===SAFETY_SKIP===\nreason=empty_db\n===END===\n', 0);
  assert.equal(r.skipped, true);
  assert.equal(r.reason, 'empty_db');
});

test('SAFE-5 parseSafetyBackup：成功标记 → 解析 size/sha/path/format', () => {
  const out = [
    '===SAFETY===',
    '===FORMAT===', 'odoo-zip',
    '===SIZE===', '12345',
    '===SHA===', 'a'.repeat(64),
    '===READY===', '/tmp/safety-backup-1.zip',
    '===END===',
  ].join('\n');
  const r = parseSafetyBackup(out, 0);
  assert.equal(r.skipped, false);
  assert.equal(r.size, 12345);
  assert.equal(r.sha256, 'a'.repeat(64));
  assert.equal(r.path, '/tmp/safety-backup-1.zip');
  assert.equal(r.format, 'odoo-zip');
});

test('SAFE-6 parseSafetyBackup：pgdump 格式被如实回报', () => {
  const out = [
    '===SAFETY===',
    '===FORMAT===', 'pgdump',
    '===SIZE===', '999',
    '===SHA===', 'b'.repeat(64),
    '===READY===', '/tmp/safety-backup-1.pgdump',
    '===END===',
  ].join('\n');
  const r = parseSafetyBackup(out, 0);
  assert.equal(r.format, 'pgdump');
});

test('SAFE-7 parseSafetyBackup：dump 失败 → 带真实错误抛错', () => {
  assert.throws(() => parseSafetyBackup('===DUMP_ERR===\npsycopg2: boom\n===END===\n', 1), /boom/);
});

test('SAFE-8 库不存在跳过时不产生「文件为空」这类误导性失败', () => {
  const r = parseSafetyBackup('===SAFETY_SKIP===\nreason=no_db\n===END===\n', 0);
  assert.equal(r.skipped, true);
  assert.equal(r.size, 0);
});

// ---------------- 站点域名 ----------------

test('DOMAIN-1 服务器名是主机名时可用作站点域名', () => {
  assert.equal(isHostname('odoo.toogel.cn'), true);
  assert.equal(isHostname('toogel'), false, '单段名字不是域名');
  assert.equal(isHostname('127.0.0.1'), false, 'IP 不做域名');
  assert.equal(isHostname('a b.com'), false);
  assert.equal(isHostname(''), false);
});

test('DOMAIN-2 resolveTargetDomain 默认取服务器名，显式覆盖优先', () => {
  assert.equal(resolveTargetDomain({ server: { name: 'odoo.toogel.cn' } }), 'odoo.toogel.cn');
  assert.equal(resolveTargetDomain({ server: { name: 'odoo.toogel.cn' }, override: 'stage.toogel.cn' }), 'stage.toogel.cn');
});

test('DOMAIN-3 服务器名不是主机名且未显式指定 → null（不猜域名）', () => {
  assert.equal(resolveTargetDomain({ server: { name: 'toogel' } }), null);
  assert.equal(resolveTargetDomain({ server: { name: 'new.toogel.cn' } }), 'new.toogel.cn');
});

test('DOMAIN-4 非法 override 被拒绝', () => {
  assert.throws(() => resolveTargetDomain({
    server: { name: 'odoo.toogel.cn' }, override: "evil'; DROP TABLE website;--",
  }), /域名不合法/);
});

test('DOMAIN-5 域名补丁脚本：改 website.domain 与 web.base.url，并冻结节域名', () => {
  const s = buildDomainPatchScript();
  assert.match(s, /UPDATE website SET domain/, '必须改 website.domain');
  assert.match(s, /web\.base\.url/, '必须改 web.base.url');
  assert.match(s, /web\.base\.url\.freeze/, '必须冻结，避免 Odoo 自动改回');
  assert.match(s, /to_regclass\('public\.website'\)/, '未装 website 模块要能安全跳过');
  assert.match(s, /===DOMAIN_SKIP===/, '跳过要有标记');
  assert.match(s, /===DOMAIN_DONE===/);
});

test('DOMAIN-6 parseDomainPatch 解析改动前后值', () => {
  const out = [
    '===DOMAIN_BEFORE===', 'www.toogel.cn',
    '===DOMAIN_AFTER===', 'odoo.toogel.cn',
    '===DOMAIN_DONE===', 'changed=1',
    '===END===',
  ].join('\n');
  const r = parseDomainPatch(out);
  assert.equal(r.ok, true);
  assert.equal(r.before, 'www.toogel.cn');
  assert.equal(r.after, 'odoo.toogel.cn');
  assert.equal(r.changed, 1);
});

test('DOMAIN-7 parseDomainPatch：未装 website 模块 → skipped', () => {
  const r = parseDomainPatch('===DOMAIN_SKIP===\nreason=no_website\n===END===\n');
  assert.equal(r.ok, true);
  assert.equal(r.skipped, true);
  assert.equal(r.reason, 'no_website');
});
