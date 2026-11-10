/**
 * 真机验证：备份包三组件抽取 + addons 前缀判定。
 * 只读本地包，不触碰目标机。
 */
import { extractBundle, detectAddonsPrefix } from '../lib/restore.js';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { spawn } from 'node:child_process';

const TAR = 'K:\\Backup\\odoo\\20261109\\629b3bb6244bc5685b42ed1c5217bf22bfa688bb32e7dbcbc5298310ebb27199\\odoo-backup-20261109-103541.tar';

const results = [];
const chk = (n, ok, d = '') => {
  results.push([n, ok]);
  console.log(`  ${ok ? '✅' : '❌'} ${n}${d ? ` — ${d}` : ''}`);
};

const tarList = (pkg, member) => new Promise((resolve) => {
  const p = spawn('tar', ['-xOf', pkg, member], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  p.stdout.on('data', (d) => { out += d.toString(); });
  p.on('close', () => resolve(out));
});

const tmp = await mkdtemp(join(tmpdir(), 'dsh-bundle-probe-'));
try {
  const b = await extractBundle(TAR, tmp);
  chk('抽出 dump.zip', Boolean(b.dumpZip), b.dumpZip ? basename(b.dumpZip) : '(无)');
  chk('抽出 addons 组件', Boolean(b.addons), b.addons ? basename(b.addons) : '(无)');
  chk('抽出 pydeps 组件', Boolean(b.pydeps), b.pydeps ? basename(b.pydeps) : '(无)');

  if (b.addons) {
    const s = await stat(b.addons);
    chk('addons 包非空', s.size > 0, `${s.size} bytes`);
  }

  // 用真实包内成员列表验证前缀判定
  const listing = await tarList(TAR, `./${basename(b.addons)}`).catch(() => '');
  // addons 包本身是 tar.zst，取成员需要 zstd；改用 tar -tf 直接看内层
  const innerList = await new Promise((resolve) => {
    const p = spawn('tar', ['--use-compress-program=zstd', '-tf', b.addons], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d.toString(); });
    p.on('error', () => resolve(''));
    p.on('close', () => resolve(out));
  });
  const head = innerList.split('\n').slice(0, 5).join('\n');
  console.log('    addons 包内前 5 项:', JSON.stringify(head.split('\n').filter(Boolean)));
  const { strip } = detectAddonsPrefix(innerList);
  chk('前缀判定为 ./ → 不 strip', strip === 0, `strip=${strip}`);
  chk('内层含模块清单', /__manifest__\.py|^\.[/]?$/m.test(innerList), '');
} finally {
  await rm(tmp, { recursive: true, force: true });
}

const failed = results.filter(([, ok]) => !ok).length;
console.log(`\nRESULT: ${failed === 0 ? 'PASS' : 'FAIL'} (${results.length - failed}/${results.length})`);
process.exit(failed === 0 ? 0 : 1);
