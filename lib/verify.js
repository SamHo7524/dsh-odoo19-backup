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
# v0.1.25：改成「库里已安装的模块，其代码是否真的被 Odoo 载入」。
# 不渲染模板、不依赖 HTTP request 上下文（website.layout 需要 request，shell 里必失败），
# 而是逐个 import odoo.addons.<name> —— 这正好命中「代码在容器启动后才部署」的故障类。
docker exec -e DB="\$DB" -i "\$OC" sh -c 'odoo shell --no-http -d "\$DB" --db_host="\$HOST" --db_user="\$USER" --db_password="\$PASSWORD" <<"PY" 2>&1 | grep -E "^MODCHECK_" || true
import importlib
mods = env["ir.module.module"].search([("state", "=", "installed")])
bad = []
for m in mods:
    if m.name in ("base", "web"):
        continue
    try:
        importlib.import_module("odoo.addons." + m.name)
    except Exception:
        bad.append(m.name)
print("MODCHECK_TOTAL=" + str(len(mods)))
print("MODCHECK_BAD=" + (",".join(bad) if bad else "none"))
PY'

echo "===V6HTTP==="
for p in / /web/login; do
  code=\$(curl -sL -o /dev/null -w '%{http_code}' -H 'Host: localhost' --max-time 15 "http://127.0.0.1:8069\$p?db=\$DB" 2>/dev/null || echo 000)
  size=\$(curl -sL -o /dev/null -w '%{size_download}' -H 'Host: localhost' --max-time 15 "http://127.0.0.1:8069\$p?db=\$DB" 2>/dev/null || echo 0)
  echo "\$p|\$code|\$size"
done

echo "===V7==="
# v0.1.25：附件内容寻址改由 Odoo 读 raw 再比对 filestore 文件名（=内容的 sha1）。
docker exec -e DB="\$DB" -i "\$OC" sh -c 'odoo shell --no-http -d "\$DB" <<"PY" 2>&1 | grep -E "^V7_" || true
import hashlib
a = env["ir.attachment"].search([("type", "=", "binary"), ("public", "=", True), ("mimetype", "like", "image/"), ("store_fname", "!=", False)], limit=1)
if not a:
    print("V7_NONE")
else:
    raw = a.raw or b""
    print("V7_SHA=" + hashlib.sha1(raw).hexdigest())
    print("V7_NAME=" + (a.store_fname or "").split("/")[-1])
    print("V7_BYTES=" + str(len(raw)))
PY'

echo "===END==="
`;
}

/** V6 解析：库里已安装模块的代码是否全部可被 Odoo 导入。 */
export function parseModuleCodeCheck(text) {
  const s = String(text ?? '');
  const total = Number((s.match(/^MODCHECK_TOTAL=(\d+)/m) ?? [])[1] ?? 0);
  const badRaw = (s.match(/^MODCHECK_BAD=(.*)$/m) ?? [])[1]?.trim() ?? '';
  if (!total || !badRaw) return { ok: false, detail: '模块代码检查未返回结果' };
  if (badRaw === 'none') return { ok: true, detail: `${total} 个已安装模块的代码全部可载入` };
  const bad = badRaw.split(',').filter(Boolean);
  return {
    ok: false,
    detail: `${bad.length} 个模块代码未载入：${bad.slice(0, 5).join('、')}${bad.length > 5 ? ' …' : ''}`,
    bad,
  };
}

/** V7 解析：附件 raw 的 sha1 是否等于 filestore 文件名。 */
export function parseAttachmentCheck(text) {
  const s = String(text ?? '');
  if (/V7_NONE/.test(s)) return { ok: true, skipped: true, detail: '无 public 图片附件，跳过' };
  const sha = (s.match(/^V7_SHA=(\w+)/m) ?? [])[1] ?? '';
  const name = (s.match(/^V7_NAME=(.+)$/m) ?? [])[1]?.trim() ?? '';
  const bytes = Number((s.match(/^V7_BYTES=(\d+)/m) ?? [])[1] ?? 0);
  if (!sha || !name) return { ok: false, skipped: false, detail: '附件校验未返回结果' };
  return {
    ok: sha === name,
    skipped: false,
    detail: sha === name
      ? `附件 sha1 匹配（${bytes} 字节）`
      : `附件内容与 filestore 不一致（raw=${sha.slice(0, 12)} filestore=${name.slice(0, 12)}）`,
  };
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

  // V6：站点可访问 —— 以「已安装模块的代码能否被 Odoo 载入」为准（HTTP 结果仅作参考）
  const codecheck = parseModuleCodeCheck(sec('V6', 'V6HTTP'));
  const httpInfo = sec('V6HTTP', 'V7')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .join(' ');
  results.push({
    id: 'V6',
    name: '模块代码已载入',
    pass: codecheck.ok,
    detail: httpInfo ? `${codecheck.detail}；HTTP 参考：${httpInfo}` : codecheck.detail,
  });

  // V7：附件内容寻址（Odoo 读 raw 的 sha1 == filestore 文件名）
  const att = parseAttachmentCheck(sec('V7', 'END'));
  results.push({ id: 'V7', name: '附件内容寻址', pass: att.ok, detail: att.detail });

  return {
    ok: results.every((x) => x.pass),
    results,
  };
}
