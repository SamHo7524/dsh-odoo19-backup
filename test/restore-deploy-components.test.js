/**
 * v0.1.14 真机缺陷（2026-11-09 第二次恢复失败）：
 *   状态文件："失败：临时环境验证失败：V6 站点可访问"
 *   Odoo 日志：AttributeError: 'website' object has no attribute 'clarity_project_id'
 *             Template: website.layout / Reference: 3807
 *
 * 根因：备份包内有 addons-*.tar.zst 与 pydeps-*.tar.zst，但恢复流程**只检查 addons 权限，
 * 从不部署 addons/pydeps**。目标机 addons 目录为空 → website_clarity 等自建模块缺失 →
 * registry 加载时字段不存在 → 模板渲染 500。
 *
 * 期望：恢复必须在加载数据库之前把 addons 与 pydeps 部署到目标机，
 * 否则"数据库恢复成功"只是假成功（站点打不开）。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import {
  buildDeployComponentsScript, parseDeployComponents, detectAddonsPrefix,
} from '../lib/restore.js';

const restoreSrc = readFileSync(new URL('../lib/restore.js', import.meta.url), 'utf8');

// ---------------- 前缀判定 ----------------

test('DEP-1 包内为 ./ 前缀时不加 strip（备份用 tar -C ADDONS -cf - .）', () => {
  const r = detectAddonsPrefix('./\n./foo/\n./foo/__manifest__.py\n');
  assert.equal(r.strip, 0);
});

test('DEP-2 包内为 addons/ 前缀时 strip 1 层', () => {
  const r = detectAddonsPrefix('addons/\naddons/foo/\naddons/foo/__manifest__.py\n');
  assert.equal(r.strip, 1);
});

test('DEP-3 包内直接是模块名时不加 strip', () => {
  const r = detectAddonsPrefix('foo/\nfoo/__manifest__.py\nbar/\n');
  assert.equal(r.strip, 0);
});

// ---------------- 脚本构造 ----------------

test('DEP-4 部署脚本解压 addons 到 addonsPath，解压 pydeps 到 dataPath', () => {
  const s = buildDeployComponentsScript({ addonsFile: 'addons-x.tar.zst', pydepsFile: 'pydeps-x.tar.zst' });
  assert.match(s, /addons-x\.tar\.zst/, '必须解压 addons');
  assert.match(s, /pydeps-x\.tar\.zst/, '必须解压 pydeps');
  assert.match(s, /zstd/, '需支持 zstd');
  assert.match(s, /\.gz\)|-xzf/, '需支持 gz 回退');
  assert.match(s, /"\$ADDONS"/, 'addons 必须解到 addonsPath');
  assert.match(s, /"\$DATA"/, 'pydeps 必须解到 dataPath');
});

test('DEP-5 部署后修正属主（odoo uid:gid），否则容器读不到', () => {
  const s = buildDeployComponentsScript({ addonsFile: 'a.tar.zst', pydepsFile: 'p.tar.zst' });
  assert.match(s, /chown/, '必须 chown');
  assert.match(s, /\$UID|\$GID|uid|gid/i, '属主应来自探测到的容器 uid/gid');
});

test('DEP-6 组件缺失时不得静默跳过（要能区分 skipped 与失败）', () => {
  const s = buildDeployComponentsScript({ addonsFile: '', pydepsFile: '' });
  assert.match(s, /skipped/, '未提供组件时要显式标记 skipped');
  // 解析层：skipped 与成功必须可区分
  const r = parseDeployComponents('===DEPLOY===\naddons_ok=skipped\npydeps_ok=skipped\n===DEPLOY_END===');
  assert.equal(r.addonsOk, false, 'skipped 不等于成功');
  assert.equal(r.addonsSkipped, true, 'skipped 必须可识别');
});

// ---------------- 结果解析 ----------------

test('DEP-7 解析部署结果：模块数与是否成功', () => {
  const out = [
    '===DEPLOY===',
    'addons_ok=true',
    'addons_modules=23',
    'pydeps_ok=true',
    'pydeps_files=1200',
    '===DEPLOY_END===',
  ].join('\n');
  const r = parseDeployComponents(out);
  assert.equal(r.addonsOk, true);
  assert.equal(r.addonsModules, 23);
  assert.equal(r.pydepsOk, true);
});

test('DEP-8 解压失败要判失败并带原因', () => {
  const r = parseDeployComponents('===DEPLOY===\naddons_ok=false\nerror=zstd: command not found\n===DEPLOY_END===');
  assert.equal(r.addonsOk, false);
  assert.match(r.reason ?? '', /zstd|command not found/);
});

test('DEP-9 缺结果段 → 判失败（不静默成功）', () => {
  assert.equal(parseDeployComponents('').addonsOk, false);
});

// ---------------- 流程接线 ----------------

test('DEP-10 部署必须发生在数据库加载之前（addons 先于 DB，否则 registry 跳过模块）', () => {
  const depIdx = restoreSrc.indexOf('phaseDeployComponents(');
  const loadIdx = restoreSrc.indexOf('phaseB_tempRestore(');
  assert.ok(depIdx > 0, '必须存在部署阶段');
  assert.ok(loadIdx > 0, '必须存在临时恢复阶段');
  assert.ok(depIdx < loadIdx, 'addons/pydeps 必须先于数据库恢复部署');
});

test('DEP-11 部署失败要抛出，不得继续做数据库恢复', () => {
  const seg = restoreSrc.slice(restoreSrc.indexOf('async function phaseDeployComponents'));
  assert.match(seg, /throw/, '失败必须抛出');
});

test('DEP-12 部署完成后校验模块数，为 0 视为失败（空 addons 会导致 500）', () => {
  const seg = restoreSrc.slice(restoreSrc.indexOf('async function phaseDeployComponents'));
  assert.match(seg, /addonsModules|modules/, '需检查模块数');
  assert.match(seg, /=== 0|<= 0|!.*Modules/, '为 0 要判失败');
});
