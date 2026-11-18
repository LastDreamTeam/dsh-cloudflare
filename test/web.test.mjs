import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { ConnectionTestError } from '../src/connections.mjs';
import { registerWeb } from '../src/web.mjs';

test('settings endpoints check the DSH browser session and keep credentials write-only', async (t) => {
  const routes = new Map();
  const connection = {
    requestRejection: req => req.headers.cookie === 'test-session=ok' ? undefined : 401,
  };
  const pendingOAuth = {
    id: 'id-2', label: null, kind: 'oauth', status: 'pending', tokens: { access_token: 'private-token' },
  };
  const oauthUrl = 'https://mcp.cloudflare.com/authorize?state=test-only';
  const verifiedOAuth = {
    ...pendingOAuth,
    label: 'Work',
    status: 'connected',
    identity: { id: 'user:id-2', name: 'Work', clientSecret: 'private-client-secret' },
    grantedScopes: ['zone.read', 'dns.write'],
  };
  const publicPending = { id: 'id-2', label: null, kind: 'oauth', status: 'pending' };
  const publicVerified = {
    ...publicPending,
    label: 'Work',
    status: 'connected',
    identity: { id: 'user:id-2', name: 'Work' },
    grantedScopes: ['zone.read', 'dns.write'],
  };
  let status = 'pending';
  const service = {
    listConnections: () => [{
      id: 'id-1',
      label: 'Work',
      kind: 'token',
      status: 'unknown',
      apiToken: 'private-token',
      identity: { id: 'user-1', clientSecret: 'private-client-secret' },
    }],
    addConnection(args) {
      assert.deepEqual(args, { label: 'Second', apiToken: 'private-token' });
      throw new Error('Upstream failure: private-token');
    },
    startOAuth(args) {
      assert.equal(args?.id, undefined);
      assert.equal(args?.scope, undefined);
      return { authorizeUrl: oauthUrl, connection: pendingOAuth };
    },
    testConnection({ id }) {
      assert.equal(id, 'id-2');
      if (status === 'pending') throw new ConnectionTestError('authorizationPending', pendingOAuth);
      if (status === 'failed') throw new ConnectionTestError('testFailed', { ...verifiedOAuth, status: 'error' });
      return verifiedOAuth;
    },
  };
  const dispose = registerWeb({
    get: key => key === 'connection' ? connection : undefined,
    webServer: {
      register(route) {
        assert.equal(route.auth, 'required');
        routes.set(route.path, route.handler);
        return () => routes.delete(route.path);
      },
    },
  }, service);
  const base = '/api/lastdreamteam/cloudflare';
  const server = createServer((req, res) => routes.get(req.url)(req, res));
  t.after(() => { dispose(); server.close(); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const listUrl = origin + base + '/connections';
  const headers = {
    'X-DSH-Cloudflare': 'settings',
    Cookie: 'test-session=ok',
  };

  assert.equal((await fetch(listUrl)).status, 403);
  assert.equal((await fetch(listUrl, { headers: { 'X-DSH-Cloudflare': 'settings' } })).status, 401);
  assert.equal((await fetch(listUrl, { headers: { ...headers, Origin: 'https://example.invalid' } })).status, 403);
  assert.equal((await fetch(listUrl, { headers: { ...headers, 'Sec-Fetch-Site': 'cross-site' } })).status, 403);

  const reply = await fetch(listUrl, { headers });
  assert.equal(reply.status, 200);
  assert.equal(reply.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await reply.json(), {
    connections: [{ id: 'id-1', label: 'Work', kind: 'token', status: 'unknown', identity: { id: 'user-1' } }],
  });

  const failure = await fetch(origin + base + '/add', {
    method: 'POST',
    headers: { ...headers, Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ label: 'Second', apiToken: 'private-token' }),
  });
  assert.equal(failure.status, 400);
  assert.deepEqual(await failure.json(), { error: 'operationFailed' });

  const post = (path, body) => fetch(origin + base + path, {
    method: 'POST',
    headers: { ...headers, Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const started = await post('/authorize', {});
  assert.equal(started.status, 200);
  assert.deepEqual(await started.json(), { authorizeUrl: oauthUrl, connection: publicPending });

  const pending = await post('/test', { id: 'id-2' });
  assert.equal(pending.status, 409);
  assert.deepEqual(await pending.json(), { error: 'authorizationPending', connection: publicPending });

  status = 'verified';
  const verified = await post('/test', { id: 'id-2' });
  assert.equal(verified.status, 200);
  assert.deepEqual(await verified.json(), { connection: publicVerified });

  status = 'failed';
  const failed = await post('/test', { id: 'id-2' });
  assert.equal(failed.status, 502);
  assert.deepEqual(await failed.json(), { error: 'testFailed', connection: { ...publicVerified, status: 'error' } });
});
