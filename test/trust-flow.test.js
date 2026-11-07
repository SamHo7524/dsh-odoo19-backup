/**
 * v0.1.8 RED — SSH 首次主机信任与公钥认证流程。
 *
 * 规格（用户 2026-11-07 批准）：
 *  - 主机指纹核验与客户端公钥认证是两套独立机制，不可混为一谈
 *  - 不自动信任扫描值；必须由服务器所有者通过独立渠道回传指纹
 *  - 不允许用户复制扫描值作为回传值（防 MITM 自证）
 *  - 指纹不一致禁止保存信任
 *  - 只更新 pinnedFingerprint，不覆盖 keyPath 或其他服务器配置
 *  - 信任确认时重新核对 host/port/user 与扫描时一致（防配置被替换）
 *  - 指纹比较统一标准化 SHA256 同时核对公钥类型
 *  - 本机公钥必须验证格式有效；API 绝不读取/返回/记录私钥
 *  - 公钥安装命令幂等（不覆盖、去重、权限、自查）
 *  - 服务器配置变化，原有信任不得迁移到新目标
 *
 * 本文件先测纯函数 lib/trust.js（尚未创建 → RED）。
 */
import { test } from 'node:test';
import assert from 'node:assert';

const T = await import('../lib/trust.js');

const SCAN = {
  ok: true,
  host: '134.175.51.9',
  port: 22,
  user: 'root',   // handler 在扫描时记录当时使用的 user，供信任确认时三方核对
  fingerprints: [{ type: 'ssh-ed25519', fingerprint: 'SHA256:Yty1O6gmuMyQ3i7vUqiZy0gomEAF/Ssg2h9uNNC0qn0' }],
};
const SERVER = { name: 'odoo.toogel.cn', host: '134.175.51.9', port: 22, user: 'root', keyPath: 'C:/k/id', pinnedFingerprint: '' };

// ---------------------------------------------------------------- 指纹比对

test('TRUST-1 指纹标准化：带/不带 SHA256 前缀、大小写、空白都归一', () => {
  assert.equal(T.normalizeFp('SHA256:AbC123='), 'AbC123=');
  assert.equal(T.normalizeFp('  sha256:AbC123=  '), 'AbC123=');
  assert.equal(T.normalizeFp('AbC123='), 'AbC123=');
  assert.equal(T.normalizeFp(''), '');
});

test('TRUST-2 扫描值与回传值一致 + 类型一致 → 允许确认', () => {
  const r = T.verifyFingerprint(SCAN, 'ssh-ed25519', 'SHA256:Yty1O6gmuMyQ3i7vUqiZy0gomEAF/Ssg2h9uNNC0qn0');
  assert.equal(r.ok, true);
  assert.equal(r.fingerprint, 'Yty1O6gmuMyQ3i7vUqiZy0gomEAF/Ssg2h9uNNC0qn0');
});

test('TRUST-3 指纹不一致 → 禁止确认，不返回可写指纹', () => {
  const r = T.verifyFingerprint(SCAN, 'ssh-ed25519', 'SHA256:WRONG');
  assert.equal(r.ok, false);
  assert.match(r.reason, /不一致/);
  assert.equal(r.fingerprint, undefined);
});

test('TRUST-4 公钥类型不一致 → 禁止确认（即使指纹字符串相同）', () => {
  const r = T.verifyFingerprint(SCAN, 'ssh-rsa', 'SHA256:Yty1O6gmuMyQ3i7vUqiZy0gomEAF/Ssg2h9uNNC0qn0');
  assert.equal(r.ok, false);
  assert.match(r.reason, /类型/);
});

test('TRUST-5 回传值等于扫描值也不算独立核验：必须由独立输入提供且带确认标记', () => {
  // 防 MITM 自证：verifyFingerprint 不关心来源，但 confirmTrust 拒绝「回传值来自扫描结果」。
  const scanFp = SCAN.fingerprints[0].fingerprint;
  const r = T.confirmTrust({
    server: SERVER, scan: SCAN, answerFp: scanFp, answerType: 'ssh-ed25519',
    answerFromScanResult: true,   // UI 若把扫描值直接回填，应被拒
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /独立|复制|扫描值/);
});

// ---------------------------------------------------------------- 身份重核

test('TRUST-6 信任确认时重新核对 host/port/user 与扫描时一致', () => {
  const drifted = { ...SERVER, host: '1.2.3.4' };
  const r = T.confirmTrust({
    server: drifted, scan: SCAN, answerFp: 'SHA256:Yty1O6gmuMyQ3i7vUqiZy0gomEAF/Ssg2h9uNNC0qn0',
    answerType: 'ssh-ed25519', answerFromScanResult: false,
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /host|目标|一致|变化/);
});

test('TRUST-7 端口/用户变化同样拒绝', () => {
  for (const patch of [{ port: 2222 }, { user: 'ubuntu' }]) {
    const r = T.confirmTrust({
      server: { ...SERVER, ...patch }, scan: SCAN,
      answerFp: 'SHA256:Yty1O6gmuMyQ3i7vUqiZy0gomEAF/Ssg2h9uNNC0qn0',
      answerType: 'ssh-ed25519', answerFromScanResult: false,
    });
    assert.equal(r.ok, false, `变化 ${JSON.stringify(patch)} 必须拒绝`);
  }
});

// ---------------------------------------------------------------- 只改指纹

test('TRUST-8 确认信任只更新 pinnedFingerprint，不覆盖 keyPath 或其他字段', () => {
  const next = T.applyTrust(SERVER, 'SHA256:Yty1O6gmuMyQ3i7vUqiZy0gomEAF/Ssg2h9uNNC0qn0');
  assert.equal(next.pinnedFingerprint, 'SHA256:Yty1O6gmuMyQ3i7vUqiZy0gomEAF/Ssg2h9uNNC0qn0');
  assert.equal(next.keyPath, 'C:/k/id', 'keyPath 必须原样保留');
  assert.equal(next.name, SERVER.name);
  assert.equal(next.sshConfigAlias, undefined);
});

test('TRUST-9 服务器目标变化后，旧信任不得自动迁移', () => {
  const trusted = T.applyTrust(SERVER, 'SHA256:Yty1O6gmuMyQ3i7vUqiZy0gomEAF/Ssg2h9uNNC0qn0');
  const moved = { ...trusted, host: '9.9.9.9' };
  const r = T.isTrustValid(moved, SCAN);
  assert.equal(r.ok, false, '换了 host 后旧指纹不能继续生效');
});

test('TRUST-10 isTrustValid：原目标 + 匹配指纹 → 有效', () => {
  const trusted = T.applyTrust(SERVER, 'SHA256:Yty1O6gmuMyQ3i7vUqiZy0gomEAF/Ssg2h9uNNC0qn0');
  assert.equal(T.isTrustValid(trusted, SCAN).ok, true);
});

// ---------------------------------------------------------------- 公钥与命令

test('TRUST-11 公钥格式校验：合法 ed25519 通过，私钥/垃圾拒绝', () => {
  assert.equal(T.validatePublicKey('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample toogel-vault-sync').ok, true);
  assert.equal(T.validatePublicKey('-----BEGIN OPENSSH PRIVATE KEY-----').ok, false, '绝不能把私钥当公钥');
  assert.equal(T.validatePublicKey('garbage').ok, false);
  assert.equal(T.validatePublicKey('').ok, false);
});

test('TRUST-12 公钥安装命令幂等：不覆盖、去重、权限、自查', () => {
  const cmd = T.authorizedKeysCommand('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample dsh-backup');
  assert.match(cmd, />>|tee -a|grep -qF/, '不得用 > 覆盖');
  assert.match(cmd, /grep -qF/, '相同公钥不重复添加');
  assert.match(cmd, /chmod 700/);
  assert.match(cmd, /chmod 600/);
  assert.match(cmd, /grep -qF/, '执行后检查公钥存在');
});

test('TRUST-13 公钥文件读取只接受 .pub 路径，绝不读私钥', () => {
  assert.equal(T.publicKeyPathOf('C:/k/id'), 'C:/k/id.pub');
  assert.equal(T.publicKeyPathOf(''), null);
  assert.equal(T.publicKeyPathOf(undefined), null);
  // 绝不构造/返回私钥路径
  assert.equal(T.publicKeyPathOf('C:/k/id_rsa'), 'C:/k/id_rsa.pub');
});

test('TRUST-14 指纹核验命令是主机所有者侧命令，不含私钥', () => {
  const cmd = T.fingerprintCommand();
  assert.match(cmd, /ssh-keygen -lf/);
  assert.match(cmd, /ssh_host_ed25519_key\.pub/);
  assert.ok(!/id_rsa|id_ed25519|PRIVATE|\.pub\s*>\s*\//.test(cmd));
});
