/**
 * Task 10：Client 三 Tab 验证（静态结构 + 真实接口交互）。
 *
 * 说明：Web GUI 需要带 ?token= 的鉴权 URL（日志脱敏无法获取），
 * 因此这里分两层验证：
 *   A. 静态结构：解析 client.js 源码，确认三 Tab、按钮、文案、locale key 齐备
 *   B. 真实交互：对运行中的 /odoo-backup/* 接口发真实请求，确认 UI 会走通的调用链
 * 不声称"浏览器内视觉已确认"。
 */
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const zh = JSON.parse(readFileSync(new URL('../locale/zh.json', import.meta.url), 'utf8'));
const en = JSON.parse(readFileSync(new URL('../locale/en.json', import.meta.url), 'utf8'));

const checks = [];
const chk = (n, ok, d = '') => checks.push([n, ok, d]);

// ---------- A. 静态结构 ----------
console.log('=== A. Client 静态结构 ===');

chk('模块 id 正确', /id:\s*'@local\/dsh-odoo-backup'/.test(src));
chk('注入 slots 与 locale', /inject:\s*\['slots',\s*'locale'\]/.test(src));
chk('注册到原生设置页 settings.section（v0.1.14 宿主迁移）', /slots\.inject\('settings\.section'/.test(src));
chk('不再注册旧入口 plugins.bundle.config', !/slots\.inject\('plugins\.bundle\.config'/.test(src));
chk('注册 key 为包名', /key:\s*'@local\/dsh-odoo-backup'/.test(src));
chk('view 为 page', /view:\s*'page'/.test(src));

// 三个 Tab
chk('Tab: 服务器', /t\('tab\.servers'\)/.test(src));
chk('Tab: 备份', /t\('tab\.backup'\)/.test(src));
chk('Tab: 恢复', /t\('tab\.restore'\)/.test(src));

// 三 tab 的分支渲染
chk('tab === servers 分支', /tab === 'servers'/.test(src));
chk('tab === backup 分支', /tab === 'backup'/.test(src));
chk('tab === restore 分支', /tab === 'restore'/.test(src));

// 关键交互
chk('添加服务器（prompt 采集 name/host/user/keyPath）', /window\.prompt\('服务器名称/.test(src) && /window\.prompt\('主机地址'/.test(src));
chk('测试连接调用 /test', /api\('\/test'/.test(src));
chk('备份调用 /backup', /api\('\/backup'/.test(src));
chk('恢复先 precheck', /api\('\/precheck'/.test(src));
chk('恢复再 restore 且带 confirmToken', /api\('\/restore'/.test(src) && /confirmToken:\s*pre\.confirmToken/.test(src));
chk('恢复前有 confirm 二次确认', /window\.confirm\(/.test(src));
chk('恢复 Tab 有不可用时间警告', /2–5 分钟不可用|2-5 分钟不可用/.test(src));
chk('busy 态防重复点击', /disabled:\s*!!busy\[s\.name\]/.test(src));

// locale 完整性：源码里用到的每个 t('key') 都必须在 zh/en 中存在
const usedKeys = [...src.matchAll(/t\('([a-z.]+)'\)/g)].map((m) => m[1]);
const uniqKeys = [...new Set(usedKeys)];
const missingZh = uniqKeys.filter((k) => !(k in (zh.ui ?? {})));
const missingEn = uniqKeys.filter((k) => !(k in (en.ui ?? {})));
console.log('  源码使用的 locale key:', uniqKeys.join(', '));
chk('所有 locale key 在 zh.json 中存在', missingZh.length === 0, '缺失: ' + missingZh.join(','));
chk('所有 locale key 在 en.json 中存在', missingEn.length === 0, '缺失: ' + missingEn.join(','));
chk('zh/en meta.title 均非空', Boolean(zh.meta?.title) && Boolean(en.meta?.title));
chk('zh/en meta.description 均非空', Boolean(zh.meta?.description) && Boolean(en.meta?.description));

// 图标存在
const icon = readFileSync(new URL('../icon.svg', import.meta.url), 'utf8');
chk('icon.svg 是有效 SVG', /<svg[\s>]/i.test(icon) && icon.length > 100, `${icon.length} bytes`);

// ---------- B. 真实接口交互 ----------
console.log('\n=== B. 真实接口交互（运行中的插件）===');
const BASE = 'http://127.0.0.1:36259/odoo-backup';
const H = { Origin: 'http://127.0.0.1:36259', 'content-type': 'application/json' };

async function call(route, body) {
  const res = await fetch(BASE + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: H,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

try {
  const servers = await call('/servers');
  console.log('  GET /servers →', JSON.stringify(servers.json));
  chk('GET /servers 返回 ok', servers.json.ok === true);
  chk('GET /servers 有 servers 数组', Array.isArray(servers.json.servers));

  const status = await call('/status', {});
  console.log('  POST /status →', JSON.stringify(status.json));
  chk('POST /status 返回 running 字段', typeof status.json.result?.running === 'boolean');

  // 未授权恢复必须被拒（UI 也会先 precheck，但直接调 restore 应失败）
  const noToken = await call('/restore', { server: 'staging', packagePath: 'K:/a.tar' });
  console.log('  POST /restore 无 token →', JSON.stringify(noToken.json));
  chk('UI /restore 无 token 被拒', noToken.json.ok === false && /confirmToken/.test(noToken.json.error ?? ''));

  const badToken = await call('/restore', { server: 'staging', packagePath: 'K:/a.tar', confirmToken: 'x' });
  console.log('  POST /restore 假 token →', JSON.stringify(badToken.json));
  chk('UI /restore 假 token 被拒', badToken.json.ok === false && /无效/.test(badToken.json.error ?? ''));

  // 跨站必须被拒
  const cross = await fetch(BASE + '/servers', { headers: { Origin: 'http://evil.example' } });
  const crossJson = await cross.json();
  console.log('  跨站 GET /servers →', cross.status, JSON.stringify(crossJson));
  chk('跨站请求被 403 拒绝', cross.status === 403 && /同源/.test(crossJson.error ?? ''));
} catch (e) {
  chk('接口可达', false, e.message);
}

// ---------- 输出 ----------
console.log('\n=== 结果 ===');
let all = true;
for (const [n, ok, d] of checks) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${ok ? '' : '  → ' + d}`);
  if (!ok) all = false;
}
console.log(`\n共 ${checks.length} 项`);
console.log(all ? 'CLIENT_UI=PASS' : 'CLIENT_UI=FAIL');
