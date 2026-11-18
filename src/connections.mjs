import { randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createRemote, RemoteError, scopeList } from './remote.mjs';

export class ConnectionTestError extends Error {
  constructor(code, connection) {
    super(code);
    this.code = code;
    this.connection = connection;
  }
}

const TEST_ERRORS = new Set(['authorizationRequired', 'credentialRejected', 'permissionDenied', 'identityMismatch']);
const INTERNAL_LABEL_PREFIX = '\u001f';

export function createConnections(profileDir, { makeRemote = createRemote } = {}) {
  const directory = join(profileDir, 'dsh-cloudflare');
  const databasePath = join(directory, 'connections.sqlite');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  closeSync(openSync(databasePath, 'a', 0o600));
  const database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA secure_delete = ON;
    CREATE TABLE IF NOT EXISTS connections (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL COLLATE NOCASE UNIQUE,
      kind TEXT NOT NULL,
      credentials TEXT,
      identity TEXT,
      identity_id TEXT
    ) STRICT;
  `);
  // Retire legacy OAuth nicknames so API-token users can reuse them.
  database.prepare(`
    UPDATE connections SET label = ? || id WHERE kind = 'oauth' AND label <> ? || id
  `).run(INTERNAL_LABEL_PREFIX, INTERNAL_LABEL_PREFIX);
  const statements = {
    all: database.prepare(`
      SELECT id, label, kind, identity, json_extract(credentials, '$.tokens.scope') AS scope
      FROM connections ORDER BY rowid
    `),
    get: database.prepare(`
      SELECT *, json_extract(credentials, '$.tokens.scope') AS scope FROM connections WHERE id = ?
    `),
    label: database.prepare('SELECT id FROM connections WHERE label = ?'),
    add: database.prepare('INSERT INTO connections (id, label, kind, credentials) VALUES (?, ?, ?, ?)'),
    rename: database.prepare('UPDATE connections SET label = ? WHERE id = ?'),
    delete: database.prepare('DELETE FROM connections WHERE id = ?'),
    credentials: database.prepare('UPDATE connections SET credentials = ? WHERE id = ?'),
    authorize: database.prepare(`
      UPDATE connections SET credentials = ?, identity = ?, identity_id = ?
      WHERE id = ? AND (identity_id IS NULL OR identity_id = ?)
    `),
    identity: database.prepare(`
      UPDATE connections SET identity = ?, identity_id = ?
      WHERE id = ? AND (identity_id IS NULL OR identity_id = ?)
    `),
  };
  const remotes = new Map();
  let closed = false;

  function get(id) {
    if (typeof id !== 'string' || !id) throw new Error('A Cloudflare connection ID is required.');
    const row = statements.get.get(id);
    if (!row) throw new Error('Cloudflare connection not found. Refresh the connections list.');
    return row;
  }

  function checkIdentity(id, identity) {
    const row = get(id);
    if (row.identity_id && row.identity_id !== identity.id) {
      throw new Error('This connection is bound to a different Cloudflare identity. Add a separate connection for this account.');
    }
  }

  function saveIdentity(id, identity) {
    if (statements.identity.run(JSON.stringify(identity), identity.id, id, identity.id).changes !== 1) {
      checkIdentity(id, identity);
      throw new Error('Cloudflare could not save the verified identity. Try again.');
    }
  }

  function runtime(id) {
    if (remotes.has(id)) return remotes.get(id);
    const entry = { status: 'unknown' };
    entry.remote = makeRemote({
      readCredentials() {
        return JSON.parse(get(id).credentials) ?? {};
      },
      writeCredentials(credentials, identity) {
        const serialized = JSON.stringify(credentials);
        if (identity) {
          if (statements.authorize.run(serialized, JSON.stringify(identity), identity.id, id, identity.id).changes !== 1) {
            checkIdentity(id, identity);
            throw new Error('Cloudflare could not save the verified authorization. Try again.');
          }
        } else if (statements.credentials.run(serialized, id).changes !== 1) {
          get(id);
        }
      },
      validateIdentity(identity) {
        const row = get(id);
        return !row.identity_id || row.identity_id === identity.id;
      },
      onAuthorized() {
        entry.status = 'connected';
        entry.error = undefined;
      },
    });
    remotes.set(id, entry);
    return entry;
  }

  function publicConnection(row) {
    const entry = remotes.get(row.id);
    const authorization = entry?.remote.oauthStatus();
    const identity = row.identity ? JSON.parse(row.identity) : undefined;
    const label = row.kind === 'oauth' ? identity?.name || identity?.email || identity?.id || null : row.label;
    const error = entry?.error ?? (authorization?.error ? 'authorizationFailed' : undefined);
    const status = authorization?.pending ? 'pending' : error ? 'error' : entry?.status ?? 'unknown';
    const connection = { id: row.id, label, kind: row.kind, status };
    if (identity) connection.identity = identity;
    if (error && status === 'error') connection.error = error;
    if (row.kind === 'oauth' && typeof row.scope === 'string') connection.grantedScopes = [...new Set(scopeList(row.scope))];
    return connection;
  }

  function normalizeLabel(label, id) {
    const normalized = typeof label === 'string' ? label.trim() : '';
    if (!normalized || normalized.length > 80 || /[\u0000-\u001f\u007f]/.test(normalized)) {
      throw new Error('Enter a Cloudflare connection name between 1 and 80 characters.');
    }
    const existing = statements.label.get(normalized);
    if (existing && existing.id !== id) throw new Error('That Cloudflare connection name already exists.');
    return normalized;
  }

  function resolveId(id) {
    if (id !== undefined) return get(id).id;
    const connections = statements.all.all();
    if (!connections.length) throw new Error('Add a connection in DSH Settings → Cloudflare first.');
    if (connections.length !== 1) {
      throw new Error('Multiple Cloudflare connections are configured. Call list_connections and specify connection_id.');
    }
    return connections[0].id;
  }

  async function verifyConnection(id, entry, options) {
    try {
      const identity = await entry.remote.connect(options);
      saveIdentity(id, identity);
      entry.status = 'connected';
      entry.error = undefined;
      return identity;
    } catch (error) {
      entry.status = 'error';
      throw error;
    }
  }

  async function removeConnection({ id }) {
    get(id);
    statements.delete.run(id);
    const entry = remotes.get(id);
    remotes.delete(id);
    await entry?.remote.close();
  }

  return {
    listConnections() {
      return statements.all.all().map(publicConnection);
    },
    addConnection({ label, apiToken }) {
      const id = randomUUID();
      const name = normalizeLabel(label, id);
      if (typeof apiToken !== 'string' || !/^[A-Za-z0-9_.-]{1,1024}$/.test(apiToken.trim())) {
        throw new Error('Enter a valid Cloudflare API token.');
      }
      statements.add.run(id, name, 'token', JSON.stringify({ apiToken: apiToken.trim() }));
      return publicConnection(get(id));
    },
    renameConnection({ id, label }) {
      if (get(id).kind !== 'token') throw new Error('The display name of an OAuth account comes from Cloudflare.');
      statements.rename.run(normalizeLabel(label, id), id);
      return publicConnection(get(id));
    },
    async startOAuth({ id } = {}) {
      const isNew = id === undefined;
      if (isNew) {
        id = randomUUID();
        statements.add.run(id, INTERNAL_LABEL_PREFIX + id, 'oauth', null);
      }
      if (get(id).kind !== 'oauth') throw new Error('This connection uses an API token.');
      try {
        const entry = runtime(id);
        entry.error = undefined;
        const { authorizeUrl } = await entry.remote.startOAuth();
        return { authorizeUrl, connection: publicConnection(get(id)) };
      } catch (error) {
        if (isNew) await removeConnection({ id });
        throw error;
      }
    },
    async testConnection({ id }) {
      const row = get(id);
      const entry = runtime(id);
      if (entry.remote.oauthStatus().pending) {
        throw new ConnectionTestError('authorizationPending', publicConnection(row));
      }
      if (row.kind === 'oauth' && !row.credentials) {
        throw new ConnectionTestError('authorizationRequired', publicConnection(row));
      }
      try {
        await verifyConnection(id, entry, { verify: true });
      } catch (error) {
        entry.error = error instanceof RemoteError && TEST_ERRORS.has(error.code) ? error.code : 'testFailed';
        throw new ConnectionTestError(entry.error, publicConnection(get(id)));
      }
      return publicConnection(get(id));
    },
    removeConnection,
    async callTool(name, { connection_id, ...args }, options) {
      const id = resolveId(connection_id);
      const entry = runtime(id);
      options?.signal?.throwIfAborted();
      const identity = await verifyConnection(id, entry);
      options?.signal?.throwIfAborted();
      if (name === 'whoami') {
        return { content: [{ type: 'text', text: JSON.stringify(identity) }], structuredContent: identity };
      }
      try {
        return await entry.remote.callTool(name, args, options);
      } catch (error) {
        if (!options?.signal?.aborted) entry.status = 'error';
        throw error;
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      const pending = [...remotes.values()].map(({ remote }) => remote.close());
      remotes.clear();
      try {
        await Promise.allSettled(pending);
      } finally {
        database.close();
      }
    },
  };
}
