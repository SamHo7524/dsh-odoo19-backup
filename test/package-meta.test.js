/**
 * v0.1.14：从备份包读源数据库名。
 *
 * 实证（2026-11-09）：包内 MANIFEST.json 已有 "source": { "dbName": "tg-odoo" }，
 * 因此无需新增元数据格式。sourceDbName 只用于展示/冲突提示，
 * 绝不作为目标库名使用。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { readPackageMeta, parseManifestSource } from '../lib/package-meta.js';

const MANIFEST = JSON.stringify({
  formatVersion: '2.1',
  source: { server: 'toogel', dbName: 'tg-odoo', odooContainer: '1Panel-odoo-kwnb' },
  dump: { file: 'dump.zip', bytes: 123 },
});

// ---------------- 纯解析 ----------------

test('META-1 parseManifestSource 读取 source.dbName', () => {
  const r = parseManifestSource(MANIFEST);
  assert.equal(r.ok, true);
  assert.equal(r.sourceDbName, 'tg-odoo');
  assert.equal(r.source.server, 'toogel');
});

test('META-2 坏 JSON / 缺字段 → ok:false（不猜）', () => {
  assert.equal(parseManifestSource('{broken').ok, false);
  assert.equal(parseManifestSource('{}').ok, false);
  assert.equal(parseManifestSource(JSON.stringify({ source: { dbName: '' } })).ok, false);
  assert.equal(parseManifestSource(JSON.stringify({ source: { dbName: 42 } })).ok, false);
});

test('META-3 dbName 两端空白被清理，但内部空白不合法', () => {
  assert.equal(parseManifestSource(JSON.stringify({ source: { dbName: '  tg-odoo  ' } })).sourceDbName, 'tg-odoo');
  assert.equal(parseManifestSource(JSON.stringify({ source: { dbName: 'tg odoo' } })).ok, false);
});

// ---------------- 读包 ----------------

/** 注入 tar 探针：模拟 `tar -xOf <pkg> ./MANIFEST.json` 的输出。 */
function deps({ format = 'plain', tarOut = MANIFEST, tarCode = 0, decrypt = async () => {} } = {}) {
  return {
    detectFormat: async () => format,
    stat: async () => ({ size: 1024 }),
    decryptFile: decrypt,
    runTar: async () => ({ code: tarCode, stdout: tarOut, stderr: '' }),
    mkdtemp: async () => '/tmp/dsh-meta-test',
    rm: async () => {},
  };
}

test('META-4 明文包直接读 MANIFEST.json → 得到源库名', async () => {
  const r = await readPackageMeta('K:/b/x.tar', deps({ format: 'plain' }));
  assert.equal(r.ok, true);
  assert.equal(r.sourceDbName, 'tg-odoo');
});

test('META-5 加密包先解密再读（需要口令）', async () => {
  let decrypted = false;
  const r = await readPackageMeta('K:/b/x.tar.enc', deps({
    format: 'dsh-odoo',
    decrypt: async () => { decrypted = true; },
  }), { passphrase: 'pw' });
  assert.equal(decrypted, true, '必须调用解密');
  assert.equal(r.ok, true);
  assert.equal(r.sourceDbName, 'tg-odoo');
});

test('META-6 加密包但没有口令 → 拒绝（不猜、不降级为明文）', async () => {
  const r = await readPackageMeta('K:/b/x.tar.enc', deps({ format: 'dsh-odoo' }), {});
  assert.equal(r.ok, false);
  assert.match(r.reason, /口令/);
});

test('META-7 外部加密格式（age/openssl）→ 拒绝，不猜', async () => {
  for (const format of ['age', 'openssl']) {
    assert.equal((await readPackageMeta('K:/b/x', deps({ format }))).ok, false);
  }
});

test('META-8 空包 → 拒绝', async () => {
  assert.equal((await readPackageMeta('K:/b/x', deps({ format: 'empty' }))).ok, false);
});

test('META-9 包内无 MANIFEST / tar 失败 → ok:false 且不抛异常', async () => {
  assert.equal((await readPackageMeta('K:/b/x', deps({ tarCode: 2, tarOut: '' }))).ok, false);
  assert.equal((await readPackageMeta('K:/b/x', deps({ tarOut: 'not json' }))).ok, false);
});

test('META-10 解密失败也不抛到 UI，返回可操作 reason', async () => {
  const r = await readPackageMeta('K:/b/x.tar.enc', deps({
    format: 'dsh-odoo',
    decrypt: async () => { throw new Error('口令错误'); },
  }), { passphrase: 'wrong' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /口令错误/);
});
