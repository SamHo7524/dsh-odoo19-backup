/**
 * v0.1.12 RED — scp 支持 sshConfigAlias + 传输进度。
 *
 * 真机缺陷（2026-11-07 备份 toogel）：服务器用 sshConfigAlias（toogel-vault）
 * 认证，SSH 命令走 buildSshArgs 的 alias 分支能连上，但 scpDownload/scpUpload
 * 只用 keyPath，导致 scp 阶段 Permission denied (publickey,password)。
 * 另：563.8MB 包传输期间本地文件 0MB、进度停在 60%，需要可读的传输进度。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const backupSrc = readFileSync(new URL('../lib/backup.js', import.meta.url), 'utf8');
const restoreSrc = readFileSync(new URL('../lib/restore.js', import.meta.url), 'utf8');

// ---------------------------------------------------------------- alias 分支

test('SCP-1 scpDownload 支持 sshConfigAlias：别名机型直接用别名作为源，不拼 user@host', () => {
  // 纯函数断言（导出后可改为直接调用）
  const s = readFileSync(new URL('../lib/ssh.js', import.meta.url), 'utf8');
  assert.match(s, /export function buildScpArgs/, 'ssh.js 应导出可复用的 scp 参数构造函数');
  assert.match(s, /sshConfigAlias/, '参数构造必须识别别名');
});

test('SCP-2 buildScpArgs(alias 型) 返回 [alias:remotePath, localPath] 形态且不含 user@host 字面量', async () => {
  const { buildScpArgs } = await import('../lib/ssh.js');
  const server = { name: 'toogel', host: '47.121.205.143', port: 22, user: 'root', sshConfigAlias: 'toogel-vault' };
  const args = buildScpArgs(server, {
    direction: 'download', remotePath: '/tmp/b.tar.enc', localPath: 'K:/b.tar.enc',
  });
  const joined = args.join(' ');
  assert.match(joined, /toogel-vault:\/tmp\/b\.tar\.enc/, '源应使用别名');
  assert.ok(!joined.includes('root@47.121.205.143'), '别名机型不应再拼 user@host');
  assert.match(joined, /K:\/b\.tar\.enc/);
});

test('SCP-3 buildScpArgs(keyPath 型) 保持原有 -i 与 user@host 形态（不回归）', async () => {
  const { buildScpArgs } = await import('../lib/ssh.js');
  const server = { host: '10.0.0.1', port: 2222, user: 'ubuntu', keyPath: 'C:/k/id' };
  const args = buildScpArgs(server, { direction: 'download', remotePath: '/r', localPath: 'L' });
  const j = args.join(' ');
  assert.match(j, /-P 2222/);
  assert.match(j, /-i C:\/k\/id/);
  assert.match(j, /ubuntu@10\.0\.0\.1:\/r/);
});

test('SCP-4 buildScpArgs(upload) 别名机型目标用 alias:path，且源在本地前', async () => {
  const { buildScpArgs } = await import('../lib/ssh.js');
  const server = { host: 'h', port: 22, user: 'root', sshConfigAlias: 'jump' };
  const args = buildScpArgs(server, { direction: 'upload', remotePath: '/dst', localPath: 'src.tgz' });
  const j = args.join(' ');
  assert.match(j, /src\.tgz/);
  assert.match(j, /jump:\/dst/);
  assert.ok(!j.includes('root@h'));
});

test('SCP-5 安全底线不变：BatchMode=yes 与 StrictHostKeyChecking=yes 仍保留', async () => {
  const { buildScpArgs } = await import('../lib/ssh.js');
  const args = buildScpArgs({ host: 'h', port: 22, user: 'root', sshConfigAlias: 'a' },
    { direction: 'download', remotePath: '/r', localPath: 'L' });
  const j = args.join(' ');
  assert.match(j, /BatchMode=yes/);
  assert.match(j, /StrictHostKeyChecking=yes/);
});

// ---------------------------------------------------------------- 接线

test('SCP-6 backup.js 不再自己拼 scp 参数，改用 buildScpArgs', () => {
  assert.match(backupSrc, /buildScpArgs\(/, '备份下载应复用统一构造函数');
  assert.ok(!/args\.push\(`\$\{server\.user\}@\$\{server\.host\}/.test(backupSrc), '不得再手工拼 user@host');
});

test('SCP-7 restore.js 不再自己拼 scp 参数，改用 buildScpArgs', () => {
  assert.match(restoreSrc, /buildScpArgs\(/, '恢复上传应复用统一构造函数');
  assert.ok(!/args\.push\(srcPath, `\$\{server\.user\}@\$\{server\.host\}/.test(restoreSrc), '不得再手工拼 user@host');
});

// ---------------------------------------------------------------- 进度

test('SCP-8 scpDownload 支持 onProgress 回调并解析 scp 进度百分比', async () => {
  const { parseScpProgress } = await import('../lib/ssh.js');
  assert.equal(typeof parseScpProgress, 'function', '应有可测的进度解析函数');
  // scp 经典进度行： "file.tar.enc   12%  512MB  10.2MB/s   00:42"
  assert.equal(parseScpProgress('b.tar.enc   12%  512MB  10.2MB/s   00:42'), 12);
  assert.equal(parseScpProgress('b.tar.enc  100%  563MB  23.1MB/s   00:24'), 100);
  assert.equal(parseScpProgress('no percent here'), null);
});

test('SCP-9 scpDownload 在 stderr 出现进度行时调用 onProgress（真实接线）', () => {
  const s = readFileSync(new URL('../lib/backup.js', import.meta.url), 'utf8');
  assert.match(s, /onProgress/, '下载函数应接受进度回调');
  assert.match(s, /parseScpProgress\(/, '应复用统一解析器');
});

test('SCP-10 传输进度接入任务状态：runBackup 的 progressReporter 能收到 transferring 阶段百分比', () => {
  const s = readFileSync(new URL('../lib/backup.js', import.meta.url), 'utf8');
  assert.match(s, /transferring/, '应有 transferring 阶段');
  assert.match(s, /onProgress/, '进度应上报给 onProgress');
});

test('SCP-11 进度不依赖 scp 的 tty 进度条：用本地文件大小轮询（真机可行）', () => {
  // OpenSSH scp 的 % 进度条只在 stderr 是 tty 时输出；spawn 用 pipe 时静默。
  // 因此必须以本地文件增长为准，否则「进度」名存实亡。
  const s = readFileSync(new URL('../lib/backup.js', import.meta.url), 'utf8');
  assert.match(s, /stat\(/, 'scpDownload 应读本地文件大小');
  assert.match(s, /expectedBytes|totalBytes|remoteBytes/, '应知道远端总大小以算百分比');
});

test('SCP-12 文件增长轮询按 expectedBytes 计算百分比并回调', async () => {
  const { computeTransferPercent } = await import('../lib/ssh.js');
  assert.equal(typeof computeTransferPercent, 'function');
  assert.equal(computeTransferPercent(0, 1000), 0);
  assert.equal(computeTransferPercent(250, 1000), 25);
  assert.equal(computeTransferPercent(1000, 1000), 100);
  assert.equal(computeTransferPercent(1200, 1000), 100, '不得超过 100');
  assert.equal(computeTransferPercent(50, 0), null, '未知总大小时不编造百分比');
});
