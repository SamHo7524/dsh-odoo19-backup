import { execRemote } from './ssh.js';
import { checkImports } from './imports.js';

/**
 * 计算 DB 引用与 filestore 实有的差集。
 * 用 Set 精确相等（v2.1 第 3 条：禁用 grep -w，避免前缀/子串误判）。
 */
export function parseCommDiff(dbList, fsList) {
  const db = new Set(
    String(dbList)
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const fs = new Set(
    String(fsList)
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  let missing = 0;
  for (const x of db) if (!fs.has(x)) missing += 1;
  let extra = 0;
  for (const x of fs) if (!db.has(x)) extra += 1;
  return { missing, extra, dbCount: db.size, fsCount: fs.size };
}

/**
 * 版本兼容性判断（v2.1 第 15 条）。
 * 仅支持 Odoo 19 系列；跨大版本（19→20）必须拒绝。
 */
export function checkVersionCompatible(sourceVer, targetVer) {
  const sMajor = String(sourceVer).split('.')[0];
  const tMajor = String(targetVer).split('.')[0];

  if (
    !sMajor ||
    !tMajor ||
    !/^\d+$/.test(sMajor) ||
    !/^\d+$/.test(tMajor)
  ) {
    return { ok: false, level: 'unknown', reason: '无法解析版本号' };
  }
  if (sMajor === tMajor) {
    return { ok: true, level: 'same-major' };
  }
  return {
    ok: false,
    level: 'cross-major',
    reason: `跨大版本（${sMajor} → ${tMajor}）无法通过备份包直接恢复`,
    evidence:
      'Odoo 20 base 无 19→20 迁移脚本；ir.model.access → ir.access 为架构级重构',
    suggestion: '作为独立升级项目执行（预估 3–10 人日）',
  };
}

function buildVerifyScript() {
  return `
set -uo pipefail
read -r OC
read -r PG
read -r DB
read -r PG_USER
read -r DATA

echo "===V1==="
docker exec "$PG" psql -U "$PG_USER" -d "$DB" -Atc 'select 1' 2>/dev/null || echo ERR

echo "===V2==="
docker exec "$PG" psql -U "$PG_USER" -d "$DB" -Atc "select count(*) from ir_module_module where state='installed'" 2>/dev/null || echo 0

echo "===V4DB==="
docker exec "$PG" psql -U "$PG_USER" -d "$DB" -Atc "select store_fname from ir_attachment where type='binary' and store_fname is not null and store_fname<>''" 2>/dev/null | sort -u

echo "===V4FS==="
find "$DATA/filestore/$DB" -type f 2>/dev/null | sed "s|^$DATA/filestore/$DB/||" | sort

echo "===V5==="
[ -d "$DATA/filestore/$DB/filestore" ] && echo NESTED || echo CLEAN

echo "===V6==="
for p in / /shop /web/login; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: localhost' --max-time 20 "http://127.0.0.1:8069$p" 2>/dev/null || echo 000)
  size=$(curl -s -o /dev/null -w '%{size_download}' -H 'Host: localhost' --max-time 20 "http://127.0.0.1:8069$p" 2>/dev/null || echo 0)
  echo "$p|$code|$size"
done

echo "===V7==="
AID=$(docker exec "$PG" psql -U "$PG_USER" -d "$DB" -Atc "select id from ir_attachment where type='binary' and public=true and mimetype like 'image/%' and store_fname is not null limit 1" 2>/dev/null)
if [ -n "$AID" ]; then
  SF=$(docker exec "$PG" psql -U "$PG_USER" -d "$DB" -Atc "select store_fname from ir_attachment where id=$AID" 2>/dev/null)
  curl -s -o /tmp/v7.bin -H 'Host: localhost' --max-time 20 "http://127.0.0.1:8069/web/content/$AID" 2>/dev/null
  GOT=$(sha1sum /tmp/v7.bin 2>/dev/null | cut -d' ' -f1)
  WANT=$(basename "$SF")
  echo "$AID|$GOT|$WANT"
  rm -f /tmp/v7.bin
else
  echo "NO_PUBLIC_ATTACHMENT"
fi

echo "===END==="
`;
}

/**
 * 执行 V1–V7 验证。
 *
 * V3（运行时依赖可导入）按 v2.1 修正：不再写死 `import alipay`（假通过风险），
 * 改为调用通用 checkImports（扫描自建模块顶层 import 并在容器内逐个探测）。
 *
 * @param {object} args
 * @param {object} args.server
 * @param {object} args.instance   discover() 产出，需含 odooContainer/pgContainer/dbName/dbUser/dataPath
 * @param {object} [args.baseline] 可选：基线值（如 baseline.installed 模块数）
 */
export async function verifyInstance({ server, instance, baseline }) {
  const stdin = [
    instance.odooContainer,
    instance.pgContainer ?? '',
    instance.dbName,
    instance.dbUser,
    instance.dataPath,
  ].join('\n') + '\n';

  const r = await execRemote(server, buildVerifyScript(), {
    stdin,
    timeoutMs: 300000,
  });

  if (!r.stdout.includes('===END===')) {
    return { ok: false, error: '验证脚本执行失败', raw: r.stderr.slice(-500) };
  }

  const sec = (name, next) => {
    const re = new RegExp(`===${name}===\\n([\\s\\S]*?)(?====${next}===|$)`);
    const m = r.stdout.match(re);
    return m ? m[1].trim() : '';
  };

  const results = [];

  // V1：数据库可连接
  results.push({ id: 'V1', name: '数据库可连接', pass: sec('V1', 'V2') === '1' });

  // V2：installed 模块数（与基线比对）
  const installed = Number(sec('V2', 'V4DB')) || 0;
  const baselineInstalled = baseline?.installed ?? installed;
  results.push({
    id: 'V2',
    name: 'installed 模块数',
    pass: installed === baselineInstalled,
    detail: `${installed} (baseline ${baselineInstalled})`,
  });

  // V3：运行时依赖可导入（通用，不写死库名）
  const imp = await checkImports({ server, instance });
  results.push({
    id: 'V3',
    name: '运行时依赖可导入',
    pass: imp.ok,
    detail: imp.ok
      ? `检查 ${imp.checked.length} 个依赖，全部可导入`
      : imp.error,
  });

  // V4：附件零缺失（DB 引用 vs filestore 实有）
  const diff = parseCommDiff(sec('V4DB', 'V4FS'), sec('V4FS', 'V5'));
  results.push({
    id: 'V4',
    name: '附件零缺失',
    pass: diff.missing === 0,
    detail: `缺失=${diff.missing} 多余=${diff.extra} DB=${diff.dbCount} FS=${diff.fsCount}`,
  });

  // V5：filestore 无嵌套
  results.push({ id: 'V5', name: 'filestore 无嵌套', pass: sec('V5', 'V6') === 'CLEAN' });

  // V6：站点可访问（HTTP 200 且体积 > 10KB）
  const v6lines = sec('V6', 'V7')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  const v6ok =
    v6lines.length > 0 &&
    v6lines.every((l) => {
      const [, code, size] = l.split('|');
      return code === '200' && Number(size) > 10000;
    });
  results.push({
    id: 'V6',
    name: '站点可访问',
    pass: v6ok,
    detail: v6lines.join(' '),
  });

  // V7：附件内容寻址（/web/content/<id> 下载的 sha1 与 filestore 文件名一致）
  const v7 = sec('V7', 'END');
  let v7pass = false;
  let v7detail = v7;
  if (v7 !== 'NO_PUBLIC_ATTACHMENT') {
    const [, got, want] = v7.split('|');
    v7pass = Boolean(got && want && got === want);
    v7detail = `附件 sha1 ${got === want ? '匹配' : '不符'}`;
  } else {
    v7detail = '无 public 图片附件，跳过';
    v7pass = true;
  }
  results.push({ id: 'V7', name: '附件内容寻址', pass: v7pass, detail: v7detail });

  return {
    ok: results.every((x) => x.pass),
    results,
  };
}
