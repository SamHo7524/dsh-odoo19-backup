/** 真机验证：从真实备份包（明文 tar）读取源数据库名。 */
import { readPackageMeta } from '../lib/package-meta.js';

const TAR = 'K:\\Backup\\odoo\\20261109\\629b3bb6244bc5685b42ed1c5217bf22bfa688bb32e7dbcbc5298310ebb27199\\odoo-backup-20261109-103541.tar';
const ENC = 'K:\\Backup\\odoo\\20261109\\odoo-backup-20261109-103541.tar.enc';

const r = await readPackageMeta(TAR);
console.log('明文包:', JSON.stringify({ ok: r.ok, sourceDbName: r.sourceDbName, source: r.source?.server, reason: r.reason }));
if (!r.ok || r.sourceDbName !== 'tg-odoo') {
  console.log('RESULT: FAIL');
  process.exit(1);
}

const e = await readPackageMeta(ENC);
console.log('加密包（无口令）:', JSON.stringify({ ok: e.ok, reason: e.reason }));
if (e.ok || !/口令/.test(e.reason ?? '')) {
  console.log('RESULT: FAIL (加密包应要求口令)');
  process.exit(1);
}
console.log('RESULT: PASS');
