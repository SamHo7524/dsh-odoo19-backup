/**
 * v0.1.17 — 恢复版本闸门。
 *
 * 背景（真实故障，2026-11-11）：备份来自 Odoo 19（toogel / tg-odoo），目标机 new.toogel.cn
 * 却是 Odoo 20，恢复一路跑到 `odoo db load -n` 才炸在 Odoo 20 自带的 neutralize SQL
 * （payment_provider.is_live）上。根因不是 neutralize，而是**版本闸门从未接线**：
 * lib/verify.js 里的 checkVersionCompatible 只有单测在调，恢复链路一次也没调用过。
 *
 * 本模块把「源版本（备份包 MANIFEST） / 目标版本（目标机 discover）」显式对比，
 * 在任何远端动作之前给出可操作的拒绝理由。
 */
import { checkVersionCompatible } from './verify.js';

/** 从备份包元数据里取源 Odoo 版本；读不到就返回空串（绝不猜）。 */
export function sourceVersionOf(meta) {
  const v = meta?.source?.odooVersion;
  return typeof v === 'string' && v.trim() ? v.trim() : '';
}

/**
 * 版本闸门。
 * @param {{sourceVersion?:string, targetVersion?:string}} p
 * @returns {{ok:boolean, level:string, sourceVersion:string, targetVersion:string, message:string}}
 */
export function versionGate({ sourceVersion, targetVersion } = {}) {
  const src = String(sourceVersion ?? '').trim();
  const tgt = String(targetVersion ?? '').trim();

  const cmp = checkVersionCompatible(src, tgt);
  const head =
    `源（备份包）：${src || '(未知)'}　目标机：${tgt || '(未知)'}`;

  if (!src || !tgt) {
    const why = !src
      ? '备份包 MANIFEST 里没有可用的 odooVersion（可能是很早的备份包，或清单被改写）。'
      : '目标机未能读出 Odoo 版本（容器未运行或 odoo 命令不可用）。';
    return {
      // 只有「证明不兼容」才硬拒；「无法确认」放行但必须显式警告，
      // 否则旧备份包将永远无法恢复（那不是 fail-closed，是把路堵死）。
      ok: true,
      level: 'unknown',
      sourceVersion: src,
      targetVersion: tgt,
      warning:
        `⚠ 无法预检版本：${head}\n` +
        `【原因】${why}\n` +
        '【风险】若目标机大版本与备份包不同，恢复会在 `odoo db load` 阶段失败；失败时会给出版本诊断与建议。\n' +
        '【建议】目标机先确认 `odoo --version` 可执行；旧备份包建议用同一台源机重新备份一次再恢复。',
      message: '版本无法确认：放行但风险自负（详见警告）。',
    };
  }

  if (cmp.ok) {
    const sameBuild = src === tgt;
    return {
      ok: true,
      level: cmp.level,
      sourceVersion: src,
      targetVersion: tgt,
      message: `版本一致（同为 Odoo ${src.split('.')[0]} 大版本${sameBuild ? '，构建号相同' : ''}）。`,
    };
  }

  if (cmp.level === 'cross-major') {
    return {
      ok: false,
      level: 'cross-major',
      sourceVersion: src,
      targetVersion: tgt,
      message:
        `版本不兼容，已在动手前拒绝恢复。${head}\n` +
        `【原因】跨大版本（${src.split('.')[0]} → ${tgt.split('.')[0]}）不能用备份包直接恢复：` +
        '目标机的模块结构、表结构与该备份库不同，恢复过程会在 neutralize / 建表阶段就崩，' +
        '即使侥幸导入，站点也会处于损坏状态。\n' +
        '【建议】二选一：① 换一台与备份包同大版本（Odoo ' +
        `${src.split('.')[0]}）的目标机做恢复；② 把 19 → 20 当作升级项目推进（备份 → 逐版本升级 → 验证 → 切换），` +
        '升级完成后再用本插件的「备份」功能建立新基线。',
    };
  }

  return {
    ok: false,
    level: cmp.level,
    sourceVersion: src,
    targetVersion: tgt,
    message: `版本无法判断，已按 fail-closed 拒绝：${cmp.reason ?? '未知原因'}。${head}`,
  };
}