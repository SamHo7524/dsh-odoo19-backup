/**
 * v0.1.5 回归：保存服务器走 settings.update 被拒
 * `Plugin entry "odoo-backup" has no volatile fields`。
 *
 * DSH 的 settings.update 只允许写 schema 中声明 volatile 的字段路径
 * （dsh-settings lib/index.js L506: volatileForm(schema) === undefined 则抛此错）。
 * 修复：Config schema 的 servers 字段标记 .volatile()，
 * 与 dsh-connect-workbuddy 的 asVolatile() 做法一致。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const hostSrc = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

test('SCHEMA-1 Config schema 的 servers 字段必须标记 volatile（settings.update 的写入门）', () => {
  assert.match(hostSrc, /\.volatile\(\)/,
    'servers 字段应调用 .volatile()（schemastery 3.18.3+ 的运行时可写标记）');
});

test('SCHEMA-2 标记必须用在 servers 字段上', () => {
  // servers 声明链以 .description('服务器列表') + .volatile() 结尾
  assert.match(hostSrc, /\.description\('服务器列表'\)\s*\n[\s\S]{0,300}?\.volatile\(\)/,
    'servers 声明应带上 .volatile()');
});

test('SCHEMA-3 volatile 引用必须在读取 config 前解包（否则整包校验失败）', () => {
  // workbuddy 的教训：volatile 字段是 {get()} 活引用，传给需要 structuredClone 的
  // 服务前必须 unwrap；插件自身读取 servers 时也要解包。
  assert.match(hostSrc, /unwrapVolatile|\.get\(\)/,
    '读取 config.servers 时应解包 volatile 引用');
});
