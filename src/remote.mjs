import { randomBytes, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { auth } from '@modelcontextprotocol/sdk/client/auth.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const MCP_ENDPOINT = new URL('https://mcp.cloudflare.com/mcp');
const RESOURCE_METADATA = new URL('/.well-known/oauth-protected-resource/mcp', MCP_ENDPOINT);
const LOOPBACK_HOST = '127.0.0.1';
const CALLBACK_PATH = '/cloudflare/oauth/callback';
const BASE_SCOPES = 'user:read account:read offline_access';
const RENEWAL_WINDOW_MS = 30_000;

class RemoteError extends Error {}

function oauthProvider({ credentials, redirectUrl, state, redirect }) {
  let codeVerifier;
  let discovery;
  return {
    redirectUrl,
    clientMetadata: {
      client_name: 'DSH Cloudflare',
      client_uri: 'https://github.com/LastDreamTeam/dsh-cloudflare',
      redirect_uris: [redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    },
    state: () => state,
    clientInformation: () => credentials.clientInformation,
    saveClientInformation: information => { credentials.clientInformation = information; },
    tokens: () => credentials.tokens,
    saveTokens: tokens => {
      credentials.tokens = { scope: credentials.tokens?.scope, ...tokens };
      credentials.expiresAt = Number.isFinite(tokens.expires_in)
        ? Date.now() + tokens.expires_in * 1_000
        : undefined;
    },
    redirectToAuthorization: redirect,
    saveCodeVerifier: verifier => { codeVerifier = verifier; },
    codeVerifier: () => codeVerifier,
    saveDiscoveryState: value => { discovery = value; },
    discoveryState: () => discovery,
    invalidateCredentials: scope => {
      if (scope === 'all' || scope === 'client') delete credentials.clientInformation;
      if (scope === 'all' || scope === 'tokens') delete credentials.tokens;
      if (scope === 'all' || scope === 'verifier') codeVerifier = undefined;
      if (scope === 'all' || scope === 'discovery') discovery = undefined;
    },
  };
}

function scopeList(value) {
  if (typeof value !== 'string' || value.length > 8_000) return [];
  return value.split(/\s+/).filter(scope => /^[a-z][a-z0-9_.:-]{0,100}$/i.test(scope));
}

function sameState(received, expected) {
  if (received?.length !== expected.length) return false;
  const left = Buffer.from(received);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function respond(response, status, message) {
  response.writeHead(status, {
    'Content-Type': 'text/plain; charset=UTF-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    Connection: 'close',
  });
  response.end(message);
}

function identityFrom(result) {
  if (!result.isError) {
    let identity = result.structuredContent;
    if (!identity?.id) {
      const text = result.content?.find(item => item.type === 'text')?.text;
      try { identity = JSON.parse(text); } catch { /* Upstream may return plain error text. */ }
    }
    if (typeof identity?.id === 'string' && /^(user|account):[a-z0-9_-]{1,128}$/i.test(identity.id)) {
      const profile = { id: identity.id };
      if (typeof identity.email === 'string') profile.email = identity.email.slice(0, 254);
      if (typeof identity.name === 'string') profile.name = identity.name.slice(0, 254);
      return profile;
    }
  }
  throw new RemoteError('Cloudflare could not verify the account for this connection.');
}

export function createRemote({
  readCredentials,
  writeCredentials = async () => {},
  validateIdentity = async () => true,
  onAuthorized = async () => {},
  fetchImpl = globalThis.fetch,
  requestTimeoutMs = 120_000,
  oauthTimeoutMs = 300_000,
}) {
  const lifetime = new AbortController();
  let pending;
  let oauthError;
  let session;
  let opening;
  let swapping;
  let generation = 0;
  let refreshRequired = false;

  // All MCP and OAuth HTTP traffic stays on Cloudflare's fixed public origin.
  function cloudflareFetch({ signal, timeout = requestTimeoutMs, mcp = false } = {}) {
    return async (input, init = {}) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.origin !== MCP_ENDPOINT.origin || url.username || url.password) {
        throw new RemoteError('Cloudflare returned an unexpected connection endpoint.');
      }
      const signals = [lifetime.signal, AbortSignal.timeout(timeout), signal, init.signal].filter(Boolean);
      const response = await fetchImpl(url, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.any(signals),
      });
      if (!mcp) return response;

      if (response.status === 401) {
        await response.body?.cancel();
        const error = new RemoteError('Cloudflare rejected the credential. Reconnect it in Cloudflare settings if it has expired.');
        error.status = 401;
        throw error;
      }
      if (response.status === 403) {
        const challenge = response.headers.get('www-authenticate') ?? '';
        const scopes = scopeList(/\bscope="([^"]*)"/i.exec(challenge)?.[1]);
        await response.body?.cancel();
        const detail = scopes.length ? ` Required scopes: ${scopes.join(' ')}.` : '';
        throw new RemoteError(`Cloudflare denied access. Check the permissions for this connection.${detail}`);
      }
      return response;
    };
  }

  async function checkIdentity(identity) {
    if (await validateIdentity(identity) === false) {
      throw new RemoteError('The authorized Cloudflare identity does not match this connection. Add it as a separate connection.');
    }
  }

  async function whoami(client, options) {
    const result = await client.callTool({ name: 'whoami' }, undefined, options);
    const identity = identityFrom(result);
    await checkIdentity(identity);
    return identity;
  }

  async function openSession(credentials, signal) {
    const bearer = credentials.apiToken ?? credentials.tokens?.access_token;
    if (!bearer) throw new RemoteError('Authorize this connection in Cloudflare settings first.');
    const options = { timeout: requestTimeoutMs, signal };
    const client = new Client({ name: 'dsh-cloudflare', version: '2.0.0' });
    const transport = new StreamableHTTPClientTransport(MCP_ENDPOINT, {
      requestInit: { headers: { Authorization: `Bearer ${bearer}` } },
      fetch: cloudflareFetch({ signal, mcp: true }),
    });
    try {
      await client.connect(transport, options);
      const identity = await whoami(client, options);
      return { client, identity, credentials };
    } catch (error) {
      await client.close().catch(() => {});
      if (error instanceof RemoteError) throw error;
      throw new RemoteError('Could not establish a connection to the Cloudflare MCP server.');
    }
  }

  async function refresh(credentials) {
    if (!credentials.tokens?.refresh_token || !credentials.redirectUrl) {
      throw new RemoteError('The Cloudflare authorization expired. Reconnect it in Cloudflare settings.');
    }
    const updated = { ...credentials };
    const provider = oauthProvider({ credentials: updated, redirectUrl: updated.redirectUrl, redirect: () => {} });
    let status;
    try {
      status = await auth(provider, {
        serverUrl: MCP_ENDPOINT,
        resourceMetadataUrl: RESOURCE_METADATA,
        fetchFn: cloudflareFetch({ timeout: 20_000 }),
      });
    } catch {
      throw new RemoteError('Cloudflare rejected the refresh. Reconnect it in Cloudflare settings.');
    }
    if (status !== 'AUTHORIZED') {
      throw new RemoteError('The Cloudflare authorization expired. Reconnect it in Cloudflare settings.');
    }
    return updated;
  }

  function stillValid(credentials) {
    return credentials.apiToken || !credentials.expiresAt || credentials.expiresAt > Date.now() + RENEWAL_WINDOW_MS;
  }

  function getSession() {
    if (lifetime.signal.aborted) throw new RemoteError('This Cloudflare connection has been closed.');
    if (swapping) return swapping.then(getSession, getSession);
    if (session && !refreshRequired && stillValid(session.credentials)) return Promise.resolve(session);
    if (opening) return opening;
    const revision = generation;
    opening = (async () => {
      const credentials = await readCredentials() ?? {};
      const renew = !credentials.apiToken && (refreshRequired || !stillValid(credentials));
      const current = renew ? await refresh(credentials) : credentials;
      // Persist a rotated refresh token even if the subsequent MCP handshake fails.
      if (renew) {
        lifetime.signal.throwIfAborted();
        await writeCredentials(current);
        refreshRequired = false;
      }
      let connected;
      try {
        connected = await openSession(current);
        lifetime.signal.throwIfAborted();
        if (revision !== generation) throw new RemoteError('This Cloudflare connection was changed. Try again.');
        const old = session;
        session = connected;
        await old?.client.close().catch(() => {});
        return connected;
      } catch (error) {
        if (error.status === 401 && !current.apiToken && current.tokens?.refresh_token) refreshRequired = true;
        throw error;
      } finally {
        if (connected && session !== connected) await connected.client.close().catch(() => {});
      }
    })().finally(() => { opening = undefined; });
    return opening;
  }

  function endOAuth(candidate, error) {
    if (pending !== candidate) return;
    pending = undefined;
    oauthError = error;
    clearTimeout(candidate.timer);
    candidate.controller.abort();
    candidate.server?.close();
  }

  async function startOAuth({ scope } = {}) {
    if (lifetime.signal.aborted) throw new RemoteError('This Cloudflare connection has been closed.');
    if (pending?.authorizeUrl) return { authorizeUrl: pending.authorizeUrl };
    if (pending) throw new RemoteError('Cloudflare authorization is already starting.');

    const candidate = { controller: new AbortController(), state: randomBytes(32).toString('base64url') };
    pending = candidate;
    oauthError = undefined;
    const staged = {};
    let provider;
    let redirectUrl;
    let scopeRequest;

    const authorize = (options = {}) => auth(provider, {
      serverUrl: MCP_ENDPOINT,
      resourceMetadataUrl: RESOURCE_METADATA,
      scope: scopeRequest,
      fetchFn: cloudflareFetch({ signal: candidate.controller.signal, timeout: 20_000 }),
      ...options,
    });

    candidate.server = createServer(async (request, response) => {
      if (!redirectUrl || request.method !== 'GET') {
        return respond(response, 404, 'Cloudflare authorization callback not found.');
      }
      const redirect = new URL(redirectUrl);
      let callback;
      try { callback = new URL(request.url, redirect); } catch {
        return respond(response, 400, 'Invalid Cloudflare authorization callback.');
      }
      if (request.headers.host !== redirect.host || callback.origin !== redirect.origin || callback.pathname !== CALLBACK_PATH) {
        return respond(response, 404, 'Cloudflare authorization callback not found.');
      }
      if (!sameState(callback.searchParams.get('state'), candidate.state)) return respond(response, 400, 'Invalid Cloudflare authorization state.');
      if (pending !== candidate || candidate.processing) return respond(response, 409, 'Cloudflare authorization has already been handled.');
      candidate.processing = true;

      let verified;
      try {
        if (callback.searchParams.has('error')) throw new RemoteError('Cloudflare authorization was declined.');
        const code = callback.searchParams.get('code');
        if (!code || callback.searchParams.get('iss') !== MCP_ENDPOINT.origin) {
          throw new RemoteError('Cloudflare returned an invalid authorization callback.');
        }
        if (await authorize({ authorizationCode: code }) !== 'AUTHORIZED') {
          throw new RemoteError('Cloudflare did not grant authorization.');
        }
        // The temporary callback session uses the staged access token. A new session
        // will open from the verified credentials after this listener is closed.
        verified = await openSession(staged, candidate.controller.signal);
        await verified.client.close().catch(() => {});
        candidate.controller.signal.throwIfAborted();
        await opening?.catch(() => {});
        candidate.controller.signal.throwIfAborted();
        candidate.committing = true;
        generation++;
        swapping = (async () => {
          await writeCredentials(staged, verified.identity);
          const old = session;
          session = undefined;
          refreshRequired = false;
          await old?.client.close().catch(() => {});
        })().finally(() => { swapping = undefined; });
        await swapping;
        await onAuthorized(verified.identity);
        respond(response, 200, 'Cloudflare 授权成功，可以关闭此页面。\nCloudflare authorization succeeded. You can close this tab.');
        endOAuth(candidate);
      } catch (error) {
        const message = error instanceof RemoteError ? error.message : 'Cloudflare authorization could not be completed. Try again from Cloudflare settings.';
        respond(response, 400, message);
        endOAuth(candidate, message);
      }
    });

    candidate.timer = setTimeout(() => {
      if (!candidate.committing) endOAuth(candidate, 'Cloudflare authorization timed out.');
    }, oauthTimeoutMs);
    candidate.timer.unref();

    try {
      const listening = once(candidate.server, 'listening', { signal: candidate.controller.signal });
      candidate.server.listen(0, LOOPBACK_HOST);
      await listening;
      redirectUrl = `http://${LOOPBACK_HOST}:${candidate.server.address().port}${CALLBACK_PATH}`;
      staged.redirectUrl = redirectUrl;
      const prior = await readCredentials();
      scopeRequest = [...new Set([...BASE_SCOPES.split(' '), ...scopeList(prior?.tokens?.scope), ...scopeList(scope)])].join(' ');
      provider = oauthProvider({
        credentials: staged,
        redirectUrl,
        state: candidate.state,
        redirect: url => {
          if (url.origin !== MCP_ENDPOINT.origin || url.pathname !== '/authorize') {
            throw new RemoteError('Cloudflare returned an unexpected authorization page.');
          }
          candidate.authorizeUrl = url.href;
        },
      });
      if (await authorize() !== 'REDIRECT' || !candidate.authorizeUrl) {
        throw new RemoteError('Cloudflare did not provide an authorization URL.');
      }
      candidate.controller.signal.throwIfAborted();
      return { authorizeUrl: candidate.authorizeUrl };
    } catch (error) {
      const message = error instanceof RemoteError ? error.message : 'Could not start Cloudflare authorization.';
      endOAuth(candidate, message);
      throw new RemoteError(message);
    }
  }

  return {
    startOAuth,
    oauthStatus: () => ({ pending: Boolean(pending), ...(oauthError ? { error: oauthError } : {}) }),
    async connect({ verify = false } = {}) {
      const previous = session;
      const connected = await getSession();
      if (verify && previous === connected) {
        try {
          connected.identity = await whoami(connected.client, { timeout: requestTimeoutMs });
        } catch (error) {
          if (error?.status === 401 && session === connected && !connected.credentials.apiToken) {
            refreshRequired = true;
          }
          if (error instanceof RemoteError) throw error;
          throw new RemoteError('Cloudflare could not verify the account for this connection.');
        }
      }
      return connected.identity;
    },
    async callTool(name, args, { signal } = {}) {
      signal?.throwIfAborted();
      const connected = await getSession();
      signal?.throwIfAborted();
      try {
        return await connected.client.callTool({ name, arguments: args }, undefined, { timeout: requestTimeoutMs, signal });
      } catch (error) {
        // A failed action is never replayed. The next explicit call can renew the token.
        if (error?.status === 401 && session === connected && !connected.credentials.apiToken) {
          refreshRequired = true;
        }
        if (error instanceof RemoteError) throw error;
        throw new RemoteError('The Cloudflare tool request failed. For changes, check the resource state before retrying.');
      }
    },
    async close() {
      lifetime.abort();
      generation++;
      if (pending) endOAuth(pending);
      await session?.client.close().catch(() => {});
      session = undefined;
    },
  };
}
