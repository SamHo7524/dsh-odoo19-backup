import { execRemote, buildScpArgs } from './ssh.js';
import { verifyInstance } from './verify.js';
import { buildDomainPatchScript, parseDomainPatch, resolveTargetDomain } from './site-domain.js';
import { decryptFile, detectFormat } from './crypto.js';
import { STATE } from './constants.js';
import {
  guardDbName,
  buildTerminateSql,
  buildExactLookupSql,
  switchRenameSql,
  rollbackRenameSql,
  assertTargetsAllowed,
} from './dbguard.js';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat, open, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';

/**
 * 解析临时恢复脚本里的 addons 权限检查段。
 * 第 11 条：addons 目录丢失执行位会导致 Odoo 静默跳过整个模块目录。
 */
export function parseAddonsPerm(sec) {
  const s = String(sec);
  const num = (k) => Number(s.match(new RegExp(`${k}=(\\d+)`))?.[1] ?? '0');
  return {
    addonsMissing: s.includes('addons_missing=true'),
    repairedX: num('repaired_x'),
    repairedR: num('repaired_r'),
    remainX: num('remaining_missing_x'),
  };
}

/**
 * 解析回滚脚本的 DB/FS 一致性探测。
 * 不依赖 STATE= 标记，直接从 DB:/FS: 行判断 prod/old 的库与 filestore 是否成对存在。
 */
export function detectRollbackState(sec) {
  const s = String(sec);
  const pick = (line) => {
    const m = s.match(new RegExp(`${line}: prod=(\\d) old=(\\d)`));
    return m ? { prod: Number(m[1]), old: Number(m[2]) } : { prod: 0, old: 0 };
  };
  const db = pick('DB');
  const fs = pick('FS');
  const consistent = db.prod === fs.prod && db.old === fs.old;
  return {
    consistent,
    hasProdDb: db.prod === 1,
    hasOldDb: db.old === 1,
  };
}

export function resolveOldDb(stdout, dbName, ts) {
  const m = String(stdout).match(/===OLDDB===\n(\S+)/);
  return m ? m[1] : `${dbName}-old-${ts}`;
}

// ---------- 阶段 A0：部署 addons / pydeps（v0.1.14 真机缺陷修复） ----------

/**
 * 判定 addons 包的路径前缀，决定解压时要不要 --strip-components。
 *
 * 备份侧用 `tar -C "$ADDONS" -cf - .` 打包 → 成员是 `./foo/...`，**不能 strip**。
 * 若某些环境打成 `addons/foo/...`，则必须 strip 1，否则会变成 addons/addons/foo。
 */
export function detectAddonsPrefix(listing) {
  const lines = String(listing ?? '')
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s && s !== './' && s !== '.');
  if (lines.length === 0) return { strip: 0 };

  const first = lines[0];
  if (first.startsWith('./')) return { strip: 0 };
  if (first.startsWith('addons/')) return { strip: 1 };
  // 直接是模块目录（foo/...）或文件
  return { strip: 0 };
}

export function buildDeployComponentsScript({ addonsFile = '', pydepsFile = '' } = {}) {
  return `
set -uo pipefail
read -r ADDONS
read -r DATA
read -r UID_
read -r GID_
read -r WORKDIR
read -r ADDONS_STRIP

echo "===DEPLOY==="

ADDONS_OK=false
PYDEPS_OK=false
ADDONS_MODULES=0
PYDEPS_FILES=0
ERR=""

# --- addons ---
if [ -n ${JSON.stringify(addonsFile)} ]; then
  SRC="$WORKDIR/${addonsFile}"
  if [ -f "$SRC" ]; then
    mkdir -p "$ADDONS"
    if [ "$ADDONS_STRIP" = "1" ]; then
      STRIP="--strip-components=1"
    else
      STRIP=""
    fi
    case "$SRC" in
      *.zst)
        if command -v zstd >/dev/null 2>&1; then
          if tar --use-compress-program=zstd -xf "$SRC" -C "$ADDONS" $STRIP 2>/tmp/dep_addons.err; then
            ADDONS_OK=true
          else
            ERR="addons 解压失败: $(tail -c 300 /tmp/dep_addons.err)"
          fi
        else
          ERR="缺少 zstd 命令，无法解压 addons"
        fi
        ;;
      *.gz)
        if tar -xzf "$SRC" -C "$ADDONS" $STRIP 2>/tmp/dep_addons.err; then
          ADDONS_OK=true
        else
          ERR="addons 解压失败: $(tail -c 300 /tmp/dep_addons.err)"
        fi
        ;;
      *)
        ERR="未知的 addons 压缩格式: $SRC"
        ;;
    esac
    if [ "$ADDONS_OK" = "true" ]; then
      ADDONS_MODULES=$(ls -1d "$ADDONS"/*/ 2>/dev/null | wc -l | tr -d ' ')
      chown -R "$UID_:$GID_" "$ADDONS" 2>/dev/null || true
      # 确保目录有执行位，否则 Odoo 静默跳过整个模块目录
      find "$ADDONS" -type d ! -perm -u+x -exec chmod u+x {} + 2>/dev/null || true
      find "$ADDONS" -type f ! -perm -u+r -exec chmod u+r {} + 2>/dev/null || true
    fi
  else
    ERR="addons 包不存在: $SRC"
  fi
else
  ADDONS_OK=skipped
fi

# --- pydeps ---
if [ -n ${JSON.stringify(pydepsFile)} ]; then
  PSRC="$WORKDIR/${pydepsFile}"
  if [ -f "$PSRC" ]; then
    mkdir -p "$DATA"
    case "$PSRC" in
      *.zst)
        if command -v zstd >/dev/null 2>&1; then
          if tar --use-compress-program=zstd -xf "$PSRC" -C "$DATA" 2>/tmp/dep_pydeps.err; then
            PYDEPS_OK=true
          else
            ERR="$ERR pydeps 解压失败: $(tail -c 300 /tmp/dep_pydeps.err)"
          fi
        else
          ERR="$ERR 缺少 zstd 命令，无法解压 pydeps"
        fi
        ;;
      *.gz)
        if tar -xzf "$PSRC" -C "$DATA" 2>/tmp/dep_pydeps.err; then
          PYDEPS_OK=true
        else
          ERR="$ERR pydeps 解压失败: $(tail -c 300 /tmp/dep_pydeps.err)"
        fi
        ;;
      *)
        ERR="$ERR 未知的 pydeps 压缩格式: $PSRC"
        ;;
    esac
    if [ "$PYDEPS_OK" = "true" ] && [ -d "$DATA/.local" ]; then
      PYDEPS_FILES=$(find "$DATA/.local" -type f 2>/dev/null | wc -l | tr -d ' ')
      chown -R "$UID_:$GID_" "$DATA/.local" 2>/dev/null || true
    fi
  else
    ERR="$ERR pydeps 包不存在: $PSRC"
  fi
else
  PYDEPS_OK=skipped
fi

rm -f /tmp/dep_addons.err /tmp/dep_pydeps.err 2>/dev/null || true

echo "addons_ok=$ADDONS_OK"
echo "addons_modules=$ADDONS_MODULES"
echo "pydeps_ok=$PYDEPS_OK"
echo "pydeps_files=$PYDEPS_FILES"
[ -n "$ERR" ] && echo "error=$ERR"
echo "===DEPLOY_END==="
`;
}

export function parseDeployComponents(stdout) {
  const m = String(stdout ?? '').match(/===DEPLOY===\n([\s\S]*?)===DEPLOY_END===/);
  if (!m) return { addonsOk: false, pydepsOk: false, reason: '未收到部署结果（脚本未完成）' };
  const sec = m[1];
  const grab = (k) => {
    const r = sec.match(new RegExp(`^${k}=(.*)$`, 'm'));
    return r ? r[1].trim() : '';
  };
  const addonsRaw = grab('addons_ok');
  const pydepsRaw = grab('pydeps_ok');
  const err = grab('error');
  return {
    addonsOk: addonsRaw === 'true',
    addonsSkipped: addonsRaw === 'skipped',
    addonsModules: Number(grab('addons_modules')) || 0,
    pydepsOk: pydepsRaw === 'true',
    pydepsSkipped: pydepsRaw === 'skipped',
    pydepsFiles: Number(grab('pydeps_files')) || 0,
    // v0.1.27：无错误时键必须整体缺席。
    // `err || undefined` 会让恢复结果携带值为 undefined 的属性，
    // lossless-json 序列化直接抛「value is not lossless JSON」，恢复成功却拿不到结果。
    ...(err ? { reason: err } : {}),
  };
}

/**
 * 部署 addons 与 pydeps 到目标机。
 *
 * 为什么必须先于数据库：registry 加载时扫描 addons，代码不在的模块被跳过，
 * 只记 "Some modules are not loaded" 日志、不报错；随后模板渲染才 500
 * （真机：website.layout 引用 website.clarity_project_id → AttributeError）。
 */
async function phaseDeployComponents({ server, instance, workDir, onProgress }) {
  onProgress({ phase: 'deploying', percent: 6, message: '正在部署 addons 与运行时依赖' });

  const addonsFile = instance.pkgAddonsFile ?? '';
  const pydepsFile = instance.pkgPydepsFile ?? '';

  // 先探测包内前缀，决定 strip
  let strip = 0;
  if (addonsFile) {
    const probe = await execRemote(
      server,
      `set -u; SRC="$1/${addonsFile}"
case "$SRC" in
  *.zst) tar --use-compress-program=zstd -tf "$SRC" 2>/dev/null | head -3 ;;
  *.gz)  tar -tzf "$SRC" 2>/dev/null | head -3 ;;
esac`,
      { stdin: `${workDir}\n`, timeoutMs: 120000 },
    );
    strip = detectAddonsPrefix(probe.stdout).strip;
  }

  const stdin = [
    instance.addonsPath,
    instance.dataPath,
    instance.uid ?? 100,
    instance.gid ?? 101,
    workDir,
    String(strip),
  ].join('\n') + '\n';

  const r = await execRemote(server, buildDeployComponentsScript({ addonsFile, pydepsFile }), {
    stdin,
    timeoutMs: 1800000,
  });
  const parsed = parseDeployComponents(r.stdout);

  if (!parsed.addonsSkipped && !parsed.addonsOk) {
    throw new Error(`addons 部署失败：${parsed.reason ?? '未知原因'}（未部署 addons 会导致站点 500，已中止）`);
  }
  if (!parsed.pydepsSkipped && !parsed.pydepsOk) {
    throw new Error(`pydeps 部署失败：${parsed.reason ?? '未知原因'}（缺少运行时依赖会导致功能静默失效，已中止）`);
  }
  if (!parsed.addonsSkipped && parsed.addonsModules === 0) {
    throw new Error('addons 部署后模块数为 0：addons 目录为空会导致站点 500，已中止');
  }

  onProgress({
    phase: 'deploying',
    percent: 8,
    message: `addons ${parsed.addonsModules} 个模块、pydeps ${parsed.pydepsFiles} 个文件已部署`,
  });
  return parsed;
}

/**
 * v0.1.23 — 部署 addons/pydeps 之后必须重启 Odoo 容器。
 *
 * 为什么：Odoo 只在**进程启动时**扫描 addons 路径并导入模块 Python。备份包里的
 * 自建模块如果是在容器启动之后才落盘的，进程内根本没有这些模块的模型/字段，
 * 于是模板渲染会 500（真机：`'website' object has no attribute 'clarity_project_id'`，
 * 来自 website_clarity 模块）。部署不重启 = 白部署。
 */
export function buildRestartOdooScript() {
  return `
set -uo pipefail
read -r OC
echo "===RESTART==="
RESTART_RC=0
docker restart "\$OC" >/dev/null 2>&1 || RESTART_RC=\$?
READY=0
LAST_CODE=000
WAITED=0
i=0
while [ "\$i" -lt 60 ]; do
  CODE=\$(docker exec "\$OC" sh -c "curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:8069/web/login 2>/dev/null || echo 000" 2>/dev/null || echo 000)
  LAST_CODE="\$CODE"
  if [ "\$CODE" != "000" ]; then
    READY=1
    break
  fi
  i=\$((i+1))
  WAITED=\$((i*2))
  sleep 2
done
echo "restart_rc=\$RESTART_RC"
echo "ready=\$READY"
echo "last_code=\$LAST_CODE"
echo "waited_s=\$WAITED"
echo "===RESTART_END==="
`;
}

/** 解析重启脚本输出；脚本未跑完一律视为未就绪（fail-closed）。 */
export function parseRestartResult(stdout) {
  const text = String(stdout ?? '');
  const m = text.match(/===RESTART===\n([\s\S]*?)===RESTART_END===/);
  if (!m) return { ready: false, reason: '未收到重启结果（脚本未完成）', waitedSeconds: 0, lastCode: '000', restartRc: null };
  const grab = (k) => {
    const r = m[1].match(new RegExp(`^${k}=(.*)$`, 'm'));
    return r ? r[1].trim() : '';
  };
  return {
    ready: grab('ready') === '1',
    lastCode: grab('last_code') || '000',
    waitedSeconds: Number(grab('waited_s')) || 0,
    restartRc: grab('restart_rc') === '' ? null : Number(grab('restart_rc')),
  };
}

/** 是否值得为本次部署重启容器（没部署任何东西就不要制造停机）。 */
export function shouldRestartAfterDeploy(deploy) {
  if (!deploy || typeof deploy !== 'object') return false;
  const modules = Number(deploy.addonsModules) || 0;
  const files = Number(deploy.pydepsFiles) || 0;
  return modules > 0 || files > 0;
}

async function phaseRestartOdoo({ server, instance, onProgress, deploy }) {
  onProgress({
    phase: 'deploying',
    percent: 10,
    message: '正在重启 Odoo 以载入新部署的模块（期间站点短暂不可访问）',
  });

  const r = await execRemote(server, buildRestartOdooScript(), {
    stdin: `${instance.odooContainer}\n`,
    timeoutMs: 600000,
  });
  const parsed = parseRestartResult(r.stdout);

  if (parsed.restartRc !== null && parsed.restartRc !== 0) {
    throw new Error(
      `重启 Odoo 容器失败（rc=${parsed.restartRc}）：新部署的模块不会被载入，站点会 500。` +
        '【建议】手工执行 docker restart 后确认容器状态，再重试恢复。',
    );
  }
  if (!parsed.ready) {
    throw new Error(
      `重启后 Odoo 在 ${parsed.waitedSeconds || 120} 秒内未响应（最后 HTTP 码 ${parsed.lastCode}）：` +
        '容器可能起不来或端口未监听。请查看容器日志后重试；已中止，未切换数据库。',
    );
  }

  onProgress({
    phase: 'deploying',
    percent: 12,
    message: `Odoo 已重启并可用（${parsed.waitedSeconds} 秒，HTTP ${parsed.lastCode}）`,
  });
  return { restarted: true, ...parsed, deployed: deploy ?? null };
}

// ---------- 阶段 A：安全备份 ----------

export function buildSafetyBackupScript() {
  // 注意：shell 的 ${VAR} 必须写成 \${VAR}，否则会被 JS 模板字符串当表达式解析
  return `
set -uo pipefail
read -r OC
read -r PG
read -r PG_SUPER
read -r DB
read -r TS

CINT="/tmp/odoo-safety-\$\$"
docker exec "\$OC" mkdir -p "\$CINT" || { echo "MKDIR_FAIL"; exit 4; }

# v0.1.14：安全备份保护的是「目标库当前的真实数据」。
# 必须把四种情况分开，绝不能把「缺 Odoo 系统表」等同于「库为空」：
#   1) 库不存在                  → 无数据，跳过（no_db）
#   2) 库存在且 0 张用户表        → 真空白，跳过（empty_db）
#   3) 库存在、有表、但无 Odoo 架构 → 有数据必须保护！odoo db dump 不可用，退回 pg_dump
#   4) 正常 Odoo 库              → odoo db dump（zip，含 filestore）
EXISTS=\$(docker exec "\$PG" psql -U "\$PG_SUPER" -d postgres -Atc "select 1 from pg_database where datname='\$DB'" 2>/dev/null || echo "")
if [ "\$EXISTS" != "1" ]; then
  docker exec "\$OC" rm -rf "\$CINT" 2>/dev/null || true
  echo "===SAFETY_SKIP==="
  echo "reason=no_db"
  echo "===END==="
  exit 0
fi

TBL=\$(docker exec "\$PG" psql -U "\$PG_SUPER" -d "\$DB" -Atc "select count(*) from information_schema.tables where table_schema not in ('pg_catalog','information_schema')" 2>/dev/null || echo "")
HAS=\$(docker exec "\$PG" psql -U "\$PG_SUPER" -d "\$DB" -Atc "select (to_regclass('public.ir_module_module') is not null)" 2>/dev/null || echo "")

# 只有「确定是 0 张用户表」才算空库；探测失败（空值）绝不能当成空库。
if [ "\$TBL" = "0" ]; then
  docker exec "\$OC" rm -rf "\$CINT" 2>/dev/null || true
  echo "===SAFETY_SKIP==="
  echo "reason=empty_db"
  echo "===END==="
  exit 0
fi

ERRF="/tmp/odoo-dump-err-\$\$.log"
FORMAT=""
FINAL=""

if [ "\$HAS" = "t" ]; then
  FORMAT=odoo-zip
  FINAL="/tmp/safety-backup-\$TS.zip"
  docker exec "\$OC" odoo db -r "\$(docker exec "\$OC" printenv USER)" -w "\$(docker exec "\$OC" printenv PASSWORD)" --db_host "\$(docker exec "\$OC" printenv HOST)" --db_port 5432 dump --format=zip "\$DB" "\$CINT/safety.zip" >/dev/null 2>"\$ERRF"
  RC=\$?
  if [ "\$RC" -ne 0 ]; then
    docker exec "\$OC" rm -rf "\$CINT" 2>/dev/null || true
    echo "===DUMP_ERR==="
    tail -6 "\$ERRF" 2>/dev/null || echo "dump 失败且无 stderr"
    rm -f "\$ERRF" 2>/dev/null || true
    echo "===END==="
    exit 1
  fi
  rm -f "\$ERRF" 2>/dev/null || true
  docker cp "\$OC:\$CINT/safety.zip" "\$FINAL"
  docker exec "\$OC" rm -rf "\$CINT" 2>/dev/null || true
else
  # 有表但没有 Odoo 架构：这是真实数据，不能跳过。用 pg_dump 做逻辑备份
  # （此库没有 Odoo 语义，也就没有对应 filestore）。
  FORMAT=pgdump
  FINAL="/tmp/safety-backup-\$TS.pgdump"
  PDINT="/tmp/safety-pgdump-\$TS.dump"
  docker exec "\$PG" pg_dump -U "\$PG_SUPER" -Fc -f "\$PDINT" "\$DB" >/dev/null 2>"\$ERRF"
  RC=\$?
  if [ "\$RC" -ne 0 ]; then
    echo "===DUMP_ERR==="
    tail -6 "\$ERRF" 2>/dev/null || echo "pg_dump 失败且无 stderr"
    rm -f "\$ERRF" 2>/dev/null || true
    echo "===END==="
    exit 1
  fi
  rm -f "\$ERRF" 2>/dev/null || true
  docker cp "\$PG:\$PDINT" "\$FINAL"
  docker exec "\$PG" rm -f "\$PDINT" 2>/dev/null || true
fi

echo "===SAFETY==="
echo "===FORMAT==="
echo "\$FORMAT"
echo "===SIZE==="
stat -c %s "\$FINAL" 2>/dev/null || echo 0
echo "===SHA==="
sha256sum "\$FINAL" 2>/dev/null | awk '{print \$1}'
echo "===READY==="
echo "\$FINAL"
echo "===END==="
`;
}

async function phaseA_safetyBackup({ server, instance, ts, onProgress }) {
  onProgress({ phase: 'safety-backup', percent: 5, message: '正在备份当前环境' });

  const dbName = guardDbName(instance.dbName);
  const stdin = [
    instance.odooContainer,
    instance.pgContainer,
    instance.pgSuperUser ?? instance.dbUser,
    dbName,
    ts,
  ].join('\n') + '\n';
  const r = await execRemote(server, buildSafetyBackupScript(), { stdin, timeoutMs: 1800000 });

  const parsed = parseSafetyBackup(r.stdout, r.code);

  if (parsed.skipped) {
    const label = parsed.reason === 'no_db'
      ? '目标库不存在，跳过安全备份'
      : '目标库为空（0 张用户表），跳过安全备份';
    onProgress({ phase: 'safety-backup', percent: 6, message: label });
    return {
      state: STATE.SAFETY_BACKED_UP,
      safetyBackup: { skipped: true, reason: parsed.reason },
    };
  }

  if (parsed.size === 0) throw new Error('安全备份文件为空，拒绝继续');

  const note = parsed.format === 'pgdump'
    ? '目标库无 Odoo 架构但有数据，已用 pg_dump 做逻辑备份（不含 filestore）'
    : '已备份当前环境';
  onProgress({ phase: 'safety-backup', percent: 7, message: note });

  return {
    state: STATE.SAFETY_BACKED_UP,
    safetyBackup: {
      path: parsed.path,
      sha256: parsed.sha256,
      bytes: parsed.size,
      format: parsed.format,
    },
  };
}

/**
 * 解析阶段 A 输出。
 * 空目标库返回 { skipped: true }；真正失败（dump 非零）抛错并带上真实 stderr。
 */
export function parseSafetyBackup(stdout, code = 0) {
  const out = String(stdout ?? '');
  if (out.includes('===SAFETY_SKIP===')) {
    const reason = (out.match(/reason=(\S+)/)?.[1] ?? 'unknown').trim();
    return { skipped: true, reason, size: 0, sha256: '', path: '' };
  }
  if (out.includes('===DUMP_ERR===')) {
    const msg = (out.split('===DUMP_ERR===')[1] ?? '').split('===END===')[0].trim();
    throw new Error(`安全备份失败：${msg.slice(0, 400) || 'dump 失败'}`);
  }
  if (code !== 0 || !out.includes('===SAFETY===')) {
    throw new Error(`安全备份失败：${out.slice(-400) || '脚本未返回成功标记'}`);
  }
  const size = Number((out.match(/===SIZE===\n(\d+)/)?.[1] ?? '0').trim()) || 0;
  const sha256 = out.match(/===SHA===\n([0-9a-f]{64})/)?.[1] ?? '';
  const path = out.match(/===READY===\n(\S+)/)?.[1] ?? '';
  const format = (out.match(/===FORMAT===\n(\S+)/)?.[1] ?? 'odoo-zip').trim();
  return { skipped: false, size, sha256, path, format };
}

// ---------- 阶段 B：临时恢复 ----------

export function buildTempRestoreScript({ neutralize = false } = {}) {
  // v0.1.27：neutralize 是显式选项（演练场景），默认不中立化。
  // 此前 -n 写死：恢复「成功」但 42/43 cron 被禁、SMTP 凭据被销毁（不可逆）、
  // 支付商全 disabled、顶中立化横幅——生产接管场景等于恢复出一个废站。
  const nFlag = neutralize ? '-n' : '';
  const nNote = neutralize
    ? '# 注意：-n 中立化会禁 cron/邮件/webhook 并销毁 SMTP 凭据；转正式需按「取消中立化」SOP 反向操作'
    : '# 未中立化（生产接管）：cron/邮件按备份原样启用';
  return `
set -uo pipefail
read -r OC
read -r PG
read -r PG_USER
read -r PG_SUPER
read -r DB
read -r TMPDB
read -r DATA
read -r ADDONS
read -r PKG_PATH

# 第 11 条：addons 执行位检查与修复（宿主机侧）
echo "===ADDONS_PERM==="
if [ -d "\$ADDONS" ]; then
  MISSING_X=\$(find "\$ADDONS" -type d ! -perm -u+x 2>/dev/null | wc -l)
  MISSING_R=\$(find "\$ADDONS" -type f ! -perm -u+r 2>/dev/null | wc -l)
  echo "dirs_missing_x=\$MISSING_X"
  echo "files_missing_r=\$MISSING_R"
  if [ "\$MISSING_X" -gt 0 ]; then
    find "\$ADDONS" -type d ! -perm -u+x -exec chmod u+x {} + 2>/dev/null || true
    echo "repaired_x=\$MISSING_X"
  fi
  if [ "\$MISSING_R" -gt 0 ]; then
    find "\$ADDONS" -type f ! -perm -u+r -exec chmod u+r {} + 2>/dev/null || true
    echo "repaired_r=\$MISSING_R"
  fi
  REMAIN_X=\$(find "\$ADDONS" -type d ! -perm -u+x 2>/dev/null | wc -l)
  echo "remaining_missing_x=\$REMAIN_X"
else
  echo "addons_missing=true"
fi
echo "===PERM_END==="

# 第 4 条：确保 filestore/<tmpdb> 不存在（避免 load 串联旧附件）
if [ -d "\$DATA/filestore/\$TMPDB" ]; then
  mv "\$DATA/filestore/\$TMPDB" "\$DATA/filestore/\$TMPDB.bak-\$(date +%s)"
fi

# 第 1 条（odoo-restore 陷阱 1）：先以超级用户删库，再让 load 自建库。
# 不能用 load -f：exp_drop 受 dbfilter 在无 HTTP 上下文时过滤，会静默跳过删除，
# 导致库已存在 → load 报 "Database already exists"。这里删掉后 load 不加 -f 即可。
docker exec "\$PG" psql -U "\$PG_SUPER" -d postgres -c "DROP DATABASE IF EXISTS \\"\$TMPDB\\"" >/dev/null 2>&1 || true

# 恢复（容器内 load，连接参数取自容器 env，与备份一致）
${nNote}
docker cp "\$PKG_PATH" "\$OC:/tmp/restore-pkg.zip"
LOAD_OUT=\$(docker exec "\$OC" odoo db -r "\$(docker exec "\$OC" printenv USER)" -w "\$(docker exec "\$OC" printenv PASSWORD)" --db_host "\$(docker exec "\$OC" printenv HOST)" --db_port 5432 load ${nFlag ? `${nFlag} ` : ''}"\$TMPDB" /tmp/restore-pkg.zip 2>&1)
LOAD_RC=\$?
echo "===LOAD==="
echo "\$LOAD_OUT"
echo "LOAD_RC=\$LOAD_RC"
docker exec -u root "\$OC" rm -f /tmp/restore-pkg.zip 2>/dev/null || true

echo "===INSTALLED==="
docker exec "\$PG" psql -U "\$PG_USER" -d "\$TMPDB" -Atc "select count(*) from ir_module_module where state='installed'" 2>/dev/null || echo 0
echo "===END==="
`;
}

async function phaseB_tempRestore({ server, instance, ts, pkgRemotePath, neutralize = false, onProgress }) {
  onProgress({ phase: 'restoring-temp', percent: 25, message: '正在恢复到临时库' });

  const tmpDb = `${instance.dbName}-restore-${ts}`;
  const stdin = [
    instance.odooContainer,
    instance.pgContainer,
    instance.dbUser,
    instance.pgSuperUser ?? instance.dbUser,
    instance.dbName,
    tmpDb,
    instance.dataPath,
    instance.addonsPath,
    pkgRemotePath,
  ].join('\n') + '\n';

  const r = await execRemote(server, buildTempRestoreScript({ neutralize }), { stdin, timeoutMs: 3600000 });

  if (!r.stdout.includes('===END===')) {
    throw new Error(`临时恢复失败：${(r.stderr || r.stdout).slice(-500)}`);
  }

  const permSec = r.stdout.match(/===ADDONS_PERM===\n([\s\S]*?)===PERM_END===/)?.[1] ?? '';
  const perm = parseAddonsPerm(permSec);
  if (perm.addonsMissing) {
    throw new Error(`addons 目录不存在：${instance.addonsPath}，无法继续恢复`);
  }
  if (perm.remainX > 0) {
    throw new Error(
      `addons 目录仍有 ${perm.remainX} 个子目录缺少执行位，Odoo 无法导入这些模块。` +
        `请以宿主机 root 手工修复后重试：find ${instance.addonsPath} -type d ! -perm -u+x -exec chmod u+x {} +`,
    );
  }

  const loadRc = Number(r.stdout.match(/LOAD_RC=(\d+)/)?.[1] ?? '0');
  if (loadRc !== 0) {
    const loadOut = r.stdout.match(/===LOAD===\n([\s\S]*?)LOAD_RC=/)?.[1] ?? '';
    throw new Error(`odoo db load 失败 (rc=${loadRc})：${loadOut.slice(-500)}`);
  }

  const installed = Number(r.stdout.match(/===INSTALLED===\n(\d+)/)?.[1] ?? '0') || 0;
  if (installed === 0) throw new Error('临时库无 installed 模块，恢复失败');

  return { state: STATE.TEMP_RESTORED, tmpDb, installed, addonsPerm: perm };
}

// ---------- 阶段 C：临时验证 ----------

async function phaseC_verifyTemp({ server, instance, tmpDb, baseline, onProgress }) {
  onProgress({ phase: 'verifying-temp', percent: 40, message: '正在验证临时环境' });

  const tempInstance = { ...instance, dbName: tmpDb };
  const result = await verifyInstance({ server, instance: tempInstance, baseline });

  if (!result.ok) {
    const failed = result.results
      .filter((r) => !r.pass)
      .map((r) => `${r.id} ${r.name}`)
      .join(', ');
    throw new Error(`临时环境验证失败：${failed}`);
  }

  return { state: STATE.TEMP_VERIFIED, verify: result };
}

// ---------- 阶段 D：停机切换 ----------

export function buildSwitchScript() {
  return `
set -uo pipefail
read -r OC
read -r PG
read -r PG_SUPER
read -r DB
read -r TMPDB
read -r DATA
read -r CONF
read -r TS
read -r TERMINATE_SQL
read -r RENAME_OLD_SQL
read -r RENAME_NEW_SQL

OLD="\${DB}-old-\${TS}"

# D1: 停 Odoo（第 2 条）
echo "===STOP==="
docker stop "\$OC" >/dev/null 2>&1 || true

# D2: 终止残留连接。SQL 由 dbguard 生成，精确 IN 名单；
#     绝不写 LIKE '<db>%' —— 那会误伤恢复目标之外的库（2026-11-04 事故）。
echo "===TERMINATE==="
docker exec "\$PG" psql -U "\$PG_SUPER" -d postgres -c "\$TERMINATE_SQL" >/dev/null 2>&1 || true

# D3: DB 改名（精确 ALTER，SQL 由 dbguard 生成）
echo "===RENAME_OLD==="
docker exec "\$PG" psql -U "\$PG_SUPER" -d postgres -c "\$RENAME_OLD_SQL"

# D4: FS 改名（精确路径）
echo "===MV_OLD==="
mv "\$DATA/filestore/\$DB" "\$DATA/filestore/\$OLD"

# D5: 临时库改名为正式库
echo "===RENAME_NEW==="
docker exec "\$PG" psql -U "\$PG_SUPER" -d postgres -c "\$RENAME_NEW_SQL"

# D6: 临时 FS 改名为正式
echo "===MV_NEW==="
mv "\$DATA/filestore/\$TMPDB" "\$DATA/filestore/\$DB"

# D7: 启动（先启动再写 conf —— v0.1.27：此前 dbfilter 写入发生在 docker stop 之后，
#     对停止中的容器 exec 必然失败，且无 -e 不报错，静默吞掉）
echo "===START==="
docker start "\$OC" >/dev/null 2>&1 || true
sleep 2

# D8b: dbfilter 锁定唯一库（第 10 条）。容器已在运行，写入后立即回读验证。
#      旧行（含注释行、无效的 .*）一律注释掉再追加有效行；
#      dbfilter 是请求期生效的配置，无需再次重启。
echo "===DBFILTER==="
docker exec -u root "\$OC" sh -c "sed -i -E 's/^[[:space:]]*;?[[:space:]]*dbfilter[[:space:]]*=.*/; dsh-old-dbfilter/' \$CONF 2>/dev/null; sed -i -E 's/^[[:space:]]*;?[[:space:]]*list_db[[:space:]]*=.*/; dsh-old-list_db/' \$CONF 2>/dev/null; echo 'dbfilter = ^\${DB}\$' >> \$CONF; echo 'list_db = False' >> \$CONF" >/dev/null 2>&1 || true
DBF_COUNT=\$(docker exec "\$OC" sh -c "grep -cE '^dbfilter[[:space:]]*=[[:space:]]*\^\${DB}\$' \$CONF" 2>/dev/null) || DBF_COUNT=0
echo "dbfilter_ok=\$DBF_COUNT"

echo "===OLDDB==="
echo "\$OLD"
echo "===END==="
`;
}

/** v0.1.27：解析切换脚本的 dbfilter 回读结果。0 或段缺失 = 未生效（站点会落库管理器）。 */
export function parseDbFilterOk(stdout) {
  const s = String(stdout ?? '');
  const m = s.match(/===DBFILTER===\n([\s\S]*?)===OLDDB===/);
  if (!m) return { applied: false, count: 0 };
  const n = Number((m[1].match(/dbfilter_ok=(\d+)/) ?? [])[1] ?? 0) || 0;
  return { applied: n > 0, count: n };
}

async function phaseD_switch({ server, instance, ts, tmpDb, onProgress }) {
  onProgress({ phase: 'switching', percent: 60, message: '正在停机切换' });

  const db = guardDbName(instance.dbName);
  const tmp = guardDbName(tmpDb);
  const oldDb = `${db}-old-${ts}`;
  guardDbName(oldDb);

  // 安全闸门：本次停机切换只允许触碰这三个精确库名，绝不扩散到目标之外。
  const allowed = [db, oldDb, tmp];
  assertTargetsAllowed(allowed, allowed);

  const terminateSql = buildTerminateSql([db, tmp]);
  const [renameOldSql, renameNewSql] = switchRenameSql({ db, oldDb, tmpDb: tmp });

  const stdin = [
    instance.odooContainer,
    instance.pgContainer,
    instance.pgSuperUser ?? instance.dbUser,
    db,
    tmp,
    instance.dataPath,
    instance.confPath ?? '/etc/odoo/odoo.conf',
    ts,
    terminateSql,
    renameOldSql,
    renameNewSql,
  ].join('\n') + '\n';

  const r = await execRemote(server, buildSwitchScript(), { stdin, timeoutMs: 900000 });

  if (!r.stdout.includes('===END===')) {
    throw new Error(`切换失败：${(r.stderr || r.stdout).slice(-600)}`);
  }

  const resolved = resolveOldDb(r.stdout, db, ts);
  const dbFilter = parseDbFilterOk(r.stdout);
  return { state: STATE.SWITCHED, oldDb: guardDbName(resolved), dbFilter };
}

// ---------- 阶段 D2：站点域名切换（v0.1.14） ----------

/**
 * 备份包来自生产库，website.domain / web.base.url 仍是生产域名；原样恢复到另一台
 * 服务器会让两个站点抢同一域名。这里把目标站点域名改为本机服务器名并冻结 base url。
 *
 * 失败不致命：数据已切换成功，域名可人工更正；故只回报原因，不触发回滚。
 */
async function phaseDomainSwitch({ server, instance, domain, onProgress }) {
  onProgress({ phase: 'domain', percent: 78, message: `正在切换站点域名 → ${domain}` });

  const stdin = [
    instance.odooContainer,
    instance.pgContainer,
    instance.pgSuperUser ?? instance.dbUser,
    instance.dbName,
    domain,
  ].join('\n') + '\n';

  const r = await execRemote(server, buildDomainPatchScript(), { stdin, timeoutMs: 300000 });
  return parseDomainPatch(r.stdout);
}

// ---------- 阶段 D3：目标库签名密钥隔离（v0.1.14） ----------

/**
 * 重签目标库 database.secret 的 SQL。
 *
 * 关键点（用户裁决 2026-11-09）：
 *  - database.secret 是**按库存储**在各自 ir_config_parameter 里；改目标库只影响目标库，
 *    生产库保留原密钥、其已发出的链接照常有效。失效的只是目标库里那些用旧密钥签发的令牌。
 *  - 新值必须密码学安全：用 PostgreSQL 的 gen_random_uuid()（PG13+ 内建，走强随机源），
 *    绝不用 now()/random()/库名派生，也不回传明文。
 *  - 只在单库会话内执行（psql -d <目标库>），不跨库、不碰生产。
 *  - 输出只含长度与是否变化，密钥明文不出现在 stdout。
 */
export const ROTATE_SECRET_SQL = `
WITH old AS (
  SELECT value FROM ir_config_parameter WHERE key = 'database.secret'
), upd AS (
  UPDATE ir_config_parameter
     SET value = gen_random_uuid()::text
   WHERE key = 'database.secret'
  RETURNING value
)
SELECT
  (SELECT length(value) FROM old)  AS before_len,
  (SELECT length(value) FROM upd)  AS after_len,
  ((SELECT value FROM upd) IS DISTINCT FROM (SELECT value FROM old)) AS changed;
`;

export function buildRotateSecretScript() {
  // SQL 单行化后嵌进脚本：不含单引号，避免 shell 引号歧义。
  const sql = ROTATE_SECRET_SQL.replace(/\s+/g, ' ').trim();
  return `
set -uo pipefail
read -r PG
read -r PG_SUPER
read -r DB

echo "===SECRET==="
# 单库会话：只操作目标库；不切换连接、不跨库。
OUT=\$(docker exec "\$PG" psql -U "\$PG_SUPER" -d "\$DB" -AtF'|' -c ${JSON.stringify(sql)} 2>&1)
RC=\$?
echo "rc=\$RC"
if [ "\$RC" -ne 0 ]; then
  echo "error=\$OUT"
else
  BEFORE=\$(echo "\$OUT" | awk -F'|' 'NR==1{print \$1}')
  AFTER=\$(echo "\$OUT" | awk -F'|' 'NR==1{print \$2}')
  CHANGED=\$(echo "\$OUT" | awk -F'|' 'NR==1{print \$3}')
  echo "before_len=\$BEFORE"
  echo "after_len=\$AFTER"
  echo "changed=\$CHANGED"
fi
echo "===SECRET_END==="
`;
}

/**
 * 解析重签结果。绝不回传密钥明文；未真正变化或 rc 非 0 一律判失败。
 */
export function parseRotateSecret(stdout) {
  const text = String(stdout ?? '');
  const m = text.match(/===SECRET===\n([\s\S]*?)===SECRET_END===/);
  if (!m) return { applied: false, reason: '未收到重签结果（脚本未完成）' };

  const sec = m[1];
  const grab = (k) => {
    const r = sec.match(new RegExp(`^${k}=(.*)$`, 'm'));
    return r ? r[1].trim() : '';
  };

  const rc = grab('rc');
  if (rc !== '' && rc !== '0') {
    return { applied: false, reason: `重签失败（rc=${rc}）：${grab('error').slice(-300)}` };
  }
  const err = grab('error');
  if (err) return { applied: false, reason: `重签失败：${err.slice(-300)}` };

  const changed = grab('changed');
  const beforeLength = Number(grab('before_len')) || 0;
  const afterLength = Number(grab('after_len')) || 0;

  if (changed !== 't' && changed !== 'true') {
    // 实测（目标机 PG18.6）：目标库没有 database.secret 行时，SQL 返回 "||f"（rc=0），
    // 即 before_len/after_len 皆空、changed=f。必须判失败，并给出可操作原因，
    // 绝不能因为 rc=0 就当成成功。
    if (beforeLength === 0 && afterLength === 0) {
      return {
        applied: false,
        changed: false,
        beforeLength,
        afterLength,
        reason: '目标库没有 database.secret 参数行（恢复可能未完成），未做任何改动',
      };
    }
    return {
      applied: false,
      changed: false,
      beforeLength,
      afterLength,
      reason: '目标库 database.secret 未变化（重签未生效），请检查目标库是否可写',
    };
  }
  if (afterLength === 0) {
    return { applied: false, changed: false, beforeLength, afterLength, reason: '重签后密钥为空，判定失败' };
  }

  return { applied: true, changed: true, beforeLength, afterLength };
}

/**
 * 在目标库已成为正式库、站点对外开放之前重签签名密钥。
 * 失败必须抛出（由主流程如实回报），绝不静默当作成功。
 */
async function phaseRotateSecret({ server, instance, onProgress }) {
  const db = guardDbName(instance.dbName);
  onProgress({ phase: 'rotating-secret', percent: 82, message: '正在重签目标库签名密钥' });

  const stdin = [
    instance.pgContainer,
    instance.pgSuperUser ?? instance.dbUser,
    db,
  ].join('\n') + '\n';

  const r = await execRemote(server, buildRotateSecretScript(), { stdin, timeoutMs: 120000 });
  const parsed = parseRotateSecret(r.stdout);

  if (!parsed.applied) {
    throw new Error(`签名密钥重签失败：${parsed.reason}`);
  }
  onProgress({
    phase: 'rotating-secret',
    percent: 84,
    message: '目标库签名密钥已重签（生产库不受影响）',
  });
  return parsed;
}

// ---------- 阶段 E + F：验证与提交/回滚 ----------

async function phaseE_verify({ server, instance, baseline, onProgress }) {
  onProgress({ phase: 'starting', percent: 75, message: '等待服务就绪' });

  // 条件轮询而非固定 sleep
  for (let i = 0; i < 40; i += 1) {
    const r = await execRemote(
      server,
      `curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:8069/web/login 2>/dev/null || echo 000`,
      { timeoutMs: 20000 },
    );
    if (r.stdout.trim() === '200') break;
    await new Promise((res) => setTimeout(res, 3000));
  }

  onProgress({ phase: 'verifying', percent: 85, message: '正在验证正式环境' });
  // v0.1.27：最终验证带 finalSite（V8 正式站点检查）——恢复的终点是「站点可访问」，
  // 不是「库切换完成」。dbfilter 未生效时访客会看到库管理器，必须在提交前拦下。
  const result = await verifyInstance({ server, instance, baseline, finalSite: true });

  if (!result.ok) {
    const failed = result.results
      .filter((r) => !r.pass)
      .map((r) => `${r.id} ${r.name}`)
      .join(', ');
    throw new Error(`正式环境验证失败：${failed}`);
  }

  return { state: STATE.VERIFIED, verify: result };
}

export function buildRollbackScript() {
  return `
set -uo pipefail
read -r OC
read -r PG
read -r PG_SUPER
read -r DB
read -r OLD
read -r DATA
read -r LOOKUP_SQL
read -r TERMINATE_SQL
read -r RENAME_FAILED_SQL
read -r RENAME_BACK_SQL

# 只读探测：精确 IN 名单（dbguard 生成），绝不扫描 '<DB>%' 前缀——避免误伤其它库。
echo "===DETECT==="
DBS=\$(docker exec "\$PG" psql -U "\$PG_SUPER" -d postgres -Atc "\$LOOKUP_SQL" 2>/dev/null || echo "")
FS=\$(ls -1 "\$DATA/filestore" 2>/dev/null | grep -Fx -e "\$DB" -e "\$OLD" || echo "")
has_db=\$(echo "\$DBS" | awk -v t="\$DB" '\$0==t{print 1}')
has_old=\$(echo "\$DBS" | awk -v t="\$OLD" '\$0==t{print 1}')
fs_db=\$(echo "\$FS" | awk -v t="\$DB" '\$0==t{print 1}')
fs_old=\$(echo "\$FS" | awk -v t="\$OLD" '\$0==t{print 1}')
echo "DB: prod=\${has_db:-0} old=\${has_old:-0}"
echo "FS: prod=\${fs_db:-0} old=\${fs_old:-0}"

if [ "\${has_db:-0}" != "\${fs_db:-0}" ]; then
  echo "STATE=INCONSISTENT"
else
  echo "STATE=CONSISTENT"
fi

# 回滚：停止 → 改名 → 启动。所有 SQL 精确且由 dbguard 生成。
docker stop "\$OC" >/dev/null 2>&1 || true
docker exec "\$PG" psql -U "\$PG_SUPER" -d postgres -c "\$TERMINATE_SQL" >/dev/null 2>&1 || true

if [ "\${has_db:-0}" = "1" ] && [ "\${has_old:-0}" = "1" ]; then
  docker exec "\$PG" psql -U "\$PG_SUPER" -d postgres -c "\$RENAME_FAILED_SQL" >/dev/null 2>&1 || true
fi
if [ "\${has_old:-0}" = "1" ]; then
  docker exec "\$PG" psql -U "\$PG_SUPER" -d postgres -c "\$RENAME_BACK_SQL" >/dev/null 2>&1 || true
fi

if [ "\${fs_db:-0}" = "1" ] && [ "\${fs_old:-0}" = "1" ]; then
  mv "\$DATA/filestore/\$DB" "\$DATA/filestore/\${DB}-failed-\$(date +%s)" 2>/dev/null || true
fi
if [ "\${fs_old:-0}" = "1" ]; then
  mv "\$DATA/filestore/\$OLD" "\$DATA/filestore/\$DB" 2>/dev/null || true
fi

docker start "\$OC" >/dev/null 2>&1 || true
echo "===ROLLED_BACK==="
`;
}

async function phaseF_rollback({ server, instance, oldDb, onProgress }) {
  onProgress({ phase: 'rolling-back', percent: 90, message: '正在回滚' });

  const db = guardDbName(instance.dbName);
  const old = guardDbName(oldDb);
  const failedDb = `${db}-failed-${Date.now()}`;
  guardDbName(failedDb);

  // 安全闸门：回滚只允许触碰这三个精确库名 + 对应精确 filestore 目录。
  const allowed = [db, old, failedDb];
  assertTargetsAllowed(allowed, allowed);

  const lookupSql = buildExactLookupSql([db, old]);
  const terminateSql = buildTerminateSql([db, old]);
  const [renameFailedSql, renameBackSql] = rollbackRenameSql({ db, oldDb: old, failedDb });

  const stdin = [
    instance.odooContainer,
    instance.pgContainer,
    instance.pgSuperUser ?? instance.dbUser,
    db,
    old,
    instance.dataPath,
    lookupSql,
    terminateSql,
    renameFailedSql,
    renameBackSql,
  ].join('\n') + '\n';

  const r = await execRemote(server, buildRollbackScript(), { stdin, timeoutMs: 900000 });

  if (!r.stdout.includes('===ROLLED_BACK===')) {
    throw new Error(`回滚失败，需人工介入：${(r.stderr || r.stdout).slice(-600)}`);
  }

  return { state: STATE.ROLLED_BACK, detect: detectRollbackState(r.stdout) };
}

// ---------- 主恢复流程 ----------

/**
 * 目标库名必须明确。库名决定「覆盖哪个库」，插件绝不猜测：
 * 服务器配置的 dbName 或 odoo.conf 的 dbfilter 至少要有其一。
 */
export function requireTargetDbName(instance) {
  const raw = instance?.dbName;
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error(
      '无法确定目标数据库名：该服务器的 odoo.conf 未设置有效的 dbfilter（可能被注释或为 .*），'
      + '插件不会猜测要覆盖哪个库。请在「服务器」页把该服务器的「数据库名」填成实际库名'
      + '（例如 toogel）后重试。',
    );
  }
  return guardDbName(raw.trim());
}

/**
 * R1 状态机：安全备份 → 临时恢复 → 验证 → 停机切换 → 验证 → 提交/回滚。
 *
 * @param {object} args
 * @param {object} args.server
 * @param {object} args.instance   discover() 产出
 * @param {string} args.packagePath 本地备份包路径
 * @param {object} [args.options]
 * @param {string} [args.options.passphrase] 若包已加密需提供；未加密且未显式 allowUnencrypted 则拒绝
 * @param {boolean} [args.options.allowUnencrypted]
 * @param {object} [args.options.baseline] V1–V7 基线
 * @param {Function} [args.onProgress]
 */
export async function runRestore({
  server, instance, packagePath, options = {}, onProgress = () => {},
}) {
  // 先校验目标库名：库名决定覆盖哪个库，必须在解密/上传/动库之前就停下。
  instance = { ...instance, dbName: requireTargetDbName(instance) };

  // 签名密钥隔离：默认开启（用户裁决 2026-11-09），显式 false 才保留备份原密钥。
  const rotateSecret = options.rotateSecret !== false;

  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const baseline = options.baseline ?? {};
  const passphrase = options.passphrase;
  const allowUnencrypted = options.allowUnencrypted === true;

  let oldDb = null;
  let state = STATE.IDLE;

  // === 格式识别与解密（Task 5b Step 6 的 restore 侧接入） ===
  let uploadPath = packagePath;
  let tempDir = null;

  const format = await detectFormat(packagePath);
  if (format === 'empty') throw new Error('备份包为空文件，拒绝恢复');

  if (format === 'plain') {
    if (!allowUnencrypted) {
      throw new Error(
        '备份包未加密。默认拒绝恢复未加密包。' +
          '若确认这是可信来源的旧版备份包，请显式开启 allowUnencrypted（仅本次恢复有效）。',
      );
    }
    onProgress({ phase: 'verifying-package', percent: 2, message: '警告：使用未加密备份包（已显式授权），请确认来源可信' });
  } else {
    if (!passphrase) {
      throw new Error(`备份包为 ${format} 加密格式，必须提供解密口令`);
    }
    onProgress({ phase: 'verifying-package', percent: 1, message: '正在解密备份包' });
    tempDir = await mkdtemp(join(tmpdir(), 'odoo-restore-'));
    const decPath = join(tempDir, 'restore-package.tar');
    await decryptFile(packagePath, decPath, passphrase);
    const st = await stat(decPath);
    if (st.size === 0) throw new Error('解密产物为空，口令可能错误');
    uploadPath = decPath;
    onProgress({ phase: 'verifying-package', percent: 2, message: '解密完成' });
  }

  // === 从备份包抽取 odoo db dump（支持 Task 5 产出的外层 tar 包） ===
  // Task 5 的 runBackup 产出 {dump.zip, addons, pydeps, odoo.conf, MANIFEST} 打包的 tar。
  // v0.1.14 真机缺陷：只抽 dump.zip 会让 addons/pydeps 丢失，站点起来后模板渲染 500
  // （website.layout 引用 website.clarity_project_id → AttributeError）。因此三者一起抽。
  let addonsLocal = '';
  let pydepsLocal = '';
  let remoteAddons = '';
  let remotePydeps = '';
  const isTar = /\.tar(\.enc)?$/.test(uploadPath) || (await headIsTar(uploadPath));
  if (isTar) {
    onProgress({ phase: 'extracting', percent: 3, message: '正在从备份包抽取 dump/addons/pydeps' });
    if (!tempDir) tempDir = await mkdtemp(join(tmpdir(), 'odoo-restore-'));
    const bundle = await extractBundle(uploadPath, tempDir);
    uploadPath = bundle.dumpZip;
    addonsLocal = bundle.addons || '';
    pydepsLocal = bundle.pydeps || '';
  }

  // 上传解密后的包到远程
  onProgress({ phase: 'uploading', percent: 3, message: '正在上传备份包' });
  const remotePkg = `/tmp/restore-${ts}.zip`;
  await scpUpload(server, uploadPath, remotePkg);

  const workDir = `/tmp/restore-${ts}`;
  await execRemote(server, `mkdir -p ${workDir}`, { timeoutMs: 60000 });
  if (addonsLocal) {
    remoteAddons = basename(addonsLocal);
    await scpUpload(server, addonsLocal, `${workDir}/${remoteAddons}`);
  }
  if (pydepsLocal) {
    remotePydeps = basename(pydepsLocal);
    await scpUpload(server, pydepsLocal, `${workDir}/${remotePydeps}`);
  }

  try {
    // 阶段 A0：先部署 addons / pydeps。
    // 顺序不可颠倒：registry 加载时扫描 addons，代码不在的模块被静默跳过，
    // 直到模板渲染才 500（真机踩坑）。
    const deploy = await phaseDeployComponents({
      server,
      instance: { ...instance, pkgAddonsFile: remoteAddons, pkgPydepsFile: remotePydeps },
      workDir,
      onProgress,
    });

    // 阶段 A0b：部署完必须重启容器，否则新模块的 Python 不会被载入（真机 500 根因）。
    const restart = shouldRestartAfterDeploy(deploy)
      ? await phaseRestartOdoo({ server, instance, onProgress, deploy })
      : { restarted: false, skippedReason: '本次未部署任何 addons/pydeps，无需重启' };

    // 阶段 A
    const a = await phaseA_safetyBackup({ server, instance, ts, onProgress });
    state = a.state;

    // 阶段 B
    // v0.1.27：neutralize 是显式选项（演练场景传 true）；生产接管默认不中立化。
    // 此前 -n 写死，恢复出的「正式站」cron 全禁、SMTP 凭据被销毁、支付全停。
    const b = await phaseB_tempRestore({ server, instance, ts, pkgRemotePath: remotePkg, neutralize: options.neutralize === true, onProgress });
    state = b.state;

    // 阶段 C
    const c = await phaseC_verifyTemp({ server, instance, tmpDb: b.tmpDb, baseline, onProgress });
    state = c.state;

    // 阶段 D
    const d = await phaseD_switch({ server, instance, ts, tmpDb: b.tmpDb, onProgress });
    state = d.state;
    oldDb = d.oldDb;
    // v0.1.27：dbfilter 未生效不在这里抛（数据已恢复，回滚代价大），
    // 但必须明说；V8 正式站点检查会在最终验证兜底拦截。
    if (d.dbFilter && !d.dbFilter.applied) {
      onProgress({
        phase: 'switching',
        percent: 65,
        message: '警告：dbfilter 未能写入 odoo.conf（站点可能落到库管理器），最终验证将核查',
      });
    }

    // 阶段 D2：站点域名切换（避免与来源站点抢同一域名）。
    // 旧库为空壳时（跳过安全备份）也照常执行；失败仅记录，不回滚已成功的切换。
    let siteDomain = null;
    let domainInfo = null;
    try {
      const targetDomain = resolveTargetDomain({ server, override: options.websiteDomain });
      if (targetDomain) {
        const dp = await phaseDomainSwitch({ server, instance, domain: targetDomain, onProgress });
        if (dp?.ok && !dp.skipped) {
          siteDomain = dp.after || targetDomain;
          domainInfo = { applied: true, before: dp.before, after: dp.after, changed: dp.changed };
          onProgress({
            phase: 'domain',
            percent: 80,
            message: dp.changed
              ? `站点域名已切换：${dp.before || '(空)'} → ${dp.after}`
              : `站点域名已是 ${dp.after}，无需改动`,
          });
        } else if (dp?.skipped) {
          domainInfo = { applied: false, skipped: true, reason: dp.reason };
        } else {
          domainInfo = { applied: false, reason: dp?.reason ?? '未知原因' };
        }
      } else {
        domainInfo = { applied: false, skipped: true, reason: '服务器名不是主机名，未自动切换' };
      }
    } catch (dErr) {
      // 域名属于收尾配置：回滚会丢掉刚恢复的数据，得不偿失。
      domainInfo = { applied: false, reason: dErr?.message ?? String(dErr) };
      onProgress({ phase: 'domain', percent: 80, message: `域名切换失败（数据已恢复）：${domainInfo.reason}` });
    }

    // 阶段 D3：目标库签名密钥隔离（默认开启）。
    // 放在切换之后：此时 toogel 才是承载恢复数据的正式库；
    // 放在最终验证之前：站点对外开放前完成。
    // 失败不吞：抛出后走阶段 F 回滚，恢复结果如实反映失败。
    let secretRotation = { applied: false, skipped: true, reason: '未执行' };
    if (rotateSecret) {
      const rot = await phaseRotateSecret({ server, instance, onProgress });
      secretRotation = { applied: true, changed: rot.changed };
    } else {
      secretRotation = {
        applied: false,
        skipped: true,
        reason: '用户已关闭「恢复后重新生成数据库签名密钥」，目标库保留备份中的原密钥',
      };
      onProgress({ phase: 'rotating-secret', percent: 82, message: '已跳过签名密钥重签（保留原密钥）' });
    }

    // 阶段 E
    const e = await phaseE_verify({ server, instance, baseline, onProgress });
    state = e.state;

    onProgress({ phase: 'done', percent: 100, message: '恢复完成' });
    return {
      ok: true,
      state: STATE.COMMITTED,
      oldDb,
      safetyBackup: a.safetyBackup,
      siteDomain,
      domain: domainInfo,
      secretRotation,
      deploy,
      restart,
      dbFilter: d.dbFilter,
      verify: e.verify,
    };
  } catch (err) {
    onProgress({ phase: 'failed', percent: 100, message: `失败：${err.message}` });

    // 阶段 F：若已切换则回滚
    if (oldDb) {
      try {
        const f = await phaseF_rollback({ server, instance, oldDb, onProgress });
        return { ok: false, state: f.state, error: err.message, rolledBack: true };
      } catch (rbErr) {
        return {
          ok: false,
          state: STATE.FAILED,
          error: `${err.message}；回滚也失败：${rbErr.message}`,
          rolledBack: false,
          needsManualIntervention: true,
        };
      }
    }
    return { ok: false, state, error: err.message };
  } finally {
    if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    await execRemote(server, `rm -f "${remotePkg}"; rm -rf "${workDir}"`, { timeoutMs: 120000 }).catch(() => {});
  }
}

/**
 * 使用系统 scp 上传文件（与备份侧 scpDownload 对称，避免依赖远程侧 Python）。
 * 通过 spawn 传 argv，绝不拼接 shell 字符串。
 */
async function scpUpload(server, srcPath, dstPath) {
  // 与备份侧对称：别名机型走 <alias>:<path>，不再手工拼 user@host。
  const args = buildScpArgs(server, { direction: 'upload', remotePath: dstPath, localPath: srcPath });

  await new Promise((resolve, reject) => {
    const p = spawn('scp', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let errBuf = '';
    p.stderr.on('data', (d) => { errBuf += d.toString(); });
    p.on('error', (e) => reject(e));
    p.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`scp 上传失败 (exit ${code}): ${errBuf.slice(-300)}`));
    });
  });
}

/**
 * 从外层 tar 包抽取恢复所需的三个组件：dump.zip、addons-*.tar.zst、pydeps-*.tar.zst。
 * 使用系统 tar；只按文件名匹配，不信任包内路径。
 */
export async function extractBundle(tarPath, outDir) {
  const extractDir = join(outDir, 'bundle');
  await rm(extractDir, { recursive: true, force: true });
  await mkdir(extractDir, { recursive: true });
  await new Promise((resolve, reject) => {
    const p = spawn('tar', ['-xf', tarPath, '-C', extractDir], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let errBuf = '';
    p.stderr.on('data', (d) => { errBuf += d.toString(); });
    p.on('error', (e) => reject(e));
    p.on('close', (code) => {
      if (code !== 0) reject(new Error(`解包失败 (exit ${code}): ${errBuf.slice(-300)}`));
      else resolve();
    });
  });

  const files = await listFilesRecursive(extractDir);
  const pick = (pred) => files.find((f) => pred(basename(f))) ?? '';

  const dumpZip = pick((n) => n === 'dump.zip');
  if (!dumpZip) throw new Error('备份包内未找到 dump.zip（可能不是本插件产出的备份包）');

  return {
    dumpZip,
    addons: pick((n) => /^addons-.*\.tar\.(zst|gz)$/.test(n)),
    pydeps: pick((n) => /^pydeps-.*\.tar\.(zst|gz)$/.test(n)),
  };
}

async function listFilesRecursive(dir) {
  const { readdir } = await import('node:fs/promises');
  const out = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...await listFilesRecursive(full));
    else out.push(full);
  }
  return out;
}

/**
 * 判断文件头是否为 tar（POSIX ustar 魔数 "ustar" 在偏移 257）。
 */
export async function headIsTar(path) {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(263);
    await fh.read(buf, 0, 263, 0);
    return buf.toString('latin1', 257, 262) === 'ustar';
  } finally {
    await fh.close();
  }
}

/**
 * 从外层 tar 包中抽取 dump.zip（Task 5 备份产物）。
 * 使用系统 tar（Windows 10+ 自带），抽取到独立临时子目录，仅取 dump.zip。
 */
export async function extractDumpZip(tarPath, outDir) {
  const extractDir = join(outDir, 'bundle');
  await rm(extractDir, { recursive: true, force: true });
  await mkdir(extractDir, { recursive: true });
  await new Promise((resolve, reject) => {
    const p = spawn('tar', ['-xf', tarPath, '-C', extractDir], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let errBuf = '';
    p.stderr.on('data', (d) => { errBuf += d.toString(); });
    p.on('error', (e) => reject(e));
    p.on('close', (code) => {
      if (code !== 0) reject(new Error(`解包失败 (exit ${code}): ${errBuf.slice(-300)}`));
      else resolve();
    });
  });
  // 定位 dump.zip（包内成员可能带 ./ 前缀，故递归查找）
  const found = await findDumpZip(extractDir);
  if (!found) throw new Error('备份包内未找到 dump.zip（可能不是本插件产出的备份包）');
  await stat(found); // 校验确实存在，否则抛错
  return found;
}

async function findDumpZip(dir) {
  const { readdir } = await import('node:fs/promises');
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      const r = await findDumpZip(full);
      if (r) return r;
    } else if (e.name === 'dump.zip') {
      return full;
    }
  }
  return null;
}

