import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { createRemote } from '../src/remote.mjs';

const origin = 'https://mcp.cloudflare.com';

function cloudflareFixture() {
  const calls = [];
  const registration = [];
  const exchanges = [];
  function rpc(id, result) {
    return Response.json({ jsonrpc: '2.0', id, result });
  }
  async function fetchImpl(url, options) {
    assert.equal(url.origin, origin);
    assert.equal(options.redirect, 'error');
    if (url.pathname === '/.well-known/oauth-protected-resource/mcp') {
      return Response.json({ resource: `${origin}/mcp`, authorization_servers: [origin] });
    }
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      return Response.json({
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
      });
    }
    if (url.pathname === '/register') {
      const entry = { ...JSON.parse(options.body), client_id: `client-${registration.length + 1}` };
      registration.push(entry);
      return Response.json(entry, { status: 201 });
    }
    if (url.pathname === '/token') {
      const params = new URLSearchParams(options.body);
      exchanges.push(params);
      const subject = params.get('code') ?? params.get('refresh_token').slice('refresh-'.length);
      return Response.json({ access_token: subject, refresh_token: `refresh-${subject}`, token_type: 'Bearer', expires_in: 3600 });
    }

    assert.equal(url.pathname, '/mcp');
    if (options.method === 'GET') return new Response(null, { status: 405 });
    const subject = new Headers(options.headers).get('authorization').slice('Bearer '.length);
    const { method, id, params } = JSON.parse(options.body);
    if (method === 'initialize') {
      return rpc(id, { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'mock-cf', version: '1' } });
    }
    if (method.startsWith('notifications/')) return new Response(null, { status: 202 });
    assert.equal(method, 'tools/call');
    calls.push({ name: params.name, args: params.arguments, subject });
    if (params.name === 'whoami') {
      return rpc(id, { content: [], structuredContent: { id: `user:${subject}`, email: `${subject}@example.test` } });
    }
    if (params.arguments?.denied) {
      return new Response(null, { status: 403, headers: { 'WWW-Authenticate': 'Bearer error="insufficient_scope", scope="dns.write"' } });
    }
    return rpc(id, { content: [{ type: 'text', text: `Executed with ${subject}` }] });
  }
  return { calls, exchanges, registration, fetchImpl };
}

function callbackFor(authorization, code) {
  const authorize = new URL(authorization.authorizeUrl);
  const callback = new URL(authorize.searchParams.get('redirect_uri'));
  callback.searchParams.set('state', authorize.searchParams.get('state'));
  callback.searchParams.set('iss', origin);
  callback.searchParams.set('code', code);
  return callback;
}

test('OAuth stages new credentials until state, issuer and account identity are verified', async t => {
  const fixture = cloudflareFixture();
  const original = { apiToken: 'alpha' };
  let read = original;
  const commits = [];
  const notifications = [];
  const remote = createRemote({
    fetchImpl: fixture.fetchImpl,
    readCredentials: async () => read,
    writeCredentials: async (credentials, identity) => {
      read = credentials;
      commits.push(identity);
    },
    validateIdentity: async identity => identity.id === 'user:alpha',
    onAuthorized: async identity => { notifications.push(identity); },
  });
  t.after(() => remote.close());
  assert.equal((await remote.connect()).id, 'user:alpha');

  const first = await remote.startOAuth({ scope: 'zone.read dns.write' });
  const auth = new URL(first.authorizeUrl);
  assert.equal(auth.origin, origin);
  assert.equal(auth.searchParams.get('scope'), 'user:read account:read offline_access zone.read dns.write');
  const callback = callbackFor(first, 'beta');
  assert.equal(callback.hostname, '127.0.0.1');
  const badState = new URL(callback);
  badState.searchParams.set('state', 'invalid');
  assert.equal((await fetch(badState)).status, 400);
  assert.equal(remote.oauthStatus().pending, true);
  assert.equal(fixture.exchanges.length, 0);

  assert.equal((await fetch(callback)).status, 400);
  assert.match(remote.oauthStatus().error, /does not match/);
  assert.equal(commits.length, 0);
  assert.equal(read, original);

  const second = await remote.startOAuth();
  const wrongIssuer = callbackFor(second, 'alpha');
  wrongIssuer.searchParams.set('iss', 'https://wrong.example.test');
  assert.equal((await fetch(wrongIssuer)).status, 400);
  assert.equal(fixture.exchanges.length, 1);
  assert.equal(commits.length, 0);

  const third = await remote.startOAuth();
  assert.equal((await fetch(callbackFor(third, 'alpha'))).status, 200);
  assert.deepEqual(commits.map(identity => identity.id), ['user:alpha']);
  assert.deepEqual(notifications, commits);
  assert.deepEqual(remote.oauthStatus(), { pending: false });
  assert.equal(read.tokens.access_token, 'alpha');
  assert.equal(read.apiToken, undefined);
  assert.equal(fixture.registration.length, 3);
  const verifier = fixture.exchanges[0].get('code_verifier');
  assert.equal(createHash('sha256').update(verifier).digest('base64url'), auth.searchParams.get('code_challenge'));
});

test('MCP sessions isolate credentials and never replay a rejected write', async t => {
  const fixture = cloudflareFixture();
  const create = apiToken => createRemote({ readCredentials: async () => ({ apiToken }), fetchImpl: fixture.fetchImpl });
  const first = create('alpha');
  const second = create('beta');
  t.after(() => Promise.all([first.close(), second.close()]));
  assert.deepEqual((await Promise.all([first.connect(), second.connect()])).map(identity => identity.id), ['user:alpha', 'user:beta']);
  assert.equal((await first.connect()).id, 'user:alpha');
  assert.equal(fixture.calls.filter(call => call.name === 'whoami' && call.subject === 'alpha').length, 1);
  assert.equal((await first.connect({ verify: true })).id, 'user:alpha');
  assert.equal(fixture.calls.filter(call => call.name === 'whoami' && call.subject === 'alpha').length, 2);
  assert.equal((await second.callTool('execute', {})).content[0].text, 'Executed with beta');
  await assert.rejects(first.callTool('execute', { denied: true }), /Required scopes: dns\.write/);
  assert.deepEqual(fixture.calls.filter(call => call.args?.denied), [{ name: 'execute', args: { denied: true }, subject: 'alpha' }]);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(first.callTool('execute', { cancelled: true }, { signal: abort.signal }), /abort/i);
  assert.equal(fixture.calls.some(call => call.args?.cancelled), false);
});

test('closing a connection aborts an in-flight request without replaying it', async t => {
  const fixture = cloudflareFixture();
  const started = Promise.withResolvers();
  let forwards = 0;
  const remote = createRemote({
    readCredentials: async () => ({ apiToken: 'alpha' }),
    async fetchImpl(url, options) {
      if (options.body && JSON.parse(options.body).params?.name === 'execute') {
        forwards++;
        started.resolve();
        return new Promise((resolve, reject) => {
          if (options.signal.aborted) reject(options.signal.reason);
          else options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
        });
      }
      return fixture.fetchImpl(url, options);
    },
  });
  t.after(() => remote.close());
  const failure = assert.rejects(remote.callTool('execute', {}), /check the resource state/);
  await started.promise;
  await remote.close();
  await failure;
  assert.equal(forwards, 1);
  await assert.rejects(remote.connect(), /closed/);
});

test('an expired OAuth token is refreshed before opening an MCP session', async t => {
  const fixture = cloudflareFixture();
  let saved = {
    redirectUrl: 'http://127.0.0.1:4321/cloudflare/oauth/callback',
    clientInformation: { client_id: 'client-existing', issuer: `${origin}/` },
    tokens: { access_token: 'old', refresh_token: 'refresh-alpha', issuer: `${origin}/` },
    expiresAt: Date.now() - 1,
  };
  const remote = createRemote({
    fetchImpl: fixture.fetchImpl,
    readCredentials: async () => saved,
    writeCredentials: async credentials => { saved = credentials; },
  });
  t.after(() => remote.close());
  assert.equal((await remote.connect()).id, 'user:alpha');
  assert.equal(saved.tokens.access_token, 'alpha');
  assert.equal(fixture.exchanges[0].get('grant_type'), 'refresh_token');
  assert.equal(fixture.registration.length, 0);
});
