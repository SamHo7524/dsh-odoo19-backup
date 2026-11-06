import { test } from 'node:test';
import assert from 'node:assert';
import {
  extractThirdPartyImports,
  isStdlib,
  isOdooInternal,
} from '../lib/imports.js';

test('extractThirdPartyImports 提取外部依赖', () => {
  const code = [
    'import alipay',
    'from wechatpy import WeChatPay',
    'import os',
    'from odoo import models',
    'import requests',
  ].join('\n');

  const r = extractThirdPartyImports(code);
  assert.ok(r.includes('alipay'));
  assert.ok(r.includes('wechatpy'));
  assert.ok(r.includes('requests'));
  assert.ok(!r.includes('os'), 'stdlib 应被过滤');
  assert.ok(!r.includes('odoo'), 'odoo 内部应被过滤');
});

test('isStdlib 识别标准库', () => {
  assert.equal(isStdlib('os'), true);
  assert.equal(isStdlib('json'), true);
  assert.equal(isStdlib('asyncio'), true);
  assert.equal(isStdlib('alipay'), false);
});

test('isOdooInternal 识别 odoo 命名空间', () => {
  assert.equal(isOdooInternal('odoo'), true);
  assert.equal(isOdooInternal('odoo.addons'), true);
  assert.equal(isOdooInternal('openerp'), true);
  assert.equal(isOdooInternal('alipay'), false);
});

test('extractThirdPartyImports 处理相对导入', () => {
  const code = 'from . import models\nfrom ..utils import helper\nimport alipay';
  const r = extractThirdPartyImports(code);
  assert.deepEqual(r, ['alipay']);
});

test('extractThirdPartyImports 去重并排序', () => {
  const code = 'import alipay\nimport alipay\nimport requests';
  const r = extractThirdPartyImports(code);
  assert.deepEqual(r, ['alipay', 'requests']);
});

test('extractThirdPartyImports 处理 import as 别名', () => {
  const code = 'import numpy as np\nfrom pandas import DataFrame as DF';
  const r = extractThirdPartyImports(code);
  assert.deepEqual(r, ['numpy', 'pandas']);
});

test('extractThirdPartyImports 处理点号子模块', () => {
  const code = 'import alipay.trade\nfrom wechatpy.pay import X';
  const r = extractThirdPartyImports(code);
  assert.deepEqual(r, ['alipay', 'wechatpy']);
});

test('extractThirdPartyImports 忽略注释与空行', () => {
  const code = '# import fake\n\n   \nimport real';
  const r = extractThirdPartyImports(code);
  assert.deepEqual(r, ['real']);
});

test('extractThirdPartyImports 处理多模块 import', () => {
  const code = 'import a, b, os';
  const r = extractThirdPartyImports(code);
  assert.deepEqual(r, ['a', 'b']);
});

test('extractThirdPartyImports 空输入返回空数组', () => {
  assert.deepEqual(extractThirdPartyImports(''), []);
  assert.deepEqual(extractThirdPartyImports(null), []);
});

test('extractThirdPartyImports 处理缩进的 import（函数内导入）', () => {
  const code = 'def f():\n    import alipay\n    from requests import get';
  const r = extractThirdPartyImports(code);
  assert.deepEqual(r, ['alipay', 'requests']);
});
