// v0.1.23 — 部署 addons/pydeps 后必须重启 Odoo 容器，否则新模块的 Python 永远不会被导入。
// 真机事故（2026-11-11，new.toogel.cn 全新部署）：addons 已落到 /mnt/extra-addons/website_clarity，
// 但容器 11:59 启动、部署 12:04 才发生，Odoo 进程从未重载模块 →
// website.layout 引用 website.clarity_project_id → AttributeError → V6 站点可访问 500。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRestartOdooScript,
  parseRestartResult,
  shouldRestartAfterDeploy,
} from '../lib/restore.js';

test('RS-1 重启脚本必须真的重启容器并等待可用', () => {
  const s = buildRestartOdooScript();
  assert.match(s, /docker restart/);
  assert.match(s, /===RESTART===/);
  assert.match(s, /===RESTART_END===/);
  assert.match(s, /8069/);           // 有就绪探测
  assert.match(s, /sleep/);          // 有轮询
});

test('RS-2 parseRestartResult 解析 ready / rc / 等待秒数', () => {
  const out = '===RESTART===\nready=1\nlast_code=200\nwaited_s=14\nrestart_rc=0\n===RESTART_END===';
  const r = parseRestartResult(out);
  assert.equal(r.ready, true);
  assert.equal(r.waitedSeconds, 14);
  assert.equal(r.lastCode, '200');
  assert.equal(r.restartRc, 0);
});

test('RS-3 未就绪时要能识别为失败（不能当成功）', () => {
  const r = parseRestartResult('===RESTART===\nready=0\nlast_code=000\nwaited_s=120\nrestart_rc=0\n===RESTART_END===');
  assert.equal(r.ready, false);
  assert.equal(r.lastCode, '000');
});

test('RS-4 脚本未完成时不得判定为成功', () => {
  const r = parseRestartResult('garbage');
  assert.equal(r.ready, false);
  assert.equal(r.reason.length > 0, true);
});

test('RS-5 只有真的部署了东西才重启（避免无谓停机）', () => {
  assert.equal(shouldRestartAfterDeploy({ addonsModules: 23, pydepsFiles: 0 }), true);
  assert.equal(shouldRestartAfterDeploy({ addonsModules: 0, pydepsFiles: 91 }), true);
  assert.equal(shouldRestartAfterDeploy({ addonsModules: 0, pydepsFiles: 0 }), false);
  assert.equal(shouldRestartAfterDeploy({ addonsSkipped: true, pydepsSkipped: true }), false);
  assert.equal(shouldRestartAfterDeploy(null), false);
});