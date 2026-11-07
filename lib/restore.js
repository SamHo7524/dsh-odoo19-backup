import { execRemote, buildScpArgs } from './ssh.js';
import { verifyInstance } from './verify.js';
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
import { join } from 'node:path';

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

// ---------- 阶段 A：安全备份 ----------

function buildSafetyBackupScript() {
  // 注意：shell 的 ${VAR} 必须写成 \${VAR}，否则会被 JS 模板字符串当表达式解析
  return `
set -uo pipefail
read -r OC
read -r DB
read -r TS

CINT="/tmp/odoo-safety-\$\$"
docker exec "\$OC" mkdir -p "\$CINT" || { echo "MKDIR_FAIL"; exit 4; }
docker exec "\$OC" odoo db -r "\$(docker exec "\$OC" printenv USER)" -w "\$(docker exec "\$OC" printenv PASSWORD)" --db_host "\$(docker exec "\$OC" printenv HOST)" --db_port 5432 dump --format=zip "\$DB" "\$CINT/safety.zip" 2>/dev/null
RC=\${PIPESTATUS[0]}

if [ "\$RC" -ne 0 ]; then docker exec "\$OC" rm -rf "\$CINT"; echo "DUMP_FAIL"; exit 1; fi

docker cp "\$OC:\$CINT/safety.zip" "/tmp/safety-backup-\$TS.zip"
docker exec "\$OC" rm -rf "\$CINT"

echo "===SIZE==="
stat -c %s "/tmp/safety-backup-\$TS.zip" 2>/dev/null || echo 0
echo "===SHA==="
sha256sum "/tmp/safety-backup-\$TS.zip" 2>/dev/null | awk '{print \$1}'
echo "===READY==="
echo "/tmp/safety-backup-\$TS.zip"
echo "===END==="
`;
}

async function phaseA_safetyBackup({ server, instance, ts, onProgress }) {
  onProgress({ phase: 'safety-backup', percent: 5, message: '正在备份当前环境' });

  const stdin = [instance.odooContainer, instance.dbName, ts].join('\n') + '\n';
  const r = await execRemote(server, buildSafetyBackupScript(), { stdin, timeoutMs: 1800000 });

  if (r.code !== 0 || !r.stdout.includes('===READY===')) {
    throw new Error(`安全备份失败：${(r.stderr || r.stdout).slice(-400)}`);
  }

  const size = Number((r.stdout.match(/===SIZE===\n(\d+)/)?.[1] ?? '0').trim()) || 0;
  if (size === 0) throw new Error('安全备份文件为空，拒绝继续');

  const sha = r.stdout.match(/===SHA===\n([0-9a-f]{64})/)?.[1] ?? '';
  const path = r.stdout.match(/===READY===\n(\S+)/)?.[1] ?? '';

  return { state: STATE.SAFETY_BACKED_UP, safetyBackup: { path, sha256: sha, bytes: size } };
}

// ---------- 阶段 B：临时恢复 ----------

export function buildTempRestoreScript() {
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

# 恢复（容器内 load，连接参数取自容器 env，与备份一致；-n 中立化防误发信）
docker cp "\$PKG_PATH" "\$OC:/tmp/restore-pkg.zip"
LOAD_OUT=\$(docker exec "\$OC" odoo db -r "\$(docker exec "\$OC" printenv USER)" -w "\$(docker exec "\$OC" printenv PASSWORD)" --db_host "\$(docker exec "\$OC" printenv HOST)" --db_port 5432 load -n "\$TMPDB" /tmp/restore-pkg.zip 2>&1)
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

async function phaseB_tempRestore({ server, instance, ts, pkgRemotePath, onProgress }) {
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

  const r = await execRemote(server, buildTempRestoreScript(), { stdin, timeoutMs: 3600000 });

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

# D7: 确认 dbfilter 锁定唯一库（第 10 条）。
#     odoo.conf 是挂载卷（data/conf/odoo.conf → /etc/odoo/odoo.conf），改动持久生效、
#     不会因重启还原；用 docker exec -u root 写容器内路径即可。
echo "===DBFILTER==="
docker exec -u root "\$OC" sh -c "grep -q '^dbfilter' \$CONF 2>/dev/null || echo 'dbfilter = ^\${DB}\$' >> \$CONF; grep -q '^list_db' \$CONF 2>/dev/null || echo 'list_db = False' >> \$CONF"

# D8: 启动
echo "===START==="
docker start "\$OC" >/dev/null 2>&1 || true

echo "===OLDDB==="
echo "\$OLD"
echo "===END==="
`;
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
  return { state: STATE.SWITCHED, oldDb: guardDbName(resolved) };
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
  const result = await verifyInstance({ server, instance, baseline });

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
  // 恢复只需 dump.zip（由 odoo db load 加载）；若传入的是单 zip 则直接使用。
  const isTar = /\.tar(\.enc)?$/.test(uploadPath) || (await headIsTar(uploadPath));
  if (isTar) {
    onProgress({ phase: 'extracting', percent: 3, message: '正在从备份包抽取 dump.zip' });
    if (!tempDir) tempDir = await mkdtemp(join(tmpdir(), 'odoo-restore-'));
    const dumpZip = await extractDumpZip(uploadPath, tempDir);
    uploadPath = dumpZip;
  }

  // 上传解密后的包到远程
  onProgress({ phase: 'uploading', percent: 3, message: '正在上传备份包' });
  const remotePkg = `/tmp/restore-${ts}.zip`;
  await scpUpload(server, uploadPath, remotePkg);

  try {
    // 阶段 A
    const a = await phaseA_safetyBackup({ server, instance, ts, onProgress });
    state = a.state;

    // 阶段 B
    const b = await phaseB_tempRestore({ server, instance, ts, pkgRemotePath: remotePkg, onProgress });
    state = b.state;

    // 阶段 C
    const c = await phaseC_verifyTemp({ server, instance, tmpDb: b.tmpDb, baseline, onProgress });
    state = c.state;

    // 阶段 D
    const d = await phaseD_switch({ server, instance, ts, tmpDb: b.tmpDb, onProgress });
    state = d.state;
    oldDb = d.oldDb;

    // 阶段 E
    const e = await phaseE_verify({ server, instance, baseline, onProgress });
    state = e.state;

    onProgress({ phase: 'done', percent: 100, message: '恢复完成' });
    return { ok: true, state: STATE.COMMITTED, oldDb, safetyBackup: a.safetyBackup, verify: e.verify };
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
    await execRemote(server, `rm -f "${remotePkg}"`, { timeoutMs: 60000 }).catch(() => {});
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

