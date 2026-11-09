/**
 * dsh-opencode-go-quota — Client half.
 *
 * Two surfaces over one poller:
 *   1. A right-sidebar tab (`sidebar.right.pane.tab`, kind
 *      `opencode-go-quota`) showing all three budget windows — rolling 5h,
 *      weekly, monthly — each with a bar, remaining share, fixed dollar cap,
 *      and the reset countdown. It registers a card on the right Sidebar's
 *      guide page, so the panel is reached from 开始 → OpenCode Go 余量.
 *   2. A ring gauge in the left sidebar's footer row (`sidebar.footer.action`):
 *      the arc is the *most constrained* window's remaining share, so a glance
 *      answers "am I about to run out?". Hovering (or focusing) opens a compact
 *      card with all three windows; clicking reveals surface 1.
 *
 * Data arrives from the Host's same-origin `/api/opencode-go/usage` (the Host
 * owns the API key; the browser never sees it). The Zen usage endpoint reports
 * only status/percent/resetsAt, so the panel states the fixed budgets instead
 * of inventing a balance.
 */
window.__ModuleLoader__.load({
  id: 'dsh-opencode-go-quota',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect } = React;
    const NS = 'dsh-opencode-go-quota';
    const ROUTE = '/api/opencode-go/usage';
    const POLL_MS = 60000;
    /** Tab-type identity: both the registry id and the `sidebar.right.pane.tab` key. */
    const TAB_TYPE_ID = 'opencode-go-quota';
    const TAB_KIND = 'opencode-go-quota';
    const WINDOWS = ['rolling', 'weekly', 'monthly'];

    const DICT = {
      zh: {
        'tab.title': 'Go 余量',
        'panel.title': 'OpenCode Go 余量',
        'panel.subtitle': '订阅额度按滚动窗口计算，接口只返回已用百分比',
        'panel.refresh': '刷新',
        'panel.refreshing': '刷新中…',
        'panel.updated': '更新于 {{time}}',
        'panel.stale': '实时读取失败，显示 {{time}} 的旧数据',
        'window.rolling': '5 小时窗口',
        'window.weekly': '本周',
        'window.monthly': '本月',
        'window.remaining': '剩余 {{value}}%',
        'window.used': '已用 {{value}}%',
        'window.resetIn': '{{value}} 后重置',
        'window.unknown': '暂无窗口数据',
        'window.budgetHint': '上限 ${{value}}',
        'state.loading': '正在读取 OpenCode Go 余量…',
        'state.noKey': '还没有 OpenCode Go 的 API key',
        'state.noKeyHint': '任选一种方式提供密钥，然后点刷新：',
        'state.noKeyConfig': '① 写进档案 cordis.patch.yml 的 opencode-go-quota 配置项 apiKey（改完重载插件生效）',
        'state.noKeyEnv': '② 在启动 Harness 的环境里设置 OPENCODE_GO_API_KEY（或在 OpenCode 里 /connect 过、已有 ~/.local/share/opencode/auth.json）',
        'state.unauthorized': '密钥被 OpenCode Go 拒绝（401）',
        'state.unauthorizedHint': '确认这个 key 属于已订阅 Go 的工作区，然后更新配置或环境变量。',
        'state.offline': '暂时读不到 OpenCode Go 余量',
        'state.offlineHint': '网络或上游异常，稍后会自动重试。',
        'state.hostOffline': '宿主配额服务没有响应',
        'state.retry': '重试',
        'state.badPayload': '上游返回了看不懂的数据',
        'state.badPayloadHint': '接口结构可能变了，稍后再试；持续失败就把它当 bug 报上来。',
        'source.config': '配置项 apiKey',
        'source.env': '环境变量 {{name}}',
        'source.credentials': 'DSH 凭据 {{name}}',
        'source.authFile': 'OpenCode auth.json',
        'source.none': '未找到',
        'footer.hint': '数据来自 {{endpoint}} · 每 60 秒自动刷新 · 余量 = 100 − 已用百分比',
        'footer.budgets': 'Go 计划固定额度：5 小时 ${{rolling}} · 本周 ${{weekly}} · 本月 ${{monthly}}；具体金额以官方账单为准',
        'badge.title': 'OpenCode Go 余量',
        'badge.aria': 'OpenCode Go 余量，最紧的窗口还剩 {{value}}%',
        'badge.ariaEmpty': 'OpenCode Go 余量，暂无数据',
        'badge.updated': '更新于 {{time}}',
        'badge.stale': '实时读取失败，显示旧数据',
        'badge.open': '打开余量面板',
        'badge.noKey': '还没有 API key',
        'badge.noData': '暂无余量数据',
      },
      en: {
        'tab.title': 'Go quota',
        'panel.title': 'OpenCode Go quota',
        'panel.subtitle': 'Budgets run on rolling windows; the API reports used share only',
        'panel.refresh': 'Refresh',
        'panel.refreshing': 'Refreshing…',
        'panel.updated': 'Updated {{time}}',
        'panel.stale': 'Live read failed — showing data from {{time}}',
        'window.rolling': '5-hour window',
        'window.weekly': 'This week',
        'window.monthly': 'This month',
        'window.remaining': '{{value}}% left',
        'window.used': '{{value}}% used',
        'window.resetIn': 'resets in {{value}}',
        'window.unknown': 'No window data yet',
        'window.budgetHint': '${{value}} cap',
        'state.loading': 'Reading OpenCode Go quota…',
        'state.noKey': 'No OpenCode Go API key yet',
        'state.noKeyHint': 'Provide the key one of these ways, then hit refresh:',
        'state.noKeyConfig': '1. Put it in this plugin\'s `apiKey` config in the profile cordis.patch.yml (reload the plugin after saving)',
        'state.noKeyEnv': '2. Export OPENCODE_GO_API_KEY where Harness starts, or reuse OpenCode\'s own ~/.local/share/opencode/auth.json',
        'state.unauthorized': 'OpenCode Go rejected the key (401)',
        'state.unauthorizedHint': 'Check that the key belongs to a workspace subscribed to Go, then update the config or environment.',
        'state.offline': 'OpenCode Go quota is unavailable',
        'state.offlineHint': 'Network or upstream failure; retrying automatically.',
        'state.hostOffline': 'The Host quota service did not answer',
        'state.retry': 'Retry',
        'state.badPayload': 'The upstream response was not understood',
        'state.badPayloadHint': 'The API shape may have changed; try again later and report it if it persists.',
        'source.config': 'config apiKey',
        'source.env': 'env {{name}}',
        'source.credentials': 'DSH credentials {{name}}',
        'source.authFile': 'OpenCode auth.json',
        'source.none': 'not found',
        'footer.hint': 'Data from {{endpoint}} · refreshes every 60s · remaining = 100 − used percent',
        'footer.budgets': 'Go plan caps: ${{rolling}} per 5 hours · ${{weekly}} weekly · ${{monthly}} monthly; the provider bill is authoritative',
        'badge.title': 'OpenCode Go quota',
        'badge.aria': 'OpenCode Go quota, {{value}}% left in the tightest window',
        'badge.ariaEmpty': 'OpenCode Go quota, no data yet',
        'badge.updated': 'Updated {{time}}',
        'badge.stale': 'Live read failed — showing stale data',
        'badge.open': 'Open quota panel',
        'badge.noKey': 'No API key yet',
        'badge.noData': 'No quota data yet',
      },
    };

    function lookup(dict, path) {
      if (dict !== null && typeof dict === 'object' && Object.prototype.hasOwnProperty.call(dict, path)) return dict[path];
      return path.split('.').reduce((node, key) => (node && typeof node === 'object' ? node[key] : undefined), dict);
    }

    function interpolate(template, vars) {
      if (typeof template !== 'string') return template;
      return template.replace(/\{\{(\w+)\}\}/g, (match, name) => (vars && vars[name] !== undefined ? String(vars[name]) : match));
    }

    function languageOf(ctx) {
      const raw = String((ctx.locale && ctx.locale.language) || (typeof navigator !== 'undefined' ? navigator.language : 'zh') || 'zh');
      return raw.toLowerCase().startsWith('zh') ? 'zh' : 'en';
    }

    function createT(ctx) {
      const register = () => {
        try {
          if (ctx.locale && typeof ctx.locale.register === 'function') return ctx.locale.register(NS, { zh: DICT.zh, en: DICT.en });
        } catch (error) {
          console.warn('opencode-go-quota: locale registration skipped', error);
        }
        return undefined;
      };
      try {
        if (typeof ctx.effect === 'function') ctx.effect(register, 'dsh-opencode-go-quota: dictionaries');
        else register();
      } catch (error) {
        console.warn('opencode-go-quota: locale registration effect failed', error);
      }

      const dict = languageOf(ctx) === 'zh' ? DICT.zh : DICT.en;
      const localize = (key) => {
        const value = lookup(dict, key);
        return typeof value === 'string' ? value : key;
      };

      try {
        if (ctx.locale && typeof ctx.locale.bind === 'function') {
          const bound = ctx.locale.bind(NS);
          if (typeof bound === 'function') {
            return (key, vars) => {
              const value = bound(key);
              return interpolate(typeof value === 'string' && value !== key ? value : localize(key), vars);
            };
          }
        }
      } catch (error) {
        console.warn('opencode-go-quota: locale bind failed', error);
      }
      return (key, vars) => interpolate(localize(key), vars);
    }

    const STYLE_ID = 'dsh-opencode-go-quota-style';

    function ensureStyle() {
      if (typeof document === 'undefined') return;
      // Upsert rather than "first caller wins": a module replacement (client HMR)
      // re-applies this bundle while the old <style> element is still mounted,
      // so the element must be refreshed or newly added rules never arrive.
      const css = [
        '.ogq-tone-ok{background:var(--dsw-alias-state-success-primary,#12b76a)}',
        '.ogq-tone-warn{background:var(--dsw-alias-state-warning-primary,#f79009)}',
        '.ogq-tone-danger{background:var(--dsw-alias-state-error-primary,#f04438)}',
        // Right-sidebar body: a narrow column, so everything stacks.
        '.ogq-panel{display:flex;flex-direction:column;gap:12px;padding:14px 14px 20px;height:100%;overflow:auto;',
        'color:var(--dsw-alias-label-primary,#222);font-size:13px;box-sizing:border-box}',
        '.ogq-head{display:flex;align-items:flex-start;gap:10px;flex-wrap:wrap}',
        '.ogq-title{font-size:14px;font-weight:600}',
        '.ogq-sub{color:var(--dsw-alias-label-tertiary,#999);font-size:11px;margin-top:2px;line-height:1.5}',
        '.ogq-head-actions{margin-left:auto;display:flex;align-items:center;gap:8px}',
        '.ogq-updated{color:var(--dsw-alias-label-tertiary,#999);font-size:11px;font-variant-numeric:tabular-nums}',
        '.ogq-btn{height:26px;padding:0 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));',
        'background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-secondary,#555);font-size:12px;cursor:pointer}',
        '.ogq-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04))}',
        '.ogq-btn[disabled]{opacity:.55;cursor:default}',
        '.ogq-banner{display:flex;gap:8px;align-items:flex-start;padding:8px 10px;border-radius:10px;font-size:11px;line-height:1.5;',
        'background:var(--dsw-alias-state-warning-soft,rgba(247,144,9,.1));color:var(--dsw-alias-label-secondary,#666)}',
        '.ogq-banner-error{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#f04438) 12%,transparent)}',
        '.ogq-rows{display:flex;flex-direction:column;gap:10px}',
        '.ogq-row{border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.07));border-radius:12px;padding:10px 12px;',
        'background:var(--dsw-alias-bg-layer-1,transparent);display:flex;flex-direction:column;gap:8px}',
        '.ogq-row-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}',
        '.ogq-row-name{font-weight:600;font-size:13px}',
        '.ogq-row-budget{color:var(--dsw-alias-label-tertiary,#999);font-size:11px}',
        '.ogq-row-pct{margin-left:auto;font-variant-numeric:tabular-nums;font-weight:700;font-size:16px}',
        '.ogq-row-pct small{font-size:11px;font-weight:500;color:var(--dsw-alias-label-tertiary,#999);margin-left:2px}',
        '.ogq-bar{height:7px;border-radius:999px;background:var(--dsw-alias-border-l3,rgba(0,0,0,.1));overflow:hidden}',
        '.ogq-bar-fill{height:100%;border-radius:999px;transition:width .35s ease}',
        '.ogq-row-foot{display:flex;gap:10px;flex-wrap:wrap;color:var(--dsw-alias-label-tertiary,#999);font-size:11px;',
        'font-variant-numeric:tabular-nums}',
        '.ogq-foot{color:var(--dsw-alias-label-tertiary,#999);font-size:11px;line-height:1.7;border-top:1px solid ',
        'var(--dsw-alias-border-subtle,rgba(0,0,0,.06));padding-top:10px;display:flex;flex-direction:column;gap:2px}',
        '.ogq-state{display:flex;flex-direction:column;gap:9px;padding:4px 0}',
        '.ogq-state-title{font-weight:600;font-size:13px}',
        '.ogq-state-text{color:var(--dsw-alias-label-secondary,#666);font-size:12px;line-height:1.65;margin:0}',
        '.ogq-state-detail{color:var(--dsw-alias-label-tertiary,#999);font-size:11px;margin:0;line-height:1.5}',
        '.ogq-code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;padding:8px 10px;border-radius:8px;',
        'background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.04));color:var(--dsw-alias-label-secondary,#555);',
        'overflow-x:auto;white-space:pre;margin:0}',
        '.ogq-loading{color:var(--dsw-alias-label-tertiary,#999);font-size:12px;padding:8px 0}',
        // Footer badge: a 26px ring gauge that belongs to the sidebar chrome
        // rather than to a panel, so it keeps its footprint in either state.
        '.ogq-badge-wrap{position:relative;display:flex;align-items:center;justify-content:center}',
        '.ogq-badge{width:26px;height:26px;padding:0;border:0;border-radius:9px;background:transparent;display:flex;',
        'align-items:center;justify-content:center;cursor:pointer;color:var(--dsw-alias-label-secondary,#555)}',
        '.ogq-badge:hover,.ogq-badge:focus-visible{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));',
        'outline:none}',
        '.ogq-ring{width:18px;height:18px;display:block;overflow:visible}',
        '.ogq-ring-track{stroke:var(--dsw-alias-border-l3,rgba(0,0,0,.14))}',
        '.ogq-ring-fill{stroke-linecap:round;transition:stroke-dasharray .4s ease}',
        '.ogq-ring-ok{stroke:var(--dsw-alias-state-success-primary,#12b76a)}',
        '.ogq-ring-warn{stroke:var(--dsw-alias-state-warning-primary,#f79009)}',
        '.ogq-ring-danger{stroke:var(--dsw-alias-state-error-primary,#f04438)}',
        '.ogq-ring-idle{stroke:var(--dsw-alias-label-tertiary,#999)}',
        '.ogq-badge-idle{opacity:.6}',
        // Hover card: fixed so the sidebar's overflow never clips it.
        '.ogq-tip{position:fixed;z-index:80;box-sizing:border-box;padding:10px 12px;border-radius:12px;',
        'border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08));background:var(--dsw-alias-bg-layer-1,#fff);',
        'box-shadow:0 10px 30px rgba(0,0,0,.16);color:var(--dsw-alias-label-primary,#222);font-size:12px;line-height:1.5}',
        '.ogq-tip-head{display:flex;align-items:baseline;gap:8px;margin-bottom:8px}',
        '.ogq-tip-title{font-weight:600;font-size:12px;white-space:nowrap}',
        '.ogq-tip-time{margin-left:auto;color:var(--dsw-alias-label-tertiary,#999);font-size:10px;font-variant-numeric:tabular-nums}',
        '.ogq-tip-rows{display:flex;flex-direction:column;gap:9px}',
        '.ogq-tip-row{display:flex;flex-direction:column;gap:4px}',
        '.ogq-tip-row-head{display:flex;align-items:baseline;gap:6px}',
        '.ogq-tip-name{font-size:11px;color:var(--dsw-alias-label-secondary,#666)}',
        '.ogq-tip-pct{margin-left:auto;font-weight:600;font-size:12px;font-variant-numeric:tabular-nums}',
        '.ogq-tip-ok{color:var(--dsw-alias-state-success-primary,#12b76a)}',
        '.ogq-tip-warn{color:var(--dsw-alias-state-warning-primary,#f79009)}',
        '.ogq-tip-danger{color:var(--dsw-alias-state-error-primary,#f04438)}',
        '.ogq-tip-bar{height:5px;border-radius:999px;background:var(--dsw-alias-border-l3,rgba(0,0,0,.1));overflow:hidden}',
        '.ogq-tip-bar-fill{height:100%;border-radius:999px;transition:width .35s ease}',
        '.ogq-tip-reset{font-size:10px;color:var(--dsw-alias-label-tertiary,#999);font-variant-numeric:tabular-nums}',
        '.ogq-tip-empty{color:var(--dsw-alias-label-secondary,#666);font-size:11px;padding:2px 0 4px}',
        '.ogq-tip-note{margin-top:6px;color:var(--dsw-alias-state-warning-primary,#f79009);font-size:10px}',
        '.ogq-tip-open{margin-top:8px;width:100%;height:24px;border-radius:7px;box-sizing:border-box;',
        'border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));background:transparent;',
        'color:var(--dsw-alias-label-secondary,#555);font-size:11px;cursor:pointer}',
        '.ogq-tip-open:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04))}',
      ].join('');
      let style = document.getElementById(STYLE_ID);
      if (style === null) {
        style = document.createElement('style');
        style.id = STYLE_ID;
        document.head.appendChild(style);
      }
      if (style.textContent !== css) style.textContent = css;
    }

    function pad2(value) {
      return String(value).padStart(2, '0');
    }

    /** `3d 04:12` over a day, `04:12:31` under it; null when already expired. */
    function formatCountdown(ms) {
      if (!Number.isFinite(ms) || ms <= 0) return null;
      const total = Math.floor(ms / 1000);
      const days = Math.floor(total / 86400);
      const hours = Math.floor((total % 86400) / 3600);
      const minutes = Math.floor((total % 3600) / 60);
      const seconds = total % 60;
      if (days > 0) return `${days}d ${pad2(hours)}:${pad2(minutes)}`;
      return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`;
    }

    function clamp(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return null;
      return Math.max(0, Math.min(100, value));
    }

    function formatPercent(value) {
      const bounded = clamp(value);
      if (bounded === null) return '—';
      return Number.isInteger(bounded) ? String(bounded) : bounded.toFixed(1);
    }

    function toneOf(remaining) {
      if (remaining === null) return 'ok';
      if (remaining >= 50) return 'ok';
      if (remaining >= 20) return 'warn';
      return 'danger';
    }

    function formatClock(iso) {
      if (typeof iso !== 'string' || iso === '') return '';
      const date = new Date(iso);
      if (Number.isNaN(date.getTime())) return '';
      return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
    }

    function resetAtMs(windowState) {
      if (!windowState || typeof windowState !== 'object') return null;
      if (typeof windowState.resetsAt === 'string' && windowState.resetsAt !== '') {
        const parsed = Date.parse(windowState.resetsAt);
        if (!Number.isNaN(parsed)) return parsed;
      }
      if (typeof windowState.resetInSec === 'number' && Number.isFinite(windowState.resetInSec)) {
        return Date.now() + windowState.resetInSec * 1000;
      }
      return null;
    }

    function windowRemaining(windowState) {
      if (!windowState || typeof windowState !== 'object') return null;
      const remaining = clamp(windowState.remainingPercent);
      if (remaining !== null) return remaining;
      const used = clamp(windowState.percent);
      return used === null ? null : 100 - used;
    }

    function describeSource(t, keySource) {
      if (typeof keySource !== 'string' || keySource === '') return t('source.none');
      if (keySource === 'config') return t('source.config');
      if (keySource === 'auth.json') return t('source.authFile');
      if (keySource.startsWith('credentials:')) return t('source.credentials', { name: keySource.slice('credentials:'.length) });
      if (keySource.startsWith('env:')) return t('source.env', { name: keySource.slice(4) });
      return keySource;
    }

    /**
     * One shared snapshot for both surfaces. Polling runs only while at least
     * one surface is mounted, and pauses while the document is hidden.
     */
    function createBus() {
      const listeners = new Set();
      let state = { phase: 'init', data: null, error: null, loading: false };
      let timer = null;
      let subscribers = 0;
      let disposed = false;

      const publish = (patch) => {
        state = { ...state, ...patch };
        for (const listener of [...listeners]) {
          try {
            listener(state);
          } catch (error) {
            console.warn('opencode-go-quota: listener failed', error);
          }
        }
      };

      async function load(force) {
        if (disposed || state.loading) return;
        publish({ loading: true });
        try {
          const response = await fetch(force === true ? `${ROUTE}?refresh=1` : ROUTE, {
            headers: { accept: 'application/json' },
            cache: 'no-store',
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const data = await response.json();
          publish({ loading: false, data, error: null, phase: data && data.ok === true ? 'ok' : 'degraded' });
        } catch (error) {
          publish({ loading: false, phase: 'offline', error: error instanceof Error ? error.message : String(error) });
        }
      }

      function onVisibility() {
        if (typeof document !== 'undefined' && !document.hidden) load(false);
      }

      const tick = () => {
        if (typeof document !== 'undefined' && document.hidden) return;
        load(false);
      };

      function start() {
        if (timer !== null || disposed) return;
        load(false);
        timer = setInterval(tick, POLL_MS);
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
      }

      function stop() {
        if (timer !== null) {
          clearInterval(timer);
          timer = null;
        }
        if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
      }

      return {
        get: () => state,
        subscribe(listener) {
          listeners.add(listener);
          subscribers += 1;
          if (subscribers === 1) start();
          return () => {
            listeners.delete(listener);
            subscribers -= 1;
            if (subscribers === 0) stop();
          };
        },
        refresh: () => load(true),
        dispose() {
          disposed = true;
          stop();
          listeners.clear();
        },
      };
    }

    function useBus(bus) {
      const [state, setState] = useState(bus.get());
      useEffect(() => {
        setState(bus.get());
        return bus.subscribe(setState);
      }, [bus]);
      return state;
    }

    function QuotaRow({ t, name, windowState, limit, now }) {
      const remaining = windowRemaining(windowState);
      const used = windowState && typeof windowState.percent === 'number' ? clamp(windowState.percent) : null;
      const tone = toneOf(remaining);
      const resetMs = resetAtMs(windowState);
      const countdown = resetMs === null ? null : formatCountdown(resetMs - now);
      const width = remaining === null ? 0 : remaining;

      return h('div', { className: 'ogq-row' },
        h('div', { className: 'ogq-row-head' },
          h('span', { className: 'ogq-row-name' }, t(`window.${name}`)),
          typeof limit === 'number' && Number.isFinite(limit)
            ? h('span', { className: 'ogq-row-budget' }, t('window.budgetHint', { value: limit }))
            : null,
          h('span', { className: 'ogq-row-pct' },
            remaining === null ? '—' : formatPercent(remaining),
            remaining === null ? null : h('small', null, '%'))),
        h('div', { className: 'ogq-bar' },
          h('div', { className: `ogq-bar-fill ogq-tone-${tone}`, style: { width: `${width}%` } })),
        h('div', { className: 'ogq-row-foot' },
          used === null ? h('span', null, t('window.unknown')) : h('span', null, t('window.used', { value: formatPercent(used) })),
          remaining === null ? null : h('span', null, t('window.remaining', { value: formatPercent(remaining) })),
          countdown === null ? null : h('span', null, t('window.resetIn', { value: countdown }))));
    }

    function SetupState({ t, bus, code, detail }) {
      const unauthorized = code === 'unauthorized';
      const badPayload = code === 'bad_payload';
      const transient = code === 'network' || code === 'timeout' || code === 'host_offline'
        || (typeof code === 'string' && code.startsWith('http_'));
      const title = unauthorized ? t('state.unauthorized')
        : badPayload ? t('state.badPayload')
          : transient ? t('state.offline')
            : t('state.noKey');
      const hint = unauthorized ? t('state.unauthorizedHint')
        : badPayload ? t('state.badPayloadHint')
          : transient ? t('state.offlineHint')
            : t('state.noKeyHint');
      const wantsKey = !unauthorized && !badPayload && !transient;
      // The Host's own message is English and operational: keep it as a small
      // technical line for failures, never as the headline.
      const technical = transient || badPayload ? detail : null;

      return h('div', { className: 'ogq-state' },
        h('div', { className: 'ogq-state-title' }, title),
        h('p', { className: 'ogq-state-text' }, hint),
        wantsKey ? h('pre', { className: 'ogq-code' }, 'OPENCODE_GO_API_KEY=sk-...') : null,
        wantsKey ? h('p', { className: 'ogq-state-text' }, t('state.noKeyConfig')) : null,
        wantsKey ? h('p', { className: 'ogq-state-text' }, t('state.noKeyEnv')) : null,
        technical ? h('p', { className: 'ogq-state-detail' }, technical) : null,
        h('div', null,
          h('button', {
            type: 'button',
            className: 'ogq-btn',
            onClick: () => bus.refresh(),
          }, t('state.retry'))));
    }

    /** Right-sidebar body: the whole quota picture for a narrow column. */
    function QuotaPanel({ t, bus }) {
      const state = useBus(bus);
      const data = state.data;
      const [now, setNow] = useState(() => Date.now());

      useEffect(() => {
        const id = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(id);
      }, []);

      useEffect(() => {
        // The tab keeps a mounted body; make sure it is never stale on arrival.
        if (data === null && !state.loading) bus.refresh();
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);

      const header = h('div', { className: 'ogq-head' },
        h('div', null,
          h('div', { className: 'ogq-title' }, t('panel.title')),
          h('div', { className: 'ogq-sub' }, t('panel.subtitle'))),
        h('div', { className: 'ogq-head-actions' },
          data && data.fetchedAt
            ? h('span', { className: 'ogq-updated' }, t('panel.updated', { time: formatClock(data.fetchedAt) }))
            : null,
          h('button', {
            type: 'button',
            className: 'ogq-btn',
            disabled: state.loading,
            onClick: () => bus.refresh(),
          }, state.loading ? t('panel.refreshing') : t('panel.refresh'))));

      if (data === null) {
        const offline = state.phase === 'offline';
        return h('div', { className: 'ogq-panel' }, header,
          offline
            ? h(SetupState, { t, bus, code: 'host_offline', detail: state.error })
            : h('div', { className: 'ogq-loading' }, t('state.loading')));
      }

      const code = data.error ? data.error.code : null;
      const hasWindows = data.windows !== null && WINDOWS.some((name) => data.windows[name] !== null);
      const banners = [];
      if (state.phase === 'offline') {
        banners.push(h('div', { className: 'ogq-banner ogq-banner-error', key: 'offline' },
          h('span', null, state.error ? `${t('state.hostOffline')} · ${state.error}` : t('state.hostOffline'))));
      }
      if (hasWindows && (data.stale === true || typeof code === 'string')) {
        banners.push(h('div', { className: 'ogq-banner', key: 'stale' },
          h('span', null, t('panel.stale', { time: formatClock(data.fetchedAt) }))));
      }

      const body = hasWindows
        ? h('div', { className: 'ogq-rows' },
          WINDOWS.map((name) => h(QuotaRow, {
            key: name,
            t,
            name,
            windowState: data.windows[name],
            limit: data.limits ? data.limits[name] : null,
            now,
          })))
        : h(SetupState, { t, bus, code, detail: data.error ? data.error.message : null });

      return h('div', { className: 'ogq-panel' },
        header,
        banners,
        body,
        h('div', { className: 'ogq-foot' },
          h('span', null, describeSource(t, data.keySource)),
          h('span', null, t('footer.budgets', {
            rolling: data.limits ? data.limits.rolling : 12,
            weekly: data.limits ? data.limits.weekly : 30,
            monthly: data.limits ? data.limits.monthly : 60,
          })),
          h('span', null, t('footer.hint', { endpoint: data.endpoint ?? '' }))));
    }

    /** Hover card width; clamped to the viewport before it is placed. */
    const TIP_WIDTH = 272;
    /** Rough height used to choose above/below before the card is measured. */
    const TIP_ESTIMATED_HEIGHT = 190;

    /** The live window with the least headroom — what the ring draws. */
    function criticalWindow(data) {
      if (data === null || typeof data !== 'object') return null;
      const windows = data.windows;
      if (windows === null || typeof windows !== 'object') return null;
      let tightest = null;
      for (const name of WINDOWS) {
        const remaining = windowRemaining(windows[name]);
        if (remaining === null) continue;
        if (tightest === null || remaining < tightest.remaining) tightest = { name, remaining };
      }
      return tightest;
    }

    /** One line for the card when no window can be drawn. */
    function badgeStateText(t, data, phase) {
      if (phase === 'offline') return t('state.hostOffline');
      if (data === null || phase === 'init') return t('state.loading');
      const code = data.error ? data.error.code : null;
      if (code === 'no_key') return t('badge.noKey');
      if (code === 'unauthorized') return t('state.unauthorized');
      return code ? t('state.offline') : t('badge.noData');
    }

    /** Place the card above the trigger, or below it when there is no room. */
    function tipPlacement(anchor) {
      if (anchor === null || anchor === undefined || typeof window === 'undefined') return null;
      const width = Math.max(180, Math.min(TIP_WIDTH, window.innerWidth - 16));
      const left = Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8));
      if (anchor.top - TIP_ESTIMATED_HEIGHT - 10 >= 8) {
        return { left, width, bottom: window.innerHeight - anchor.top + 8 };
      }
      return { left, width, top: anchor.bottom + 8 };
    }

    /** One window inside the hover card: name, remaining share, bar, countdown. */
    function TipRow({ t, name, windowState, now }) {
      const remaining = windowRemaining(windowState);
      const tone = toneOf(remaining);
      const resetMs = resetAtMs(windowState);
      const countdown = resetMs === null ? null : formatCountdown(resetMs - now);
      return h('div', { className: 'ogq-tip-row' },
        h('div', { className: 'ogq-tip-row-head' },
          h('span', { className: 'ogq-tip-name' }, t(`window.${name}`)),
          h('span', { className: `ogq-tip-pct ogq-tip-${tone}` },
            remaining === null ? '—' : `${formatPercent(remaining)}%`)),
        h('div', { className: 'ogq-tip-bar' },
          h('div', {
            className: `ogq-tip-bar-fill ogq-tone-${tone}`,
            style: { width: `${remaining === null ? 0 : remaining}%` },
          })),
        countdown === null ? null : h('div', { className: 'ogq-tip-reset' }, t('window.resetIn', { value: countdown })));
    }

    /** The hover/focus card: every window at once, plus the way into the panel. */
    function QuotaTip({ t, data, phase, anchor, now, onOpen }) {
      const placement = tipPlacement(anchor);
      if (placement === null) return null;
      const style = { left: `${placement.left}px`, width: `${placement.width}px` };
      if (placement.bottom === undefined) style.top = `${placement.top}px`;
      else style.bottom = `${placement.bottom}px`;
      const windows = data !== null && data.windows !== null && typeof data.windows === 'object' ? data.windows : null;
      const rows = windows === null ? [] : WINDOWS.filter((name) => windows[name] !== null && windows[name] !== undefined);
      return h('div', { className: 'ogq-tip', style, role: 'dialog', 'aria-label': t('badge.title') },
        h('div', { className: 'ogq-tip-head' },
          h('span', { className: 'ogq-tip-title' }, t('badge.title')),
          data !== null && typeof data.fetchedAt === 'string' && data.fetchedAt !== ''
            ? h('span', { className: 'ogq-tip-time' }, t('badge.updated', { time: formatClock(data.fetchedAt) }))
            : null),
        rows.length > 0
          ? h('div', { className: 'ogq-tip-rows' },
            rows.map((name) => h(TipRow, { key: name, t, name, windowState: windows[name], now })))
          : h('div', { className: 'ogq-tip-empty' }, badgeStateText(t, data, phase)),
        data !== null && data.stale === true ? h('div', { className: 'ogq-tip-note' }, t('badge.stale')) : null,
        h('button', { type: 'button', className: 'ogq-tip-open', onClick: onOpen }, t('badge.open')));
    }

    /**
     * The left sidebar's footer gauge. It shares the panel's poller (`bus`), so
     * the ring stays live whether or not the right tab is open; hovering or
     * focusing explains all three windows, and a click is the only way it opens
     * the panel — the badge is telemetry first, launcher second.
     */
    function QuotaBadge({ t, bus, openTab }) {
      const state = useBus(bus);
      const data = state.data;
      const [open, setOpen] = useState(false);
      const [anchor, setAnchor] = useState(null);
      const [now, setNow] = useState(() => Date.now());
      const buttonRef = React.useRef(null);
      const hideTimer = React.useRef(null);

      const cancelHide = () => {
        if (hideTimer.current !== null) {
          clearTimeout(hideTimer.current);
          hideTimer.current = null;
        }
      };

      const show = () => {
        cancelHide();
        const node = buttonRef.current;
        if (node === null || node === undefined || typeof node.getBoundingClientRect !== 'function') return;
        const rect = node.getBoundingClientRect();
        setAnchor({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom });
        setNow(Date.now());
        setOpen(true);
      };

      // A short grace period lets the pointer cross the gap into the card
      // instead of the card flickering shut on the way.
      const hideSoon = () => {
        cancelHide();
        hideTimer.current = setTimeout(() => {
          hideTimer.current = null;
          setOpen(false);
        }, 120);
      };

      const hideNow = () => {
        cancelHide();
        setOpen(false);
      };

      useEffect(() => () => cancelHide(), []);

      useEffect(() => {
        if (!open) return undefined;
        const id = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(id);
      }, [open]);

      useEffect(() => {
        if (!open) return undefined;
        const onKeyDown = (event) => {
          if (event.key === 'Escape') hideNow();
        };
        window.addEventListener('keydown', onKeyDown);
        window.addEventListener('resize', hideNow);
        return () => {
          window.removeEventListener('keydown', onKeyDown);
          window.removeEventListener('resize', hideNow);
        };
      }, [open]);

      const tightest = criticalWindow(data);
      const remaining = tightest === null ? null : tightest.remaining;
      const tone = tightest === null ? 'idle' : toneOf(remaining);
      const label = remaining === null
        ? t('badge.ariaEmpty')
        : t('badge.aria', { value: formatPercent(remaining) });

      return h('div', {
        className: 'ogq-badge-wrap',
        onMouseEnter: show,
        onMouseLeave: hideSoon,
        onFocus: show,
        onBlur: hideSoon,
      },
        h('button', {
          type: 'button',
          ref: buttonRef,
          className: `ogq-badge${data === null ? ' ogq-badge-idle' : ''}`,
          'aria-label': label,
          'aria-expanded': open,
          onClick: () => {
            hideNow();
            openTab();
          },
        },
          h('svg', { viewBox: '0 0 24 24', className: 'ogq-ring', 'aria-hidden': 'true', focusable: 'false' },
            h('circle', { className: 'ogq-ring-track', cx: 12, cy: 12, r: 9, fill: 'none', strokeWidth: 3 }),
            h('circle', {
              className: `ogq-ring-fill ogq-ring-${tone}`,
              cx: 12,
              cy: 12,
              r: 9,
              fill: 'none',
              strokeWidth: 3,
              pathLength: 100,
              strokeDasharray: `${remaining === null ? 0 : Math.max(0, Math.min(100, remaining))} 100`,
              transform: 'rotate(-90 12 12)',
            }))),
        open ? h(QuotaTip, {
          t,
          data,
          phase: state.phase,
          anchor,
          now,
          onOpen: () => {
            hideNow();
            openTab();
          },
        }) : null);
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ensureStyle();
        const t = createT(ctx);
        const bus = createBus();

        if (typeof ctx.effect === 'function') ctx.effect(() => () => bus.dispose(), 'dsh-opencode-go-quota: poller');
        else ctx.on?.('dispose', () => bus.dispose());

        // The right Sidebar contributes its services in its own apply, which may run
        // after this bundle; `ctx.inject` waits for them instead of racing.
        try {
          ctx.inject(['sidebarRightTabs', 'sidebarRight'], (scope) => {
            scope.effect(() => scope.sidebarRightTabs.register({
              id: TAB_TYPE_ID,
              kind: TAB_KIND,
              priority: 'extension',
              keepMounted: true,
              title: () => t('tab.title'),
              guide: [{
                id: TAB_TYPE_ID,
                order: 30,
                title: () => t('tab.title'),
                description: () => t('panel.subtitle'),
              }],
            }), 'dsh-opencode-go-quota: tab type');

            scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register({
              name: 'sidebar.right.pane.tab',
              key: TAB_TYPE_ID,
              locale: NS,
              // The seat's injected face is a factory; the tab reader it wants is the
              // framework's own, so the body just forwards it.
              inject: () => ({ hooks: { tabInfo: (_standard, useTabInfo) => useTabInfo } }),
            }, () => h(QuotaPanel, { t, bus })));
          });
        } catch (error) {
          console.warn('opencode-go-quota: right-sidebar registration failed', error);
        }

        // Footer gauge, click target first: the tab type is opened through the
        // Sidebar Right service, which arrives after this bundle (never predict
        // its load order — bind when it is there).
        let openQuotaTab = () => {};
        try {
          ctx.inject(['sidebarRight'], (scope) => {
            openQuotaTab = () => {
              try {
                scope.sidebarRight.openTab(TAB_KIND);
              } catch (error) {
                console.warn('opencode-go-quota: opening the quota panel failed', error);
              }
            };
          });
        } catch (error) {
          console.warn('opencode-go-quota: right-sidebar service unavailable', error);
        }

        // `sidebar.footer.action` is a list slot, so the gauge sits beside
        // whatever else the profile puts in the sidebar footer.
        try {
          ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
            name: 'sidebar.footer.action',
            id: 'opencode-go-quota-badge',
            order: 20,
          }, () => h(QuotaBadge, { t, bus, openTab: () => openQuotaTab() })));
        } catch (error) {
          console.warn('opencode-go-quota: footer badge registration failed', error);
        }
      },
    };
  },
});
