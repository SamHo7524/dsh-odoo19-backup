window.__ModuleLoader__.load({
  id: '@local/dsh-odoo19-backup',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useCallback, useEffect, useRef, useSyncExternalStore } = React;
    const pkgName = '@local/dsh-odoo19-backup';
    // useSyncExternalStore 要求稳定引用：这两个常量必须定义在模块级，
    // 绝不能在 getSnapshot/subscribe 里现造新对象/新函数。
    const EMPTY_SNAPSHOT = Object.freeze({});
    const NOOP_UNSUB = () => {};

    // v0.1.14：恢复包路径规范化。Client 与 Host 不能共享模块（各自独立作用域），
    // 因此这里内联一份与 lib/restore-path.js 严格同语义的实现；
    // test/restore-path-flow.test.js 的 FLOW-6 断言两端都调用同名函数，防止规则漂移。
    function normalizeRestorePath(raw) {
      let s = String(raw ?? '').trim();
      if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1);
      return s.replace(/\//g, '\\'); // 仅浏览器端（Windows 桌面）使用
    }

    // v0.1.14：恢复目标域名校验（与 lib/site-domain.js 的 isHostname 同语义）。
    const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
    function isHostname(value) {
      const s = String(value ?? '').trim();
      if (!s || s.length > 253) return false;
      if (/^(\d{1,3}\.){3}\d{1,3}$/.test(s)) return false;
      return HOSTNAME_RE.test(s);
    }

    // 只使用 cordis_inspect_query Theme.listTokens 列出的主题 token。
    // 字面颜色仅用于 artwork；UI 控件一律走 token，保证明暗主题自动适配。
    const T = {
      brand: 'var(--dsw-alias-brand-primary)',
      text: 'var(--dsw-alias-label-primary)',
      text2: 'var(--dsw-alias-label-secondary)',
      border: 'var(--dsw-alias-border-l1)',
      borderStrong: 'var(--dsw-alias-border-l2)',
      bg1: 'var(--dsw-alias-bg-layer-1)',
      bg2: 'var(--dsw-alias-bg-layer-2)',
      error: 'var(--dsw-alias-state-error-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      success: 'var(--dsw-alias-state-success-primary)',
      onBrand: 'var(--dsw-alias-bg-base)',
    };

    function Tab({ active, onClick, children }) {
      return h('button', {
        onClick,
        type: 'button',
        'aria-current': active ? 'page' : undefined,
        style: {
          padding: '8px 16px', border: 'none',
          borderBottom: active ? `2px solid ${T.brand}` : '2px solid transparent',
          background: 'transparent', color: active ? T.text : T.text2,
          cursor: 'pointer', fontSize: 14,
        },
      }, children);
    }

    function Btn({ onClick, children, tone, disabled }) {
      const danger = tone === 'danger';
      return h('button', {
        onClick, disabled, type: 'button',
        style: {
          padding: '6px 12px', cursor: disabled ? 'not-allowed' : 'pointer',
          fontSize: 13, borderRadius: 4, opacity: disabled ? 0.6 : 1,
          border: `1px solid ${danger ? T.error : T.borderStrong}`,
          background: danger ? 'transparent' : T.brand,
          color: danger ? T.error : T.onBrand,
        },
      }, children);
    }

    function Status({ text, tone }) {
      if (!text) return null;
      return h('div', {
        role: 'status',
        style: {
          marginTop: 8, fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all',
          color: tone === 'error' ? T.error : T.text2,
        },
      }, text);
    }

    /**
     * v0.1.13 真实进度条（§14.3）：宽度只由 Host 上报的 percent 驱动，
     * 不使用定时动画伪造；paused 冻结；网络中断显示「连接中断，重试中」不置 failed。
     */
    function TaskProgress({ task, netError }) {
      if (!task || !task.taskId) return null;
      const status = task.status ?? 'pending';
      const percent = Math.max(0, Math.min(100, Number(task.percent) || 0));
      const terminal = ['completed', 'failed', 'cancelled'].includes(status);
      const paused = status === 'paused';
      const label = paused ? '已暂停' : (terminal
        ? ({ completed: '已完成', failed: '失败', cancelled: '已取消' })[status]
        : (task.phaseMessage || '正在处理…'));
      const tone = status === 'failed' ? T.error : (status === 'completed' ? T.success : T.brand);
      return h('div', { style: { margin: '8px 0', padding: 10, border: `1px solid ${T.border}`, borderRadius: 6, background: T.bg2 } },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 6 } },
          h('span', null,
            `${task.kind === 'restore' ? '恢复' : '备份'} · ${label}`),
          h('span', null, `${percent}%`),
        ),
        h('div', {
          role: 'progressbar',
          'aria-valuenow': percent,
          'aria-valuemin': 0,
          'aria-valuemax': 100,
          style: { height: 8, borderRadius: 4, background: T.bg1, overflow: 'hidden', border: `1px solid ${T.border}` },
        },
          h('div', {
            style: {
              width: `${percent}%`,
              height: '100%',
              background: tone,
              transition: paused ? 'none' : 'width 0.3s linear',
            },
          }),
        ),
        netError && h(Status, { text: '连接中断，重试中（任务仍在进行，不会中断）', tone: 'warn' }),
        status === 'failed' && task.error && h(Status, { text: String(task.error), tone: 'error' }),
      );
    }

    // 真实契约（见 dsh-web-search-free / dsh-connect-workbuddy 等已工作插件）：
    //  - 配置读写走 Client 的 `configForms` 服务，按 Host 实际服务的 entry id 取 scope
    //  - scope 提供 getSnapshot()/subscribe()/set(field,value)，快照的配置值在 .value 下
    //  - 通过 slot 注册的 `inject:()=>({scope, locale})` 把服务作为 props 交给组件
    //  - 宿主并不提供 config/setConfig props；之前误用导致按钮点击调用 undefined 而无反应
    //  - 卡片注册不得依赖可选服务：服务缺失时降级显示提示，而不是整卡消失
    return {
      inject: ['slots'],
      apply(ctx) {
        // 可见文案走 Client locale 服务；回退值与 locale/zh.json 保持一致。
        const dict = {
          'tab.servers': '服务器', 'tab.backup': '备份', 'tab.restore': '恢复',
          'settings.nav': 'Odoo19 备份与恢复',
          'server.add': '添加服务器', 'server.test': '测试连接',
          'backup.start': '开始备份', 'restore.start': '执行恢复',
          'task.delete': '删除',
        };
        const locale = ctx.reflect?.get?.('locale');
        let tr;
        try { tr = locale?.bind?.('@local/dsh-odoo19-backup'); } catch (_) { tr = null; }
        const t = (k) => {
          if (tr) { try { const v = tr(k); if (v && v !== k) return v; } catch (_) { /* fallthrough */ } }
          return dict[k] ?? k;
        };

        // ---- v0.1.8 信任流程纯函数（与 lib/trust.js 同语义，前端即时反馈） ----
        const normFp = (v) => String(v ?? '').trim().replace(/^SHA256:/i, '').trim();
        const FINGERPRINT_CMD = 'ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub';
        const inputStyle = {
          display: 'block', width: '100%', boxSizing: 'border-box',
          marginBottom: 6, padding: '6px 8px', fontSize: 13,
          color: T.text, background: T.bg1,
          border: `1px solid ${T.border}`, borderRadius: 4,
        };
        // 主机身份状态与登录认证状态必须分开显示，不能混为一谈。
        const hostState = (s, scan) => {
          if (s.sshConfigAlias) return { text: '已信任（SSH 配置别名接管）', tone: 'ok' };
          if (!s.pinnedFingerprint) return { text: '等待所有者核验指纹', tone: 'warn' };
          if (scan?.fingerprints?.length
            && !scan.fingerprints.some((f) => normFp(f.fingerprint) === normFp(s.pinnedFingerprint))) {
            return { text: '主机指纹发生变化，需重新核验', tone: 'error' };
          }
          return { text: '已信任（指纹已固化）', tone: 'ok' };
        };
        const authState = (s, lastTest) => {
          if (lastTest && /err:/i.test(lastTest)) return { text: '认证失败：检查 keyPath / authorized_keys / 用户名', tone: 'error' };
          if (lastTest && /^ok:/i.test(lastTest)) return { text: '连接成功', tone: 'ok' };
          if (!s.keyPath && !s.sshConfigAlias) return { text: '未配置公钥（需设置 keyPath 或别名）', tone: 'warn' };
          return { text: '等待服务器授权公钥', tone: 'warn' };
        };

        /**
         * v0.1.8 信任主机面板。
         * 四阶段：扫描 → 展示材料/命令 → 所有者执行并回传 → 核验 → 保存。
         * 安全：不自动信任扫描值；回传值必须由用户从独立可信渠道粘贴；
         * 只有「扫描值 == 回传值 且 公钥类型一致」才启用确认按钮。
         */
        function TrustHostPanel({ server, state, patch, onScan, onLoadPubkey, onConfirm, onClose }) {
          const td = {
            padding: 12, marginTop: 8, border: `1px solid ${T.borderStrong}`,
            borderRadius: 6, background: T.bg1, fontSize: 13,
          };
          const scan = state?.scan;
          const answer = String(state?.answerFp ?? '').trim();
          const answerType = String(state?.answerType ?? '').trim();
          const scanList = scan?.fingerprints ?? [];
          const matches = scanList.some((f) => normFp(f.fingerprint) === normFp(answer))
            && (!answerType || scanList.some((f) => normFp(f.fingerprint) === normFp(answer) && f.type === answerType));
          const canConfirm = !!scan?.ok && !!answer && matches && !state?.busy;

          return h('div', { style: td },
            h('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 8 } },
              `信任主机：${server.name}（${server.user}@${server.host}:${server.port ?? 22}）`),
            h('p', { style: { color: T.text2, marginTop: 0 } },
              '这是两件独立的事：① 主机指纹 = 服务器证明自己是谁；② 公钥认证 = 服务器允许本插件登录。请让服务器所有者分别完成。'),

            // 阶段 1：扫描
            h('div', { style: { marginBottom: 8 } },
              h(Btn, { disabled: !!state?.busy, onClick: onScan }, state?.busy ? '…' : '重新扫描'),
              h('span', { style: { marginLeft: 8, color: T.text2 } },
                scan?.ok ? `扫描到 ${scanList.length} 个主机公钥` : (scan ? `扫描失败：${scan.error?.message ?? '未知'}` : '尚未扫描')),
            ),
            scan?.ok && h('pre', {
              style: { whiteSpace: 'pre-wrap', wordBreak: 'break-all', background: T.bg2, padding: 8, borderRadius: 4, margin: '4px 0 8px' },
            }, scanList.map((f) => `${f.type} ${f.fingerprint}`).join('\n')),

            // 阶段 2：给服务器所有者的材料（授权本插件登录）
            h('div', { style: { marginBottom: 6, fontWeight: 600 } }, '第 1 步 · 请服务器所有者授权本插件登录（客户端公钥认证）'),
            h('p', { style: { color: T.text2, marginTop: 0 } },
              '两个方向的公钥不要混淆：上面的扫描值是「服务器主机公钥」（服务器证明自己是谁）；' +
              '这里要发给所有者的是「本插件客户端公钥」（我们证明自己有私钥），两者方向相反、不是同一个东西。'),
            // 文件浏览器选择私钥：只取路径，绝不读取/上传私钥内容。
            // 桌面端用官方桥 __DSH_HOST_PATHS__.pathFor(file) 拿真实绝对路径
            // （Electron webUtils.getPathForFile）；浏览器环境只给 C:\fakepath\，
            // 无法拿真实路径时降级为手动输入。
            h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 } },
              h('input', {
                type: 'file',
                accept: '.pem,.key,.ppk,*',
                'aria-label': '选择本机私钥文件',
                'data-trust-file-input': server.name,
                style: { display: 'none' },
                onChange: (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  let realPath = '';
                  try {
                    const bridge = globalThis.__DSH_HOST_PATHS__;
                    if (bridge && typeof bridge.pathFor === 'function') realPath = bridge.pathFor(file);
                  } catch (_) { realPath = ''; }
                  if (!realPath) {
                    // 浏览器环境拿不到真实绝对路径：给出可操作降级，不静默失败
                    patch({
                      keyPath: '', pubkey: '', installCmd: '',
                      manualKeyPath: true,
                      pubkeyErr: '浏览器环境无法获取文件真实路径，请点「手动输入路径」填写；' +
                        '或在 DSH 桌面端使用「选择私钥文件」。',
                    });
                    return;
                  }
                  patch({ keyPath: realPath, pubkey: '', installCmd: '', pubkeyErr: '', manualKeyPath: false });
                },
              }),
              h(Btn, {
                disabled: !!state?.busy,
                onClick: () => {
                  // 精确定位本面板的 file input，避免多台服务器展开时选错
                  let el = null;
                  if (typeof document !== 'undefined') {
                    const all = document.querySelectorAll('input[data-trust-file-input]');
                    for (const input of all) {
                      if (input.getAttribute('data-trust-file-input') === server.name) { el = input; break; }
                    }
                  }
                  if (el) el.click();
                },
              }, '选择私钥文件'),
              h('span', { style: { color: T.text2, fontSize: 12 } },
                state?.keyPath ? `已选择：${state.keyPath}` : '尚未选择私钥文件'),
              h(Btn, {
                onClick: () => patch({ manualKeyPath: !state?.manualKeyPath }),
              }, '手动输入路径'),
            ),
            // 只读路径显示（文件浏览器选择后的结果，不可直接编辑）
            h('input', {
              value: state?.keyPath ?? '',
              placeholder: '通过「选择私钥文件」自动填入，无需自己输入',
              'aria-label': '本机私钥路径',
              readOnly: true,
              style: { ...inputStyle, opacity: 0.85, cursor: 'default' },
            }),
            // 降级：浏览器环境或用户主动切换时允许手动输入
            state?.manualKeyPath && h('input', {
              value: state?.manualKeyPathValue ?? '',
              placeholder: '手动输入本机私钥路径（仅在文件选择不可用时使用）',
              'aria-label': '手动输入本机私钥路径',
              onChange: (e) => patch({ manualKeyPathValue: e.target.value }),
              style: inputStyle,
            }),
            state?.manualKeyPath && h(Btn, {
              onClick: () => {
                const v = (state?.manualKeyPathValue ?? '').trim();
                if (!v) { patch({ pubkeyErr: '请填写私钥路径' }); return; }
                patch({ keyPath: v, pubkey: '', installCmd: '', pubkeyErr: '' });
              },
            }, '使用此路径'),
            h('p', { style: { color: T.text2, fontSize: 12, marginTop: 0 } },
              '选择私钥文件后，插件只读取同名 .pub 公钥展示给你；私钥内容绝不读取、绝不上传、绝不出现在任何接口响应里。'),
            h(Btn, { disabled: !!state?.busy, onClick: onLoadPubkey }, '读取本机公钥'),
            !state?.keyPath && !state?.pubkey && !state?.manualKeyPath && h(Status, {
              text: '请先点「选择私钥文件」用文件浏览器选择本机私钥，再点「读取本机公钥」；无需自己输入路径。', tone: 'warn',
            }),
            state?.pubkey && h('pre', {
              style: { whiteSpace: 'pre-wrap', wordBreak: 'break-all', background: T.bg2, padding: 8, borderRadius: 4, margin: '6px 0' },
            }, state.pubkey),
            state?.pubkeyErr && h(Status, { text: state.pubkeyErr, tone: 'error' }),
            state?.pubkey && h('pre', {
              style: { whiteSpace: 'pre-wrap', wordBreak: 'break-all', background: T.bg2, padding: 8, borderRadius: 4, margin: '6px 0' },
            }, state.installCmd || ''),

            // 阶段 3：所有者回传指纹
            h('div', { style: { margin: '10px 0 6px', fontWeight: 600 } }, '第 2 步 · 请服务器所有者核实服务器身份并回传指纹'),
            h('p', { style: { color: T.text2, marginTop: 0 } },
              '所有者在服务器上执行下面命令，把完整输出通过独立可信渠道发回给你（不要直接复制上面的扫描值）：'),
            h('pre', { style: { background: T.bg2, padding: 8, borderRadius: 4, margin: '4px 0 8px' } }, FINGERPRINT_CMD),
            h('input', {
              value: state?.answerFp ?? '', placeholder: '粘贴服务器所有者回传的 SHA256:... 值（不要复制扫描结果）',
              'aria-label': '服务器所有者回传的指纹',
              onChange: (e) => patch({ answerFp: e.target.value }), style: inputStyle,
            }),
            h('input', {
              value: state?.answerType ?? '', placeholder: '公钥类型（如 ssh-ed25519，与扫描结果核对）',
              'aria-label': '回传公钥类型',
              onChange: (e) => patch({ answerType: e.target.value }), style: inputStyle,
            }),
            !canConfirm && answer && h(Status, {
              text: '回传值与扫描值或公钥类型不一致，禁止确认信任（防中间人攻击）', tone: 'error',
            }),

            // 阶段 4：确认
            h('div', { style: { display: 'flex', gap: 8, marginTop: 6 } },
              h(Btn, { disabled: !canConfirm, onClick: onConfirm }, '确认信任并保存'),
              h(Btn, { onClick: onClose }, '关闭'),
            ),
            h('p', { style: { color: T.text2, fontSize: 12, marginBottom: 0 } },
              '确认只写入主机指纹，不会改动私钥路径或服务器其他配置；随后请点「测试连接」验证登录认证。'),
          );
        }

        // v0.1.14 UI 宿主迁移：设置页导航图标（settings.section.icon 组件收 { size }）。
        // 壳层对未注册图标的栏目只渲染默认齿轮，这里给一个数据库轮廓图标。
        function OdooNavIcon({ size = 16 }) {
          return h('svg', {
            width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
            stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round',
            strokeLinejoin: 'round', 'aria-hidden': true, focusable: 'false',
          },
          h('ellipse', { cx: 8, cy: 4, rx: 5.2, ry: 2.1 }),
          h('path', { d: 'M2.8 4v8c0 1.16 2.33 2.1 5.2 2.1s5.2-.94 5.2-2.1V4' }),
          h('path', { d: 'M2.8 8c0 1.16 2.33 2.1 5.2 2.1s5.2-.94 5.2-2.1' }));
        }

        function OdooBackupPanel({ scope }) {
          const [tab, setTab] = useState('servers');
          const [status, setStatus] = useState({});
          const [busy, setBusy] = useState({});
          const [saveErr, setSaveErr] = useState('');
          // 「添加服务器」走内联表单：Electron 不实现 window.prompt。
          const [adding, setAdding] = useState(false);
          const [draft, setDraft] = useState({
            name: '', host: '', user: 'root', keyPath: '',
            sshConfigAlias: '', pinnedFingerprint: '', dbName: '',
          });
          // v0.1.8：编辑已有服务器（null = 新增，name = 正在编辑的服务器）
          const [editingName, setEditingName] = useState(null);
          // v0.1.8：信任面板状态，按服务器名隔离
          // { scan, answerFp, answerType, pubkey, pubkeyErr, expected:{host,port,user}, phase }
          const [trust, setTrust] = useState({});
          const [restorePath, setRestorePath] = useState({}); // 恢复包路径：同样不用 window.prompt（Electron 不实现）。
          // v0.1.14：恢复目标域名（留空=自动用服务器名）；只存 Host 配置，不落浏览器存储。
          const [domainState, setDomainState] = useState({ loaded: false, value: '', input: '', busy: false, err: '', ok: '' });
          // v0.1.14：恢复后重签目标库签名密钥。默认开启；取消勾选则保留备份中的原密钥。
          const [rotateSecret, setRotateSecret] = useState(true);
          const loadRestoreDomain = useCallback(async () => {
            try {
              const r = await fetch('/odoo-backup/restore-domain');
              const d = await r.json().catch(() => ({}));
              setDomainState((s) => ({ ...s, loaded: true, value: d?.domain ?? '', err: d?.ok === false ? (d?.error ?? '') : '' }));
            } catch (e) { setDomainState((s) => ({ ...s, loaded: true, err: String(e?.message ?? e) })); }
          }, []);
          const saveRestoreDomain = useCallback(async () => {
            const v = String(domainState.input ?? '').trim();
            if (v && !isHostname(v)) {
              setDomainState((s) => ({ ...s, err: '域名不合法：只接受形如 odoo.example.com 的主机名（留空表示自动用服务器名）', ok: '' }));
              return;
            }
            setDomainState((s) => ({ ...s, busy: true, err: '', ok: '' }));
            try {
              const r = await fetch('/odoo-backup/restore-domain', {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ domain: v }),
              });
              const d = await r.json().catch(() => ({}));
              if (!(r.ok && d?.ok)) throw new Error(d?.error ?? `HTTP ${r.status}`);
              setDomainState((s) => ({
                ...s, busy: false, value: d.domain ?? '', input: '',
                ok: d.mode === 'auto' ? '已保存：留空（自动用服务器名）' : `已保存：${d.domain}`,
              }));
            } catch (e) {
              setDomainState((s) => ({ ...s, busy: false, err: `保存失败：${e?.message ?? String(e)}` }));
            }
          }, [domainState.input]);
          useEffect(() => { loadRestoreDomain(); }, [loadRestoreDomain]);
          // v0.1.11：备份加密口令（存官方 Credentials，不进插件配置）。
          // 状态只含 configured；口令值只在输入框里，保存成功后立即清空。
          const [passState, setPassState] = useState({ loaded: false, configured: false, input: '', busy: false, err: '', ok: '' });
          const loadPassStatus = useCallback(async (api) => {
            try {
              const { configured } = await api('/passphrase-status');
              setPassState((s) => ({ ...s, loaded: true, configured: Boolean(configured), err: '' }));
            } catch (e) {
              setPassState((s) => ({ ...s, loaded: true, err: e?.message ?? String(e) }));
            }
          }, []);
          // 首次挂载加载口令状态（真实 React 的 useEffect；测试替身 stub 为空）。
          useEffect(() => {
            let alive = true;
            fetch('/odoo-backup/passphrase-status')
              .then((r) => r.json().catch(() => ({})))
              .then((d) => { if (alive) setPassState((s) => ({ ...s, loaded: true, configured: Boolean(d?.configured) })); })
              .catch(() => { if (alive) setPassState((s) => ({ ...s, loaded: true })); });
            return () => { alive = false; };
          }, []);

          // v0.1.13：Host 任务状态轮询（§6.3 统一状态源 / §14.3 轮询可靠性）。
          // 磁盘 /status 是唯一真相源；按 taskId 丢弃旧响应；kind 隔离备份/恢复。
          // v0.1.17 修复（用户裁决 §二）：
          //  ① 移除「终态停表」——磁盘会残留上次终态，旧实现第一次轮询读到
          //    completed 就 clearInterval，导致下一次任务的进度永远刷不出来
          //    （症状：点开始备份无进度条，退出设置页重进才有）。轮询只在
          //    组件卸载时清理；1.5s 本地请求成本极低且天然自愈。
          //  ② 不同 taskId 的接管不再被旧终态阻挡：新任务按 updatedAt 判定
          //    新旧后接管；时间戳缺失/无效时保守采用「请求序号新」的数据，
          //    绝不用旧终态无限期压住新任务。
          //  ③ 请求序号防乱序：慢的旧 fetch 晚返回时不得覆盖已确认的新数据。
          const [hostTask, setHostTask] = useState(null);
          const [netError, setNetError] = useState(false);
          const [serverLock, setServerLock] = useState({ locked: false });
          const pollSeq = useRef(0); // 单调递增请求序号：只有最新一次请求允许落状态
          const terminal = ['completed', 'failed', 'cancelled'];
          const poll = useCallback(async () => {
            const seq = ++pollSeq.current;
            try {
              const [sr, lr] = await Promise.all([
                fetch('/odoo-backup/status').then((r) => r.json().catch(() => ({}))),
                fetch('/odoo-backup/task-lock').then((r) => r.json().catch(() => ({}))).catch(() => ({})),
              ]);
              if (seq !== pollSeq.current) return; // 已有更新的请求发出：本次作废
              setNetError(false);
              const data = sr?.result ?? sr ?? {};
              if (data.taskId) {
                setHostTask((prev) => {
                  if (!prev || prev.taskId === data.taskId) return { ...data };
                  // 不同 taskId：按可解析的 updatedAt 判新旧；都不可解析时，
                  // 本次轮询是「更晚发起的请求」，其数据必然不早于已有状态 → 接管。
                  const a = Date.parse(prev.updatedAt);
                  const b = Date.parse(data.updatedAt);
                  const prevTs = Number.isFinite(a) ? a : null;
                  const nowTs = Number.isFinite(b) ? b : null;
                  if (prevTs !== null && nowTs !== null) return nowTs >= prevTs ? { ...data } : prev;
                  return { ...data };
                });
              }
              setServerLock({ locked: Boolean(lr?.result?.locked ?? lr?.locked), kind: lr?.result?.kind ?? lr?.kind ?? null });
            } catch {
              if (seq === pollSeq.current) setNetError(true); // 网络暂时中断 ≠ 任务失败：保留上次真实进度
            }
          }, []);
          useEffect(() => {
            let alive = true;
            const timer = setInterval(() => { if (alive) poll(); }, 1500);
            poll();
            return () => { alive = false; clearInterval(timer); };
          }, [poll]);
          // v0.1.13 §3.1：本地备份目录显示/修改/验证（Host 持久化，状态不存浏览器）
          const [dirState, setDirState] = useState({ loaded: false, path: '', fullPath: '', writable: false, editing: false, input: '', busy: false, err: '', ok: '' });
          const loadDir = useCallback(async () => {
            try {
              const r = await fetch('/odoo-backup/backup-directory');
              const d = await r.json().catch(() => ({}));
              setDirState((s) => ({ ...s, loaded: true, path: d?.path ?? '', fullPath: d?.fullPath ?? '', writable: Boolean(d?.writable), err: d?.ok === false ? (d?.error ?? '') : '' }));
            } catch (e) { setDirState((s) => ({ ...s, loaded: true, err: String(e?.message ?? e) })); }
          }, []);
          const saveDir = useCallback(async () => {
            const next = dirState.input.trim();
            setDirState((s) => ({ ...s, busy: true, err: '', ok: '' }));
            try {
              const r = await fetch('/odoo-backup/backup-directory', {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ path: next }),
              });
              const d = await r.json().catch(() => ({}));
              if (!(r.ok && d?.ok)) throw new Error(d?.error ?? `HTTP ${r.status}`);
              setDirState((s) => ({ ...s, busy: false, path: next, fullPath: d.fullPath ?? next, writable: true, editing: false, input: '', ok: '目录已验证并保存（只影响新建任务）' }));
            } catch (e) { setDirState((s) => ({ ...s, busy: false, err: `目录保存失败：${e?.message ?? String(e)}` })); }
          }, [dirState.input]);
          useEffect(() => { loadDir(); }, [loadDir]);
          const taskLocked = Boolean(serverLock?.locked);
          const busyHint = taskLocked
            ? `服务器正在执行${serverLock.kind === 'restore' ? '恢复' : '备份'}任务，已阻止并发操作`
            : '';

          // 配置服务缺席（或不可用）时，首次渲染就给出可见提示，绝不静默空白。
          const scopeReady = !!(scope && typeof scope.getSnapshot === 'function' && typeof scope.set === 'function');
          const notReady = '配置服务未就绪：无法读取或保存服务器配置。请确认 DSH 已启用「设置」服务后刷新页面。';

          // 订阅配置快照，scope.set 后会重新渲染。
          // 关键：React 的 useSyncExternalStore 硬要求 getSnapshot 返回**稳定引用**，
          // 否则抛 "The result of getSnapshot should be cached to avoid an infinite loop"
          // 让组件崩溃，被插件页错误边界吞掉后卡片区域整块空白
          // （2026-11-06 真机症状：连「未就绪」提示都不出现）。
          // 因此无 scope / 无快照时必须返回同一个常量对象，不能现造 {}。
          const snapshot = useSyncExternalStore(
            useCallback((listener) => (scope?.subscribe ? scope.subscribe(listener) : NOOP_UNSUB), [scope]),
            useCallback(() => (scope?.getSnapshot ? scope.getSnapshot() : EMPTY_SNAPSHOT), [scope]),
          );
          // ConfigFormController.getSnapshot() 返回 { status, value, base, user, ... }，
          // 用户配置在 .value 下；兼容直接给出 value 形态的测试作用域。
          const config = snapshot?.value ?? snapshot ?? {};
          const servers = Array.isArray(config.servers) ? config.servers : [];

          // 保存服务器：优先走 Host 路由（Host 有官方 settings.update，
          // 不依赖前端 configForms 的 namespace 猜测）；scope 可用时同步一份。
          const saveServers = useCallback(async (next) => {
            setSaveErr('');
            let saved = false;
            let hostErr = '';
            try {
              const res = await fetch('/odoo-backup/save-servers', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ servers: next }),
              });
              const data = await res.json().catch(() => ({}));
              if (res.ok && data?.ok) saved = true;
              else hostErr = data?.error ?? `HTTP ${res.status}`;
            } catch (e) {
              hostErr = e?.message ?? String(e);
            }
            // 兜底：Host 路由失败时，若 configForms 可用则再用它写一次。
            if (!saved && scope?.set) {
              try { await scope.set('servers', next); saved = true; } catch (e) {
                hostErr = `${hostErr || ''} / ${e?.message ?? String(e)}`.trim();
              }
            }
            if (!saved) {
              setSaveErr(`保存失败：${hostErr || '未知原因'}`);
            }
          }, [scope]);

          const setOne = useCallback((name, text) => {
            setStatus((s) => ({ ...s, [name]: text }));
          }, []);

          // 动作走 Host 的 /odoo-backup/* JSON 接口（与 Agent 工具共用同一 service 与 tokenStore，
          // 因此授权语义完全一致）。
          const api = useCallback(async (route, body) => {
            const res = await fetch(`/odoo-backup${route}`, {
              method: body === undefined ? 'GET' : 'POST',
              headers: { 'content-type': 'application/json' },
              body: body === undefined ? undefined : JSON.stringify(body),
            });
            const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
            if (!data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
            return data;
          }, []);

          const call = useCallback(async (name, fn) => {
            setBusy((b) => ({ ...b, [name]: true }));
            try {
              await fn(api);
            } catch (e) {
              setOne(name, `失败：${e?.message ?? String(e)}`);
            } finally {
              setBusy((b) => ({ ...b, [name]: false }));
            }
          }, [api, setOne]);

          // ---- v0.1.14 收尾：中立化状态（按服务器名隔离，不用 window.confirm） ----
          const [neuState, setNeuState] = useState({});
          const setNeu = useCallback((name, patch) => {
            setNeuState((m) => ({ ...m, [name]: { ...(m[name] ?? {}), ...patch } }));
          }, []);
          const loadNeuStatus = useCallback(async (name) => {
            setNeu(name, { busy: true, err: '', okText: '' });
            try {
              const d = await api('/neutralize-status', { server: name });
              setNeu(name, { busy: false, loaded: true, status: d, err: '' });
            } catch (e) {
              setNeu(name, { busy: false, loaded: true, err: `读取中立化状态失败：${e?.message ?? String(e)}` });
            }
          }, [api, setNeu]);
          const keepNeutralize = useCallback(async (name) => {
            setNeu(name, { busy: true, err: '', okText: '', result: null, warnings: null, confirmToken: null });
            try {
              const d = await api('/neutralize-apply', { server: name, action: 'keep' });
              setNeu(name, {
                busy: false, result: d.result,
                okText: d.result?.reason ?? '已保持中立化（未改动目标库）',
              });
            } catch (e) {
              setNeu(name, { busy: false, err: `保持失败：${e?.message ?? String(e)}` });
            }
          }, [api, setNeu]);
          const precheckRelease = useCallback(async (name) => {
            setNeu(name, { busy: true, err: '', okText: '', result: null });
            try {
              const d = await api('/neutralize-precheck', { server: name, action: 'release' });
              if (d.alreadyReleased) {
                setNeu(name, {
                  busy: false, warnings: null, confirmToken: null,
                  okText: '目标库当前未处于中立化状态，无需解除。',
                });
                return;
              }
              setNeu(name, {
                busy: false, warnings: d.warnings ?? [],
                confirmToken: d.confirmToken, status: d.status ?? null,
              });
            } catch (e) {
              setNeu(name, { busy: false, err: `预检失败：${e?.message ?? String(e)}` });
            }
          }, [api, setNeu]);
          const confirmRelease = useCallback(async (name) => {
            const st = neuState[name] ?? {};
            if (!st.confirmToken) { setNeu(name, { err: '缺少确认令牌，请重新预检' }); return; }
            setNeu(name, { busy: true, err: '', okText: '' });
            try {
              const codes = String(st.codes ?? '').split(',').map((x) => x.trim()).filter(Boolean);
              const d = await api('/neutralize-apply', {
                server: name,
                action: 'release',
                confirmToken: st.confirmToken,
                enablePaymentCodes: codes,
              });
              setNeu(name, {
                busy: false, confirmToken: null, warnings: null,
                result: d.result, okText: '已解除中立化', loaded: false,
              });
            } catch (e) {
              setNeu(name, { busy: false, err: `解除失败：${e?.message ?? String(e)}` });
            }
          }, [api, neuState, setNeu]);
          // 服务器列表就绪后自动读取一次中立化状态（测试替身的 useEffect 为空实现）。
          useEffect(() => {
            for (const s of servers) loadNeuStatus(s.name);
            // eslint-disable-next-line react-hooks/exhaustive-deps
          }, [servers.map((s) => s.name).join(',')]);

          // ---- v0.1.11 加密口令（官方 Credentials；保存成功才清空输入，失败保留） ----
          const setPassphrase = useCallback(async () => {
            const value = passState.input;
            setPassState((s) => ({ ...s, busy: true, err: '', ok: '' }));
            try {
              const res = await fetch('/odoo-backup/set-passphrase', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ passphrase: value }),
              });
              const data = await res.json().catch(() => ({}));
              if (!(res.ok && data?.ok)) throw new Error(data?.error ?? `HTTP ${res.status}`);
              // 用户修正 3：set 成功后才清空输入；失败保留输入并显示错误。
              setPassState((s) => ({ ...s, busy: false, configured: true, input: '', ok: '口令已保存到 DSH 凭证库。请离线妥善保管：丢失后历史加密备份将无法解密。' }));
            } catch (e) {
              setPassState((s) => ({ ...s, busy: false, err: `保存失败：${e?.message ?? String(e)}` }));
            }
          }, [passState.input]);

          const unsetPassphrase = useCallback(async () => {
            setPassState((s) => ({ ...s, busy: true, err: '', ok: '' }));
            try {
              const res = await fetch('/odoo-backup/unset-passphrase', { method: 'POST' });
              const data = await res.json().catch(() => ({}));
              if (!(res.ok && data?.ok)) throw new Error(data?.error ?? `HTTP ${res.status}`);
              // 用户修正 4：unset 成功后以重新读取的状态为准。
              const st = await fetch('/odoo-backup/passphrase-status');
              const sd = await st.json().catch(() => ({}));
              setPassState((s) => ({ ...s, busy: false, configured: Boolean(sd?.configured), ok: '口令已从凭证库移除。' }));
            } catch (e) {
              setPassState((s) => ({ ...s, busy: false, err: `清除失败：${e?.message ?? String(e)}` }));
            }
          }, []);

          // ---- v0.1.8 信任面板回调（全部走既有 /odoo-backup/* 路由） ----
          const patchTrust = (name, delta) =>
            setTrust((m) => ({ ...m, [name]: { ...(m[name] ?? {}), ...delta } }));

          const doScan = (s) => call(s.name, async (api) => {
            patchTrust(s.name, { busy: true });
            try {
              const { result } = await api('/fingerprint', { server: s.name });
              patchTrust(s.name, {
                scan: result,
                expected: { host: s.host, port: s.port ?? 22, user: s.user ?? 'root' },
              });
            } finally { patchTrust(s.name, { busy: false }); }
          });

          const doLoadPubkey = (s) => call(s.name, async (api) => {
            const st = trust[s.name] ?? {};
            // 优先用信任面板里填写的 keyPath；未填则内联提示，不调用 API。
            const keyPath = (st.keyPath ?? s.keyPath ?? '').trim();
            if (!keyPath) {
              patchTrust(s.name, {
                pubkeyErr: '请先点「选择私钥文件」用文件浏览器选择本机私钥；若环境不支持文件选择，请点「手动输入路径」。',
              });
              return;
            }
            patchTrust(s.name, { busy: true, pubkeyErr: '' });
            try {
              const { publicKey } = await api('/client-pubkey', { keyPath });
              const line = publicKey.trim();
              const installCmd = [
                'mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"',
                `grep -qF '${line}' "$HOME/.ssh/authorized_keys" 2>/dev/null || echo '${line}' >> "$HOME/.ssh/authorized_keys"`,
                'chmod 600 "$HOME/.ssh/authorized_keys"',
                `if grep -qF '${line}' "$HOME/.ssh/authorized_keys"; then echo 'PUBKEY_INSTALLED_OK'; else echo 'PUBKEY_INSTALL_FAILED'; fi`,
              ].join('\n');
              patchTrust(s.name, { pubkey: line, installCmd });
            } catch (e) {
              patchTrust(s.name, { pubkeyErr: `读取公钥失败：${e?.message ?? String(e)}（请检查上方私钥路径是否正确、且存在同名 .pub 文件）` });
            } finally { patchTrust(s.name, { busy: false }); }
          });

          const doConfirmTrust = (s) => call(s.name, async (api) => {
            const st = trust[s.name] ?? {};
            patchTrust(s.name, { busy: true });
            try {
              const { result } = await api('/trust-host', {
                server: s.name,
                answerFingerprint: st.answerFp,
                answerType: st.answerType,
                expectedHost: st.expected?.host,
                expectedPort: st.expected?.port,
                expectedUser: st.expected?.user,
              });
              patchTrust(s.name, { open: false });
              setOne(s.name, `主机身份已确认并保存（${result?.servers?.length ?? 0} 台服务器配置保持）。请点「测试连接」验证登录认证。`);
            } finally { patchTrust(s.name, { busy: false }); }
          });

          return h('div', { style: { padding: 16, fontFamily: 'inherit', color: T.text } },
            h('h2', { style: { margin: '0 0 4px', fontSize: 18 } }, 'dsh-odoo19-backup'),
            h('p', { style: { margin: '0 0 16px', color: T.text2, fontSize: 13 } },
              '远程备份 Odoo 19（数据库 + filestore + addons + 依赖 + 配置）并安全恢复。'),
            !scopeReady && h(Status, { text: notReady, tone: 'error' }),
            saveErr ? h(Status, { text: saveErr, tone: 'error' }) : null,

            h('div', { style: { display: 'flex', gap: 4, borderBottom: `1px solid ${T.border}`, marginBottom: 16 } },
              h(Tab, { active: tab === 'servers', onClick: () => setTab('servers') }, t('tab.servers')),
              h(Tab, { active: tab === 'backup', onClick: () => setTab('backup') }, t('tab.backup')),
              h(Tab, { active: tab === 'restore', onClick: () => setTab('restore') }, t('tab.restore')),
            ),

            // ---- 服务器 tab ----
            tab === 'servers' && h('div', null,
              // 不能用 window.prompt：Electron 不实现它（恒返回 null），
              // 点了会静默无反应。改为内联表单。
              !adding && h(Btn, {
                onClick: () => {
                  setEditingName(null);
                  setDraft({ name: '', host: '', user: 'root', keyPath: '', sshConfigAlias: '', pinnedFingerprint: '', dbName: '' });
                  setAdding(true); setSaveErr('');
                },
              }, t('server.add')),
              adding && h('div', {
                style: {
                  padding: 12, marginBottom: 12, border: `1px solid ${T.borderStrong}`,
                  borderRadius: 6, background: T.bg2,
                },
              },
                h('div', { style: { fontSize: 13, marginBottom: 8 } },
                  editingName ? `编辑服务器：${editingName}` : '新增服务器'),
                h('input', {
                  value: draft.name, placeholder: '服务器名称（唯一）', 'aria-label': '服务器名称',
                  onChange: (e) => setDraft({ ...draft, name: e.target.value }),
                  style: inputStyle,
                }),
                h('input', {
                  value: draft.host, placeholder: '主机地址', 'aria-label': '主机地址',
                  onChange: (e) => setDraft({ ...draft, host: e.target.value }),
                  style: inputStyle,
                }),
                h('input', {
                  value: draft.user, placeholder: '用户名', 'aria-label': '用户名',
                  onChange: (e) => setDraft({ ...draft, user: e.target.value }),
                  style: inputStyle,
                }),
                h('input', {
                  value: draft.keyPath, placeholder: '私钥路径（可留空）', 'aria-label': '私钥路径',
                  onChange: (e) => setDraft({ ...draft, keyPath: e.target.value }),
                  style: inputStyle,
                }),
                h('input', {
                  value: draft.sshConfigAlias,
                  placeholder: 'SSH 配置别名（~/.ssh/config 里的 Host，可留空）',
                  'aria-label': 'SSH 配置别名',
                  onChange: (e) => setDraft({ ...draft, sshConfigAlias: e.target.value }),
                  style: inputStyle,
                }),
                h('input', {
                  value: draft.pinnedFingerprint,
                  placeholder: '已确认主机指纹 SHA256:...（可留空）',
                  'aria-label': '已确认主机指纹',
                  onChange: (e) => setDraft({ ...draft, pinnedFingerprint: e.target.value }),
                  style: inputStyle,
                }),
                h('input', {
                  value: draft.dbName ?? '',
                  placeholder: '数据库名（留空则自动发现：dbfilter → db_name → 唯一业务库）',
                  'aria-label': '数据库名',
                  onChange: (e) => setDraft({ ...draft, dbName: e.target.value }),
                  style: inputStyle,
                }),
                h('div', { style: { display: 'flex', gap: 8, marginTop: 4 } },
                  h(Btn, {
                    disabled: !draft.name.trim() || !draft.host.trim(),
                    onClick: async () => {
                      const name = (editingName || draft.name).trim();
                      const host = draft.host.trim();
                      if (!name || !host) { setSaveErr('名称与主机地址必填'); return; }
                      if (!editingName && servers.some((s) => s.name === name)) {
                        setSaveErr(`服务器名称已存在：${name}`); return;
                      }
                      const existing = editingName ? servers.find((s) => s.name === editingName) : null;
                      const nextServer = {
                        // 保留既有服务器的其它字段（odooContainer/pgContainer/dataPath 等），
                        // 避免「编辑只为填库名」却把其它配置清空。
                        ...(existing ?? {}),
                        name, host, port: existing?.port ?? 22,
                        user: draft.user.trim() || 'root',
                        keyPath: draft.keyPath.trim(),
                        sshConfigAlias: draft.sshConfigAlias.trim(),
                        // v0.1.14：目标库名。留空则从 dbfilter 解析；两处都没有时恢复会明确拒绝。
                        dbName: (draft.dbName ?? '').trim(),
                        // 编辑时保留已固化指纹（除非用户明确清空/修改），避免误删信任
                        pinnedFingerprint: draft.pinnedFingerprint.trim()
                          || (existing?.pinnedFingerprint ?? ''),
                      };
                      const next = editingName
                        ? servers.map((s) => (s.name === editingName ? nextServer : s))
                        : [...servers, nextServer];
                      await saveServers(next);
                      setDraft({
                        name: '', host: '', user: 'root', keyPath: '',
                        sshConfigAlias: '', pinnedFingerprint: '', dbName: '',
                      });
                      setAdding(false);
                      setEditingName(null);
                    },
                  }, '保存'),
                  h(Btn, {
                    onClick: () => { setAdding(false); setSaveErr(''); },
                  }, '取消'),
                ),
              ),
              servers.length === 0 && !adding
                && h('p', { style: { color: T.text2, fontSize: 13 } }, '尚未配置服务器。'),
              servers.map((s, idx) => h('div', {
                key: s.name,
                style: {
                  padding: 12, marginBottom: 8, border: `1px solid ${T.border}`,
                  borderRadius: 6, background: T.bg2,
                },
              },
                h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 } },
                  h('div', null,
                    h('strong', null, s.name),
                    h('span', { style: { marginLeft: 8, color: T.text2, fontSize: 12 } },
                      `${s.user}@${s.host}:${s.port ?? 22}`),
                    h('div', { style: { marginTop: 4, fontSize: 12, color: T.text2 } },
                      `主机身份：${hostState(s, trust[s.name]?.scan).text} ｜ 登录认证：${authState(s, status[s.name]).text}`),
                  ),
                  h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
                    h(Btn, {
                      disabled: !!busy[s.name],
                      onClick: () => call(s.name, async (api) => {
                        setOne(s.name, 'testing...');
                        const { result } = await api('/test', { server: s.name });
                        setOne(s.name, result?.ok
                          ? `ok: ${result?.system?.os ?? ''}`
                          : `err: ${result?.error?.message ?? '未知错误'}`);
                      }),
                    }, busy[s.name] ? '…' : t('server.test')),
                    h(Btn, {
                      disabled: !!busy[s.name],
                      onClick: () => call(s.name, async (api) => {
                        setOne(s.name, '正在发现库名...');
                        const { result, autoPersistedDbName } = await api('/discover', { server: s.name });
                        const inst = result?.instances?.[0];
                        const found = autoPersistedDbName || inst?.dbName || '';
                        const why = inst?.dbNameDiscovery?.reason;
                        setOne(s.name, found
                          ? `发现库名：${found}${autoPersistedDbName ? '（已保存）' : ''}`
                          : `未能自动发现库名${why ? `（${why}）` : ''}，请手工填写`);
                      }),
                    }, busy[s.name] ? '…' : '发现库名'),
                    h(Btn, {
                      onClick: () => patchTrust(s.name, {
                        open: !(trust[s.name]?.open),
                        keyPath: trust[s.name]?.keyPath ?? s.keyPath ?? '',
                      }),
                    }, '信任主机'),
                    h(Btn, {
                      onClick: () => {
                        setEditingName(s.name);
                        setDraft({
                          name: s.name, host: s.host ?? '', user: s.user ?? 'root',
                          keyPath: s.keyPath ?? '', sshConfigAlias: s.sshConfigAlias ?? '',
                          pinnedFingerprint: s.pinnedFingerprint ?? '',
                          dbName: s.dbName ?? '',
                        });
                        setAdding(true); setSaveErr('');
                      },
                    }, '编辑'),
                    h(Btn, {
                      disabled: !!busy[s.name],
                      onClick: () => doScan(s),
                    }, busy[s.name] ? '…' : '重新扫描'),
                    h(Btn, {
                      tone: 'danger',
                      onClick: async () => { await saveServers(servers.filter((_, i) => i !== idx)); },
                    }, t('task.delete')),
                  ),
                ),
                trust[s.name]?.open && h(TrustHostPanel, {
                  server: s, state: trust[s.name],
                  patch: (delta) => patchTrust(s.name, delta),
                  onScan: () => doScan(s),
                  onLoadPubkey: () => doLoadPubkey(s),
                  onConfirm: () => doConfirmTrust(s),
                  onClose: () => patchTrust(s.name, { open: false }),
                }),
                h(Status, { text: status[s.name] }),
              )),
            ),

            // ---- 备份 tab ----
            tab === 'backup' && h('div', null,
              // v0.1.13 §3.1：当前备份目录 + 验证结果 + 修改（只影响新建任务，fail-closed）
              h('div', { style: { padding: 12, marginBottom: 12, border: `1px solid ${T.border}`, borderRadius: 6, background: T.bg2 } },
                h('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 6 } }, '本地备份目录'),
                h('div', { style: { fontSize: 12, color: T.text2, marginBottom: 6 } },
                  `当前备份目录：${dirState.path || '读取中…'} ｜ 验证：${dirState.writable ? '可写 ✓' : '不可验证/不可用'} ｜ 实际完整路径：${dirState.fullPath || '—'}`),
                h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
                  h(Btn, { disabled: dirState.busy, onClick: () => setDirState((s) => ({ ...s, editing: !s.editing, input: s.path, err: '', ok: '' })) }, dirState.editing ? '取消' : '修改目录'),
                  dirState.editing && h('input', {
                    value: dirState.input, 'aria-label': '备份目录', placeholder: '如 K:\\Backup\\odoo',
                    onChange: (e) => setDirState((s) => ({ ...s, input: e.target.value })), style: inputStyle,
                  }),
                  dirState.editing && h(Btn, { disabled: dirState.busy || !dirState.input.trim(), onClick: saveDir }, dirState.busy ? '…' : '验证并保存'),
                ),
                dirState.err && h(Status, { text: dirState.err, tone: 'error' }),
                dirState.ok && h(Status, { text: dirState.ok }),
                h('p', { style: { fontSize: 12, color: T.warn, margin: '6px 0 0' } },
                  '修改目录只影响新建任务；未完成/历史任务仍绑定创建时的原目录，不会自动迁移。'),
              ),
              // v0.1.11：备份加密口令（官方 Credentials；不进插件配置、不回显明文）
              h('div', { style: { padding: 12, marginBottom: 12, border: `1px solid ${T.border}`, borderRadius: 6, background: T.bg2 } },
                h('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 6 } }, '备份加密口令'),
                h('p', { style: { color: T.text2, fontSize: 12, margin: '0 0 8px' } },
                  '保存在 DSH 官方凭证库（文件 0600 保护），不写入插件配置；设置后备份与恢复共用，界面不再回显。'),
                h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
                  h('input', {
                    type: 'password',
                    value: passState.input,
                    placeholder: passState.configured ? '已配置（输入新口令可更新）' : '输入备份加密口令',
                    'aria-label': '备份加密口令',
                    onChange: (e) => setPassState((s) => ({ ...s, input: e.target.value })),
                    style: inputStyle,
                  }),
                  h(Btn, {
                    disabled: passState.busy || !passState.input,
                    onClick: setPassphrase,
                  }, passState.busy ? '…' : (passState.configured ? '更新口令' : '保存口令')),
                  passState.configured && h(Btn, {
                    disabled: passState.busy,
                    onClick: unsetPassphrase,
                  }, '清除口令'),
                ),
                h('div', { style: { fontSize: 12, marginTop: 4, color: passState.configured ? T.text2 : T.warn } },
                  `状态：${!passState.loaded ? '读取中…' : (passState.configured ? '已配置 ✓（备份/恢复共用）' : '未配置 — 备份将被拒绝')}`),
                passState.err && h(Status, { text: passState.err, tone: 'error' }),
                passState.ok && h(Status, { text: passState.ok }),
                h('p', { style: { color: T.warn, fontSize: 12, margin: '6px 0 0' } },
                  '⚠️ 请离线妥善保管口令（如密码管理器/纸质保险柜）：口令丢失后，历史加密备份将无法解密。'),
              ),
              h('p', { style: { fontSize: 13, color: T.text2 } },
                '选择服务器后开始备份。备份包将下载到插件设置页配置的本地目录。'),
              // v0.1.13：真实进度条（备份）与服务器级互斥提示（§14.3 / §17.1）
              taskLocked && h(Status, { text: busyHint, tone: 'warn' }),
              hostTask && hostTask.kind === 'backup' && h(TaskProgress, { task: hostTask, netError }),
              servers.map((s) => h('div', { key: s.name, style: { marginBottom: 8 } },
                h(Btn, {
                  disabled: !!busy[s.name] || (taskLocked && true),
                  onClick: () => call(s.name, async (api) => {
                    // v0.1.17：开始新任务时立即清掉上一次的终态显示（裁决 §二），
                    // 避免新任务启动前界面仍停留「已完成/失败」旧条；进度由轮询接管。
                    setHostTask(null);
                    setOne(s.name, 'backing up...');
                    const { result } = await api('/backup', { server: s.name });
                    if (result?.ok) {
                      setOne(s.name, `完成：${result.localPath}（${((result.bytes ?? 0) / 1048576).toFixed(1)} MB）`);
                      // v0.1.14：仅在备份后端确认成功后回填最终加密包路径。
                      // Host 侧已用 completed.json + 存在性 + 加密格式三重校验；
                      // 回填失败绝不影响“备份成功”状态，也绝不覆盖已有恢复路径。
                      try {
                        const last = await api('/last-backup');
                        if (last?.ok && last.localPath) {
                          setRestorePath((m) => ({ ...m, [s.name]: last.localPath }));
                        }
                      } catch { /* 忽略：回填是便利功能，不是备份成功条件 */ }
                    } else {
                      // 失败/未完成：不回填、不触碰原恢复路径
                      setOne(s.name, `失败：${result?.error ?? '未知错误'}`);
                    }
                  }),
                }, busy[s.name] ? '…' : `${t('backup.start')} ${s.name}`),
                h(Status, { text: status[s.name] }),
              )),
            ),

            // ---- 恢复 tab ----
            tab === 'restore' && h('div', null,
              h('p', { style: { fontSize: 13, color: T.text2 } },
                '恢复会覆盖目标数据库。流程：安全备份 → 临时恢复 → 验证 → 停机切换 → 验证。失败自动回滚。'),
              h('p', { style: { fontSize: 12, color: T.text2 } },
                `解密口令：${!passState.loaded ? '读取中…' : (passState.configured ? '使用已配置的备份加密口令（与备份共用，在「备份」页管理）' : '未配置 — 恢复加密包将被拒绝，请先在「备份」页设置')}`),
              h('p', { style: { fontSize: 12, color: T.warn } },
                '⚠️ 切换期间站点约 2–5 分钟不可用；切换后正式环境回到备份包对应的业务时间点。'),
              // v0.1.14：路径易用性提示（真机踩坑：粘贴带引号路径 / 误选分片目录明文 .tar）
              h('p', { style: { fontSize: 12, color: T.text2, margin: '6px 0 0' } },
                '正确格式：备份根目录下的最终加密产物 .tar.enc（备份成功后会在此自动回填）。'
                + '不要选择分片目录（<backupId>/）中的明文 .tar 中间文件——它会被默认拒绝恢复。'
                + '执行恢复前请再次确认备份时间点与目标数据库：切换后正式环境将回到该时间点。'),
              // v0.1.14：签名密钥隔离（默认开启）
              h('div', { style: { padding: 12, marginBottom: 12, border: `1px solid ${T.border}`, borderRadius: 6, background: T.bg2 } },
                h('label', { style: { display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer' } },
                  h('input', {
                    type: 'checkbox',
                    checked: rotateSecret,
                    'aria-label': '恢复后重新生成数据库签名密钥',
                    onChange: (e) => setRotateSecret(e.target.checked),
                    style: { marginTop: 2 },
                  }),
                  h('div', null,
                    h('div', { style: { fontSize: 13, fontWeight: 600 } }, '恢复后重新生成数据库签名密钥'),
                    h('p', { style: { fontSize: 12, color: T.text2, margin: '4px 0 0' } },
                      '备份包带着来源库的 database.secret。开启后只重签**目标库**这一个密钥，'
                      + '使恢复环境与来源环境不再共用签名密钥；生产库不受影响（生产保留原密钥，其已发出的链接照常有效）。'
                      + '目标库中少量使用旧密钥签发的签名链接与令牌可能失效（如部分 Portal 访问链接、退订链接）——这正是环境隔离的目的。'
                      + '若确需保留原签名链接，可取消勾选。'),
                  ),
                ),
                rotateSecret
                  ? h('div', { style: { fontSize: 12, marginTop: 6, color: T.text2 } }, '将重签（推荐）')
                  : h('div', { style: { fontSize: 12, marginTop: 6, color: T.warn } }, '将保留备份中的原密钥（与来源环境共用密钥）'),
              ),
              // v0.1.14：恢复目标域名（避免与来源站点抢同一域名）
              h('div', { style: { padding: 12, marginBottom: 12, border: `1px solid ${T.border}`, borderRadius: 6, background: T.bg2 } },
                h('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 6 } }, '恢复目标域名'),
                h('p', { style: { fontSize: 12, color: T.text2, margin: '0 0 8px' } },
                  '恢复后会把目标站点的 website.domain 与 web.base.url 改成这里填的域名，避免与来源站点抢同一域名。'
                  + '留空则自动使用服务器名（仅当其形如 odoo.example.com）；服务器名不是主机名时不做域名切换。'),
                h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
                  h('input', {
                    value: domainState.input,
                    placeholder: domainState.value ? `当前：${domainState.value}` : '留空 = 用服务器名',
                    'aria-label': '恢复目标域名',
                    onChange: (e) => setDomainState((s) => ({ ...s, input: e.target.value })),
                    style: inputStyle,
                  }),
                  h(Btn, {
                    disabled: domainState.busy,
                    onClick: saveRestoreDomain,
                  }, domainState.busy ? '…' : (domainState.value ? '更新域名' : '保存域名')),
                ),
                h('div', { style: { fontSize: 12, marginTop: 4, color: T.text2 } },
                  `当前：${domainState.value || '自动（使用服务器名）'}`),
                domainState.err && h(Status, { text: domainState.err, tone: 'error' }),
                domainState.ok && h(Status, { text: domainState.ok }),
              ),
              // v0.1.13：真实进度条（恢复）与服务器级互斥提示（§14.3 / §17.1）
              taskLocked && h(Status, { text: busyHint, tone: 'warn' }),
              hostTask && hostTask.kind === 'restore' && h(TaskProgress, { task: hostTask, netError }),
              servers.map((s) => h('div', { key: s.name, style: { marginBottom: 8 } },
                h('input', {
                  value: restorePath[s.name] ?? '',
                  placeholder: '备份包完整路径（如 K:\\Backup\\odoo\\20261109\\odoo-backup-20261109-103541.tar.enc）',
                  'aria-label': `恢复包路径 ${s.name}`,
                  onChange: (e) => setRestorePath((m) => ({ ...m, [s.name]: e.target.value })),
                  style: inputStyle,
                }),
                h(Btn, {
                  tone: 'danger',
                  disabled: (!!busy[s.name] || !(restorePath[s.name] ?? '').trim()) || (taskLocked && true),
                  onClick: () => {
                    // 同样不能用 window.prompt/confirm：Electron 不实现它们。
                    // v0.1.14：与 Host 同一规范化规则（去首尾空白、去一对完整引号、斜杠统一）
                    const pkg = normalizeRestorePath(restorePath[s.name]);
                    if (!pkg) { setOne(s.name, '请先填写备份包完整路径'); return; }
                    call(s.name, async (api) => {
                      // v0.1.17：与备份一致，开始前清掉旧终态显示（裁决 §二）。
                      setHostTask(null);
                      setOne(s.name, '预检中...');
                      const pre = await api('/precheck', { server: s.name, packagePath: pkg });
                      const sourceText = pre.sourceDbName
                        ? `来源库：${pre.sourceDbName}`
                        : `来源库：未能读取${pre.sourceReason ? `（${pre.sourceReason}）` : ''}`;
                      const targetText = pre.targetDbName
                        ? `目标库：${pre.targetDbName}${pre.dbNameSource ? `（${pre.dbNameSource}）` : ''}`
                        : `目标库：未能可靠确定。${pre.targetReason || '请在「服务器」页填写数据库名后重试。'}`;
                      const conflictText = pre.conflict === 'same-name'
                        ? ' 名称相同只作提示：恢复仍只覆盖目标服务器上的该库，不会用源库名决定覆盖位置。'
                        : '';
                      if (!pre.targetDbName) {
                        setOne(s.name, `${sourceText}；${targetText}`);
                        return;
                      }
                      setOne(s.name, `${sourceText}；${targetText}${conflictText} 恢复中（此过程较久，请勿关闭页面）...`);
                      const { result } = await api('/restore', {
                        server: s.name,
                        packagePath: pkg,
                        confirmToken: pre.confirmToken,
                        rotateSecret,
                      });
                      if (result?.ok) {
                        const sr = result.secretRotation;
                        const secretText = sr?.applied
                          ? '签名密钥已重签（生产库不受影响）'
                          : (sr?.skipped ? `签名密钥未重签：${sr.reason ?? '已跳过'}` : '签名密钥重签状态未知');
                        setOne(s.name, `恢复成功；${secretText}`);
                      } else {
                        setOne(s.name, `失败：${result?.error ?? '未知错误'}`);
                      }
                    });
                  },
                }, busy[s.name] ? '…' : `${t('restore.start')} ${s.name}`),
                h(Status, { text: status[s.name] }),
              )),
              // v0.1.14 收尾：中立化状态（恢复完成后决定该环境是否接管生产）
              h('div', { style: { padding: 12, marginTop: 12, border: `1px solid ${T.border}`, borderRadius: 6, background: T.bg2 } },
                h('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 6 } }, '中立化状态（恢复后是否接管生产）'),
                h('p', { style: { fontSize: 12, color: T.text2, margin: '0 0 8px' } },
                  '中立化（neutralize）会把恢复库的邮件外发、定时任务、支付提供商全部停掉，'
                  + '并写入 database.is_neutralized 标记——用于「只做验证、不接管生产」的恢复。'
                  + '确认该环境要正式对外服务时，在此解除中立化，无需再登服务器。'),
                // 静态安全提示：点「解除」之前就要看到，不依赖后端 warnings 是否返回
                h('div', { style: { fontSize: 12, color: T.warn, margin: '0 0 8px', lineHeight: 1.7 } },
                  h('div', null, '· 解除会启用全部定时任务（含自动发信）并恢复邮件服务器；'),
                  h('div', null, '· 中立化时已清空 SMTP 用户名与密码且不可还原，解除后必须到 Odoo 后台重新填写；'),
                  h('div', null, '· 支付提供商不会被自动启用——留空即全部保持禁用，需你显式给出 code；'),
                  h('div', null, '· 该操作不可逆，请确认此环境确需接管生产。')),
                servers.map((s) => {
                  const st = neuState[s.name] ?? {};
                  const stat = st.status;
                  const showWarn = Array.isArray(st.warnings) && st.warnings.length > 0;
                  return h('div', { key: s.name, style: { padding: 10, marginBottom: 8, border: `1px solid ${T.border}`, borderRadius: 6 } },
                    h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 } },
                      h('div', { style: { fontSize: 13, fontWeight: 600, flex: 1 } }, s.name),
                      h(Btn, { disabled: !!st.busy, onClick: () => loadNeuStatus(s.name) },
                        st.busy ? '…' : '刷新状态'),
                    ),
                    !stat && !st.err && h('div', { style: { fontSize: 12, color: T.text2 } },
                      st.busy ? '读取中…' : '尚未读取状态'),
                    stat && h('div', { style: { fontSize: 12, color: T.text2, lineHeight: 1.7 } },
                      h('div', null,
                        '目标库：', h('b', null, stat.dbName || '未知'),
                        '　中立化：', h('b', null, stat.neutralized ? '是（已隔离）' : '否'),
                        stat.flag === false && stat.neutralized ? '（标记缺失但仍有停用项）' : ''),
                      h('div', null,
                        `定时任务：启用 ${stat.cronActive ?? 0} / 停用 ${stat.cronDisabled ?? 0}`),
                      h('div', null,
                        `邮件服务器：占位 ${stat.mailPlaceholder ?? 0} 个；真实启用 ${stat.mailRealActive ?? 0} 个`
                        + (stat.credentialsLost ? '（凭据已被清空）' : '')),
                      h('div', null,
                        `支付提供商：启用 ${stat.paymentEnabled ?? 0} / 禁用 ${stat.paymentDisabled ?? 0}`),
                    ),
                    h('div', { style: { display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' } },
                      h(Btn, { disabled: !!st.busy, onClick: () => keepNeutralize(s.name) }, '保持中立化'),
                      h(Btn, {
                        tone: 'danger',
                        disabled: !!st.busy || showWarn,
                        onClick: () => precheckRelease(s.name),
                      }, '解除中立化（接管生产）'),
                    ),
                    // 二次确认：先列出全部不可逆提示，再由用户点「确认解除」
                    showWarn && h('div', {
                      style: { marginTop: 8, padding: 10, border: `1px solid ${T.warn}`, borderRadius: 6 },
                    },
                    h('div', { style: { fontSize: 12, fontWeight: 600, color: T.warn, marginBottom: 6 } },
                      '解除前请确认以下不可逆事项：'),
                    st.warnings.map((w, i) => h('div', { key: i, style: { fontSize: 12, color: T.text2, marginBottom: 4 } },
                      `${i + 1}. ${w}`)),
                    h('div', { style: { fontSize: 12, color: T.text2, margin: '8px 0 4px' } },
                      '要启用的支付提供商 code（逗号分隔；留空 = 全部保持禁用，绝不自动启用）'),
                    h('input', {
                      value: st.codes ?? '',
                      placeholder: '留空 = 全部保持禁用（如 alipay, airwallex）',
                      'aria-label': `支付提供商 code ${s.name}`,
                      onChange: (e) => setNeu(s.name, { codes: e.target.value }),
                      style: inputStyle,
                    }),
                    h('div', { style: { display: 'flex', gap: 8, marginTop: 8 } },
                      h(Btn, { tone: 'danger', disabled: !!st.busy, onClick: () => confirmRelease(s.name) },
                        st.busy ? '…' : '确认解除'),
                      h(Btn, { disabled: !!st.busy, onClick: () => setNeu(s.name, { warnings: null, confirmToken: null }) },
                        '取消'),
                    )),
                    st.result && h('div', { style: { fontSize: 12, marginTop: 8, color: T.text2, lineHeight: 1.7 } },
                      h('div', null, `结果：applied=${st.result.applied ? 'true' : 'false'}`),
                      h('div', null, `标记已删除：${st.result.flagDeleted ? '是' : '否'}；占位邮件服务器已删除：${st.result.placeholderDeleted ? '是' : '否'}`),
                      h('div', null, `已启用定时任务：${st.result.cronEnabled ?? 0} 个；重新启用的真实邮件服务器：${st.result.mailReactivated ?? 0} 个`),
                      h('div', null, `支付提供商启用：${st.result.paymentEnabled ?? 0} 个`),
                      h('div', { style: { color: T.warn } },
                        st.result.restartRequired
                          ? `restartRequired：需重启 Odoo 容器（已尝试自动重启：${st.result.restarted ? '是' : '否'}），并确认 max_cron_threads ≥ 1`
                          : ''),
                      Array.isArray(st.result.warnings) && st.result.warnings.map((w, i) => h('div', { key: i, style: { color: T.warn } }, `· ${w}`)),
                    ),
                    st.okText && h(Status, { text: st.okText }),
                    st.err && h(Status, { text: st.err, tone: 'error' }),
                  );
                }),
              ),
            ),
          );
        }

        // ---- 配置服务：软取 + 动态确认 namespace（全部防御式） ----
        // 铁律：卡片注册必须先做、且与配置服务完全解耦。配置服务里的任何异常
        // （ctx.get 抛错、describe 抛错、whileServed 抛错）都只能让卡片降级为
        // 「未就绪提示」，绝不能中断 apply 让整张卡片消失。
        const NAMESPACE_CANDIDATES = [
          'include:odoo-backup', // 当前 Desktop host 实际服务的 entryId
          'odoo-backup',         // 裸 row id（旧版 / 其他部署形态）
          pkgName,               // 包名兜底
        ];
        let scope;
        let disposeSection = null;
        // v0.1.14 UI 宿主迁移：整个操作界面挂在 DSH 原生设置页（settings.section），
        // 不再是「已安装插件」里的 plugins.bundle.config 卡片。
        // 渲染器按条目缓存 inject() 的返回值，因此 scope 晚到时必须
        // 「注销 + 重新注册」，否则 inject 不会重新求值。
        const mountSection = () => {
          try { disposeSection?.(); } catch (_) { /* 旧 disposer 失败不影响重挂 */ }
          disposeSection = ctx.slots.inject('settings.section', () => {
            // 先注册图标、再注册页面：测试替身以「最后一次 register」为观察对象时，
            // 观察到的仍是页面组件（真实 ledger 是两份独立条目，顺序无关）。
            const disposeIcon = ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
              name: 'settings.section.icon',
              id: 'odoo-backup',
              order: 210,
              label: () => t('settings.nav'),
            }, OdooNavIcon)) ?? null;
            const disposePage = ctx.slots.register({
              name: 'settings.section',
              id: 'odoo-backup',
              order: 210,
              label: () => t('settings.nav'),
              inject: () => ({ scope, locale }),
            }, OdooBackupPanel);
            return () => {
              try { disposePage?.(); } catch (_) { /* ignore */ }
              try { disposeIcon?.(); } catch (_) { /* ignore */ }
            };
          }) ?? null;
        };
        // 无条件注册：配置服务缺席/异常时页面仍在，由组件显示可见提示。
        mountSection();

        // 以下全部包在 try/catch 里：任何失败都只影响 scope，不影响卡片。
        let forms = null;
        const setScope = (served) => {
          const ns = NAMESPACE_CANDIDATES.find((c) => served.has(c))
            ?? [...served].find((n) => /odoo-backup/i.test(n));
          let next;
          try { next = ns && forms ? forms.get(ns) : undefined; } catch (_) { next = undefined; }
          if (next === scope) return false; // 同一 controller 不重复注册
          scope = next;
          return true;
        };
        const servedNamespaces = () => new Set(
          forms?.describe?.()?.getSnapshot?.()?.view?.namespaces?.map((v) => v.ns) ?? [],
        );
        // 用当前可用的 configForms 绑一次 scope；绑到就重挂卡片让 inject 生效。
        const bindFromService = () => {
          try {
            forms = ctx.get('configForms') ?? null;
            if (!forms) return false;
            if (setScope(servedNamespaces())) { mountSection(); return true; }
            if (typeof forms.whileServed === 'function') {
              ctx.effect(() => {
                const off = forms.whileServed(NAMESPACE_CANDIDATES, (served) => {
                  if (setScope(served)) mountSection();
                  return () => {};
                });
                return () => { try { off?.(); } catch (_) {} };
              }, 'odoo-backup: configForms namespace binding');
            }
            return true;
          } catch (err) {
            console.warn('[dsh-odoo19-backup] 绑定配置服务失败，卡片降级为只读提示：', err?.message ?? String(err));
            return false;
          }
        };

        // 先按「服务已在」试一次；若服务此刻缺席，则注册一个等待者。
        // 关键：等待者只负责「绑定 scope」，卡片注册已经完成，绝不受它 gate。
        if (!bindFromService()) {
          try {
            ctx.inject(['configForms'], (sctx) => {
              try {
                forms = sctx.configForms;
                if (setScope(servedNamespaces())) mountSection();
                if (typeof forms?.whileServed === 'function') {
                  const off = forms.whileServed(NAMESPACE_CANDIDATES, (served) => {
                    if (setScope(served)) mountSection();
                    return () => {};
                  });
                  return () => { try { off?.(); } catch (_) {} };
                }
              } catch (err) {
                console.warn('[dsh-odoo19-backup] configForms 晚到后绑定失败：', err?.message ?? String(err));
              }
              return () => {};
            });
          } catch (err) {
            console.warn('[dsh-odoo19-backup] 无法等待 configForms：', err?.message ?? String(err));
          }
        }

        // 服务缺席 5 秒后输出点名 configForms 的诊断告警（不再静默）。
        const diagTimer = setTimeout(() => {
          if (!scope) {
            console.warn('[dsh-odoo19-backup] configForms 未提供或未服务本插件的命名空间：'
              + '设置页仍显示，但无法读写配置。请确认 dsh.client.inject 已声明 '
              + '@deepseek-ai/dsh-client-ui-settings，并重启 DSH / 硬刷新页面。');
          }
        }, 5000);
        ctx.effect(() => () => clearTimeout(diagTimer), 'odoo-backup: configForms diagnostic');
      },
    };
  },
});
