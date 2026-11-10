import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8');
const zh = JSON.parse(readFileSync(new URL('../locale/zh.json', import.meta.url), 'utf8'));
const en = JSON.parse(readFileSync(new URL('../locale/en.json', import.meta.url), 'utf8'));

// ---------- 1. 名称 ----------
const NEW = '@local/dsh-odoo19-backup';

test('package.json 的 name 为 dsh-odoo19-backup', () => {
  assert.equal(pkg.name, NEW);
});

test('cordis.patch.yml 的 name 与包名一致', () => {
  assert.match(patch, /name:\s*'@local\/dsh-odoo19-backup'/);
});

test('client.js 的 ModuleLoader id 与包名一致', () => {
  assert.match(src, /id:\s*'@local\/dsh-odoo19-backup'/);
});

test('client.js 在原生设置页的栏目 id 为插件自有 id（v0.1.14 宿主迁移）', () => {
  assert.match(src, /name:\s*'settings\.section'/, '整页挂在 settings.section');
  assert.match(src, /id:\s*'odoo-backup'/, '栏目 id 必须是自有 id，避免顶替内置栏目');
});

test('显示名称含 dsh-odoo19-backup（zh + en）', () => {
  assert.match(zh.meta.title, /dsh-odoo19-backup/);
  assert.match(en.meta.title, /dsh-odoo19-backup/);
});

// ---------- 2. 配置契约（2026-11-06 修复后） ----------

test('配置服务用 ctx.get 软取，页面注册不被 configForms 的 inject gate 包裹', () => {
  assert.match(src, /ctx\.get\(\s*['"]configForms['"]\s*\)/,
    '必须软取：服务缺席时不抛错、不阻塞');
  // 允许用 ctx.inject 注册「服务晚到」的等待者，但页面注册必须先于它、
  // 且不得被它包裹（2026-11-06 真机缺陷：gate 住就整页消失）。
  const mountIdx = src.indexOf('mountSection();');
  const injectIdx = src.indexOf("ctx.inject(['configForms']");
  assert.ok(mountIdx > 0, '必须先无条件调用 mountSection()');
  if (injectIdx > 0) {
    assert.ok(mountIdx < injectIdx,
      'mountSection() 必须先于 ctx.inject 等待者执行（页面注册不能被服务 gate）');
  }
});

test('配置 namespace 由运行时实际服务列表动态确认，不硬编码猜测的 odoo-backup', () => {
  assert.match(src, /whileServed/, '应订阅 mirror 以应对服务后到达');
  assert.match(src, /describe\??\.?\(\)/, '应从 describe mirror 读取实际服务的命名空间');
  assert.match(src, /include:odoo-backup/, '候选应包含当前 host 实际的 entryId 形态');
  assert.ok(!/configForms\.get\(\s*['"]odoo-backup['"]\s*\)/.test(src),
    '不得再硬编码裸 row id 作为唯一 namespace');
});

test('组件从 ConfigFormController 快照的 value 读取 servers', () => {
  assert.match(src, /value\?*\.servers|\.value\s*\?\?/, '应读 snapshot.value，而非 snapshot 顶层');
});

test('服务缺失时有可见提示与 5 秒点名 configForms 的诊断告警', () => {
  assert.match(src, /配置服务未就绪/);
  assert.match(src, /5000/);
  assert.match(src, /console\.warn/);
  assert.match(src, /configForms/);
});

test('manifest 补齐 configForms 提供者与插件页依赖，且不引入无关依赖', () => {
  const inject = pkg.dsh?.client?.inject ?? [];
  assert.ok(inject.includes('@deepseek-ai/dsh-client-ui-settings'),
    '缺 ui-settings 就没有 configForms 服务提供者');
  assert.ok(inject.includes('@deepseek-ai/dsh-client-ui-plugin-manager'),
    '缺 plugin-manager 就没有 plugins.bundle.config 页面的声明方');
  assert.ok(!inject.includes('@deepseek-ai/dsh-client-ui-chat'),
    '与配置卡片无关的 UI 包不应引入');
});

// ---------- 3. 仍然成立的既有契约 ----------

test('client.js 用 inject:()=>({scope,locale}) 把服务作为 props 传入组件', () => {
  assert.match(src, /inject:\s*\(\)\s*=>\s*\(\{\s*scope/);
});

test('client.js 用 scope.getSnapshot() 读取配置', () => {
  assert.match(src, /scope\.getSnapshot\(\)/);
});

test('client.js 用 scope.set 写配置（而非 setConfig）', () => {
  assert.match(src, /scope\.set\(/);
  assert.ok(!/setConfig\(/.test(src), '仍在调用不存在的 setConfig');
});

test('添加服务器写入 servers 字段', () => {
  assert.match(src, /scope\.set\(\s*['"]servers['"]/);
});

test('组件通过 useSyncExternalStore 订阅 scope.subscribe，配置变更可刷新', () => {
  assert.match(src, /useSyncExternalStore/);
  assert.match(src, /scope\.subscribe/);
});
