import { test } from 'node:test';
import assert from 'node:assert';
import { classifySshError, buildSshArgs } from '../lib/ssh.js';

test('classifySshError 识别认证失败', () => {
  const r = classifySshError(255, 'root@1.2.3.4: Permission denied (publickey).');
  assert.equal(r.kind, 'auth');
});

test('classifySshError 识别网络拒绝', () => {
  const r = classifySshError(255, 'ssh: connect to host 1.2.3.4 port 22: Connection refused');
  assert.equal(r.kind, 'network');
});

test('classifySshError 识别云厂商二次验证', () => {
  const r = classifySshError(255, '请使用微信扫码安全登录。');
  assert.equal(r.kind, 'cloud-mfa');
});

test('classifySshError 识别指纹变化', () => {
  const r = classifySshError(255, 'REMOTE HOST IDENTIFICATION HAS CHANGED!');
  assert.equal(r.kind, 'hostkey-changed');
});

test('classifySshError 成功时返回 ok', () => {
  const r = classifySshError(0, '');
  assert.equal(r.kind, 'ok');
});

test('buildSshArgs 不包含密码参数', () => {
  const args = buildSshArgs({
    host: '1.2.3.4',
    port: 22,
    user: 'root',
    keyPath: '/k/id',
  });
  assert.ok(!args.some((a) => a.includes('password')), 'SSH 参数不得含密码');
  assert.ok(args.includes('BatchMode=yes'));
  assert.ok(args.includes('StrictHostKeyChecking=yes'));
});

test('buildSshArgs 支持 ssh config 别名', () => {
  const args = buildSshArgs({ sshConfigAlias: 'production' });
  assert.deepEqual(args, ['production']);
});

test('buildSshArgs 非默认端口使用 -p', () => {
  const args = buildSshArgs({ host: 'h', port: 2222, user: 'u' });
  assert.ok(args.includes('-p'));
  assert.ok(args.includes('2222'));
});
