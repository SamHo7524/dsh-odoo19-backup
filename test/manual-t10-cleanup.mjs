/**
 * Task 10：清理历史遗留临时资源。
 * 只删本次开发过程中产生的临时文件/目录，不触碰主库与正式 filestore。
 * 保留 /tmp/safety-backup-*.zip（事故兜底），其余清理。
 */
import { execRemote } from '../lib/ssh.js';

const srv = {
  name: 'staging', host: '119.29.10.202', port: 22, user: 'root',
  keyPath: process.env.USERPROFILE + '/.ssh/toogel_vault',
};

const script = `
set -uo pipefail
FS=/opt/1panel/apps/odoo/odoo/data/data/filestore

echo "=== 清理前 ==="
ls -1 "$FS" 2>/dev/null
ls -lh /tmp/debug-dump.zip /tmp/safety-backup-*.zip 2>/dev/null || true

echo "=== 删除容器内残留 ==="
docker exec -u root 1Panel-odoo-5td9 rm -f /tmp/sbcheck.zip 2>/dev/null && echo "removed /tmp/sbcheck.zip" || echo "no sbcheck"

echo "=== 删除 /tmp 调试产物（保留 safety-backup）==="
rm -f /tmp/debug-dump.zip && echo "removed debug-dump.zip" || true

echo "=== 删除 filestore 探针目录（精确名）==="
# tg-odoo-probe 是早期探针建的临时库 filestore
if [ -d "$FS/tg-odoo-probe" ]; then rm -rf "$FS/tg-odoo-probe" && echo "removed tg-odoo-probe"; fi
# tg-odoo.pre-recovery-* 是事故恢复时移开的原始 filestore，主库已从备份恢复且 V7 校验通过，
# 保留会占用 894M 且磁盘已 91%。删除前先确认主库 filestore 完整。
MAIN_COUNT=$(find "$FS/tg-odoo" -type f 2>/dev/null | wc -l)
if [ "$MAIN_COUNT" -ge 1887 ]; then
  for d in "$FS"/tg-odoo.pre-recovery-*; do
    [ -d "$d" ] && rm -rf "$d" && echo "removed $(basename "$d")"
  done
else
  echo "SKIP: 主库 filestore 仅 $MAIN_COUNT 文件，保留 pre-recovery 兜底"
fi

echo "=== 清理后 ==="
ls -1 "$FS" 2>/dev/null
echo -n "tg-odoo 文件数: "
find "$FS/tg-odoo" -type f 2>/dev/null | wc -l
echo -n "磁盘: "
df -h / | tail -1
echo -n "主库完好: "
docker exec 1Panel-postgresql-ZcrG psql -U pgsl -d postgres -Atc "select count(*) from pg_database where datname='tg-odoo'"
echo -n "HTTP: "
curl -s -o /dev/null -w '%{http_code}\\n' --max-time 15 http://127.0.0.1:8069/web/login
echo "=== END ==="
`;
const r = await execRemote(srv, script, { timeoutMs: 300000 });
console.log(r.stdout);
