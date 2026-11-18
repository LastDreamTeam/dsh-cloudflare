import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { registerWeb } from '../src/web.mjs';

test('settings endpoints check the DSH browser session and keep credentials write-only', async (t) => {
  const routes = new Map();
  const connection = {
    requestRejection: req => req.headers.cookie === 'test-session=ok' ? undefined : 401,
  };
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
});
