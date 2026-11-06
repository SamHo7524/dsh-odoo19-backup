window.__ModuleLoader__.load({
  id: '@local/dsh-odoo19-backup',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useCallback, useSyncExternalStore } = React;
    const pkgName = '@local/dsh-odoo19-backup';
    // useSyncExternalStore 要求稳定引用：这两个常量必须定义在模块级，
    // 绝不能在 getSnapshot/subscribe 里现造新对象/新函数。
    const EMPTY_SNAPSHOT = Object.freeze({});
    const NOOP_UNSUB = () => {};

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

        function OdooBackupPanel({ scope }) {
          const [tab, setTab] = useState('servers');
          const [status, setStatus] = useState({});
          const [busy, setBusy] = useState({});
          const [saveErr, setSaveErr] = useState('');
          // 「添加服务器」走内联表单：Electron 不实现 window.prompt。
          const [adding, setAdding] = useState(false);
          const [draft, setDraft] = useState({
            name: '', host: '', user: 'root', keyPath: '',
            sshConfigAlias: '', pinnedFingerprint: '',
          });
          // 恢复包路径：同样不用 window.prompt（Electron 不实现）。
          const [restorePath, setRestorePath] = useState({});
          const inputStyle = {
            display: 'block', width: '100%', boxSizing: 'border-box',
            marginBottom: 6, padding: '6px 8px', fontSize: 13,
            color: T.text, background: T.bg1,
            border: `1px solid ${T.border}`, borderRadius: 4,
          };

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
                onClick: () => { setAdding(true); setSaveErr(''); },
              }, t('server.add')),
              adding && h('div', {
                style: {
                  padding: 12, marginBottom: 12, border: `1px solid ${T.borderStrong}`,
                  borderRadius: 6, background: T.bg2,
                },
              },
                h('div', { style: { fontSize: 13, marginBottom: 8 } }, '新增服务器'),
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
                h('div', { style: { display: 'flex', gap: 8, marginTop: 4 } },
                  h(Btn, {
                    disabled: !draft.name.trim() || !draft.host.trim(),
                    onClick: async () => {
                      const name = draft.name.trim();
                      const host = draft.host.trim();
                      if (!name || !host) { setSaveErr('名称与主机地址必填'); return; }
                      if (servers.some((s) => s.name === name)) { setSaveErr(`服务器名称已存在：${name}`); return; }
                      await saveServers([...servers, {
                        name, host, port: 22,
                        user: draft.user.trim() || 'root',
                        keyPath: draft.keyPath.trim(),
                        sshConfigAlias: draft.sshConfigAlias.trim(),
                        pinnedFingerprint: draft.pinnedFingerprint.trim(),
                      }]);
                      setDraft({
                        name: '', host: '', user: 'root', keyPath: '',
                        sshConfigAlias: '', pinnedFingerprint: '',
                      });
                      setAdding(false);
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
                  ),
                  h('div', { style: { display: 'flex', gap: 6 } },
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
                        setOne(s.name, '扫描主机指纹中...');
                        const { result } = await api('/fingerprint', { server: s.name });
                        const list = result?.fingerprints ?? [];
                        setOne(s.name, list.length
                          ? `指纹（请人工核对后填入「已确认主机指纹」字段）：\n`
                            + list.map((f) => `${f.type} ${f.fingerprint}`).join('\n')
                          : `扫描失败：${result?.error?.message ?? '未取得指纹'}`);
                      }),
                    }, busy[s.name] ? '…' : '扫描指纹'),
                    h(Btn, {
                      tone: 'danger',
                      onClick: async () => { await saveServers(servers.filter((_, i) => i !== idx)); },
                    }, t('task.delete')),
                  ),
                ),
                h(Status, { text: status[s.name] }),
              )),
            ),

            // ---- 备份 tab ----
            tab === 'backup' && h('div', null,
              h('p', { style: { fontSize: 13, color: T.text2 } },
                '选择服务器后开始备份。备份包将下载到插件设置页配置的本地目录。'),
              servers.map((s) => h('div', { key: s.name, style: { marginBottom: 8 } },
                h(Btn, {
                  disabled: !!busy[s.name],
                  onClick: () => call(s.name, async (api) => {
                    setOne(s.name, 'backing up...');
                    const { result } = await api('/backup', { server: s.name });
                    setOne(s.name, result?.ok
                      ? `完成：${result.localPath}（${((result.bytes ?? 0) / 1048576).toFixed(1)} MB）`
                      : `失败：${result?.error ?? '未知错误'}`);
                  }),
                }, busy[s.name] ? '…' : `${t('backup.start')} ${s.name}`),
                h(Status, { text: status[s.name] }),
              )),
            ),

            // ---- 恢复 tab ----
            tab === 'restore' && h('div', null,
              h('p', { style: { fontSize: 13, color: T.text2 } },
                '恢复会覆盖目标数据库。流程：安全备份 → 临时恢复 → 验证 → 停机切换 → 验证。失败自动回滚。'),
              h('p', { style: { fontSize: 12, color: T.warn } },
                '⚠️ 切换期间站点约 2–5 分钟不可用；切换后正式环境回到备份包对应的业务时间点。'),
              servers.map((s) => h('div', { key: s.name, style: { marginBottom: 8 } },
                h('input', {
                  value: restorePath[s.name] ?? '',
                  placeholder: '备份包完整路径（如 K:\\Backup\\odoo\\xxx.tgz）',
                  'aria-label': `恢复包路径 ${s.name}`,
                  onChange: (e) => setRestorePath((m) => ({ ...m, [s.name]: e.target.value })),
                  style: inputStyle,
                }),
                h(Btn, {
                  tone: 'danger',
                  disabled: !!busy[s.name] || !(restorePath[s.name] ?? '').trim(),
                  onClick: () => {
                    // 同样不能用 window.prompt/confirm：Electron 不实现它们。
                    const pkg = (restorePath[s.name] ?? '').trim();
                    if (!pkg) { setOne(s.name, '请先填写备份包完整路径'); return; }
                    call(s.name, async (api) => {
                      setOne(s.name, '预检中...');
                      const pre = await api('/precheck', { server: s.name, packagePath: pkg });
                      setOne(s.name, '恢复中（此过程较久，请勿关闭页面）...');
                      const { result } = await api('/restore', {
                        server: s.name,
                        packagePath: pkg,
                        confirmToken: pre.confirmToken,
                      });
                      setOne(s.name, result?.ok
                        ? '恢复成功'
                        : `失败：${result?.error ?? '未知错误'}`);
                    });
                  },
                }, busy[s.name] ? '…' : `${t('restore.start')} ${s.name}`),
                h(Status, { text: status[s.name] }),
              )),
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
        let disposeCard = null;
        // 渲染器按条目缓存 inject() 的返回值，因此 scope 晚到时必须
        // 「注销 + 重新注册」，否则 inject 不会重新求值。
        const mountCard = () => {
          try { disposeCard?.(); } catch (_) { /* 旧 disposer 失败不影响重挂 */ }
          disposeCard = ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
            name: 'plugins.bundle.config',
            key: '@local/dsh-odoo19-backup',
            view: 'page',
            inject: () => ({ scope, locale }),
          }, OdooBackupPanel)) ?? null;
        };
        // 无条件注册：配置服务缺席/异常时卡片仍在，由组件显示可见提示。
        mountCard();

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
            if (setScope(servedNamespaces())) { mountCard(); return true; }
            if (typeof forms.whileServed === 'function') {
              ctx.effect(() => {
                const off = forms.whileServed(NAMESPACE_CANDIDATES, (served) => {
                  if (setScope(served)) mountCard();
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
                if (setScope(servedNamespaces())) mountCard();
                if (typeof forms?.whileServed === 'function') {
                  const off = forms.whileServed(NAMESPACE_CANDIDATES, (served) => {
                    if (setScope(served)) mountCard();
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
              + '配置卡片仍显示，但无法读写配置。请确认 dsh.client.inject 已声明 '
              + '@deepseek-ai/dsh-client-ui-settings，并重启 DSH / 硬刷新页面。');
          }
        }, 5000);
        ctx.effect(() => () => clearTimeout(diagTimer), 'odoo-backup: configForms diagnostic');
      },
    };
  },
});
