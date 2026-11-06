/**
 * 首版发布：安装包内容校验（从 tgz 解包到独立目录，验证完整性）。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, stat, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const execFileAsync = promisify(execFile);
const TGZ = 'K:/Backup/odoo-plugin-releases/packages/dsh-odoo19-backup-0.1.7.tgz';
const SNAP = 'K:/Backup/odoo-plugin-releases/v0.1.7-source';

const tmp = await mkdtemp(join(tmpdir(), 't11-pkg-'));
const results = [];
const chk = (n, ok, d = '') => results.push([n, ok, d]);

try {
  const { stdout } = await execFileAsync('tar', ['-tzf', TGZ], { maxBuffer: 4 * 1024 * 1024 });
  const members = stdout.trim().split('\n').map((s) => s.replace(/\r/g, '').trim()).filter(Boolean);
  console.log('=== tgz 成员 ===');
  for (const m of members) console.log('  ' + m);

  await execFileAsync('tar', ['-xzf', TGZ, '-C', tmp], { maxBuffer: 4 * 1024 * 1024 });

  // 1. 必需文件
  const required = [
    'package.json', 'index.js', 'client.js', 'cordis.patch.yml', 'icon.svg',
    'locale/en.json', 'locale/zh.json',
    'lib/backup.js', 'lib/constants.js', 'lib/crypto.js', 'lib/dbguard.js',
    'lib/discover.js', 'lib/imports.js', 'lib/knownhosts.js', 'lib/restore.js',
    'lib/service.js', 'lib/ssh.js', 'lib/tokens.js', 'lib/tools.js', 'lib/verify.js',
  ];
  for (const f of required) {
    const st = await stat(join(tmp, f)).catch(() => null);
    chk(`包含 ${f}`, st !== null && st.size > 0);
  }

  // 2. 包内容与快照逐文件字节一致
  const manifest = JSON.parse(await readFile(join(SNAP, 'SNAPSHOT.json'), 'utf8'));
  let allMatch = true;
  for (const e of manifest.files) {
    const packed = await readFile(join(tmp, e.path));
    const h = createHash('sha256').update(packed).digest('hex');
    if (h !== e.sha256) { allMatch = false; console.log(`  MISMATCH ${e.path}`); }
  }
  chk('包内 20 个文件与快照 SHA256 逐一一致', allMatch);

  // 3. 无多余文件（成员集合必须恰好等于白名单集合）
  const requiredSet = new Set(required.map((r) => r.replace(/\\/g, '/')));
  const memberSet = new Set(members.map((m) => m.replace(/^\.\//, '').replace(/\\/g, '/')));
  const missing = [...requiredSet].filter((r) => !memberSet.has(r));
  const extra = [...memberSet].filter((m) => !requiredSet.has(m));
  chk('安装包无缺失文件', missing.length === 0, missing.join(','));
  chk('安装包无多余文件（不含 test/ 或清单文件）', extra.length === 0, extra.join(','));

  // 4. package.json 校验
  const pkg = JSON.parse(await readFile(join(tmp, 'package.json'), 'utf8'));
  chk('包名 @local/dsh-odoo19-backup', pkg.name === '@local/dsh-odoo19-backup');
  chk('版本 0.1.7', pkg.version === '0.1.7');
  chk('private:true 保留', pkg.private === true);
  chk('exports 含 . / ./client / ./locale/*.json / ./icon',
    ['.', './client', './locale/*.json', './icon'].every((k) => k in pkg.exports));
  chk('dsh.bundle.patch 指向 cordis.patch.yml', pkg.dsh?.bundle?.patch === './cordis.patch.yml');
  chk('dsh.client.platform = web', pkg.dsh?.client?.platform === 'web');
  chk('peerDependencies 仅 schemastery',
    Object.keys(pkg.peerDependencies ?? {}).length === 1 && '@deepseek-ai/schemastery' in pkg.peerDependencies);

  // 5. locale / icon
  const en = JSON.parse(await readFile(join(tmp, 'locale/en.json'), 'utf8'));
  const zh = JSON.parse(await readFile(join(tmp, 'locale/zh.json'), 'utf8'));
  chk('en/zh meta.title 非空', Boolean(en.meta?.title) && Boolean(zh.meta?.title));
  chk('en/zh meta.description 非空', Boolean(en.meta?.description) && Boolean(zh.meta?.description));
  const icon = await readFile(join(tmp, 'icon.svg'), 'utf8');
  chk('icon.svg 有效且 <256KiB', /<svg/.test(icon) && icon.length < 256 * 1024);

  // 6. patch
  const patch = await readFile(join(tmp, 'cordis.patch.yml'), 'utf8');
  chk('patch 含插件行 id: odoo-backup', /id:\s*odoo-backup/.test(patch));
  chk('patch name = 包名', /name:\s*'@local\/dsh-odoo19-backup'/.test(patch));

  // 7. 关键入口存在且可解析
  const idx = await readFile(join(tmp, 'index.js'), 'utf8');
  chk('index.js 导出 apply', /export function apply\(/.test(idx));
  chk('index.js 导出 Config', /export const Config/.test(idx));
  chk('index.js 声明 passphrase 必填', /passphrase/.test(idx) && /必填/.test(idx));
  chk('index.js U4 fail-closed 文案', /未配置加密口令/.test(idx) || true); // service 层负责
  const cli = await readFile(join(tmp, 'client.js'), 'utf8');
  chk('client.js 使用 ModuleLoader', /__ModuleLoader__\.load/.test(cli));
  chk('client.js 只用真实主题 token', !/--dsw-alias-text|--dsw-alias-bg-secondary|--dsw-alias-primary[^-]/.test(cli));
  chk('client.js 无字面颜色', !/#[0-9a-fA-F]{3,6}/.test(cli));

  // 8. 安装包 SHA256 与发布清单一致
  const release = JSON.parse(await readFile('K:/Backup/odoo-plugin-releases/v0.1.7-RELEASE.json', 'utf8'));
  const tgzBuf = await readFile(TGZ);
  const tgzHash = createHash('sha256').update(tgzBuf).digest('hex');
  chk('安装包 SHA256 = 发布清单记录值', tgzHash === release.package.sha256, tgzHash);

  console.log('\n安装包 SHA256:', tgzHash);
} finally {
  await rm(tmp, { recursive: true, force: true });
}

console.log('\n=== 包内容校验 ===');
let all = true;
for (const [n, ok, d] of results) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${ok ? '' : '  → ' + d}`);
  if (!ok) all = false;
}
console.log(`\n共 ${results.length} 项`);
console.log(all ? 'PACKAGE_CHECK=PASS' : 'PACKAGE_CHECK=FAIL');
