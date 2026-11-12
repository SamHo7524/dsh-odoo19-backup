import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSwitchScript,
  parseDbFilterOk,
  parseDeployComponents,
} from '../lib/restore.js';

// ---------------- v0.1.27-A：dbfilter 写入必须发生在容器启动后，且回读验证 ----------------

test('DBF-1 dbfilter 写入必须在 docker start 之后（此前 exec 停止中的容器必然静默失败）', () => {
  const s = buildSwitchScript();
  const startIdx = s.indexOf('docker start');
  const dbfIdx = s.indexOf('===DBFILTER===');
  assert.ok(startIdx > -1, '脚本应包含 docker start');
  assert.ok(dbfIdx > -1, '脚本应包含 DBFILTER 段');
  assert.ok(startIdx < dbfIdx, 'DBFILTER 段必须在容器启动后执行');
});

test('DBF-2 必须回读验证 dbfilter 生效（dbfilter_ok=），不能写完就算成功', () => {
  const s = buildSwitchScript();
  assert.match(s, /dbfilter_ok=/);
});

test('DBF-3 已有无效 dbfilter 行（如 dbfilter = .*）必须被注释掉再追加有效行', () => {
  const s = buildSwitchScript();
  // 存在把旧 dbfilter 行注释掉的 sed
  assert.match(s, /sed -i[^|]*dbfilter/);
});

test('DBF-4 parseDbFilterOk：回读 1 行有效 dbfilter = 通过', () => {
  const r = parseDbFilterOk('===DBFILTER===\ndbfilter_ok=1\n===OLDDB===');
  assert.deepEqual(r, { applied: true, count: 1 });
});

test('DBF-5 parseDbFilterOk：回读 0 行 = 失败（站点会落到库管理器）', () => {
  const r = parseDbFilterOk('===DBFILTER===\ndbfilter_ok=0\n===OLDDB===');
  assert.deepEqual(r, { applied: false, count: 0 });
});

test('DBF-6 parseDbFilterOk：段缺失 = 失败，绝不当成功', () => {
  const r = parseDbFilterOk('===START===\nok\n===OLDDB===');
  assert.equal(r.applied, false);
});

// ---------------- v0.1.27-B：部署结果不得携带 undefined 值（lossless-JSON 契约） ----------------

test('LJ-D1 parseDeployComponents 无错误时 reason 键必须整体缺席（不能是 undefined）', () => {
  const out = '===DEPLOY===\naddons_ok=true\naddons_modules=23\npydeps_ok=skipped\n===DEPLOY_END===';
  const r = parseDeployComponents(out);
  assert.ok(!('reason' in r), `reason 键不应存在，实际：${JSON.stringify(r)}`);
  const json = JSON.stringify(r);
  assert.ok(!json.includes('undefined'));
});

test('LJ-D2 parseDeployComponents 有错误时 reason 保留原文', () => {
  const out = '===DEPLOY===\naddons_ok=false\nerror=tar: 无法写入\n===DEPLOY_END===';
  const r = parseDeployComponents(out);
  assert.equal(r.reason, 'tar: 无法写入');
});
