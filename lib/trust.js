/**
 * v0.1.8 — SSH 首次主机信任的纯逻辑。
 *
 * 安全边界（用户 2026-11-07 批准）：
 *  - 主机指纹核验（服务器证明自己）与客户端公钥认证（我们证明自己）是两套独立机制
 *  - 不自动信任扫描值；必须由服务器所有者通过独立渠道回传
 *  - 不允许把扫描值直接当回传值（防 MITM 自证）
 *  - 指纹不一致 / 公钥类型不一致 / 目标身份漂移 → 一律拒绝，不写配置
 *  - 只更新 pinnedFingerprint，不覆盖 keyPath 或其他字段
 *  - 信任绑定具体 host/port/user，目标变化后旧信任失效
 *  - 本机只展示公钥；API 绝不读取、返回或记录私钥内容
 *  - 公钥安装命令幂等：不覆盖、去重、正确权限、执行后自查
 */

/** 标准化 SHA256 指纹：去前缀、去空白。 */
export function normalizeFp(fp) {
  return String(fp ?? '').trim().replace(/^SHA256:/i, '').trim();
}

/**
 * 比对「扫描值」与「所有者回传值」，同时核对公钥类型。
 * 只返回是否允许与归一化后的指纹，不产生任何副作用。
 */
export function verifyFingerprint(scan, answerType, answerFp) {
  if (!scan?.ok || !Array.isArray(scan.fingerprints)) {
    return { ok: false, reason: '扫描失败：未取得服务器主机公钥' };
  }
  const expected = normalizeFp(answerFp);
  if (!expected) return { ok: false, reason: '回传指纹为空' };

  const hit = scan.fingerprints.find((f) => normalizeFp(f.fingerprint) === expected);
  if (!hit) {
    return { ok: false, reason: '指纹不一致：所有者回传值与扫描值不匹配，可能存在中间人攻击' };
  }
  const type = String(answerType ?? '').trim();
  if (type && type !== hit.type) {
    return { ok: false, reason: `公钥类型不一致：扫描为 ${hit.type}，回传为 ${type}` };
  }
  return { ok: true, fingerprint: expected, type: hit.type };
}

/**
 * 信任确认前的最终校验。
 * 防 MITM 自证：answerFromScanResult=true 表示 UI 把扫描值直接回填，必须拒绝。
 * 防信任迁移：重新核对 host/port/user 与扫描时一致。
 */
export function confirmTrust({ server, scan, answerFp, answerType, answerFromScanResult = false }) {
  if (answerFromScanResult) {
    return { ok: false, reason: '禁止直接复制扫描值作为回传值：必须由服务器所有者通过独立可信渠道返回指纹' };
  }
  const host = scan?.host ?? server?.host;
  const port = scan?.port ?? server?.port ?? 22;
  const user = scan?.user ?? server?.user ?? 'root';
  // 重新核对 host / port / user 与扫描时一致，防止核验后服务器配置被替换。
  if (server.host !== host || Number(server.port ?? 22) !== Number(port) || String(server.user ?? '') !== String(user)) {
    return { ok: false, reason: '服务器目标已变化（host/port/user 与扫描时不一致），拒绝把信任迁移到新目标' };
  }
  if (!server.user) {
    return { ok: false, reason: '服务器用户名为空，无法确认信任绑定目标' };
  }
  const v = verifyFingerprint(scan, answerType, answerFp);
  if (!v.ok) return v;
  return { ok: true, fingerprint: v.fingerprint, type: v.type };
}

/** 只更新 pinnedFingerprint，其余字段原样保留。 */
export function applyTrust(server, fingerprint) {
  return { ...server, pinnedFingerprint: fingerprint };
}

/** 目标变化后旧信任不得继续生效。 */
export function isTrustValid(server, scan) {
  if (!server.pinnedFingerprint) return { ok: false, reason: '尚未建立信任' };
  if (server.host !== (scan?.host ?? server.host)) return { ok: false, reason: '主机地址变化，需重新核验' };
  if (Number(server.port ?? 22) !== Number(scan?.port ?? server.port ?? 22)) return { ok: false, reason: '端口变化，需重新核验' };
  const hit = (scan?.fingerprints ?? []).find((f) => normalizeFp(f.fingerprint) === normalizeFp(server.pinnedFingerprint));
  if (!hit) return { ok: false, reason: '主机指纹已变化，可能被中间人攻击或服务器重装，需重新核验' };
  return { ok: true };
}

/** 只构造 .pub 路径；绝不读取或返回私钥路径内容。 */
export function publicKeyPathOf(keyPath) {
  const k = String(keyPath ?? '').trim();
  if (!k) return null;
  return k.endsWith('.pub') ? k : `${k}.pub`;
}

/** 校验公钥文本格式；拒绝私钥内容。 */
export function validatePublicKey(text) {
  const s = String(text ?? '').trim();
  if (!s) return { ok: false, reason: '公钥为空' };
  if (/PRIVATE KEY|BEGIN OPENSSH/i.test(s)) return { ok: false, reason: '这是私钥，绝不能展示或传输' };
  if (!/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp\d+|sk-ssh-ed25519@openssh\.com)\s+[A-Za-z0-9+/=]+(\s+\S.*)?$/.test(s)) {
    return { ok: false, reason: '公钥格式无效' };
  }
  return { ok: true };
}

/** 主机所有者在服务器执行的指纹核验命令（只读，不含私钥）。 */
export function fingerprintCommand() {
  return 'ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub';
}

/**
 * 幂等的 authorized_keys 安装命令（给服务器所有者复制执行）。
 * 不覆盖、去重、权限正确、执行后自查并输出结果。
 */
export function authorizedKeysCommand(publicKey) {
  const v = validatePublicKey(publicKey);
  if (!v.ok) throw new Error(`拒绝生成安装命令：${v.reason}`);
  const line = publicKey.trim();
  return [
    'mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"',
    `grep -qF '${line}' "$HOME/.ssh/authorized_keys" 2>/dev/null || echo '${line}' >> "$HOME/.ssh/authorized_keys"`,
    'chmod 600 "$HOME/.ssh/authorized_keys"',
    `if grep -qF '${line}' "$HOME/.ssh/authorized_keys"; then echo 'PUBKEY_INSTALLED_OK'; else echo 'PUBKEY_INSTALL_FAILED'; fi`,
  ].join('\n');
}
