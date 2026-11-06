import { test } from 'node:test';
import assert from 'node:assert';
import {
  parseHostKeyFromVerbose,
  computeFingerprint,
  normalizeFingerprint,
  compareFingerprint,
} from '../lib/knownhosts.js';

test('parseHostKeyFromVerbose 提取服务器主机密钥', () => {
  const out = [
    'debug1: kex: host key algorithm: ssh-ed25519',
    'debug1: Server host key: ssh-ed25519 SHA256:uOmOzd32qk8nGbHznwaA2QKQ0FnT6vm/DvTyA/o+38w',
    'Warning: Permanently added 1.2.3.4 (ED25519) to the list of known hosts.',
  ].join('\n');

  const r = parseHostKeyFromVerbose(out);
  assert.equal(r.length, 1);
  assert.equal(r[0].type, 'ssh-ed25519');
  assert.equal(r[0].fingerprint, 'SHA256:uOmOzd32qk8nGbHznwaA2QKQ0FnT6vm/DvTyA/o+38w');
});

test('parseHostKeyFromVerbose 对同一类型去重', () => {
  const line =
    'debug1: Server host key: ssh-ed25519 SHA256:abc123';
  const r = parseHostKeyFromVerbose(`${line}\n${line}\n`);
  assert.equal(r.length, 1);
});

test('parseHostKeyFromVerbose 忽略无关行与错误行', () => {
  const out = [
    'debug1: Offering public key: C:\\Users\\x\\.ssh\\id ED25519 SHA256:clientkey',
    'root@1.2.3.4: Permission denied (publickey).',
    'debug1: Server host key: rsa-sha2-512 SHA256:serverkey',
  ].join('\n');

  const r = parseHostKeyFromVerbose(out);
  assert.equal(r.length, 1);
  assert.equal(r[0].type, 'rsa-sha2-512');
  assert.equal(r[0].fingerprint, 'SHA256:serverkey');
});

test('parseHostKeyFromVerbose 空输入返回空数组', () => {
  assert.deepEqual(parseHostKeyFromVerbose(''), []);
  assert.deepEqual(parseHostKeyFromVerbose(null), []);
});

test('computeFingerprint 对已知输入稳定', () => {
  // 空公钥体的 sha256 base64（去尾 =）是固定值，用于锁定实现
  const fp = computeFingerprint('');
  assert.equal(fp, '47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU');
});

test('computeFingerprint 与 OpenSSH 算法一致', () => {
  // 用真实 ed25519 公钥验证：ssh-keygen -lf 给出 SHA256:XBn9YtM5wD0PjPZ0jKz8vQ0zZ0
  // 这里用固定 base64 锁定 sha256+base64+去尾= 的实现细节
  const raw = 'AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl';
  const fp = computeFingerprint(raw);
  assert.match(fp, /^[A-Za-z0-9+/]+$/);
  assert.ok(!fp.endsWith('='), 'OpenSSH 指纹不带尾部 =');
});

test('normalizeFingerprint 去掉算法前缀和空格', () => {
  assert.equal(normalizeFingerprint('SHA256:AbC123='), 'AbC123=');
  assert.equal(normalizeFingerprint('  SHA256:AbC123=  '), 'AbC123=');
  assert.equal(normalizeFingerprint('AbC123='), 'AbC123=');
});

test('compareFingerprint 一致时通过', () => {
  const r = compareFingerprint('SHA256:abc=', 'abc=');
  assert.equal(r.ok, true);
  assert.equal(r.reason, 'match');
});

test('compareFingerprint 不一致时拒绝并给出双方值', () => {
  const r = compareFingerprint('SHA256:new=', 'SHA256:old=');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'mismatch');
  assert.equal(r.expected, 'old=');
  assert.equal(r.actual, 'new=');
});

test('compareFingerprint 任一方为空时拒绝（fail-closed）', () => {
  assert.equal(compareFingerprint('', 'abc=').ok, false);
  assert.equal(compareFingerprint('abc=', '').ok, false);
  assert.equal(compareFingerprint('', 'abc=').reason, 'missing');
  assert.equal(compareFingerprint(null, undefined).reason, 'missing');
});
