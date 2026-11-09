import { execRemote, buildScpArgs, parseScpProgress, computeTransferPercent } from './ssh.js';
import { shouldChunk, planChunks, buildManifest, DEFAULT_CHUNK_SIZE } from './chunks.js';
import { downloadAll, assemble, realScp, remoteSplitScript } from './chunk-transfer.js';
import { findResumableBackup } from './resume-plan.js';
import { createHash } from 'node:crypto';
import { encryptFile, detectFormat, isEncrypted } from './crypto.js';
import { mkdir, stat, rm, writeFile, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

/**
 * 远程备份脚本。
 *
 * 关键实测结论（2026-11-04，staging 1Panel-odoo-5td9）：
 *  1. `odoo db dump --format=zip` 默认**已包含 filestore**（1887 条 filestore/ 前缀条目），
 *     不需要单独打包 filestore 目录，也不需要拼装 zip。
 *  2. 连接参数必须写在 `db` 子命令**之后**且用 `-r/-w/--db_host/--db_port` 长参数形式：
 *     `odoo db -r U -w P --db_host H --db_port 5432 dump --format=zip DB PATH`
 *     放在 `db` 之前会被当作 server 参数，报 "no such option: --format"。
 *  3. odoo.conf 通常不含 db_host/db_user（1Panel 靠容器 env 注入），
 *     因此必须显式传参，否则会去连本地 socket 并失败。
 *
 * 参数全部经 stdin 传入，脚本内不拼接任何用户输入。
 */
function buildDumpScript() {
  return `
set -uo pipefail
read -r OC
read -r DB
read -r DB_HOST
read -r DB_PORT
read -r HOST_WD

# 数据库口令从容器自身的环境变量读取，绝不写进插件配置或备份包
DB_USER=$(docker exec "$OC" printenv USER 2>/dev/null)
DB_PASS=$(docker exec "$OC" printenv PASSWORD 2>/dev/null)
if [ -z "$DB_USER" ] || [ -z "$DB_PASS" ]; then
  echo "===ERR==="
  echo "无法从容器 $OC 读取数据库凭据（USER/PASSWORD 环境变量缺失）"
  echo "===END==="
  exit 3
fi

# 关键：odoo db dump 在容器内执行，产物必须落在容器自己的文件系统里。
# 宿主机 /tmp 对容器不可见（实测：直接 dump 到宿主机路径会 FileNotFoundError）。
# 先容器内建目录 → dump 到容器内 → docker cp 拷出到宿主机工作目录。
CINT="/tmp/odoo-dump-int-$$"
docker exec "$OC" mkdir -p "$CINT" || {
  echo "===ERR==="
  echo "容器内建临时目录失败：$CINT"
  echo "===END==="
  exit 4
}

echo "===DUMP_START==="
docker exec "$OC" odoo db \\
  -r "$DB_USER" -w "$DB_PASS" \\
  --db_host "$DB_HOST" --db_port "$DB_PORT" \\
  dump --format=zip "$DB" "$CINT/dump.zip" 2>&1 | tail -5
RC=\${PIPESTATUS[0]}

if [ "$RC" -ne 0 ]; then
  docker exec "$OC" rm -rf "$CINT" 2>/dev/null || true
  echo "===RC==="
  echo "$RC"
  echo "===END==="
  exit 0
fi

echo "===COPY==="
docker cp "$OC:$CINT/dump.zip" "$HOST_WD/dump.zip" 2>&1 | tail -3
CPRC=\${PIPESTATUS[0]}
if [ "$CPRC" -ne 0 ]; then
  docker exec "$OC" rm -rf "$CINT" 2>/dev/null || true
  echo "===ERR==="
  echo "docker cp 将 dump 拷出到宿主机失败"
  echo "===END==="
  exit 5
fi

echo "===SIZE==="
stat -c %s "$HOST_WD/dump.zip" 2>/dev/null || echo 0

echo "===SHA==="
sha256sum "$HOST_WD/dump.zip" 2>/dev/null | awk '{print $1}'

# 清理容器内临时目录（静默，不产出任何标记行）
docker exec "$OC" rm -rf "$CINT" 2>/dev/null || true

echo "===RC==="
echo "0"
echo "===END==="
`;
}

/**
 * 打包 addons 与 pydeps 的远程脚本。
 * 用 tar + zstd（有则用），输出到宿主机路径（不在容器内）。
 */
function buildPackScript() {
  return `
set -uo pipefail
read -r ADDONS
read -r PYDATA
read -r OUTDIR
read -r TS

mkdir -p "$OUTDIR"

COMP=zstd
if ! command -v zstd >/dev/null 2>&1; then COMP=gzip; fi
EXT=zst; [ "$COMP" = gzip ] && EXT=gz

echo "===COMPRESSOR==="
echo "$COMP"

echo "===PACK_ADDONS==="
if [ -d "$ADDONS" ]; then
  if [ "$COMP" = zstd ]; then
    tar -C "$ADDONS" -cf - . 2>/dev/null | zstd -3 -T0 -q -o "$OUTDIR/addons-$TS.tar.zst"
  else
    tar -C "$ADDONS" -cf - . 2>/dev/null | gzip -6 -c > "$OUTDIR/addons-$TS.tar.gz"
  fi
  echo "addons_ok"
else
  echo "addons_missing"
fi

echo "===PACK_PYDEPS==="
if [ -d "$PYDATA/.local" ]; then
  if [ "$COMP" = zstd ]; then
    tar -C "$PYDATA" --numeric-owner -cf - .local 2>/dev/null | zstd -3 -T0 -q -o "$OUTDIR/pydeps-$TS.tar.zst"
  else
    tar -C "$PYDATA" --numeric-owner -cf - .local 2>/dev/null | gzip -6 -c > "$OUTDIR/pydeps-$TS.tar.gz"
  fi
  echo "pydeps_ok"
else
  echo "pydeps_missing"
fi

echo "===CONF==="
CONF=""
for c in "$OUTDIR/../../conf/odoo.conf" /opt/1panel/apps/odoo/odoo/data/conf/odoo.conf; do
  if [ -f "$c" ]; then CONF="$c"; break; fi
done
if [ -n "$CONF" ]; then
  sed -E 's/^([[:space:]]*admin_passwd[[:space:]]*=).*/\\1 <REDACTED>/' "$CONF" \\
    > "$OUTDIR/odoo.conf"
  echo "conf_ok"
else
  echo "conf_missing"
fi

echo "===EXT==="
echo "$EXT"
echo "===END==="
`;
}

/**
 * 把远程文件下载到本地。用 scp 的 stdout 流式写入，避免中间临时文件。
 */
function scpDownload(server, remotePath, localPath, timeoutMs, onProgress = () => {}, expectedBytes = 0) {
  // 与 buildSshArgs 共用别名逻辑：sshConfigAlias 机型用 <alias>:<path>，
  // 不再手工拼 user@host（真机缺陷：别名机型 scp 阶段 Permission denied）。
  const args = buildScpArgs(server, { direction: 'download', remotePath, localPath });

  return new Promise((resolve, reject) => {
    const child = spawn('scp', args, { windowsHide: true });
    let stderr = '';
    let lastPercent = -1;
    const report = (pct) => {
      if (pct !== null && pct !== lastPercent) { lastPercent = pct; onProgress(pct); }
    };
    // 主进度源：本地文件增长轮询（scp 的 tty 进度条在 pipe stderr 下不输出）。
    const poll = expectedBytes > 0
      ? setInterval(() => {
          stat(localPath).then((s) => report(computeTransferPercent(s.size, expectedBytes))).catch(() => {});
        }, 2000)
      : null;
    poll?.unref?.();
    child.stderr.on('data', (c) => {
      const chunk = c.toString('utf8');
      if (stderr.length < 65536) stderr += chunk;
      // 增强：若 scp 恰好输出了经典进度行，也上报（与文件轮询取较新值）。
      report(parseScpProgress(chunk));
    });
    const stopPoll = () => { if (poll) clearInterval(poll); };
    const timer = timeoutMs
      ? setTimeout(() => {
          stopPoll();
          try {
            child.kill('SIGKILL');
          } catch {
            /* ignore */
          }
          reject(new Error(`下载超时（${timeoutMs} ms）`));
        }, timeoutMs)
      : null;
    timer?.unref?.();

    child.on('error', (e) => {
      stopPoll();
      if (timer) clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      stopPoll();
      if (timer) clearTimeout(timer);
      if (code === 0) { report(100); resolve({ ok: true }); }
      else reject(new Error(`scp 失败（退出码 ${code}）：${stderr.slice(-400)}`));
    });
  });
}

function section(text, name, next) {
  const re = new RegExp(`===${name}===\\n([\\s\\S]*?)(?====${next}===|$)`);
  const m = String(text).match(re);
  return m ? m[1].trim() : '';
}

function tsStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

/**
 * 执行完整备份：dump（含 filestore）→ 打包 addons/pydeps/conf → 下载 → 校验 → 加密。
 *
 * @param {object}   args
 * @param {object}   args.server      SSH 连接配置
 * @param {object}   args.instance    discover() 产出的实例
 * @param {string}   args.localDir    本机备份根目录
 * @param {string}   [args.passphrase] 加密口令（**必需**；R10 fail-closed）
 * @param {function} [args.onProgress]
 */
export async function runBackup({
  server,
  instance,
  localDir,
  passphrase,
  onProgress = () => {},
}) {
  // R10 强制加密（U4 决策：fail-closed）。
  // 门禁必须在任何远程操作之前——否则会先下载数百 MB 才失败，且留下残留文件。
  // 未配置 / 空 / 全空白 / 非字符串口令一律拒绝，绝不降级为明文。
  if (typeof passphrase !== 'string' || passphrase.trim() === '') {
    throw new Error(
      '未配置加密口令，拒绝备份（R10 强制加密）。' +
        '请先在插件设置页填写 passphrase 后重试；本插件不会生成明文备份包。',
    );
  }

  const ts = tsStamp();
  // v0.1.13 §3.5 / §10：重启后重新发起备份时，若磁盘已有可续传任务，
  // 复用其 manifest/分片目录，跳过远端「打包 + 切片」，只补下载缺失片后组装。
  // SHA-256 只保证完整性；manifest 由 Host 生成并存本机（非来源认证）。
  const resumePlan = await findResumableBackup(localDir);
  const workDir = resumePlan?.manifest?.remoteWorkDir ?? `/tmp/odoo-backup-${ts}`;

  let outer = resumePlan?.manifest?.remoteTarPath ?? `/tmp/odoo-backup-${ts}.tar`;
  let outerSize = 0;
  let outerSha = '';
  let chunkManifest = null;

  try {
    if (!resumePlan) {
    // 1) 建宿主机工作目录（dump 产物拷出后的落点）
    onProgress({ phase: 'dumping', percent: 5, message: '正在导出数据库与 filestore' });
    const mk = await execRemote(server, 'read -r D; mkdir -p "$D"; echo OK', {
      stdin: `${workDir}\n`,
      timeoutMs: 30000,
    });
    if (!mk.stdout.includes('OK')) {
      throw new Error(`无法创建远程工作目录：${(mk.stderr || mk.stdout).slice(-300)}`);
    }

    // 2) dump（容器内执行 → docker cp 拷出到宿主机工作目录）
    const dumpScript = buildDumpScript();
    const dumpRes = await execRemote(server, dumpScript, {
      stdin: [
        instance.odooContainer,
        instance.dbName,
        instance.dbHost,
        String(instance.dbPort ?? 5432),
        workDir,
      ].join('\n') + '\n',
      timeoutMs: 3600000,
    });

    if (!dumpRes.stdout.includes('===END===')) {
      throw new Error(`dump 脚本未完成：${(dumpRes.stderr || dumpRes.stdout).slice(-500)}`);
    }

    if (dumpRes.stdout.includes('===ERR===')) {
      throw new Error(section(dumpRes.stdout, 'ERR', 'END'));
    }

    const dumpRc = Number(section(dumpRes.stdout, 'RC', 'END')) || 0;
    const dumpSize = Number(section(dumpRes.stdout, 'SIZE', 'SHA')) || 0;
    const dumpSha = section(dumpRes.stdout, 'SHA', 'RC');

    if (dumpRc !== 0) {
      throw new Error(
        `odoo db dump 失败（退出码 ${dumpRc}）：` +
          `${section(dumpRes.stdout, 'DUMP_START', 'SIZE').slice(-400)}`,
      );
    }
    if (dumpSize === 0) {
      throw new Error('dump 产物为 0 字节，备份失败');
    }

    // 3) 打包 addons / pydeps / conf
    onProgress({ phase: 'packing-addons', percent: 25, message: '正在打包 addons 与运行时依赖' });
    const packRes = await execRemote(server, buildPackScript(), {
      stdin: [
        instance.addonsPath,
        instance.dataPath,
        workDir,
        ts,
      ].join('\n') + '\n',
      timeoutMs: 3600000,
    });

    if (!packRes.stdout.includes('===END===')) {
      throw new Error(`打包脚本未完成：${(packRes.stderr || packRes.stdout).slice(-500)}`);
    }

    const compressor = section(packRes.stdout, 'COMPRESSOR', 'PACK_ADDONS') || 'gzip';
    const ext = section(packRes.stdout, 'EXT', 'END') || 'gz';
    const addonsStatus = section(packRes.stdout, 'PACK_ADDONS', 'PACK_PYDEPS');
    const pydepsStatus = section(packRes.stdout, 'PACK_PYDEPS', 'CONF');
    const confStatus = section(packRes.stdout, 'CONF', 'EXT');

    // 4) 写 MANIFEST
    onProgress({ phase: 'compressing', percent: 40, message: '正在生成清单' });
    const manifest = {
      formatVersion: '2.1',
      createdAt: new Date().toISOString(),
      source: {
        server: server.name ?? server.host,
        odooContainer: instance.odooContainer,
        odooVersion: instance.odooVersion,
        imageId: instance.imageId,
        dbName: instance.dbName,
        dbHost: instance.dbHost,
        addonsPath: instance.addonsPath,
        dataPath: instance.dataPath,
      },
      dump: { file: 'dump.zip', bytes: dumpSize, sha256: dumpSha, includesFilestore: true },
      addons: { present: addonsStatus === 'addons_ok', file: `addons-${ts}.tar.${ext}` },
      pydeps: { present: pydepsStatus === 'pydeps_ok', file: `pydeps-${ts}.tar.${ext}` },
      conf: { present: confStatus === 'conf_ok', file: 'odoo.conf' },
      compressor,
    };

    const manifestB64 = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8').toString('base64');
    const writeManifest = await execRemote(
      server,
      'read -r D; read -r B; echo "$B" | base64 -d > "$D/MANIFEST.json"; echo OK',
      { stdin: `${workDir}\n${manifestB64}\n`, timeoutMs: 30000 },
    );
    if (!writeManifest.stdout.includes('OK')) {
      throw new Error('写入 MANIFEST 失败');
    }

    // 5) 外层打包（把工作目录整体打成一个 tar）
    onProgress({ phase: 'compressing', percent: 50, message: '正在打包备份单元' });
    outer = `/tmp/odoo-backup-${ts}.tar`;
    const outerRes = await execRemote(
      server,
      `read -r W; read -r O; tar -cf "$O" -C "$W" . && chmod 600 "$O" && stat -c %s "$O" && sha256sum "$O" | awk '{print $1}'; echo "===END==="`,
      { stdin: `${workDir}\n${outer}\n`, timeoutMs: 3600000 },
    );
    if (!outerRes.stdout.includes('===END===')) {
      throw new Error(`外层打包失败：${(outerRes.stderr || outerRes.stdout).slice(-400)}`);
    }
    const outerLines = outerRes.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    outerSize = Number(outerLines.find((l) => /^\d+$/.test(l))) || 0;
    outerSha = outerLines.find((l) => /^[0-9a-f]{64}$/.test(l)) ?? '';
    if (outerSize === 0) throw new Error('备份单元为 0 字节');
    } // end if (!resumePlan)：远端「建目录→dump→MANIFEST→打包」仅在新建任务时执行

    // 续传时从磁盘 manifest 恢复大小/哈希；新建任务时上面已算好
    if (resumePlan) {
      outerSize = resumePlan.manifest.totalBytes;
      outerSha = resumePlan.manifest.fullSha256;
      outer = resumePlan.manifest.remoteTarPath;
    }

    // 6) 下载：<100 MiB 走原单文件 SCP；≥100 MiB 走分片/断点续传（v0.1.13 §2.2）。
    // 两条路径最终都得到「完整明文 tar」，后续 encryptFile 时机/格式/恢复入口零改动。
    onProgress({ phase: 'transferring', percent: 60, message: '正在下载备份单元' });
    const dateDir = join(
      localDir,
      new Date().toISOString().slice(0, 10).replace(/-/g, ''),
    );
    await mkdir(dateDir, { recursive: true });

    const localTar = join(dateDir, `odoo-backup-${ts}.tar`);

    if (shouldChunk(outerSize)) {
      // ---- 大文件：远端切片 → 分片 SCP → 单片校验 → 断点续传 → 组装 → 全量 SHA ----
      const backupId = resumePlan?.backupId ?? createHash('sha256')
        .update(`${server.name ?? server.host}\u0000${outer}\u0000${outerSize}\u0000${outerSha}\u0000${ts}`)
        .digest('hex');
      const taskDir = resumePlan?.taskDir ?? join(dateDir, backupId);
      await mkdir(taskDir, { recursive: true });

      if (!resumePlan) {
      // 6a) 远端切片并取回每片 SHA（stdin 传固定路径，不拼 shell 字符串）
      const splitRes = await execRemote(server, remoteSplitScript(), {
        stdin: `${outer}\n${DEFAULT_CHUNK_SIZE}\n`, timeoutMs: 3600000,
      });
      if (!splitRes.stdout.includes('===SPLIT_END===')) {
        throw new Error(`远端切片失败：${(splitRes.stderr || splitRes.stdout).slice(-400)}`);
      }
      const partShas = splitRes.stdout.split('\n').map((s) => s.trim())
        .filter((l) => /^[0-9a-f]{64}$/.test(l));
      const plan = planChunks(outerSize, DEFAULT_CHUNK_SIZE);
      if (partShas.length !== plan.length) {
        throw new Error(`分片数不符：远端 ${partShas.length} / 计划 ${plan.length}`);
      }
      chunkManifest = buildManifest({
        backupId, createdAt: new Date().toISOString(),
        serverConfigId: server.name ?? server.host,
        remoteTarPath: outer, remoteWorkDir: workDir,
        fileName: `odoo-backup-${ts}.tar`, totalBytes: outerSize,
        fullSha256: outerSha, chunkSize: DEFAULT_CHUNK_SIZE,
        chunks: plan.map((p, i) => ({ ...p, sha256: partShas[i] })),
      });
      await writeFile(join(taskDir, 'manifest.json'), JSON.stringify(chunkManifest, null, 2));
      } else {
        // 续传：复用磁盘 manifest（结构已由 findResumableBackup 校验），不重新切片
        chunkManifest = resumePlan.manifest;
        onProgress({ phase: 'transferring', percent: 60, message: '检测到未完成任务，续传缺失分片' });
      }
      chunkManifest.__server = server;
      chunkManifest.taskDirResolved = taskDir;

      const dl = await downloadAll({
        dir: taskDir,
        manifest: chunkManifest,
        scp: ({ remotePath, localPath, onSpawn }) => realScp({ server, remotePath, localPath, onSpawn }),
        resume: true, // 逐片重新 stat+SHA 重验，只下缺失/损坏片（重启续传的关键）
        onProgress: (state) => onProgress({
          phase: 'transferring',
          percent: 60 + Math.round((state.percent ?? 0) * 0.2),
          message: `正在下载分片 ${state.chunks.filter((c) => c.status === 'verified').length}/${chunkManifest.chunkCount}`,
          chunks: state.chunks,
          downloadedBytes: state.downloadedBytes,
        }),
      });
      if (!dl.ok) throw new Error(`分片下载未完成：${dl.reason}`);
      const asm = await assemble({ dir: taskDir, manifest: chunkManifest, expectedBackupId: backupId });
      if (!asm.ok) throw new Error(`分片组装/全量校验失败，禁止进入恢复：${asm.reason}`);
      await copyFile(asm.path, localTar);
    } else {
      // ---- 小文件：原单文件 SCP（零改动） ----
      await scpDownload(server, outer, localTar, 7200000, (pct) => {
        // scp 的 0–100% 映射到任务的 transferring 阶段 60–80%，
        // 不覆盖后续 encrypting(85)/cleaning(95)/done(100)。
        onProgress({
          phase: 'transferring',
          percent: 60 + Math.round(pct * 0.2),
          message: `正在下载备份单元 ${pct}%`,
        });
      }, outerSize);
    }

    const st = await stat(localTar);
    if (st.size === 0) throw new Error('下载的备份单元为空');
    if (st.size !== outerSize) {
      throw new Error(
        `下载大小不一致：本地 ${st.size} / 远程 ${outerSize}（传输可能中断）`,
      );
    }

    // 7) 加密（R10 强制；入口门禁已保证 passphrase 有效）
    let finalPath = localTar;
    let encrypted = false;
    let finalFormat = 'plain';

    onProgress({ phase: 'encrypting', percent: 85, message: '正在加密备份单元' });
    const encPath = `${localTar}.enc`;
    await encryptFile(localTar, encPath, passphrase);

    if (!(await isEncrypted(encPath))) {
      throw new Error('加密产物格式校验失败');
    }
    finalFormat = await detectFormat(encPath);

    // 删除明文，避免明文残留
    await rm(localTar, { force: true });
    finalPath = encPath;
    encrypted = true;

    // 8) 清理远程（§13：download→校验→组装→全量 SHA→encryptFile→最终验证 全通过后）
    onProgress({ phase: 'cleaning', percent: 95, message: '清理远程临时文件' });
    await execRemote(server, 'read -r W; read -r O; rm -rf "$W"; rm -f "$O" "$O".part*; echo OK', {
      stdin: `${workDir}\n${outer}\n`,
      timeoutMs: 120000,
    });

    const finalSt = await stat(finalPath);

    // v0.1.13：分片任务成功后写完成标记，避免下次备份把已完成目录误当续传目标。
    // 仅在最终 .tar.enc 验证通过之后写入（§13 六项条件）。
    if (chunkManifest?.taskDirResolved) {
      await writeFile(join(chunkManifest.taskDirResolved, 'completed.json'), JSON.stringify({
        completed: true, backupId: chunkManifest.backupId, localPath: finalPath,
        finishedAt: new Date().toISOString(),
      })).catch(() => {});
    }

    onProgress({ phase: 'done', percent: 100, message: '备份完成' });

    return {
      ok: true,
      localPath: finalPath,
      bytes: finalSt.size,
      sha256Remote: outerSha,
      encrypted,
      format: finalFormat,
      manifest,
    };
  } catch (err) {
    // v0.1.13 §13（最小调整，记录原因）：失败/异常/重启时**保留远端 tar 与分片**
    // 供断点续传，不再提前删除；仅清理工作目录中的中间产物目录（不影响续传数据）。
    // 旧行为在 catch 里删 "$O" 会毁掉未下载完的分片来源，与数据安全约束冲突。
    try {
      await execRemote(server, 'read -r W; rm -rf "$W"/tmp 2>/dev/null; echo OK', {
        stdin: `${workDir}\n`,
        timeoutMs: 60000,
      });
    } catch {
      /* 清理失败不掩盖原始错误 */
    }
    onProgress({ phase: 'failed', percent: 100, message: `备份失败：${err.message}` });
    throw err;
  }
}
