import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import {
  parseAddonsPerm,
  detectRollbackState,
  resolveOldDb,
  extractDumpZip,
  headIsTar,
  buildTempRestoreScript,
  buildSwitchScript,
  buildRollbackScript,
} from '../lib/restore.js';

function tarExtract(args) {
  return new Promise((resolve, reject) => {
    const p = spawn('tar', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (c) => (c === 0 ? resolve() : reject(new Error(err.slice(-200)))));
  });
}

test('headIsTar 识别 tar 文件头', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rst-'));
  try {
    const tar = join(dir, 'a.tar');
    const buf = Buffer.alloc(263, 0);
    buf.write('ustar', 257, 'latin1'); // POSIX ustar 魔数在偏移 257
    await writeFile(tar, buf);
    assert.equal(await headIsTar(tar), true);
    const not = join(dir, 'x.txt');
    await writeFile(not, 'hello');
    assert.equal(await headIsTar(not), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('extractDumpZip 从包中抽取 dump.zip', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rst-'));
  try {
    const bundle = join(dir, 'b.tar');
    const work = join(dir, 'work');
    await writeFile(join(dir, 'dump.zip'), 'DUMP-CONTENT-1234');
    // 真实备份包用 tar -C workdir . 打包，成员带 ./ 前缀，这里复现
    await tarExtract(['-cf', bundle, '-C', dir, '.']);
    const out = await extractDumpZip(bundle, work);
    const st = await stat(out);
    assert.ok(st.size > 0);
    assert.equal(out.endsWith('dump.zip'), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('parseAddonsPerm 解析修复与残留', () => {
  const sec = [
    'dirs_missing_x=12',
    'files_missing_r=3',
    'repaired_x=12',
    'repaired_r=3',
    'remaining_missing_x=0',
  ].join('\n');
  const p = parseAddonsPerm(sec);
  assert.equal(p.addonsMissing, false);
  assert.equal(p.repairedX, 12);
  assert.equal(p.repairedR, 3);
  assert.equal(p.remainX, 0);
});

test('parseAddonsPerm 检测 addons 目录缺失', () => {
  const p = parseAddonsPerm('addons_missing=true');
  assert.equal(p.addonsMissing, true);
  assert.equal(p.remainX, 0);
});

test('parseAddonsPerm 残留 > 0 标记需要手工修复', () => {
  const sec = [
    'repaired_x=5',
    'remaining_missing_x=2',
  ].join('\n');
  const p = parseAddonsPerm(sec);
  assert.equal(p.repairedX, 5);
  assert.equal(p.remainX, 2);
});

test('detectRollbackState 一致时返回 CONSISTENT', () => {
  const s = detectRollbackState('DB: prod=1 old=1\nFS: prod=1 old=1');
  assert.equal(s.consistent, true);
});

test('detectRollbackState 不一致时返回 INCONSISTENT', () => {
  const s = detectRollbackState('DB: prod=0 old=1\nFS: prod=1 old=1');
  assert.equal(s.consistent, false);
});

test('resolveOldDb 从脚本输出解析旧库名', () => {
  const out = '===OLDDB===\ntg-odoo-old-20261101000000\n===END===';
  assert.equal(resolveOldDb(out), 'tg-odoo-old-20261101000000');
});

test('resolveOldDb 缺失时回退默认', () => {
  assert.equal(resolveOldDb('===END===', 'tg-odoo', '20261101'), 'tg-odoo-old-20261101');
});

// 回归：odoo-restore 陷阱 1 —— dbfilter=^tg-odoo$ / list_db=False 时
// `load -f` 的 exp_drop 被过滤，预建库会导致 "Database already exists" 且
// 旧代码用 `| tail -5` 吞掉错误。修正 = 超级用户 DROP + load 不带 -f + 全量输出。
test('buildTempRestoreScript 用超级用户 DROP 且 load 默认不带 -n/-f（v0.1.27）', () => {
  const s = buildTempRestoreScript();
  assert.match(s, /DROP DATABASE IF EXISTS/);
  assert.match(s, /psql -U \"\$PG_SUPER\"/);
  // load 命令里不应出现 -f（--db_host 里有 -h 不算）
  const loadLine = s.split('\n').find((l) => l.includes('odoo db') && l.includes(' load '));
  assert.ok(loadLine, '应有 load 命令');
  assert.doesNotMatch(loadLine, / load -n -f /);
  // v0.1.27：neutralize 改为显式选项，默认不中立化。
  // 旧实现把 `load -n` 写死 → 恢复「成功」但 42/43 cron 被禁、SMTP 凭据被销毁。
  assert.doesNotMatch(loadLine, / load -n /, '默认不得中立化（-n 必须由 neutralize:true 显式开启）');
  assert.ok(!loadLine.includes('CREATE DATABASE'), '不应预建临时库');
});

test('buildTempRestoreScript neutralize:true 时才带 -n（演练场景显式开启）', () => {
  const s = buildTempRestoreScript({ neutralize: true });
  const loadLine = s.split('\n').find((l) => l.includes('odoo db') && l.includes(' load '));
  assert.ok(loadLine, '应有 load 命令');
  assert.match(loadLine, / load -n /, '显式要求中立化时必须带 -n');
});

test('buildTempRestoreScript 捕获完整 load 输出与退出码', () => {
  const s = buildTempRestoreScript();
  assert.match(s, /LOAD_OUT=\$\(/);
  assert.match(s, /LOAD_RC=\$\?/);
  assert.match(s, /===LOAD===/);
  assert.ok(!s.includes('| tail -5'), '不能用 tail 吞掉 load 错误');
  assert.match(s, /echo \"\$LOAD_OUT\"/);
});

test('buildTempRestoreScript shell 变量全部转义（无 JS 模板插值泄漏）', () => {
  const s = buildTempRestoreScript();
  assert.equal((s.match(/(^|[^\\])\$\{[A-Za-z_]/g) ?? []).length, 0);
});

// 事故回归：切换/回滚脚本里的可执行行绝不能再用 LIKE 前缀扫描或 % 通配。
// 只检查非注释行（注释里说明"不要写 LIKE"是允许的）。
function executableLines(s) {
  return s.split('\n').filter((l) => !l.trimStart().startsWith('#'));
}

test('buildSwitchScript 可执行行不含 LIKE 或前缀通配', () => {
  const s = buildSwitchScript();
  const code = executableLines(s).join('\n');
  assert.ok(!/LIKE/i.test(code), '切换脚本可执行行不得出现 LIKE');
  assert.ok(!/'\$\{DB\}%'/ .test(code), "不得出现 '${DB}%' 前缀模式");
  assert.match(s, /TERMINATE_SQL/);
  assert.match(s, /RENAME_OLD_SQL/);
  assert.match(s, /RENAME_NEW_SQL/);
});

test('buildRollbackScript 可执行行不含 LIKE 或前缀通配', () => {
  const s = buildRollbackScript();
  const code = executableLines(s).join('\n');
  assert.ok(!/LIKE/i.test(code), '回滚脚本可执行行不得出现 LIKE');
  assert.ok(!code.includes('grep "^${DB}"'), '不得出现前缀 grep 扫描');
  assert.match(s, /grep -Fx/);
  assert.match(s, /LOOKUP_SQL/);
  assert.match(s, /RENAME_FAILED_SQL/);
  assert.match(s, /RENAME_BACK_SQL/);
});
