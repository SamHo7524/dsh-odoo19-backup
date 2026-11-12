// 发布一个版本（幂等）。每次更新都必须同步的六件事，一处漏了就拒发或补齐：
//   package.json 版本 / 中英文 CHANGELOG / 中英文 README / 测试 / GitHub Release + .tgz 附件 / tag+push
//
// 用法：
//   node scripts/publish-release.mjs --dry-run                 只校验 + 测试 + 打包，不写远端
//   node scripts/publish-release.mjs                           发布 package.json 里的版本（全流程）
//   node scripts/publish-release.mjs --releases-only           只补 GitHub Release + 附件（tag 已存在的补发布）
//   node scripts/publish-release.mjs --releases-only --version 0.1.15   为历史版本补 Release
//
// 依赖：git 命令行 + git credential manager 里的 GitHub PAT（与 git push 同一份凭据）。
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GIT = 'C:/Program Files/Git/cmd/git.exe';
const NODE = process.execPath;
const REPO = process.env.RELEASE_REPO || 'K:/Backup/odoo-plugin-releases/_gh-publish/repo';
const PKG_DIR = 'K:/Backup/odoo-plugin-releases/packages';
const OWNER_REPO = 'SamHo7524/dsh-odoo19-backup';
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const releasesOnly = args.includes('--releases-only');
const versionArg = args.includes('--version') ? args[args.indexOf('--version') + 1] : null;

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const version = versionArg || pkg.version;
const tag = `v${version}`;
const tgzName = `dsh-odoo19-backup-${version}.tgz`;

const log = (m) => console.log(m);
const die = (m) => { console.error(`\nFAILED: ${m}`); process.exit(1); };
const run = (cmd, argv, opts = {}) => execFileSync(cmd, argv, { encoding: 'utf8', ...opts }).trim();
const runInRepo = (argv, opts) => run(GIT, ['-C', REPO, ...argv], opts);

let tokenCache;
const ghToken = () => {
  if (tokenCache) return tokenCache;
  const out = execFileSync(GIT, ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8',
  });
  const line = out.split('\n').find((l) => l.startsWith('password='));
  if (!line) die('git credential fill 未返回 password（先 git push 一次以保存凭据）');
  return (tokenCache = line.slice('password='.length));
};

const ghHeaders = (extra = {}) => ({
  Authorization: `token ${ghToken()}`,
  'User-Agent': 'dsh-publish-release',
  Accept: 'application/vnd.github+json',
  ...extra,
});

async function ghApi(path, init = {}) {
  const clean = String(path).replace(/^\/+/, '');
  const r = await fetch(`https://api.github.com/repos/${OWNER_REPO}/${clean}`, { ...init, headers: ghHeaders(init.headers) });
  if (r.status === 404 && (init.method || 'GET') === 'GET') return null;
  if (!r.ok) die(`GitHub API ${init.method || 'GET'} ${path} -> ${r.status}: ${(await r.text()).slice(0, 400)}`);
  return r.status === 204 ? null : r.json();
}

// 从 CHANGELOG 抽出该版本章节，拼成 Release 说明（与历史 Release 保持同风格 + 双语链接）。
function releaseNotes(changelogText) {
  const lines = changelogText.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim().startsWith(`## [${version}]`));
  if (start === -1) return null;
  const body = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) break;
    body.push(lines[i]);
  }
  // 只取概述段（到第一个 ### 之前），再补安装行。
  const summary = [];
  for (const l of body) {
    if (/^### /.test(l)) break;
    if (l.trim() === '---') break;
    summary.push(l);
  }
  const text = summary.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return `${text}\n\n---\n\nInstall: \`github:${OWNER_REPO}#${tag}\`\n\nDetails: [CHANGELOG.md](https://github.com/${OWNER_REPO}/blob/main/CHANGELOG.md) · [CHANGELOG.zh-CN.md](https://github.com/${OWNER_REPO}/blob/main/CHANGELOG.zh-CN.md)`;
}

// Release 标题沿用历史风格：「vX.Y.Z — 一句话摘要」（取自该版本章节的加粗概述首句）。
function releaseTitle(changelogText) {
  const lines = changelogText.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim().startsWith(`## [${version}]`));
  if (start === -1) return tag;
  let first = '';
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) break;
    const t = lines[i].replace(/\*\*/g, '').trim();
    if (t && !t.startsWith('###') && t !== '---') { first = t; break; }
  }
  const short = first
    .replace(/`/g, '')
    .split(/(?<=[.。!?])\s/)[0]
    .replace(/[.。!?]$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  const capped = short.length > 64 ? `${short.slice(0, 64).replace(/\s+\S*$/, '')}…` : short;
  return capped ? `${tag} — ${capped}` : tag;
}

// ---------- 1. 文档一致性闸门 ----------
log(`=== publish ${tag}${dryRun ? ' (dry-run)' : ''}${releasesOnly ? ' (releases-only)' : ''} ===`);
const changelogEn = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');
const changelogZh = readFileSync(join(ROOT, 'CHANGELOG.zh-CN.md'), 'utf8');
if (!changelogEn.includes(`## [${version}]`)) die(`CHANGELOG.md 缺 ## [${version}] 章节`);
if (!changelogZh.includes(`## [${version}]`)) die(`CHANGELOG.zh-CN.md 缺 ## [${version}] 章节`);
log('✓ 中英文 CHANGELOG 均有该版本章节');

if (!releasesOnly) {
  const readmeEn = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const readmeZh = readFileSync(join(ROOT, 'README.zh-CN.md'), 'utf8');
  if (pkg.version !== version) die(`package.json(${pkg.version}) 与目标版本(${version}) 不一致`);
  if (!readmeEn.includes(`Current version: \`${version}\``)) die(`README.md 当前版本不是 ${version}`);
  if (!readmeZh.includes(`当前版本：\`${version}\``)) die(`README.zh-CN.md 当前版本不是 ${version}`);
  if (!readmeEn.includes(`#${tag}`) || !readmeZh.includes(`#${tag}`)) die(`README 安装源未指向 #${tag}`);
  log('✓ 中英文 README 版本号与安装源一致');
}

// ---------- 2. 测试 ----------
if (!releasesOnly) {
  log('=== tests ===');
  // v0.1.27：串行执行（--test-concurrency=1）。
  // 若干既有测试（service-v0113 / v0117-fix 等）共用固定状态目录与锁文件，
  // 并行跑时偶发互相踩踏（SVC-3 / V17-S2 间歇性失败），会让发布门禁误报。
  // 串行后连续 3 次稳定 646/646，代价是耗时略增，换来门禁可信。
  const out = execFileSync(NODE, ['--test', '--test-concurrency=1', 'test/**/*.test.js'], { cwd: ROOT, encoding: 'utf8' });
  const num = (re) => out.split('\n').map((l) => l.match(re)).filter(Boolean).at(-1)?.[1];
  const pass = num(/^# pass (\d+)/) ?? num(/^ℹ pass (\d+)/);
  const fail = num(/^# fail (\d+)/) ?? num(/^ℹ fail (\d+)/) ?? '0';
  log(`  pass=${pass} fail=${fail}`);
  if (fail !== '0') die('测试未全部通过');
}

// ---------- 3. 打包（统一命名 dsh-odoo19-backup-X.Y.Z.tgz） ----------
log('=== pack ===');
mkdirSync(PKG_DIR, { recursive: true });
const finalTgz = join(PKG_DIR, tgzName);
if (!existsSync(finalTgz)) {
  if (pkg.version !== version) {
    die(`缺少 ${tgzName}，且工作区版本(${pkg.version}) ≠ 目标(${version})；拒绝用错误内容打包，请先把该版本的 tarball 放进 ${PKG_DIR}`);
  }
  const pnpm = join(dirname(NODE), '..', '..', 'pnpm', 'bin', 'pnpm.mjs');
  if (!existsSync(pnpm)) die(`找不到 pnpm: ${pnpm}`);
  const tmp = join(tmpdir(), `pack-${version}-${Date.now()}`);
  mkdirSync(tmp, { recursive: true });
  execFileSync(NODE, [pnpm, 'pack', '--pack-destination', tmp], { cwd: ROOT, encoding: 'utf8' });
  const { readdirSync } = await import('node:fs');
  const tgz = readdirSync(tmp).find((f) => f.endsWith('.tgz'));
  if (!tgz) die('打包未产出 .tgz');
  copyFileSync(join(tmp, tgz), finalTgz);
  rmSync(tmp, { recursive: true, force: true });
  log(`  ${tgz} -> ${tgzName}`);
} else {
  log(`  复用已有 ${tgzName}`);
}

if (dryRun) { log('\nDRY-RUN OK（未写远端）'); process.exit(0); }

// ---------- 4. 同步发布仓 + 提交 + tag + push ----------
if (!releasesOnly) {
  log('=== mirror to publish repo ===');
  // robocopy 用 0–7 表示成功（1 = 有文件被复制），>=8 才是失败。
  try {
    execFileSync('robocopy', [ROOT, REPO, '/MIR', '/XD', '.git', 'node_modules', '/NFL', '/NDL', '/NJH', '/NJS', '/NP'], { stdio: 'pipe', cwd: ROOT });
  } catch (e) {
    if (typeof e.status !== 'number' || e.status >= 8) die(`robocopy 失败 (exit ${e.status})`);
  }
  runInRepo(['add', '-A']);
  const status = runInRepo(['status', '--porcelain']);
  if (status) {
    runInRepo(['commit', '-m', `${tag}: ${version} release`]);
    log(`  committed`);
  } else log('  nothing to commit');

  log('=== tag ===');
  const existing = runInRepo(['tag', '-l', tag]);
  if (!existing) {
    runInRepo(['tag', '-a', tag, '-m', `${tag}`]);
    log(`  created ${tag}`);
  } else {
    const headOfTag = runInRepo(['rev-list', '-n', '1', tag]);
    const head = runInRepo(['rev-parse', 'HEAD']);
    if (headOfTag !== head) die(`tag ${tag} 已存在且不指向当前 HEAD（拒绝改写已发布 tag）`);
    log(`  ${tag} already at HEAD`);
  }

  log('=== push ===');
  runInRepo(['push', 'origin', 'main']);
  runInRepo(['push', 'origin', tag]);
  log('  pushed main + tag');
}

// ---------- 5. GitHub Release + .tgz 附件 ----------
log('=== github release ===');
const remoteTag = await ghApi(`git/ref/tags/${tag}`);
if (!remoteTag) die(`远端不存在 tag ${tag}，先推 tag`);
const notes = releaseNotes(changelogEn);
if (!notes) die('无法从 CHANGELOG 生成 Release 说明');
const title = releaseTitle(changelogEn);

let release = await ghApi(`releases/tags/${tag}`);
if (!release) {
  release = await ghApi('/releases', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tag_name: tag, name: title, body: notes, draft: false, prerelease: false }),
  });
  log(`  release created: ${release.html_url}`);
} else {
  log(`  release exists: ${release.html_url}`);
  if (release.body !== notes || release.name !== title) {
    release = await ghApi(`/releases/${release.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: title, body: notes }),
    });
    log(`  notes/title refreshed: ${title}`);
  }
}

const assets = release.assets || [];
if (assets.some((x) => x.name === tgzName)) {
  log(`  asset exists: ${tgzName}`);
} else {
  const bytes = readFileSync(finalTgz);
  const uploaded = await fetch(
    `https://uploads.github.com/repos/${OWNER_REPO}/releases/${release.id}/assets?name=${encodeURIComponent(tgzName)}`,
    { method: 'POST', headers: ghHeaders({ 'Content-Type': 'application/gzip', 'Content-Length': String(bytes.length) }), body: bytes },
  );
  if (!uploaded.ok) die(`附件上传失败 ${uploaded.status}: ${(await uploaded.text()).slice(0, 300)}`);
  log(`  asset uploaded: ${tgzName} (${bytes.length} B)`);
}

// ---------- 6. 终检 ----------
const verify = await ghApi(`releases/tags/${tag}`);
if (!verify.assets?.some((x) => x.name === tgzName)) die('终检失败：Release 附件缺失');
log(`\nDONE: https://github.com/${OWNER_REPO}/releases/tag/${tag}`);