// DSH concatenates client bundles and supplies its own React instance to each factory.
window.__ModuleLoader__.load({
  id: 'dsh-cloudflare',
  factory(require) {
    const { createElement: h, useEffect, useRef, useState } = require('react');
    const API = '/api/lastdreamteam/cloudflare';
    const DNS_SCOPE = 'zone.read dns.read dns.write';
    const SCOPE_REFERENCE = 'https://mcp.cloudflare.com/.well-known/oauth-authorization-server';
    const messages = {
      en: {
        title: 'Cloudflare connections',
        intro: 'Give each connection a name so agents can target the right Cloudflare account.',
        add: 'Add connection',
        displayName: 'Connection name',
        authMethod: 'Sign-in method',
        oauth: 'Browser OAuth',
        token: 'API token',
        scope: 'Additional OAuth permissions',
        scopeHelp: 'Separate scopes with spaces. The defaults cover zone lookup and DNS editing.',
        scopeReference: 'Cloudflare scope reference',
        apiToken: 'Cloudflare API token',
        connect: 'Connect',
        save: 'Save',
        cancel: 'Cancel',
        authorize: 'Authorize',
        browser: 'Open Cloudflare authorization',
        check: 'Test connection',
        rename: 'Rename',
        remove: 'Disconnect',
        confirmRemove: 'Remove this connection and its saved credentials from DSH?',
        empty: 'No Cloudflare connections yet.',
        loading: 'Loading connections…',
        connected: 'Connected',
        pending: 'Waiting for browser authorization',
        unknown: 'Not verified',
        error: 'Connection failed',
        localOnly: 'Open Cloudflare settings directly in the local DSH app.',
        invalidRequest: 'DSH rejected this request. Refresh the settings page and try again.',
        operationFailed: 'The operation failed. Check your connection name, Cloudflare authorization, or token and retry.',
        unavailable: 'Could not reach the Cloudflare settings service. Check that the plugin is enabled.',
      },
      zh: {
        title: 'Cloudflare 连接',
        intro: '给每个连接取一个名称，方便 Agent 指定要操作的 Cloudflare 账号。',
        add: '添加连接',
        displayName: '连接名称',
        authMethod: '授权方式',
        oauth: '浏览器 OAuth',
        token: 'API 令牌',
        scope: '附加 OAuth 权限',
        scopeHelp: '多个权限用空格分隔。默认权限支持查询域名与编辑 DNS。',
        scopeReference: 'Cloudflare 权限列表',
        apiToken: 'Cloudflare API 令牌',
        connect: '连接',
        save: '保存',
        cancel: '取消',
        authorize: '授权',
        browser: '打开 Cloudflare 授权页',
        check: '测试连接',
        rename: '改名',
        remove: '断开连接',
        confirmRemove: '从 DSH 移除此连接及其保存的凭据？',
        empty: '尚未添加 Cloudflare 连接。',
        loading: '正在加载连接…',
        connected: '已连接',
        pending: '等待浏览器授权',
        unknown: '尚未验证',
        error: '连接失败',
        localOnly: '请在本机 DSH 应用里打开 Cloudflare 设置。',
        invalidRequest: 'DSH 拒绝了请求。请刷新设置页后重试。',
        operationFailed: '操作失败。请检查连接名称、Cloudflare 授权或 API 令牌后重试。',
        unavailable: '无法连接 Cloudflare 设置服务。请检查插件是否已启用。',
      },
    };

    const control = {
      border: '1px solid var(--dsw-alias-border-l2)',
      background: 'var(--dsw-alias-bg-layer-1)',
      color: 'var(--dsw-alias-label-primary)',
      borderRadius: 7,
      padding: '6px 10px',
      font: 'inherit',
    };
    const styles = {
      section: { display: 'grid', gap: 14, width: '100%', maxWidth: 680, fontSize: 13 },
      card: { border: '1px solid var(--dsw-alias-border-l1)', padding: 14, borderRadius: 10, display: 'grid', gap: 10 },
      row: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      title: { margin: 0, fontSize: 17, fontWeight: 600 },
      meta: { margin: 0, color: 'var(--dsw-alias-label-secondary)', fontSize: 12, lineHeight: 1.5, overflowWrap: 'anywhere' },
      field: { display: 'grid', gap: 5 },
      button: { ...control, cursor: 'pointer' },
      primary: { ...control, cursor: 'pointer', background: 'var(--dsw-alias-label-primary)', color: 'var(--dsw-alias-bg-base)' },
      link: { color: 'var(--dsw-alias-label-primary)', textDecoration: 'underline' },
      danger: { color: 'var(--dsw-alias-state-error-primary)' },
    };

    async function request(path, payload) {
      const headers = { 'X-DSH-Cloudflare': 'settings' };
      const init = { credentials: 'same-origin', headers };
      if (payload !== undefined) {
        headers['Content-Type'] = 'application/json';
        init.method = 'POST';
        init.body = JSON.stringify(payload);
      }
      const response = await fetch(API + path, init);
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'unavailable');
      return result;
    }

    function connectionButton(text, onClick, disabled, options = {}) {
      const { type = 'button', primary, danger } = options;
      return h('button', {
        type,
        onClick,
        disabled,
        style: { ...(primary ? styles.primary : styles.button), ...(danger ? styles.danger : {}) },
      }, text);
    }

    function field(text, input) {
      return h('label', { style: styles.field }, text, input);
    }

    function authorizationScopes(copy, value, setValue, disabled) {
      return h('div', { style: styles.field },
        field(copy.scope, h('input', {
          value,
          maxLength: 2000,
          onChange: event => setValue(event.target.value),
          spellCheck: false,
          style: control,
          disabled,
        })),
        h('p', { style: styles.meta }, copy.scopeHelp, ' ',
          h('a', { href: SCOPE_REFERENCE, target: '_blank', rel: 'noopener noreferrer', style: styles.link }, copy.scopeReference)));
    }

    function NewConnection({ copy, disabled, add, close }) {
      const [kind, setKind] = useState('oauth');
      const [scope, setScope] = useState(DNS_SCOPE);
      const token = useRef(null);

      return h('form', {
        style: styles.card,
        onSubmit(event) {
          event.preventDefault();
          const label = new FormData(event.currentTarget).get('label').trim();
          if (!label) return;
          const apiToken = token.current?.value.trim();
          if (kind === 'token' && !apiToken) return;
          if (token.current) token.current.value = '';
          add(kind === 'token' ? { label, apiToken } : { label }, scope);
        },
      },
      field(copy.displayName, h('input', { name: 'label', required: true, maxLength: 60, style: control, disabled, autoFocus: true })),
      field(copy.authMethod, h('select', { value: kind, onChange: event => setKind(event.target.value), style: control, disabled },
        h('option', { value: 'oauth' }, copy.oauth), h('option', { value: 'token' }, copy.token))),
      kind === 'oauth'
        ? authorizationScopes(copy, scope, setScope, disabled)
        : field(copy.apiToken, h('input', {
          ref: token, type: 'password', required: true, autoComplete: 'off', spellCheck: false, maxLength: 1024, style: control, disabled,
        })),
      h('div', { style: styles.row },
        connectionButton(copy.connect, undefined, disabled, { type: 'submit', primary: true }),
        connectionButton(copy.cancel, close, disabled)));
    }

    function Connection({ copy, connection, disabled, authorizeUrl, act, authorize }) {
      const { id, label, kind, status, identity } = connection;
      const [action, setAction] = useState('');
      const [scope, setScope] = useState(DNS_SCOPE);
      const oauth = kind === 'oauth';
      const identityLabel = [identity?.name, identity?.email].filter(Boolean).join(' · ') || identity?.id;
      const clear = () => setAction('');

      return h('article', { style: styles.card, 'aria-label': label },
        h('div', { style: styles.row }, h('strong', null, label), h('span', { style: styles.meta }, id)),
        h('p', { role: 'status', style: styles.meta },
          [oauth ? copy.oauth : copy.token, copy[status] ?? copy.unknown, identityLabel].filter(Boolean).join(' · ')),
        status === 'pending' && authorizeUrl &&
          h('a', { href: authorizeUrl, target: '_blank', rel: 'noopener noreferrer', style: styles.link }, copy.browser),
        action === '' && h('div', { style: styles.row },
          ...(oauth && status !== 'pending' ? [connectionButton(copy.authorize, () => setAction('authorize'), disabled)] : []),
          connectionButton(copy.check, () => act('/test', { id }), disabled || status === 'pending'),
          connectionButton(copy.rename, () => setAction('rename'), disabled),
          connectionButton(copy.remove, () => setAction('remove'), disabled, { danger: true })),
        action === 'authorize' && h('div', { style: styles.field },
          authorizationScopes(copy, scope, setScope, disabled),
          h('div', { style: styles.row },
            connectionButton(copy.authorize, async () => { if (await authorize(id, scope)) clear(); }, disabled, { primary: true }),
            connectionButton(copy.cancel, clear, disabled))),
        action === 'rename' && h('form', {
          style: styles.field,
          async onSubmit(event) {
            event.preventDefault();
            const nextLabel = new FormData(event.currentTarget).get('label').trim();
            if (nextLabel && await act('/rename', { id, label: nextLabel })) clear();
          },
        },
        field(copy.displayName, h('input', { name: 'label', defaultValue: label, required: true, maxLength: 60, style: control, disabled, autoFocus: true })),
        h('div', { style: styles.row },
          connectionButton(copy.save, undefined, disabled, { type: 'submit', primary: true }),
          connectionButton(copy.cancel, clear, disabled))),
        action === 'remove' && h('div', { style: styles.field },
          h('p', { style: styles.meta }, copy.confirmRemove),
          h('div', { style: styles.row },
            connectionButton(copy.remove, () => act('/remove', { id }), disabled, { danger: true }),
            connectionButton(copy.cancel, clear, disabled))));
    }

    function Settings({ locale }) {
      const activeLocale = locale?.getLocale?.()?.active ?? navigator.language;
      const copy = activeLocale.toLowerCase().startsWith('zh') ? messages.zh : messages.en;
      const [connections, setConnections] = useState(null);
      const [error, setError] = useState('');
      const [adding, setAdding] = useState(false);
      const [busy, setBusy] = useState(false);
      const [links, setLinks] = useState({});
      const pending = connections?.some(connection => connection.status === 'pending');
      const refreshId = useRef(0);

      async function refresh() {
        const id = ++refreshId.current;
        try {
          const latest = (await request('/connections')).connections;
          if (id !== refreshId.current) return;
          setConnections(latest);
          setLinks(previous => Object.fromEntries(latest
            .filter(connection => connection.status === 'pending' && previous[connection.id])
            .map(connection => [connection.id, previous[connection.id]])));
        } catch (failure) {
          if (id === refreshId.current) setError(failure.message);
        }
      }

      useEffect(() => {
        if (busy) return undefined;
        refresh();
        window.addEventListener('focus', refresh);
        const interval = pending ? setInterval(refresh, 1800) : undefined;
        return () => {
          refreshId.current++;
          window.removeEventListener('focus', refresh);
          clearInterval(interval);
        };
      }, [pending, busy]);

      async function perform(action) {
        refreshId.current++;
        setBusy(true);
        setError('');
        try {
          await action();
          await refresh();
          return true;
        } catch (failure) {
          setError(failure.message);
          return false;
        } finally {
          setBusy(false);
        }
      }

      async function launch(id, scope) {
        const { authorizeUrl } = await request('/authorize', { id, scope });
        setLinks(current => ({ ...current, [id]: authorizeUrl }));
        window.open(authorizeUrl, '_blank', 'noopener,noreferrer');
      }

      function add(payload, scope) {
        perform(async () => {
          const { connection } = await request('/add', payload);
          setAdding(false);
          if (connection.kind === 'oauth') await launch(connection.id, scope);
        });
      }

      return h('section', { style: styles.section, 'aria-busy': busy },
        h('h2', { style: styles.title }, copy.title),
        h('p', { style: styles.meta }, copy.intro),
        error && h('p', { role: 'alert', style: styles.danger }, copy[error] ?? copy.unavailable),
        connections === null && !error && h('p', { role: 'status', style: styles.meta }, copy.loading),
        connections?.length === 0 && h('p', { style: styles.meta }, copy.empty),
        ...(connections ?? []).map(connection => h(Connection, {
          key: connection.id,
          copy,
          connection,
          disabled: busy,
          authorizeUrl: links[connection.id],
          act: (path, payload) => perform(() => request(path, payload)),
          authorize: (id, scope) => perform(() => launch(id, scope)),
        })),
        adding
          ? h(NewConnection, { copy, disabled: busy, add, close: () => setAdding(false) })
          : h('div', { style: styles.row }, connectionButton(copy.add, () => setAdding(true), busy, { primary: true })));
    }

    return {
      inject: ['locale', 'slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section', id: 'cloudflare', order: 331, label: 'Cloudflare',
        }, () => h(Settings, { locale: ctx.locale })));
      },
    };
  },
});
