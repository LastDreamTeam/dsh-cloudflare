// DSH concatenates client bundles and supplies its own React instance to each factory.
window.__ModuleLoader__.load({
  id: 'dsh-cloudflare',
  factory(require) {
    const { createElement: h, useEffect, useRef, useState } = require('react');
    const API = '/api/lastdreamteam/cloudflare';
    const connectionErrors = new Set([
      'authorizationPending', 'authorizationRequired', 'credentialRejected',
      'permissionDenied', 'identityMismatch', 'testFailed',
    ]);
    const messages = {
      en: {
        title: 'Cloudflare accounts',
        intro: 'Connect the Cloudflare accounts you want agents to manage.',
        add: 'Add account',
        addToken: 'Add API token',
        account: 'Cloudflare account',
        pendingAccount: 'Cloudflare account awaiting authorization',
        displayName: 'Connection name',
        tokenName: 'Token name',
        oauth: 'Browser OAuth',
        token: 'API token',
        granted: 'Granted permissions',
        apiToken: 'Cloudflare API token',
        save: 'Save',
        cancel: 'Cancel',
        authorize: 'Authorize again',
        authorizing: 'Opening Cloudflare authorization…',
        browser: 'Open Cloudflare authorization',
        check: 'Test connection',
        testing: 'Testing connection…',
        testSucceeded: 'Connection test passed.',
        testFailed: 'Connection test failed. Check the Cloudflare authorization or API token and retry.',
        authorizationPending: 'Finish authorization in your browser, then test the connection again.',
        authorizationRequired: 'Authorize this account before testing the connection.',
        credentialRejected: 'Cloudflare rejected the credentials. Authorize again or check the API token.',
        permissionDenied: 'Cloudflare denied access. Check the permissions granted to this connection.',
        identityMismatch: 'Cloudflare returned a different account. Sign in with the account linked to this connection.',
        authorizationStartFailed: 'Could not start Cloudflare authorization. Try again.',
        authorizationFailed: 'Cloudflare authorization failed. Authorize the account again.',
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
        title: 'Cloudflare 账号',
        intro: '添加需要由 Agent 管理的 Cloudflare 账号。',
        add: '添加账号',
        addToken: '添加 API 令牌',
        account: 'Cloudflare 账号',
        pendingAccount: '待授权的 Cloudflare 账号',
        displayName: '连接名称',
        tokenName: '令牌名称',
        oauth: '浏览器 OAuth',
        token: 'API 令牌',
        granted: '已授权权限',
        apiToken: 'Cloudflare API 令牌',
        save: '保存',
        cancel: '取消',
        authorize: '重新授权',
        authorizing: '正在打开 Cloudflare 授权页…',
        browser: '打开 Cloudflare 授权页',
        check: '测试连接',
        testing: '正在测试连接…',
        testSucceeded: '连接测试通过。',
        testFailed: '连接测试失败。请检查 Cloudflare 授权或 API 令牌后重试。',
        authorizationPending: '请先在浏览器完成授权，然后再次测试连接。',
        authorizationRequired: '请先授权此账号，再测试连接。',
        credentialRejected: 'Cloudflare 拒绝了凭据。请重新授权或检查 API 令牌。',
        permissionDenied: 'Cloudflare 拒绝访问。请检查此连接已获授权的权限。',
        identityMismatch: 'Cloudflare 返回了另一个账号。请使用已绑定的账号登录。',
        authorizationStartFailed: '无法启动 Cloudflare 授权，请重试。',
        authorizationFailed: 'Cloudflare 授权失败，请重新授权。',
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
      success: { color: 'var(--dsw-alias-state-success-primary)' },
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

    function NewToken({ copy, disabled, add, close }) {
      const token = useRef(null);

      return h('form', {
        style: styles.card,
        onSubmit(event) {
          event.preventDefault();
          const label = new FormData(event.currentTarget).get('label').trim();
          const apiToken = token.current?.value.trim();
          if (!label || !apiToken) return;
          token.current.value = '';
          add({ label, apiToken });
        },
      },
      field(copy.tokenName, h('input', { name: 'label', required: true, maxLength: 80, style: control, disabled, autoFocus: true })),
      field(copy.apiToken, h('input', {
        ref: token, type: 'password', required: true, autoComplete: 'off', spellCheck: false, maxLength: 1024, style: control, disabled,
      })),
      h('div', { style: styles.row },
        connectionButton(copy.save, undefined, disabled, { type: 'submit', primary: true }),
        connectionButton(copy.cancel, close, disabled)));
    }

    function Connection({ copy, connection, disabled, authorizeUrl, act, authorize }) {
      const { id, kind, status, identity, grantedScopes } = connection;
      const [action, setAction] = useState('');
      const [testResult, setTestResult] = useState('');
      const oauth = kind === 'oauth';
      const label = connection.label || (status === 'pending' ? copy.pendingAccount : copy.account);
      const identityLabel = [identity?.name, identity?.email]
        .filter(value => value && value !== label).join(' · ') || (!identity?.name && !identity?.email ? identity?.id : '');
      const clear = () => setAction('');
      const testVisible = testResult && (testResult !== 'authorizationPending' || status === 'pending');

      async function check() {
        setTestResult('testing');
        const passed = await act('/test', { id }, failure => {
          setTestResult(connectionErrors.has(failure.message) ? failure.message : 'testFailed');
        });
        if (passed) setTestResult('testSucceeded');
      }

      function authorizeConnection() {
        setTestResult('');
        authorize(id);
      }

      return h('article', { style: styles.card, 'aria-label': label },
        h('div', { style: styles.row }, h('strong', null, label), h('span', { style: styles.meta }, id)),
        h('p', { role: 'status', style: styles.meta },
          [oauth ? copy.oauth : copy.token, copy[status] ?? copy.unknown, identityLabel].filter(Boolean).join(' · ')),
        status === 'pending' && (authorizeUrl
          ? h('a', { href: authorizeUrl, target: '_blank', rel: 'noopener noreferrer', style: styles.link }, copy.browser)
          : h('div', { style: styles.row }, connectionButton(copy.browser, authorizeConnection, disabled))),
        status === 'error' && !testVisible &&
          h('p', { role: 'alert', style: styles.danger },
            copy[connectionErrors.has(connection.error)
              ? connection.error : oauth ? 'authorizationFailed' : 'testFailed']),
        oauth && grantedScopes?.length > 0 && h('details', { style: styles.meta },
          h('summary', null, copy.granted, ' (', grantedScopes.length, ')'),
          h('p', null, grantedScopes.join(', '))),
        testVisible && h('p', {
          role: 'status',
          style: {
            ...styles.meta,
            ...(testResult === 'testSucceeded' ? styles.success : {}),
            ...(connectionErrors.has(testResult) && testResult !== 'authorizationPending' ? styles.danger : {}),
          },
        }, copy[testResult]),
        action === '' && h('div', { style: styles.row },
          oauth && status !== 'pending' && connectionButton(copy.authorize, authorizeConnection, disabled),
          connectionButton(copy.check, check, disabled),
          !oauth && connectionButton(copy.rename, () => setAction('rename'), disabled),
          connectionButton(copy.remove, () => setAction('remove'), disabled, { danger: true })),
        action === 'rename' && h('form', {
          style: styles.field,
          async onSubmit(event) {
            event.preventDefault();
            const nextLabel = new FormData(event.currentTarget).get('label').trim();
            if (nextLabel && await act('/rename', { id, label: nextLabel })) clear();
          },
        },
        field(copy.displayName, h('input', { name: 'label', defaultValue: label, required: true, maxLength: 80, style: control, disabled, autoFocus: true })),
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
      const [addingToken, setAddingToken] = useState(false);
      const [startingOAuth, setStartingOAuth] = useState(false);
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

      async function perform(action, onFailure) {
        refreshId.current++;
        setBusy(true);
        setError('');
        try {
          await action();
          await refresh();
          return true;
        } catch (failure) {
          if (onFailure) onFailure(failure);
          else setError(failure.message);
          return false;
        } finally {
          setBusy(false);
        }
      }

      function launch(id) {
        // Desktop forwards external HTTPS windows to the system browser. On the Web,
        // reserve the new tab during the click so the authorization request can finish asynchronously.
        const desktop = Boolean(window.dshDesktop);
        const popup = desktop ? null : window.open('about:blank', '_blank');
        if (popup) popup.opener = null;
        setStartingOAuth(true);
        return perform(async () => {
          const { authorizeUrl, connection } = await request('/authorize', id ? { id } : {});
          const url = new URL(authorizeUrl);
          if (url.origin !== 'https://mcp.cloudflare.com' || url.pathname !== '/authorize' || url.username || url.password) {
            throw new Error('authorizationStartFailed');
          }
          setLinks(current => ({ ...current, [connection.id]: url.href }));
          if (desktop) window.open(url.href, '_blank', 'noopener,noreferrer');
          else if (popup && !popup.closed) popup.location.replace(url.href);
        }, failure => {
          popup?.close();
          setError(failure.message === 'localOnly' ? 'localOnly' : 'authorizationStartFailed');
        }).finally(() => setStartingOAuth(false));
      }

      return h('section', { style: styles.section },
        h('h2', { style: styles.title }, copy.title),
        h('p', { style: styles.meta }, copy.intro),
        error && h('p', { role: 'alert', style: styles.danger }, copy[error] ?? copy.unavailable),
        startingOAuth && h('p', { role: 'status', style: styles.meta }, copy.authorizing),
        connections === null && !error && h('p', { role: 'status', style: styles.meta }, copy.loading),
        connections?.length === 0 && h('p', { style: styles.meta }, copy.empty),
        ...(connections ?? []).map(connection => h(Connection, {
          key: connection.id,
          copy,
          connection,
          disabled: busy,
          authorizeUrl: links[connection.id],
          act: (path, payload, onFailure) => perform(() => request(path, payload), onFailure),
          authorize: launch,
        })),
        h('div', { style: styles.row },
          connectionButton(copy.add, () => launch(), busy, { primary: true }),
          !addingToken && connectionButton(copy.addToken, () => setAddingToken(true), busy)),
        addingToken && h(NewToken, {
          copy,
          disabled: busy,
          add: payload => perform(async () => {
            await request('/add', payload);
            setAddingToken(false);
          }),
          close: () => setAddingToken(false),
        }));
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
