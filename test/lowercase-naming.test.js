/**
 * 全量小写重命名回归（用户要求「安装 dsh 的插件标注全部转换为小写」）。
 *
 * 目标标识：@local/dsh-odoo19-backup
 * 仓库：SamHo7524/dsh-odoo19-backup
 * 安装包：dsh-odoo19-backup-<ver>.tgz
 *
 *  RED 断言：
 *   - 所有运行时/发布相关文件里不得再出现大写 DSH-ODOO19-Backup
 *   - package.json name 必须为小写
 *   - client.js 的 ModuleLoader id / slot key / locale.bind 必须与包名一致
 *   - locale en/zh 的 meta.title 必须为小写
 *   - cordis.patch.yml 的 name 必须与包名一致
 *   - 构建脚本产出的 tgz 名必须为小写
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OLD = 'DSH-ODOO19-Backup';
const NEW = '@local/dsh-odoo19-backup';
const SHORT = 'dsh-odoo19-backup';

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git' || name === 'test') continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(js|mjs|json|yml|yaml|md)$/.test(name)) out.push(p);
  }
  return out;
}

function read(rel) {
  return readFileSync(join(ROOT, rel), 'utf8');
}

test('LOWER-1 运行时/发布文件里不再有大写标识 DSH-ODOO19-Backup（CHANGELOG 历史记录除外）', () => {
  const files = walk(ROOT);
  const offenders = [];
  for (const f of files) {
    const rel = relative(ROOT, f).replace(/\\/g, '/');
    // CHANGELOG 里 0.1.0–0.1.6 的历史包名是真实记录，允许保留
    if (/^CHANGELOG(\.zh-CN)?\.md$/.test(rel)) continue;
    const text = readFileSync(f, 'utf8');
    if (text.includes(OLD)) offenders.push(rel);
  }
  assert.deepEqual(offenders, [],
    '以下文件仍含大写标识：' + offenders.join(', '));
});

test('LOWER-2 package.json 的 name 为小写 @local/dsh-odoo19-backup', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.name, NEW);
});

test('LOWER-3 cordis.patch.yml 的 name 与包名一致', () => {
  const patch = read('cordis.patch.yml');
  assert.match(patch, /name:\s*'?@local\/dsh-odoo19-backup'?/);
  assert.ok(!patch.includes(OLD));
});

test('LOWER-4 client.js 的 id / key / locale.bind 与包名一致且为小写', () => {
  const src = read('client.js');
  assert.match(src, /id:\s*'@local\/dsh-odoo19-backup'/);
  assert.match(src, /key:\s*'@local\/dsh-odoo19-backup'/);
  assert.match(src, /bind\?\.\('@local\/dsh-odoo19-backup'\)/);
  assert.ok(!src.includes(OLD));
});

test('LOWER-5 locale en/zh 的 meta.title 为小写', () => {
  for (const f of ['locale/en.json', 'locale/zh.json']) {
    const j = JSON.parse(read(f));
    assert.equal(j.meta.title, SHORT, `${f} 的 title 应为小写短名`);
  }
});

test('LOWER-6 构建脚本产出的 tgz 名为小写', () => {
  const s = read('test/manual-release-build.mjs');
  assert.match(s, /dsh-odoo19-backup-\$\{VERSION\}\.tgz/);
  assert.ok(!s.includes(OLD));
});

test('LOWER-7 发布校验脚本期望小写包名', () => {
  const v = read('test/manual-release-verify.mjs');
  assert.match(v, /@local\/dsh-odoo19-backup/);
});
