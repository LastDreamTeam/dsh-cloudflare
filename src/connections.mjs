import { randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createRemote } from './remote.mjs';

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
  const statements = {
    all: database.prepare('SELECT id, label, kind, identity FROM connections ORDER BY rowid'),
    get: database.prepare('SELECT * FROM connections WHERE id = ?'),
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
      },
    });
    remotes.set(id, entry);
    return entry;
  }

  function publicConnection(row) {
    const entry = remotes.get(row.id);
    const authorization = entry?.remote.oauthStatus();
    const status = authorization?.pending ? 'pending' : entry?.status ?? 'unknown';
    const connection = { id: row.id, label: row.label, kind: row.kind, status };
    if (authorization?.error) {
      connection.status = 'error';
      connection.error = authorization.error;
    }
    if (row.identity) connection.identity = JSON.parse(row.identity);
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
      return identity;
    } catch (error) {
      entry.status = 'error';
      throw error;
    }
  }

  return {
    listConnections() {
      return statements.all.all().map(publicConnection);
    },
    addConnection({ label, apiToken }) {
      const id = randomUUID();
      const name = normalizeLabel(label, id);
      if (apiToken !== undefined && (typeof apiToken !== 'string' || !/^[A-Za-z0-9_.-]{1,1024}$/.test(apiToken.trim()))) {
        throw new Error('Enter a valid Cloudflare API token.');
      }
      const credentials = apiToken === undefined ? null : JSON.stringify({ apiToken: apiToken.trim() });
      statements.add.run(id, name, credentials ? 'token' : 'oauth', credentials);
      return publicConnection(get(id));
    },
    renameConnection({ id, label }) {
      get(id);
      statements.rename.run(normalizeLabel(label, id), id);
      return publicConnection(get(id));
    },
    async startOAuth({ id, scope }) {
      if (get(id).kind !== 'oauth') throw new Error('This connection uses an API token.');
      if (scope !== undefined && (typeof scope !== 'string' || scope.length > 2048 || !/^[a-zA-Z0-9:._ -]*$/.test(scope))) {
        throw new Error('Enter OAuth permission scopes separated by spaces.');
      }
      return runtime(id).remote.startOAuth({ scope });
    },
    async testConnection({ id }) {
      get(id);
      const entry = runtime(id);
      await verifyConnection(id, entry, { verify: true });
      return publicConnection(get(id));
    },
    async removeConnection({ id }) {
      get(id);
      statements.delete.run(id);
      const entry = remotes.get(id);
      remotes.delete(id);
      await entry?.remote.close();
    },
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
