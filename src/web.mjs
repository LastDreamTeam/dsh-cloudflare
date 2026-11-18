import { ConnectionTestError } from './connections.mjs';

const BASE = '/api/lastdreamteam/cloudflare';
const MAX_BODY_SIZE = 8192;
const LOCAL_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function isLocalRequest(req) {
  if (!LOCAL_ADDRESSES.has(req.socket.remoteAddress)) return false;
  if (req.headers['x-dsh-cloudflare'] !== 'settings') return false;
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin') return false;

  const host = req.headers.host;
  if (!host || !/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host)) return false;
  try {
    const expected = new URL(`${req.socket.encrypted ? 'https' : 'http'}://${host}`);
    return LOCAL_HOSTS.has(expected.hostname)
      && (!req.headers.origin || req.headers.origin === expected.origin);
  } catch {
    return false;
  }
}

function send(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(JSON.stringify(payload));
}

async function readBody(req) {
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') return undefined;
  if (Number(req.headers['content-length']) > MAX_BODY_SIZE) return undefined;

  const chunks = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > MAX_BODY_SIZE) {
      req.resume();
      return undefined;
    }
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return body && typeof body === 'object' && !Array.isArray(body) ? body : undefined;
  } catch {
    return undefined;
  }
}

function view({ id, label, kind, status, identity, error, grantedScopes }) {
  const connection = { id, label, kind, status };
  if (identity) {
    const { id: userId, name, email } = identity;
    connection.identity = { id: userId, name, email };
  }
  if (error) connection.error = error;
  if (grantedScopes) connection.grantedScopes = grantedScopes;
  return connection;
}

function authorizeUrl(value) {
  const url = new URL(value);
  if (url.origin !== 'https://mcp.cloudflare.com' || url.pathname !== '/authorize' || url.username || url.password) {
    throw new Error('Unexpected Cloudflare OAuth URL');
  }
  return url.href;
}

/** Expose account management to the authenticated, local DSH settings page. */
export function registerWeb(ctx, service) {
  const routes = [
    ['/connections', 'GET', async () => ({ connections: (await service.listConnections()).map(view) })],
    ['/add', 'POST', async ({ label, apiToken }) => ({
      connection: view(await service.addConnection({ label, apiToken })),
    })],
    ['/authorize', 'POST', async ({ id }) => {
      const result = await service.startOAuth({ id });
      return { authorizeUrl: authorizeUrl(result.authorizeUrl), connection: view(result.connection) };
    }],
    ['/test', 'POST', async ({ id }) => ({ connection: view(await service.testConnection({ id })) })],
    ['/rename', 'POST', async ({ id, label }) => ({ connection: view(await service.renameConnection({ id, label })) })],
    ['/remove', 'POST', async ({ id }) => { await service.removeConnection({ id }); return {}; }],
  ];

  const disposers = routes.map(([path, method, action]) => ctx.webServer.register({
    kind: 'exact',
    path: `${BASE}${path}`,
    auth: 'required',
    async handler(req, res, peer) {
      if (!isLocalRequest(req)) return send(res, 403, { error: 'localOnly' });
      if (!peer) {
        // DSH 0.2.2-rc.1 authenticates custom HTTP routes through Connection.
        const connection = ctx.get('connection');
        if (!connection?.requestRejection) return send(res, 503, { error: 'unavailable' });
        const rejected = connection.requestRejection(req);
        if (rejected !== undefined) return send(res, rejected, { error: 'unavailable' });
      }
      if (req.method !== method) {
        res.setHeader('Allow', method);
        return send(res, 405, { error: 'invalidRequest' });
      }
      try {
        const input = method === 'POST' ? await readBody(req) : {};
        if (input === undefined) return send(res, 400, { error: 'invalidRequest' });
        return send(res, 200, await action(input));
      } catch (error) {
        if (error instanceof ConnectionTestError) {
          const needsConsent = error.code === 'authorizationPending' || error.code === 'authorizationRequired';
          return send(res, needsConsent ? 409 : 502, { error: error.code, connection: view(error.connection) });
        }
        // SDK failures can contain request details. Keep them out of browser responses.
        return send(res, 400, { error: 'operationFailed' });
      }
    },
  }));

  return () => { for (const dispose of disposers.reverse()) dispose(); };
}
