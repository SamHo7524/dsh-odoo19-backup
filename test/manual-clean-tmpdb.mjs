// 已废弃：此脚本曾用 LIKE 'tg-odoo%' 误删主库 tg-odoo（2026-11-04 事故）。
// 保留为空壳，仅打印警告，绝不执行任何 DROP。清理临时库请用精确名逐条确认。
console.error(
  'DISABLED: this probe once dropped the main tg-odoo DB via an over-broad LIKE pattern. ' +
  'It will never run again. Clean temp DBs only by explicit exact names after listing them.',
);
process.exit(1);
