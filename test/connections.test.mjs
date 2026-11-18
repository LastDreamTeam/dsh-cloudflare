import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createConnections } from '../src/connections.mjs';
import { apply, buildTools } from '../src/index.mjs';

const FIRST_TOKEN = 'mock_api_token_for_staging';
const FIRST_IDENTITY = { id: 'user:staging', email: 'staging@example.com' };
const SECOND_IDENTITY = { id: 'user:production', name: 'Production account', email: 'production@example.com' };
const GRANTED_SCOPES = ['user:read', 'account:read', 'zone.read', 'dns.write'];
const OAUTH_CREDENTIALS = {
  tokens: { access_token: 'mock_oauth_access', refresh_token: 'mock_oauth_refresh', scope: GRANTED_SCOPES.join(' ') },
  clientInformation: { client_secret: 'mock_oauth_client_secret' },
};
const TOOL_PREFIX = 'mcp__cfapi__';

async function workspace(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-cloudflare-test-'));
  const services = [];
  t.after(async () => {
    await Promise.all(services.map(service => service.close()));
    await rm(directory, { recursive: true, force: true });
  });
  return {
    directory,
    create(profile, makeRemote) {
      const service = createConnections(join(directory, profile), { makeRemote });
      services.push(service);
      return service;
    },
  };
}

function upstream({ startError } = {}) {
  const remotes = [];
  const calls = [];
  const probes = [];
  const identities = new Map([
    [FIRST_TOKEN, FIRST_IDENTITY],
    [OAUTH_CREDENTIALS.tokens.access_token, SECOND_IDENTITY],
  ]);
  return {
    remotes,
    calls,
    probes,
    makeRemote(adapter) {
      let pending = false;
      const remote = {
        ...adapter,
        closed: false,
        oauthStatus: () => ({ pending }),
        async startOAuth() {
          if (startError) throw startError;
          pending = true;
          return { authorizeUrl: 'https://mcp.cloudflare.com/authorize?state=mock-state' };
        },
        async commitAuthorization(credentials, identity, { checked = false } = {}) {
          if (!checked && !await adapter.validateIdentity(identity)) {
            throw new Error('This connection is bound to a different Cloudflare identity.');
          }
          await adapter.writeCredentials(credentials, identity);
          await adapter.onAuthorized(identity);
          pending = false;
        },
        async connect(options) {
          const credentials = adapter.readCredentials();
          const identity = identities.get(credentials.apiToken ?? credentials.tokens?.access_token);
          probes.push({ identity, options });
          if (!identity) throw new Error('Authorize this connection first.');
          return identity;
        },
        async callTool(name, args, options) {
          calls.push({ identity: await remote.connect(), name, args, signal: options?.signal });
          return { content: [{ type: 'text', text: 'mock resource result' }] };
        },
        async close() { remote.closed = true; },
      };
      remotes.push(remote);
      return remote;
    },
  };
}

function agentTools(service) {
  const tools = new Map(buildTools(service).map(tool => [tool.name, tool]));
  return (name) => tools.get(`${TOOL_PREFIX}${name}`);
}

function assertNoCredentials(value) {
  const output = JSON.stringify(value);
  const { tokens, clientInformation } = OAUTH_CREDENTIALS;
  for (const secret of [FIRST_TOKEN, tokens.access_token, tokens.refresh_token, clientInformation.client_secret]) {
    assert.ok(!output.includes(secret), 'Hosted tool or settings output contains a connection credential.');
  }
  assert.doesNotMatch(output, /"(?:credentials|apiToken|access_token|refresh_token|client_secret|authorizeUrl)"/);
}

test('DSH apply registers five Agent tools and keeps settings local, authenticated, and free of credentials', async (t) => {
  const { directory } = await workspace(t);
  const tools = new Map();
  const routes = new Map();
  const cleanups = [];
  const ctx = {
    profileContext: { dir: directory },
    effect(register) { cleanups.push(register()); },
    inject(dependencies, register) {
      assert.deepEqual(dependencies, ['webServer']);
      register(ctx);
    },
    get(service) {
      assert.equal(service, 'connection');
      return {
        requestRejection: request => request.headers.authorization === 'Bearer fake-dsh-session' ? undefined : 401,
      };
    },
    tools: {
      register(tool) {
        tools.set(tool.name, tool);
        return () => tools.delete(tool.name);
      },
    },
    webServer: {
      register(route) {
        routes.set(route.path, route);
        return () => routes.delete(route.path);
      },
    },
  };
  const server = createServer((request, response) => {
    const route = routes.get(request.url);
    if (route) return void route.handler(request, response);
    response.writeHead(404).end();
  });

  try {
    apply(ctx);
    assert.deepEqual([...tools.keys()], ['list_connections', 'whoami', 'docs', 'search', 'execute'].map(name => `${TOOL_PREFIX}${name}`));
    assert.deepEqual(tools.get(`${TOOL_PREFIX}list_connections`).execute(), []);
    assert.ok(routes.has('/api/lastdreamteam/cloudflare/connections'));
    assert.ok(routes.has('/api/lastdreamteam/cloudflare/authorize'));
    for (const route of routes.values()) assert.equal(route.auth, 'required');

    const listening = once(server, 'listening');
    server.listen(0, '127.0.0.1');
    await listening;
    const endpoint = `http://127.0.0.1:${server.address().port}/api/lastdreamteam/cloudflare`;
    const sameOrigin = { 'X-DSH-Cloudflare': 'settings' };
    const authorized = { ...sameOrigin, Authorization: 'Bearer fake-dsh-session' };

    const missingAuth = await fetch(`${endpoint}/connections`, { headers: sameOrigin });
    assert.equal(missingAuth.status, 401);
    await missingAuth.json();
    const crossOrigin = await fetch(`${endpoint}/connections`, { headers: { ...authorized, Origin: 'https://example.com' } });
    assert.equal(crossOrigin.status, 403);
    await crossOrigin.json();

    const added = await fetch(`${endpoint}/add`, {
      method: 'POST',
      headers: { ...authorized, 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'staging', apiToken: FIRST_TOKEN }),
    });
    assert.equal(added.status, 200);
    const addedBody = await added.json();
    const listed = await fetch(`${endpoint}/connections`, { headers: authorized });
    assert.equal(listed.status, 200);
    const listedBody = await listed.json();
    assert.deepEqual(listedBody.connections, [addedBody.connection]);
    assert.deepEqual(tools.get(`${TOOL_PREFIX}list_connections`).execute(), listedBody.connections);
    assertNoCredentials([addedBody, listedBody]);
  } finally {
    if (server.listening) await new Promise(resolve => server.close(resolve));
    for (const cleanup of cleanups.reverse()) cleanup();
  }
  assert.equal(tools.size, 0);
  assert.equal(routes.size, 0);
});

test('Agent tools resolve a single connection and require an explicit choice when another is pending', async (t) => {
  const fixture = await workspace(t);
  const remote = upstream();
  const connections = fixture.create('routing', remote.makeRemote);
  const tool = agentTools(connections);
  await assert.rejects(tool('whoami').execute({}), /add a connection/i);

  const first = connections.addConnection({ label: 'staging', apiToken: FIRST_TOKEN });
  const fallback = await tool('whoami').execute({});
  assert.deepEqual(fallback.structuredContent, FIRST_IDENTITY);
  assertNoCredentials([first, fallback, await connections.testConnection({ id: first.id })]);
  assert.deepEqual(remote.probes.at(-1), { identity: FIRST_IDENTITY, options: { verify: true } });

  const { connection: second } = await connections.startOAuth();
  const pendingList = tool('list_connections').execute({});
  assert.deepEqual(pendingList.map(item => [item.id, item.status]), [[first.id, 'connected'], [second.id, 'pending']]);
  assert.equal(second.label, null);
  assertNoCredentials(pendingList);
  await assert.rejects(tool('whoami').execute({}), /multiple.*connection_id/i);
  await assert.rejects(tool('execute').execute({ code: 'async () => null', account_id: 'cloudflare-account' }), /multiple.*connection_id/i);
  await assert.rejects(tool('whoami').execute({ connection_id: 'missing' }), /not found/i);
  await assert.rejects(tool('whoami').execute({ connection_id: second.id }), /authorize/i);
  await remote.remotes[1].commitAuthorization(OAUTH_CREDENTIALS, SECOND_IDENTITY);

  const signal = new AbortController().signal;
  const executeArgs = { code: 'async () => null', account_id: 'cloudflare-account', truncate: false };
  const docsArgs = { query: 'Cloudflare DNS record TTL' };
  const execution = await tool('execute').execute({ connection_id: first.id, ...executeArgs }, { signal });
  const docs = await tool('docs').execute({ connection_id: second.id, ...docsArgs });
  assert.deepEqual(remote.calls, [
    { identity: FIRST_IDENTITY, name: 'execute', args: executeArgs, signal },
    { identity: SECOND_IDENTITY, name: 'docs', args: docsArgs, signal: undefined },
  ]);
  const list = tool('list_connections').execute({});
  assert.deepEqual(list.map(item => item.identity), [FIRST_IDENTITY, SECOND_IDENTITY]);
  assert.equal(list[1].label, SECOND_IDENTITY.name);
  assert.deepEqual(list[1].grantedScopes, GRANTED_SCOPES);
  assertNoCredentials([execution, docs, list, tool('list_connections').output.render({}, list)]);
});

test('a different OAuth identity cannot replace a verified identity or its saved credentials', async (t) => {
  const fixture = await workspace(t);
  const remote = upstream();
  const service = fixture.create('oauth', remote.makeRemote);
  const { connection } = await service.startOAuth();
  const [session] = remote.remotes;
  await session.commitAuthorization(OAUTH_CREDENTIALS, SECOND_IDENTITY);

  await service.startOAuth({ id: connection.id });
  const replacement = { tokens: { access_token: 'mock_replacement_token' } };
  await assert.rejects(session.commitAuthorization(replacement, FIRST_IDENTITY), /different Cloudflare identity/i);
  // The SQLite write itself rejects a stale callback even if the initial check ran earlier.
  await assert.rejects(session.commitAuthorization(replacement, FIRST_IDENTITY, { checked: true }), /different Cloudflare identity/i);
  assert.deepEqual(session.readCredentials(), OAUTH_CREDENTIALS);
  assert.throws(() => service.renameConnection({ id: connection.id, label: 'Override' }));
  const result = await agentTools(service)('whoami').execute({ connection_id: connection.id });
  assert.deepEqual(result.structuredContent, SECOND_IDENTITY);
  assertNoCredentials([service.listConnections(), result]);
});

test('saved connections are profile-local and removing one clears it and closes its session', async (t) => {
  const fixture = await workspace(t);
  const remote = upstream();
  const first = fixture.create('first', remote.makeRemote);
  const other = fixture.create('other', remote.makeRemote);
  const connection = first.addConnection({ label: 'staging', apiToken: FIRST_TOKEN });
  await first.testConnection({ id: connection.id });
  first.renameConnection({ id: connection.id, label: 'staging-renamed' });
  await first.close();

  assert.deepEqual(other.listConnections(), []);
  await assert.rejects(other.testConnection({ id: connection.id }), /not found/i);
  const restored = fixture.create('first', remote.makeRemote);
  assert.deepEqual(restored.listConnections().map(({ id, label, identity }) => ({ id, label, identity })), [
    { id: connection.id, label: 'staging-renamed', identity: FIRST_IDENTITY },
  ]);
  assert.deepEqual((await restored.testConnection({ id: connection.id })).identity, FIRST_IDENTITY);
  await restored.removeConnection({ id: connection.id });
  assert.equal(remote.remotes.at(-1).closed, true);
  assert.deepEqual(restored.listConnections(), []);
  await assert.rejects(restored.testConnection({ id: connection.id }), /not found/i);

  const replacement = restored.addConnection({ label: 'staging-renamed', apiToken: FIRST_TOKEN });
  assert.notEqual(replacement.id, connection.id);
  assertNoCredentials(restored.listConnections());
  await restored.close();
  const reopened = fixture.create('first', remote.makeRemote);
  assert.deepEqual(reopened.listConnections().map(item => item.id), [replacement.id]);
});

test('OAuth start rolls back a failed draft and a pending test avoids a connection probe', async (t) => {
  const fixture = await workspace(t);
  const failedRemote = upstream({ startError: new Error('Simulated authorization failure') });
  const failed = fixture.create('failed', failedRemote.makeRemote);
  await assert.rejects(failed.startOAuth());
  assert.deepEqual(failed.listConnections(), []);
  assert.equal(failedRemote.remotes[0].closed, true);

  const remote = upstream();
  const service = fixture.create('pending', remote.makeRemote);
  const { connection } = await service.startOAuth();
  await assert.rejects(service.testConnection({ id: connection.id }), error => {
    assert.equal(error.code, 'authorizationPending');
    assert.equal(error.connection.id, connection.id);
    assert.equal(error.connection.status, 'pending');
    assertNoCredentials(error.connection);
    return true;
  });
  assert.deepEqual(remote.probes, []);
  await service.close();

  const reopened = fixture.create('pending', remote.makeRemote);
  await assert.rejects(reopened.testConnection({ id: connection.id }), error => {
    assert.equal(error.code, 'authorizationRequired');
    assert.equal(error.connection.id, connection.id);
    assertNoCredentials(error.connection);
    return true;
  });
  assert.deepEqual(remote.probes, []);
  const restarted = await reopened.startOAuth({ id: connection.id });
  assert.equal(restarted.connection.id, connection.id);
  assert.equal(restarted.connection.status, 'pending');
});

test('saved OAuth connections display a verified identity in place of the legacy nickname', async (t) => {
  const fixture = await workspace(t);
  const remote = upstream();
  assert.throws(() => fixture.create('empty', remote.makeRemote).addConnection({ label: 'Requires a token' }));
  const service = fixture.create('legacy', remote.makeRemote);
  const { connection } = await service.startOAuth();
  const identity = { id: SECOND_IDENTITY.id, email: SECOND_IDENTITY.email };
  await remote.remotes[0].commitAuthorization(OAUTH_CREDENTIALS, identity);
  await service.close();

  const database = new DatabaseSync(join(fixture.directory, 'legacy', 'dsh-cloudflare', 'connections.sqlite'));
  try {
    database.prepare('UPDATE connections SET label = ? WHERE id = ?').run('old nickname', connection.id);
  } finally {
    database.close();
  }

  const reopened = fixture.create('legacy', remote.makeRemote);
  const [saved] = reopened.listConnections();
  assert.equal(saved.label, identity.email);
  assert.deepEqual(saved.grantedScopes, GRANTED_SCOPES);
  assertNoCredentials(saved);
  assert.equal(reopened.addConnection({ label: 'old nickname', apiToken: FIRST_TOKEN }).label, 'old nickname');
});
