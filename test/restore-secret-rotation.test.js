/**
 * v0.1.14 — 恢复后数据库签名密钥隔离（用户裁决 2026-11-09）。
 *
 * 边界：
 *  - 只改**目标库**的 database.secret；生产库不读不写。
 *  - 默认开启，允许显式关闭（保留备份里的原密钥）。
 *  - 新密钥必须是密码学安全随机（uuid4 等价强度），不得由时间戳/库名派生。
 *  - 密钥明文绝不进入日志、状态文件、UI、返回值。
 *  - 失败必须如实报告，不得静默显示全部成功。
 *  - 在目标站点对外开放前执行（阶段 D 切换后、阶段 E 验证前）。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import {
  buildRotateSecretScript, parseRotateSecret, ROTATE_SECRET_SQL,
} from '../lib/restore.js';

const restoreSrc = readFileSync(new URL('../lib/restore.js', import.meta.url), 'utf8');
const clientSrc = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const hostSrc = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

// ---------------- 脚本构造 ----------------

test('SEC-1 重签脚本只针对目标库，且用 UPDATE 保留原行', () => {
  const s = buildRotateSecretScript();
  assert.match(s, /database\.secret/, '必须操作 database.secret');
  assert.match(s, /UPDATE|INSERT/, '必须写入新值');
  assert.match(s, /\$DB|"\$DB"/, '必须由目标库变量驱动');
  assert.ok(!/database\.uuid/.test(s), '本次不重生成 database.uuid');
});

test('SEC-2 密钥生成使用安全随机（gen_random_uuid），不得用时间戳/库名派生', () => {
  assert.match(ROTATE_SECRET_SQL, /gen_random_uuid\(\)/,
    '必须用 PostgreSQL 的密码学随机 uuid，而不是 now()/random()');
  assert.ok(!/\bnow\(\)|\bclock_timestamp\(\)|random\(\)/.test(ROTATE_SECRET_SQL),
    '不得用可预测值');
  assert.ok(!/md5\(|current_database\(\)/.test(ROTATE_SECRET_SQL),
    '不得由库名派生');
});

test('SEC-3 SQL 只作用于单库会话，不跨库', () => {
  const s = buildRotateSecretScript();
  assert.ok(!/\\c |CONNECT |dblink|postgres -c/.test(s), '不得切换连接或跨库操作');
});

test('SEC-4 脚本输出新值长度与哈希，但绝不输出密钥明文', () => {
  const s = buildRotateSecretScript();
  assert.match(s, /===SECRET===/, '需要结果段');
  assert.match(s, /length\(|len=/, '应回报长度用于校验');
  assert.ok(!/echo\s+"\$NEW_SECRET"|echo\s+"\$VALUE"/.test(s),
    '不得把密钥明文 echo 到 stdout');
});

// ---------------- 结果解析 ----------------

test('SEC-5 解析成功结果：applied=true，且不含明文密钥', () => {
  const out = [
    '===SECRET===',
    'before_len=36',
    'after_len=36',
    'changed=true',
    '===SECRET_END===',
  ].join('\n');
  const r = parseRotateSecret(out);
  assert.equal(r.applied, true);
  assert.equal(r.changed, true);
  assert.equal(r.beforeLength, 36);
  assert.equal(r.afterLength, 36);
  assert.equal(r.secret, undefined, '返回值不得携带密钥');
  assert.ok(!JSON.stringify(r).includes('9f200f36'), '不得回传原密钥');
});

test('SEC-6 解析失败/缺段 → applied=false 且给出原因（不静默成功）', () => {
  assert.equal(parseRotateSecret('').applied, false);
  assert.equal(parseRotateSecret('boom').applied, false);
  const r = parseRotateSecret('===SECRET===\nrc=1\nerror=permission denied\n===SECRET_END===');
  assert.equal(r.applied, false);
  assert.match(r.reason ?? '', /permission|失败|error/i);
});

test('SEC-7 新旧值相同（未真正重签）必须判为失败', () => {
  const out = '===SECRET===\nbefore_len=36\nafter_len=36\nchanged=false\n===SECRET_END===';
  const r = parseRotateSecret(out);
  assert.equal(r.applied, false, 'changed=false 不能算成功');
  assert.match(r.reason ?? '', /未变化|未生效/);
});

test('SEC-7b 目标库无 database.secret 行（实测 "||f" rc=0）必须判失败且原因可操作', () => {
  const out = [
    '===SECRET===',
    'rc=0',
    'before_len=',
    'after_len=',
    'changed=f',
    '===SECRET_END===',
  ].join('\n');
  const r = parseRotateSecret(out);
  assert.equal(r.applied, false, 'rc=0 也不能掩盖未写入');
  assert.match(r.reason ?? '', /database\.secret/, '原因要指向缺失的参数行');
});

test('SEC-7c 目标库不存在（psql rc=2）判失败并带出错误', () => {
  const out = [
    '===SECRET===',
    'rc=2',
    'error=psql: FATAL:  database "nope" does not exist',
    '===SECRET_END===',
  ].join('\n');
  const r = parseRotateSecret(out);
  assert.equal(r.applied, false);
  assert.match(r.reason ?? '', /does not exist|rc=2/);
});

// ---------------- 流程接线 ----------------

test('SEC-8 默认开启：runRestore 在未显式关闭时执行重签', () => {
  assert.match(restoreSrc, /rotateSecret\s*=\s*true|rotateSecret\s*\?\?\s*true|rotateSecret\s*!==\s*false/,
    '默认值必须是开启');
});

test('SEC-9 重签发生在阶段 D 切换之后、阶段 E 验证之前', () => {
  const dIdx = restoreSrc.indexOf('phaseD_switch({');
  const rotIdx = restoreSrc.indexOf('phaseRotateSecret(');
  const eIdx = restoreSrc.indexOf('phaseE_verify({');
  assert.ok(dIdx > 0 && rotIdx > 0 && eIdx > 0, '三个阶段都应存在');
  assert.ok(dIdx < rotIdx, '必须在切换之后（此时目标库才是正式库）');
  assert.ok(rotIdx < eIdx, '必须在最终验证之前（站点开放前）');
});

test('SEC-10 重签失败不得被吞：结果里必须能看出失败', () => {
  assert.match(restoreSrc, /secretRotation/);
  assert.match(restoreSrc, /applied:\s*false|ok:\s*false/, '失败要落进结果对象');
  // 失败时不得无条件返回 ok:true 而不带标记
  const seg = restoreSrc.slice(restoreSrc.indexOf('phaseRotateSecret('));
  assert.match(seg, /throw|failed|error/, '失败路径必须显式处理');
});

test('SEC-11 显式关闭时不执行重签（保留备份原密钥）', () => {
  assert.match(restoreSrc, /rotateSecret/, 'runRestore 需接受该选项');
  assert.match(restoreSrc, /skipped:\s*true|reason:\s*'[^']*关闭/, '关闭时要记录 skipped 与原因');
});

test('SEC-12 service 透传选项，默认不覆盖为关闭', () => {
  const svcSrc = readFileSync(new URL('../lib/service.js', import.meta.url), 'utf8');
  assert.match(svcSrc, /rotateSecret/);
  assert.ok(!/rotateSecret:\s*false/.test(svcSrc), 'service 不得把默认值改成 false');
});

test('SEC-13 Host 路由接受该选项并透传', () => {
  assert.match(hostSrc, /rotateSecret/);
});

test('SEC-14 UI 提供勾选项，默认勾选，并给出失效提示', () => {
  assert.match(clientSrc, /恢复后重新生成数据库签名密钥|重新生成数据库签名密钥/);
  assert.match(clientSrc, /type:\s*'checkbox'|checked:/, '需要复选框');
  assert.match(clientSrc, /旧密钥|签名链接|令牌/, '必须提示旧签名可能失效');
  assert.match(clientSrc, /生产库不受影响/, '必须说明生产库不受影响');
  assert.match(clientSrc, /rotateSecret/, '提交时带上该选项');
});

test('SEC-15 结果里绝不包含密钥明文（UI/状态/返回）', () => {
  assert.ok(!/secret\s*[:=]\s*['"][0-9a-f]{8}-[0-9a-f]{4}/i.test(restoreSrc), 'restore 不得硬编码或回传密钥');
  assert.ok(!/console\.log\([^)]*secret/i.test(restoreSrc), '不得打印密钥');
  assert.ok(!/console\.log\([^)]*secret/i.test(clientSrc), '前端不得打印密钥');
});
