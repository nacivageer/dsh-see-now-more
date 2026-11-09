/**
 * dsh-see-now-more — **Client 半侧**：标题栏左上角的一个入口。
 *
 * 点一下 POST 到 Host 半侧的路由（`src/open-window.js`），悬浮窗没起就拉起、
 * 被藏了就显示出来。这样用户不必先让模型调一次 `see_now` 才能看到窗。
 *
 * 不 import 任何 Harness Client 包：按钮是普通 React + 主题 token，
 * 万一 token 改名，最坏结果是样式退化，而不是整块崩掉。
 */

window.__ModuleLoader__.load({
  id: 'dsh-see-now-more',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** 字典命名空间；同一个名字要传给 Slot 注册的 `locale`。 */
    const NS = 'see-now-more';
    const SLOT = 'conversation.header.leading';

    const DICT = {
      en: {
        'action.open': 'Open the see-now floating window',
        'hint.idle': 'Open the see-now floating window',
        'state.opening': 'Opening the see-now window…',
        'state.opened': 'see-now window is up',
        'state.already': 'see-now window was already up — brought it forward',
        'state.failed': 'Could not open the see-now window',
        'label.error': 'failed',
      },
      zh: {
        'action.open': '打开 see-now 悬浮窗',
        'hint.idle': '打开 see-now 悬浮窗',
        'state.opening': '正在打开 see-now 悬浮窗…',
        'state.opened': 'see-now 悬浮窗已打开',
        'state.already': '悬浮窗本来就在，已显示出来',
        'state.failed': '没能打开 see-now 悬浮窗',
        'label.error': '失败',
      },
    };

    const CSS = `
.dsh-see-now-open{display:flex;align-items:center;gap:8px;margin:0 8px 0 0;min-width:0;-webkit-app-region:no-drag}
.dsh-see-now-open__btn{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px 0 8px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;line-height:1;letter-spacing:.01em;cursor:pointer;transition:background-color .12s ease,color .12s ease;max-width:100%}
.dsh-see-now-open__btn:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.dsh-see-now-open__btn:active{background:var(--dsw-alias-bg-layer-1)}
.dsh-see-now-open__btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dsh-see-now-open__btn[disabled]{cursor:progress;color:var(--dsw-alias-state-idle-primary)}
.dsh-see-now-open__btn[data-state=ok]{color:var(--dsw-alias-state-success-primary)}
.dsh-see-now-open__btn[data-state=error]{color:var(--dsw-alias-state-error-primary)}
.dsh-see-now-open__icon{flex:none;display:block}
.dsh-see-now-open__text{white-space:nowrap}
.dsh-see-now-open__note{min-width:0;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--dsw-alias-label-secondary)}
.dsh-see-now-open__note[data-tone=error]{color:var(--dsw-alias-state-error-primary)}
`;

    /** 窗格图标：一块带标题栏和圆点的面板，用 currentColor 画。 */
    function WindowIcon() {
      return h('svg', {
        className: 'dsh-see-now-open__icon',
        viewBox: '0 0 16 16', width: 15, height: 15,
        'aria-hidden': true, focusable: 'false',
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinejoin: 'round',
      },
        h('rect', { x: 1.8, y: 2.9, width: 12.4, height: 10.2, rx: 2 }),
        h('path', { d: 'M1.8 6.1h12.4', strokeLinecap: 'round' }),
        h('circle', { cx: 4.4, cy: 4.5, r: 0.75, fill: 'currentColor', stroke: 'none' }),
      );
    }

    function routeUrl() {
      const relative = 'dsh-see-now-window/open';
      try { return new URL(relative, document.baseURI).pathname; } catch { return `/${relative}`; }
    }

    /** idle → busy → ok/error；成功的提示自己消失，失败的信息留着给人看。 */
    function SeeNowOpen({ t }) {
      const [state, setState] = React.useState('idle');
      const [note, setNote] = React.useState('');
      const clearTimer = React.useRef(null);

      React.useEffect(() => () => { if (clearTimer.current) clearTimeout(clearTimer.current); }, []);

      const open = React.useCallback(async () => {
        if (state === 'busy') return;
        if (clearTimer.current) { clearTimeout(clearTimer.current); clearTimer.current = null; }
        setState('busy');
        setNote(t('state.opening'));

        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        const timer = setTimeout(() => { try { controller?.abort(); } catch { /* already settled */ } }, 60_000);
        try {
          const response = await fetch(routeUrl(), {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: '{}',
            signal: controller ? controller.signal : undefined,
          });
          let body = null;
          try { body = await response.json(); } catch { body = null; }
          if (!response.ok || !body || body.ok !== true) {
            const message = body?.error || `HTTP ${response.status}`;
            setState('error');
            setNote(`${t('state.failed')}：${message}`);
            return;
          }
          setState('ok');
          setNote(body.already ? t('state.already') : t('state.opened'));
          clearTimer.current = setTimeout(() => { setState('idle'); setNote(''); }, 2600);
        } catch (e) {
          setState('error');
          setNote(`${t('state.failed')}：${String(e?.message ?? e)}`);
        } finally {
          clearTimeout(timer);
        }
      }, [state, t]);

      const label = t('action.open');
      return h(React.Fragment, null,
        h('style', { key: 'css' }, CSS),
        h('div', { className: 'dsh-see-now-open', key: 'wrap' },
          h('button', {
            type: 'button',
            className: 'dsh-see-now-open__btn',
            'data-state': state,
            'data-see-now-open': '',
            'aria-label': label,
            title: note || t('hint.idle'),
            disabled: state === 'busy',
            onClick: open,
          },
            h(WindowIcon),
            h('span', { className: 'dsh-see-now-open__text' }, 'see-now'),
          ),
          note
            ? h('span', {
              className: 'dsh-see-now-open__note',
              'data-tone': state === 'error' ? 'error' : 'normal',
              role: state === 'error' ? 'alert' : 'status',
              title: note,
            }, note)
            : null,
        ),
      );
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { en: DICT.en, zh: DICT.zh }), 'see-now-more: dictionaries');
        ctx.effect(
          () => ctx.slots.inject(SLOT, () => ctx.slots.register({ name: SLOT, locale: NS }, SeeNowOpen)),
          'see-now-more: header entry',
        );
      },
    };
  },
});
