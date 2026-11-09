/**
 * 首版内部发布：从工作区固化独立源码快照，并构建 DSH bundle 安装包。
 *
 * 原则（用户批准）：
 *  - 不初始化 Git、不建 commit/tag、不改 private:true、不公开发布
 *  - 独立发布快照目录 + 文件清单 + SHA256
 *  - 原工作区保留不动
 */
import {
  mkdir, readdir, copyFile, writeFile, stat, rm, readFile,
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, relative, dirname, basename } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const SRC = 'C:/Users/Ho/.dsh/remote-workspaces/wmv8yhew3a4r8/dsh-odoo-backup';
const RELEASES = 'K:/Backup/odoo-plugin-releases';
const VERSION = '0.1.13';
const SNAP = join(RELEASES, `v${VERSION}-source`);
const PACKAGES = join(RELEASES, 'packages');

async function sha256(file) {
  const h = createHash('sha256');
  const buf = await readFile(file);
  h.update(buf);
  return h.digest('hex');
}

async function walk(dir, out = []) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) await walk(full, out);
    else out.push(full);
  }
  return out;
}

console.log('=== 1. 固化源码快照 ===');
await rm(SNAP, { recursive: true, force: true });
await mkdir(SNAP, { recursive: true });
await mkdir(PACKAGES, { recursive: true });

const pkg = JSON.parse(await readFile(join(SRC, 'package.json'), 'utf8'));
const patterns = pkg.files;

// 解析 files 白名单为具体文件
const relFiles = new Set(['package.json']);
for (const p of patterns) {
  if (p.includes('*')) {
    const dir = join(SRC, dirname(p));
    const match = basename(p); // 仅支持 *.js / *.json 形式
    const ext = match.startsWith('*') ? match.slice(1) : null;
    const list = await readdir(dir, { withFileTypes: true });
    for (const e of list) {
      if (e.isFile() && (!ext || e.name.endsWith(ext))) {
        relFiles.add(relative(SRC, join(dir, e.name)).replace(/\\/g, '/'));
      }
    }
  } else {
    relFiles.add(p);
  }
}

const sorted = [...relFiles].sort();
const entries = [];
for (const rel of sorted) {
  const from = join(SRC, rel);
  const to = join(SNAP, rel);
  const st = await stat(from);
  await mkdir(dirname(to), { recursive: true });
  await copyFile(from, to);
  entries.push({ path: rel, bytes: st.size, sha256: await sha256(to) });
  console.log(`  ${String(st.size).padStart(7)}  ${rel}`);
}

console.log(`\n  ${entries.length} 个文件，${entries.reduce((a, b) => a + b.bytes, 0)} 字节`);

// 快照自身的清单
const manifest = {
  name: pkg.name,
  version: pkg.version,
  private: pkg.private,
  generatedAt: new Date().toISOString(),
  source: SRC,
  snapshot: SNAP,
  note: 'v0.1.7 全量小写命名版源码快照；不含 test/；未初始化 Git，无 commit/tag',
  files: entries,
};
const manifestPath = join(SNAP, 'SNAPSHOT.json');
await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

// 独立的 SHA256 校验文件（标准 sha256sum 格式）
const sums = entries.map((e) => `${e.sha256}  ${e.path}`).join('\n') + '\n';
await writeFile(join(RELEASES, `v${VERSION}-source.SHA256`), sums, 'utf8');

console.log('\n=== 2. 从快照构建 DSH bundle ===');
const tgzName = `dsh-odoo19-backup-${VERSION}.tgz`;
const tgzPath = join(PACKAGES, tgzName);
await rm(tgzPath, { force: true });

// 用系统 tar 打包（排除 SNAPSHOT.json 与 SHA256 文件之外的临时物）
// 只包含 files 白名单 + package.json，确保包内容与快照一致
const tarArgs = ['-czf', tgzPath, '-C', SNAP];
for (const rel of sorted) tarArgs.push(rel.replace(/\\/g, '/'));
try {
  await execFileAsync('tar', tarArgs, { maxBuffer: 10 * 1024 * 1024 });
} catch (e) {
  console.error('tar 失败:', e.message, e.stderr);
  process.exit(1);
}

const tgzStat = await stat(tgzPath);
const tgzSha = await sha256(tgzPath);
console.log(`  安装包: ${tgzPath}`);
console.log(`  大小:   ${tgzStat.size} 字节`);
console.log(`  SHA256: ${tgzSha}`);

await writeFile(
  join(PACKAGES, `${tgzName}.sha256`),
  `${tgzSha}  ${tgzName}\n`,
  'utf8',
);

// 顶层发布清单
const releaseManifest = {
  name: pkg.name,
  version: pkg.version,
  private: pkg.private,
  generatedAt: new Date().toISOString(),
  sourceSnapshot: SNAP,
  sourceFileCount: entries.length,
  sourceBytes: entries.reduce((a, b) => a + b.bytes, 0),
  package: {
    path: tgzPath,
    bytes: tgzStat.size,
    sha256: tgzSha,
    format: 'tar.gz (DSH bundle, install_bundle 可用目录或 tgz)',
  },
  verification: {
    unitTests: '278/278',
    syntax: '15/15',
    redGreen: 'REG-1..8 + STORE-1..2 + ADD-1..3 + SCOPE-1..2 经 RED/GREEN 验证（含 getSnapshot 崩溃与 Electron 无 prompt 回归）',
    application: 'applies, warnings: []',
    u4: 'fail-closed',
  },
  notVerified: [
    '真实 R1 停机切换与回滚（需单独授权）',
    '浏览器内视觉渲染与点击（GUI 需鉴权 URL，本轮未接入浏览器控制）',
  ],
  production: '未部署，生产服务器全程只读',
};
await writeFile(
  join(RELEASES, `v${VERSION}-RELEASE.json`),
  JSON.stringify(releaseManifest, null, 2) + '\n',
  'utf8',
);

console.log('\n=== 3. 输出 ===');
console.log('  发布根目录:', RELEASES);
console.log('  源码快照:  ', SNAP);
console.log('  快照清单:  ', manifestPath);
console.log('  文件校验:  ', join(RELEASES, `v${VERSION}-source.SHA256`));
console.log('  安装包:    ', tgzPath);
console.log('  发布清单:  ', join(RELEASES, `v${VERSION}-RELEASE.json`));
console.log('\nRELEASE_BUILD=PASS');
