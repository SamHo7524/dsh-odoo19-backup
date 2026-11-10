// 检查本仓库的发布物是否齐全、同步（只读，不改任何东西）。
// 用法：node scripts/release-sync-check.mjs
//
// 检查项（对照 GitHub 远端，逐版本）：
//   1. git tag 是否存在
//   2. GitHub Release 是否存在（tag != Release，Release 是带说明和附件的发布物）
//   3. Release 附件 .tgz 是否存在
//   4. 仓库根 README.md / README.zh-CN.md 的「当前版本」是否等于 package.json 版本
//   5. CHANGELOG.md / CHANGELOG.zh-CN.md 是否都有该版本的章节
//   6. package.json version 是否等于最新 tag
//
// 依赖：git 命令行（凭据复用 git credential manager，与 push 相同）。
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const repo = process.env.RELEASE_REPO || 'K:/Backup/odoo-plugin-releases/_gh-publish/repo';
const git = (args) => execFileSync('C:/Program Files/Git/cmd/git.exe', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

// 与 git push 相同的凭据路径：credential manager 里存的 PAT。
function ghToken() {
  const out = execFileSync('C:/Program Files/Git/cmd/git.exe', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8',
  });
  const line = out.split('\n').find((l) => l.startsWith('password='));
  if (!line) throw new Error('git credential fill 未返回 password（先 git push 一次以保存凭据）');
  return line.slice('password='.length);
}

async function gh(path) {
  const r = await fetch(`https://api.github.com/repos/SamHo7524/dsh-odoo19-backup/${path}`, {
    headers: { Authorization: `token ${ghToken()}`, 'User-Agent': 'release-sync-check', Accept: 'application/vnd.github+json' },
  });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GitHub API ${r.status}: ${await r.text()}`);
  return r.json();
}

const cmpSemver = (a, b) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
};
const tagList = git(['tag', '-l']).split('\n').filter(Boolean).map((t) => t.replace(/^v/, ''));
const versions = tagList.sort(cmpSemver);
const latest = versions.at(-1);
const readmeEn = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const readmeZh = readFileSync(new URL('../README.zh-CN.md', import.meta.url), 'utf8');
const changelogEn = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
const changelogZh = readFileSync(new URL('../CHANGELOG.zh-CN.md', import.meta.url), 'utf8');

let bad = 0;
const fail = (msg) => { bad++; console.log(`  ✗ ${msg}`); };
const ok = (msg) => console.log(`  ✓ ${msg}`);

console.log(`package.json version = ${pkg.version}; latest tag = v${latest}`);
if (pkg.version !== latest) fail(`package.json(${pkg.version}) != 最新 tag(v${latest})`);

for (const v of versions) {
  console.log(`\n[v${v}]`);
  let release = null;
  try { release = await gh(`releases/tags/v${v}`); } catch (e) { fail(`Release 查询失败: ${e.message}`); continue; }
  if (!release) { fail('缺少 GitHub Release（只有 tag 不算发布）'); continue; }
  ok(`Release 存在 (draft=${release.draft})`);
  const assets = release.assets.map((a) => a.name);
  const want = [`dsh-odoo19-backup-${v}.tgz`, `local-dsh-odoo19-backup-${v}.tgz`];
  if (!want.some((w) => assets.includes(w))) fail(`附件缺 .tgz（现有: ${assets.join(',') || '无'}）`);
  else ok(`附件 ${assets.join(',')} (${release.assets[0].size} B)`);
  if (!changelogEn.includes(`## [${v}]`)) fail('CHANGELOG.md 缺该版本章节');
  if (!changelogZh.includes(`## [${v}]`)) fail('CHANGELOG.zh-CN.md 缺该版本章节');
}

console.log('\n[README 版本同步]');
for (const [name, text] of [['README.md', readmeEn], ['README.zh-CN.md', readmeZh]]) {
  if (text.includes(`Current version: \`${pkg.version}\``) || text.includes(`当前版本：\`${pkg.version}\``)) ok(`${name} 版本号 = ${pkg.version}`);
  else fail(`${name} 的「当前版本」不是 ${pkg.version}`);
}

console.log(bad === 0 ? '\nALL SYNCED ✓' : `\n${bad} 项不同步 ✗`);
process.exit(bad === 0 ? 0 : 1);
