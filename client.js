window.__ModuleLoader__.load({
  id: '@yhong91/dsh-llm-wiki',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const PANEL_ID = 'llm-wiki';
    const NS = 'llm-wiki-dashboard';
    const messages = {
      en: {
        panel: 'Wiki',
        title: 'Wiki',
        subtitle: 'Read-only view of the wiki vault used by this session.',
        refresh: 'Refresh',
        loading: 'Loading dashboard…',
        error: 'Dashboard unavailable',
        recentActivity: 'Recent activity',
        pages: 'Pages',
        size: 'Size',
        fresh: 'Last touch',
        queue: 'Raw queue',
        links: 'Zero backlinks',
        events: 'Events (7d)',
        embeddings: 'Embeddings',
        types: 'Page types',
        activity: 'Activity · last 7 days',
        recent: 'Recent pages',
        noRecent: 'No pages yet.',
        noEvents: 'No recent events.',
        readOnly: 'read-only',
        updated: 'updated',
        retry: 'Retry',
        settings: 'Settings',
        taskModel: 'Background task model',
        taskModelHint: 'Model used for wiki background synthesis (ingest). Default: session model.',
        sessionModel: 'Session model (default)',
        apply: 'Apply',
        clearModel: 'Reset',
        modelApplied: 'Background model updated: ',
        modelCleared: 'Background model reset to session model.',
        modelError: 'Could not update the background model.',
        modelSelect: 'Select a model…',
      },
      zh: {
        panel: '知识库',
        title: '知识库',
        subtitle: '当前会话所用 Wiki vault 的只读概览。',
        refresh: '刷新',
        loading: '正在加载看板…',
        error: '看板暂不可用',
        recentActivity: '最近活动',
        pages: '页面',
        size: '大小',
        fresh: '最近更新',
        queue: '待处理源',
        links: '零入链页面',
        events: '近 7 天事件',
        embeddings: '向量索引',
        types: '页面类型',
        activity: '近 7 天活动',
        recent: '最近页面',
        noRecent: '还没有页面。',
        noEvents: '没有最近活动。',
        readOnly: '只读',
        updated: '更新于',
        retry: '重试',
        settings: '设置',
        taskModel: '后台任务模型',
        taskModelHint: 'Wiki 后台合成（资料摄取）使用的模型，默认跟随会话模型。',
        sessionModel: '会话模型（默认）',
        apply: '应用',
        clearModel: '重置',
        modelApplied: '后台模型已更新：',
        modelCleared: '后台模型已重置为会话模型。',
        modelError: '后台模型更新失败。',
        modelSelect: '选择模型…',
      },
    };

    const CSS = `
      .llm-wiki-dashboard { height: 100%; overflow: auto; padding: 28px 32px 48px; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-size: 14px; }
      .llm-wiki-dashboard * { box-sizing: border-box; }
      .llm-wiki-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; margin-bottom: 24px; }
      .llm-wiki-title { margin: 0; font-size: 24px; line-height: 1.2; font-weight: 650; letter-spacing: -.02em; }
      .llm-wiki-sub { margin: 8px 0 0; color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 1.5; overflow-wrap: anywhere; }
      .llm-wiki-badge { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 999px; padding: 4px 10px; color: var(--dsw-alias-label-secondary); font-size: 11px; white-space: nowrap; }
      .llm-wiki-refresh { font: inherit; cursor: pointer; color: var(--dsw-alias-brand-primary); background: transparent; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; padding: 7px 12px; }
      .llm-wiki-refresh:hover { background: var(--dsw-alias-bg-layer-1); }
      .llm-wiki-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 24px; }
      .llm-wiki-card { min-width: 0; border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; background: var(--dsw-alias-bg-layer-1); padding: 14px 16px; }
      .llm-wiki-card-label { color: var(--dsw-alias-label-secondary); font-size: 12px; margin-bottom: 7px; }
      .llm-wiki-card-value { font-size: 22px; line-height: 1.15; font-weight: 650; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
      .llm-wiki-card-note { color: var(--dsw-alias-label-secondary); font-size: 11px; margin-top: 6px; }
      .llm-wiki-section { border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; background: var(--dsw-alias-bg-layer-1); padding: 18px 20px; margin-bottom: 16px; }
      .llm-wiki-section-title { margin: 0 0 14px; font-size: 14px; font-weight: 650; }
      .llm-wiki-chips { display: flex; flex-wrap: wrap; gap: 8px; }
      .llm-wiki-chip { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 999px; padding: 4px 9px; color: var(--dsw-alias-label-secondary); font-size: 12px; }
      .llm-wiki-chip strong { color: var(--dsw-alias-label-primary); font-weight: 650; }
      .llm-wiki-list { display: grid; gap: 0; }
      .llm-wiki-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 16px; padding: 12px 0; border-top: 1px solid var(--dsw-alias-border-l1); }
      .llm-wiki-row:first-child { border-top: 0; padding-top: 0; }
      .llm-wiki-row-title { font-weight: 550; line-height: 1.4; overflow-wrap: anywhere; }
      .llm-wiki-row-meta { color: var(--dsw-alias-label-secondary); font-size: 11px; margin-top: 5px; }
      .llm-wiki-row-excerpt { color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 1.55; margin-top: 6px; max-height: 38px; overflow: hidden; }
      .llm-wiki-row-side { color: var(--dsw-alias-label-secondary); font-size: 11px; white-space: nowrap; text-align: right; }
      .llm-wiki-empty { color: var(--dsw-alias-label-secondary); font-size: 13px; padding: 8px 0; }
      .llm-wiki-error { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }
      .llm-wiki-model-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
      .llm-wiki-select { font: inherit; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; padding: 7px 10px; min-width: 220px; max-width: 100%; }
      .llm-wiki-select:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
      .llm-wiki-model-note { color: var(--dsw-alias-label-secondary); font-size: 12px; margin-top: 8px; overflow-wrap: anywhere; }
      .llm-wiki-model-status { font-size: 12px; margin-top: 8px; }
      .llm-wiki-model-status.ok { color: var(--dsw-alias-state-success-primary, var(--dsw-alias-label-secondary)); }
      .llm-wiki-model-status.err { color: var(--dsw-alias-state-error-primary); }
      .llm-wiki-refresh[disabled] { opacity: 0.5; cursor: default; }
      @media (max-width: 720px) { .llm-wiki-dashboard { padding: 20px 16px 36px; } .llm-wiki-head { flex-direction: column; } }
    `;

    function icon(size, active) {
      return h('svg', {
        width: size || 20,
        height: size || 20,
        viewBox: '0 0 24 24',
        fill: 'none',
        'aria-hidden': true,
        style: { display: 'block', opacity: active ? 1 : 0.78 },
      }, [
        h('path', { key: 'book', d: 'M4 4.5A2.5 2.5 0 0 1 6.5 2H20v18H6.5A2.5 2.5 0 0 0 4 22V4.5Z', stroke: 'currentColor', strokeWidth: '1.7', strokeLinejoin: 'round' }),
        h('path', { key: 'line', d: 'M8 7h8M8 11h8M8 15h5', stroke: 'currentColor', strokeWidth: '1.7', strokeLinecap: 'round' }),
      ]);
    }

    function DashboardIcon(props) {
      return icon(props.size, props.active);
    }

    function localeText(ctx, key, fallback) {
      try {
        const value = ctx.locale?.bind?.(NS)?.(key);
        return typeof value === 'string' && value ? value : fallback;
      } catch {
        return fallback;
      }
    }

    let tr = (key, fallback) => fallback;

    function Card({ label, value, note }) {
      return h('div', { className: 'llm-wiki-card' }, [
        h('div', { className: 'llm-wiki-card-label', key: 'l' }, label),
        h('div', { className: 'llm-wiki-card-value', key: 'v' }, value),
        note ? h('div', { className: 'llm-wiki-card-note', key: 'n' }, note) : null,
      ]);
    }

    function Chips({ pairs }) {
      if (!pairs.length) return h('div', { className: 'llm-wiki-empty' }, '—');
      return h('div', { className: 'llm-wiki-chips' }, pairs.map(([key, value]) => h(
        'span',
        { className: 'llm-wiki-chip', key },
        [h('strong', { key: 'v' }, String(value)), h('span', { key: 'k' }, key)],
      )));
    }

    function ModelSettings() {
      const [state, setState] = React.useState({ loading: true, data: null, error: '' });
      const [choice, setChoice] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [status, setStatus] = React.useState(null); // { ok: boolean, text: string }

      const load = React.useCallback(async () => {
        try {
          const response = await fetch('api/llm-wiki/model', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({}),
          });
          const payload = await response.json();
          if (!response.ok || !payload?.ok) throw new Error(payload?.error?.message || response.statusText);
          const data = payload.value;
          setState({ loading: false, data, error: '' });
          const current = data.taskModel ? `${data.taskModel.provider}/${data.taskModel.id}` : '';
          setChoice(current);
        } catch (error) {
          setState({ loading: false, data: null, error: error instanceof Error ? error.message : String(error) });
        }
      }, []);

      React.useEffect(() => { load(); }, [load]);

      const send = async (body) => {
        setBusy(true);
        setStatus(null);
        try {
          const response = await fetch('api/llm-wiki/model', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          });
          const payload = await response.json();
          if (!response.ok || !payload?.ok) throw new Error(payload?.error?.message || response.statusText);
          const data = payload.value;
          setState({ loading: false, data, error: '' });
          const current = data.taskModel ? `${data.taskModel.provider}/${data.taskModel.id}` : '';
          setChoice(current);
          setStatus({ ok: true, text: current ? `${tr('modelApplied', 'Background model updated: ')}${current}` : tr('modelCleared', 'Background model reset to session model.') });
        } catch (error) {
          setStatus({ ok: false, text: `${tr('modelError', 'Could not update the background model.')} ${error instanceof Error ? error.message : String(error)}` });
        } finally {
          setBusy(false);
        }
      };

      if (state.loading) return null;
      if (state.error) {
        return h('div', { className: 'llm-wiki-section', key: 'model' }, [
          h('h2', { className: 'llm-wiki-section-title', key: 't' }, tr('taskModel', 'Background task model')),
          h('div', { className: 'llm-wiki-empty', key: 'e' }, state.error),
        ]);
      }

      const data = state.data;
      const options = [
        h('option', { key: 'session', value: '' }, tr('sessionModel', 'Session model (default)')),
        ...(data?.catalog || []).map((entry, index) => entry.id
          ? h('option', { key: `m-${index}`, value: `${entry.provider}/${entry.id}` }, `${entry.provider}/${entry.id}`)
          : h('option', { key: `p-${index}`, value: `${entry.provider}/` }, `${entry.provider} · ${tr('modelSelect', 'Select a model…')}`)),
      ].filter((option, index, all) => all.findIndex((other) => other.props.value === option.props.value) === index);

      return h('div', { className: 'llm-wiki-section', key: 'model' }, [
        h('h2', { className: 'llm-wiki-section-title', key: 't' }, tr('taskModel', 'Background task model')),
        h('div', { className: 'llm-wiki-model-row', key: 'row' }, [
          h('select', {
            key: 'select',
            className: 'llm-wiki-select',
            value: choice,
            disabled: busy,
            onChange: (event) => setChoice(event.target.value),
          }, options),
          h('button', {
            key: 'apply',
            className: 'llm-wiki-refresh',
            type: 'button',
            disabled: busy || !choice,
            onClick: () => send({ action: 'set', model: choice }),
          }, tr('apply', 'Apply')),
          h('button', {
            key: 'clear',
            className: 'llm-wiki-refresh',
            type: 'button',
            disabled: busy || !data?.taskModel,
            onClick: () => send({ action: 'clear' }),
          }, tr('clearModel', 'Reset')),
        ]),
        h('div', { className: 'llm-wiki-model-note', key: 'hint' }, tr('taskModelHint', 'Model used for wiki background synthesis (ingest). Default: session model.')),
        status ? h('div', { className: `llm-wiki-model-status ${status.ok ? 'ok' : 'err'}`, key: 'status' }, status.text) : null,
      ]);
    }

    function DashboardPage() {
      const [state, setState] = React.useState({ loading: true, data: null, error: '' });
      const [tick, setTick] = React.useState(0);

      React.useEffect(() => {
        let cancelled = false;
        const load = async () => {
          try {
            const response = await fetch('api/llm-wiki/dashboard', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({}),
            });
            const payload = await response.json();
            if (!response.ok || !payload?.ok) throw new Error(payload?.error?.message || response.statusText);
            if (!cancelled) setState({ loading: false, data: payload.value, error: '' });
          } catch (error) {
            if (!cancelled) setState({ loading: false, data: null, error: error instanceof Error ? error.message : String(error) });
          }
        };
        load();
        const timer = setInterval(load, 30_000);
        return () => { cancelled = true; clearInterval(timer); };
      }, [tick]);

      const data = state.data;
      const stats = data?.stats;
      const typePairs = stats ? Object.entries(stats.byType || {}).sort((a, b) => b[1] - a[1]).slice(0, 8) : [];
      const eventPairs = stats ? Object.entries(stats.last7dByKind || {}).sort((a, b) => b[1] - a[1]).slice(0, 8) : [];

      return h('div', { className: 'llm-wiki-dashboard' }, [
        h('div', { className: 'llm-wiki-head', key: 'head' }, [
          h('div', { key: 'txt' }, [
            h('h1', { className: 'llm-wiki-title', key: 't' }, tr('title', 'Wiki')),
            h('p', { className: 'llm-wiki-sub', key: 's' }, state.data?.stats?.root
              ? `${state.data.stats.root} · ${state.data.stats.pageCount} ${tr('pages', 'pages')}${state.data.topic ? ` · ${state.data.topic}` : ''}`
              : tr('loading', 'Loading dashboard…')),
          ]),
          h('div', { key: 'actions', style: { display: 'flex', gap: 8, alignItems: 'center' } }, [
            h('span', { className: 'llm-wiki-badge', key: 'badge' }, tr('readOnly', 'read-only')),
            h('button', { className: 'llm-wiki-refresh', key: 'refresh', type: 'button', onClick: () => setTick((value) => value + 1) }, tr('refresh', 'Refresh')),
          ]),
        ]),
        state.loading ? h('div', { className: 'llm-wiki-empty', key: 'loading' }, tr('loading', 'Loading dashboard…')) : null,
        state.error ? h('div', { className: 'llm-wiki-section llm-wiki-error', key: 'error' }, [
          h('div', { className: 'llm-wiki-section-title', key: 't' }, tr('error', 'Dashboard unavailable')),
          h('div', { className: 'llm-wiki-empty', key: 'e' }, state.error),
        ]) : null,
        stats ? h('div', { className: 'llm-wiki-grid', key: 'cards' }, [
          h(Card, { key: 'pages', label: tr('pages', 'Pages'), value: String(stats.pageCount) }),
          h(Card, { key: 'size', label: tr('size', 'Size'), value: `${stats.sizeKB} KB` }),
          h(Card, { key: 'fresh', label: tr('fresh', 'Last touch'), value: stats.lastTouch || '—' }),
          h(Card, { key: 'queue', label: tr('queue', 'Raw queue'), value: String(stats.rawQueue) }),
          h(Card, { key: 'links', label: tr('links', 'Zero backlinks'), value: String(stats.zeroBacklinks) }),
          h(Card, { key: 'events', label: tr('events', 'Events (7d)'), value: `${stats.last7dTotal}/${stats.totalEvents}` }),
          h(Card, { key: 'emb', label: tr('embeddings', 'Embeddings'), value: stats.embEnabled ? `${stats.embFiles}/${stats.pageCount}` : 'off' }),
        ]) : null,
        stats ? h('div', { className: 'llm-wiki-section', key: 'types' }, [
          h('h2', { className: 'llm-wiki-section-title', key: 't' }, tr('types', 'Page types')),
          h(Chips, { key: 'c', pairs: typePairs }),
        ]) : null,
        stats ? h('div', { className: 'llm-wiki-section', key: 'activity' }, [
          h('h2', { className: 'llm-wiki-section-title', key: 't' }, tr('activity', 'Activity · last 7 days')),
          h(Chips, { key: 'c', pairs: eventPairs }),
        ]) : null,
        h(ModelSettings, { key: 'model' }),
        data ? h('div', { className: 'llm-wiki-section', key: 'recent' }, [
          h('h2', { className: 'llm-wiki-section-title', key: 't' }, tr('recent', 'Recent pages')),
          data.recentPages?.length ? h('div', { className: 'llm-wiki-list', key: 'list' }, data.recentPages.map((page) => h(
            'div',
            { className: 'llm-wiki-row', key: page.id },
            [
              h('div', { key: 'main' }, [
                h('div', { className: 'llm-wiki-row-title', key: 'title' }, page.title),
                h('div', { className: 'llm-wiki-row-meta', key: 'meta' }, `${page.type}${page.status ? ` · ${page.status}` : ''}`),
                page.excerpt ? h('div', { className: 'llm-wiki-row-excerpt', key: 'excerpt' }, page.excerpt) : null,
              ]),
              h('div', { className: 'llm-wiki-row-side', key: 'side' }, page.updated || ''),
            ],
          ))) : h('div', { className: 'llm-wiki-empty', key: 'empty' }, tr('noRecent', 'No pages yet.')),
        ]) : null,
        data?.recentEvents?.length ? h('div', { className: 'llm-wiki-section', key: 'events' }, [
          h('h2', { className: 'llm-wiki-section-title', key: 't' }, tr('recentActivity', 'Recent activity')),
          h('div', { className: 'llm-wiki-list', key: 'list' }, data.recentEvents.map((event, index) => h(
            'div',
            { className: 'llm-wiki-row', key: `${event.kind}-${index}` },
            [
              h('div', { key: 'main' }, [
                h('div', { className: 'llm-wiki-row-title', key: 'title' }, event.title),
                h('div', { className: 'llm-wiki-row-meta', key: 'meta' }, event.kind),
              ]),
              h('div', { className: 'llm-wiki-row-side', key: 'side' }, event.timestamp ? event.timestamp.slice(0, 10) : ''),
            ],
          ))),
        ]) : null,
      ]);
    }

    return {
      name: '@yhong91/dsh-llm-wiki-dashboard',
      inject: ['slots', 'locale'],
      apply(ctx) {
        try {
          ctx.locale?.register?.(NS, messages);
        } catch {
          // Locale registration is optional; the component falls back below.
        }

        tr = (key, fallback) => localeText(ctx, key, fallback);

        ctx.effect(() => {
          const style = document.createElement('style');
          style.dataset.plugin = 'llm-wiki-dashboard';
          style.textContent = CSS;
          document.head.appendChild(style);
          return () => style.remove();
        }, 'llm-wiki: dashboard styles');

        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 40,
          label: () => localeText(ctx, 'panel', 'Wiki'),
          locale: NS,
        }, DashboardIcon));

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: NS,
        }, DashboardPage));
      },
    };
  },
});
