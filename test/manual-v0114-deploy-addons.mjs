/**
 * 真机验证：addons 部署能否消除 V6 的 500。
 *
 * 做法：把真实包里的 addons-*.tar.zst 上传到目标机，用 buildDeployComponentsScript
 * 部署，然后直接验证 website.layout 引用的 website_clarity 是否已存在。
 * 不修改数据库、不碰正式库 toogel。
 */
import { buildDeployComponentsScript, parseDeployComponents, detectAddonsPrefix } from '../lib/restore.js';
import { execRemote } from '../lib/ssh.js';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { extractBundle } from '../lib/restore.js';

const server = {
  name: 'odoo.toogel.cn', host: '134.175.51.9', port: 22, user: 'root',
  keyPath: 'C:/Users/Ho/.ssh/toogel_vault',
};
const TAR = 'K:\\Backup\\odoo\\20261109\\629b3bb6244bc5685b42ed1c5217bf22bfa688bb32e7dbcbc5298310ebb27199\\odoo-backup-20261109-103541.tar';
const WORK = '/tmp/dsh-deploy-verify';

const results = [];
const chk = (n, ok, d = '') => {
  results.push([n, ok]);
  console.log(`  ${ok ? '✅' : '❌'} ${n}${d ? ` — ${d}` : ''}`);
};
const run = (cmd, opts = {}) => execRemote(server, cmd, { timeoutMs: 600000, ...opts });

const tmp = await mkdtemp(join(tmpdir(), 'dsh-deploy-src-'));
try {
  const b = await extractBundle(TAR, tmp);
  chk('本地抽出 addons', Boolean(b.addons), b.addons ? basename(b.addons) : '(无)');
  const st = await stat(b.addons);
  console.log(`    addons 包 ${(st.size / 1048576).toFixed(1)} MB`);

  await run(`mkdir -p ${WORK}`);
  // scp 上传（用系统 scp，与插件一致）
  await new Promise((resolve, reject) => {
    const p = spawn('scp', ['-o', 'StrictHostKeyChecking=yes', '-i', 'C:/Users/Ho/.ssh/toogel_vault',
      b.addons, `root@134.175.51.9:${WORK}/${basename(b.addons)}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    let e = ''; p.stderr.on('data', (d) => { e += d.toString(); });
    p.on('close', (c) => (c === 0 ? resolve() : reject(new Error(e.slice(-300)))));
  });
  chk('addons 包已上传', true, `${WORK}/${basename(b.addons)}`);

  // 用真实包探测前缀
  const probe = await run(`tar --use-compress-program=zstd -tf ${WORK}/${basename(b.addons)} 2>/dev/null | head -3`);
  const head = probe.stdout.split('\n').filter(Boolean);
  console.log('    包内前 3 项:', JSON.stringify(head));
  const strip = detectAddonsPrefix(probe.stdout).strip;
  chk('前缀判定不 strip（备份用 tar -C . )', strip === 0, `strip=${strip}`);

  // 真实部署（用实现里的脚本）
  const stdin = [
    '/opt/1panel/apps/odoo/odoo/data/addons',
    '/opt/1panel/apps/odoo/odoo/data/data',
    '100', '101', WORK, String(strip),
  ].join('\n') + '\n';
  const r = await run(buildDeployComponentsScript({
    addonsFile: basename(b.addons), pydepsFile: '',
  }), { stdin });
  const parsed = parseDeployComponents(r.stdout);
  console.log('    部署结果:', JSON.stringify(parsed));

  chk('addons_ok=true', parsed.addonsOk === true);
  chk('模块数 > 0', parsed.addonsModules > 0, `modules=${parsed.addonsModules}`);

  // 关键：website_clarity 是否已就位（这是 500 的直接原因）
  const hasClarity = await run(
    `test -d /opt/1panel/apps/odoo/odoo/data/addons/website_clarity && echo YES || echo NO`);
  chk('website_clarity 模块已部署', hasClarity.stdout.trim() === 'YES', hasClarity.stdout.trim());

  const clarityField = await run(
    `grep -rl "clarity_project_id" /opt/1panel/apps/odoo/odoo/data/addons/website_clarity 2>/dev/null | head -3`);
  chk('clarity_project_id 字段定义存在', Boolean(clarityField.stdout.trim()),
    clarityField.stdout.trim().split('\n')[0] ?? '');

  // 容器内可见性
  const inContainer = await run(`docker exec 1Panel-odoo-OmjL ls -1 /mnt/extra-addons | head -5`);
  chk('容器内可见 addons', Boolean(inContainer.stdout.trim()), inContainer.stdout.trim().split('\n')[0] ?? '');
} finally {
  await run(`rm -rf ${WORK}`).catch(() => {});
  await rm(tmp, { recursive: true, force: true });
  console.log('  已清理临时文件');
}

const failed = results.filter(([, ok]) => !ok).length;
console.log(`\nRESULT: ${failed === 0 ? 'PASS' : 'FAIL'} (${results.length - failed}/${results.length})`);
process.exit(failed === 0 ? 0 : 1);
