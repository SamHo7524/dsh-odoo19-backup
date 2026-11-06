import { test } from 'node:test';
import assert from 'node:assert';
import { createTokenStore, TOKEN_TTL_MS } from '../lib/tokens.js';

const payload = () => ({
  server: 'staging',
  packagePath: 'K:/Backup/odoo/a.tar',
  neutralize: false,
});

test('create 返回一次性 token 且绑定载荷', () => {
  const store = createTokenStore();
  const token = store.create(payload());
  assert.equal(typeof token, 'string');
  assert.ok(token.length >= 32, 'token 应有足够熵');
  const rec = store.peek(token);
  assert.equal(rec.payload.server, 'staging');
  assert.equal(rec.used, false);
});

test('两个 token 互不相同', () => {
  const store = createTokenStore();
  const a = store.create(payload());
  const b = store.create(payload());
  assert.notEqual(a, b);
});

test('verify 成功后被标记 used，二次使用被拒', () => {
  const store = createTokenStore();
  const token = store.create(payload());
  assert.equal(store.verify(token, payload()), true);
  assert.throws(() => store.verify(token, payload()), /已使用过/);
});

test('未知 token 被拒', () => {
  const store = createTokenStore();
  assert.throws(() => store.verify('deadbeef', payload()), /无效/);
});

test('过期 token 被拒', () => {
  let now = 1_000_000;
  const store = createTokenStore({ now: () => now });
  const token = store.create(payload());
  now += TOKEN_TTL_MS + 1;
  assert.throws(() => store.verify(token, payload()), /已过期/);
});

test('有效期边界：刚好到期前仍可用', () => {
  let now = 1_000_000;
  const store = createTokenStore({ now: () => now });
  const token = store.create(payload());
  now += TOKEN_TTL_MS - 1;
  assert.equal(store.verify(token, payload()), true);
});

test('载荷不匹配（目标服务器不同）被拒', () => {
  const store = createTokenStore();
  const token = store.create(payload());
  assert.throws(
    () => store.verify(token, { ...payload(), server: 'prod' }),
    /不匹配：server/,
  );
});

test('载荷不匹配（备份包不同）被拒', () => {
  const store = createTokenStore();
  const token = store.create(payload());
  assert.throws(
    () => store.verify(token, { ...payload(), packagePath: 'K:/other.tar' }),
    /不匹配：packagePath/,
  );
});

test('载荷不匹配（neutralize 不同）被拒', () => {
  const store = createTokenStore();
  const token = store.create(payload());
  assert.throws(
    () => store.verify(token, { ...payload(), neutralize: true }),
    /不匹配：neutralize/,
  );
});

test('载荷不匹配时不得消耗 token（仍可用正确载荷兑换）', () => {
  const store = createTokenStore();
  const token = store.create(payload());
  assert.throws(() => store.verify(token, { ...payload(), server: 'prod' }));
  assert.equal(store.verify(token, payload()), true);
});

test('过期 token 被清理，peek 返回 undefined', () => {
  let now = 1_000_000;
  const store = createTokenStore({ now: () => now });
  const token = store.create(payload());
  now += TOKEN_TTL_MS + 1;
  store.sweep();
  assert.equal(store.peek(token), undefined);
});
