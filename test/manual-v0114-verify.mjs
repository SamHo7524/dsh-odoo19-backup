/**
 * v0.1.14 真机验证（只读）：
 *  1. 用真实 K:\Backup\odoo 驱动 Host handleUiRequest，验证 /last-backup 返回最终 .enc
 *  2. 复现用户原始缺陷路径（带引号），验证 precheck→restore 的 token 绑定已规范化
 *  3. 验证分片目录中的明文 .tar 被拒绝回填
 * 不写盘、不触达远端、不重启 DSH。
 */
import { readFileSync } from 'node:fs';
import { createTokenStore } from '../lib/tokens.js';
import { normalizeRestorePath } from '../lib/restore-path.js';
import { resolveLastBackup } from '../lib/completed-package.js';

const hostSrc = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const start = hostSrc.indexOf('async function handleUiRequest');
if (start < 0) throw new Error('index.js 缺少 handleUiRequest');
const body = hostSrc.slice(start).replace(/^async function handleUiRequest/, 'async function');

// handleUiRequest 依赖模块级辅助函数/import；单独提取后必须显式注入。
// 其中 unwrapVolatile / stateDirOf 与 index.js 内定义保持同语义（volatile 活引用解包）。
const unwrapVolatile = (v) => (v !== null && typeof v === 'object' && typeof v.get === 'function' ? v.get() : v);
const DEFAULT_BACKUP_DIRECTORY = 'K:/Backup/odoo';
const stateDirOf = (config) => unwrapVolatile(config?.backupDirectory)
  ?? unwrapVolatile(config?.localBackupDir) ?? DEFAULT_BACKUP_DIRECTORY;

// eslint-disable-next-line no-new-func
const handleUiRequest = new Function(
  'normalizeRestorePath', 'resolveLastBackup', 'unwrapVolatile', 'stateDirOf', 'DEFAULT_BACKUP_DIRECTORY',
  `${body.replace(/^async function/, 'return (async function')})`,
)(normalizeRestorePath, resolveLastBackup, unwrapVolatile, stateDirOf, DEFAULT_BACKUP_DIRECTORY);

const results = [];
const chk = (name, ok, detail = '') => {
  results.push([name, ok, detail]);
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};

function makeRes() {
  const out = { statusCode: 0, body: '' };
  return {
    out,
    set statusCode(v) { out.statusCode = v; },
    get statusCode() { return out.statusCode; },
    setHeader() {},
    end(b) { out.body = b; },
  };
}
function makeReq({ method = 'GET', url, body: payload } = {}) {
  const chunks = payload === undefined ? [] : [Buffer.from(JSON.stringify(payload))];
  return {
    method, url,
    headers: { host: '127.0.0.1:29123' },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() { yield* chunks; },
  };
}

const BACKUP_DIR = 'K:\\Backup\\odoo';
const EXPECT_ENC = 'K:\\Backup\\odoo\\20261109\\odoo-backup-20261109-103541.tar.enc';
const SPLIT_TAR = 'K:\\Backup\\odoo\\20261109\\629b3bb6244bc5685b42ed1c5217bf22bfa688bb32e7dbcbc5298310ebb27199\\odoo-backup-20261109-103541.tar';

console.log('\n=== 1. /last-backup 真实磁盘 ===');
{
  const res = makeRes();
  await handleUiRequest({
    req: makeReq({ url: '/odoo-backup/last-backup' }),
    res,
    config: { backupDirectory: BACKUP_DIR },
    service: {},
    tokenStore: createTokenStore(),
    settings: {},
    entryId: 'odoo-backup',
  });
  const data = JSON.parse(res.out.body);
  chk('返回 ok=true', data.ok === true, JSON.stringify(data));
  chk('路径是最终 .tar.enc', typeof data.localPath === 'string' && data.localPath.toLowerCase().endsWith('.tar.enc'), data.localPath ?? '');
  chk('路径与 completed.json 权威一致', data.localPath === EXPECT_ENC, data.localPath ?? '');
  chk('不是分片目录明文 .tar', data.localPath !== SPLIT_TAR);
}

console.log('\n=== 2. 用户原始缺陷路径（带引号）===');
{
  const raw = `"${EXPECT_ENC}"`;
  const norm = normalizeRestorePath(raw);
  chk('带引号路径被规范化为真实路径', norm === EXPECT_ENC, norm);
  chk('规范化结果可 stat（真实存在）', await (await import('node:fs/promises')).stat(norm).then(() => true, () => false));

  const store = createTokenStore();
  const res1 = makeRes();
  await handleUiRequest({
    req: makeReq({ method: 'POST', url: '/odoo-backup/precheck', body: { server: 'toogel', packagePath: raw } }),
    res: res1,
    config: { backupDirectory: BACKUP_DIR, servers: [{ name: 'toogel', host: 'h' }] },
    service: {}, tokenStore: store, settings: {}, entryId: 'odoo-backup',
  });
  const pre = JSON.parse(res1.out.body);
  chk('带引号 precheck 通过并发放 token', pre.ok === true && typeof pre.confirmToken === 'string', JSON.stringify(pre).slice(0, 120));

  const res2 = makeRes();
  await handleUiRequest({
    req: makeReq({ method: 'POST', url: '/odoo-backup/restore', body: { server: 'toogel', packagePath: EXPECT_ENC, confirmToken: pre.confirmToken } }),
    res: res2,
    config: { backupDirectory: BACKUP_DIR, servers: [{ name: 'toogel', host: 'h' }] },
    service: { async restore() { return { ok: true, reached: 'service.restore' }; } },
    tokenStore: store, settings: {}, entryId: 'odoo-backup',
  });
  const rest = JSON.parse(res2.out.body);
  chk('引号版 precheck + 无引号 restore 正确配对', rest.ok === true && rest.result?.reached === 'service.restore', JSON.stringify(rest).slice(0, 160));
}

console.log('\n=== 3. 安全边界未降低 ===');
{
  const store = createTokenStore();
  const res1 = makeRes();
  await handleUiRequest({
    req: makeReq({ method: 'POST', url: '/odoo-backup/precheck', body: { server: 'toogel', packagePath: EXPECT_ENC } }),
    res: res1, config: { backupDirectory: BACKUP_DIR, servers: [{ name: 'toogel', host: 'h' }] },
    service: {}, tokenStore: store, settings: {}, entryId: 'odoo-backup',
  });
  const pre = JSON.parse(res1.out.body);
  const res2 = makeRes();
  await handleUiRequest({
    req: makeReq({ method: 'POST', url: '/odoo-backup/restore', body: { server: 'toogel', packagePath: SPLIT_TAR, confirmToken: pre.confirmToken } }),
    res: res2, config: { backupDirectory: BACKUP_DIR, servers: [{ name: 'toogel', host: 'h' }] },
    service: { async restore() { return { ok: true }; } }, tokenStore: store, settings: {}, entryId: 'odoo-backup',
  });
  const bad = JSON.parse(res2.out.body);
  chk('换包仍被 token 拒绝', res2.out.statusCode === 400 && /不匹配：packagePath/.test(bad.error ?? ''), bad.error ?? '');

  const res3 = makeRes();
  await handleUiRequest({
    req: makeReq({ method: 'POST', url: '/odoo-backup/restore', body: { server: 'toogel', packagePath: EXPECT_ENC } }),
    res: res3, config: { backupDirectory: BACKUP_DIR, servers: [{ name: 'toogel', host: 'h' }] },
    service: {}, tokenStore: store, settings: {}, entryId: 'odoo-backup',
  });
  chk('无 confirmToken 仍被拒绝', res3.out.statusCode === 400 && /confirmToken/.test(JSON.parse(res3.out.body).error ?? ''), JSON.parse(res3.out.body).error ?? '');
}

const failed = results.filter(([, ok]) => !ok);
console.log(`\nRESULT: ${failed.length === 0 ? 'PASS' : 'FAIL'} (${results.length - failed.length}/${results.length})`);
process.exit(failed.length === 0 ? 0 : 1);
