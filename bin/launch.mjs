#!/usr/bin/env node
// Launch the official Cloudflare API MCP through the mcp-remote dependency.
// Paths are resolved from this package and the user's home directory.

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const MCP_URL = 'https://mcp.cloudflare.com/mcp';
const AUTH_DIR = join(homedir(), '.mcp-auth', 'cloudflare-api');

function resolveProxy() {
  const require = createRequire(import.meta.url);
  try {
    return require.resolve('mcp-remote/dist/proxy.js');
  } catch {
    return require.resolve('mcp-remote');
  }
}

const proxy = resolveProxy();
const checkOnly = process.argv.includes('--check');

if (checkOnly) {
  console.log(JSON.stringify({ proxy, authDir: AUTH_DIR, mcpUrl: MCP_URL }, null, 2));
  process.exit(0);
}

mkdirSync(AUTH_DIR, { recursive: true });

const childEnv = { ...process.env, MCP_REMOTE_CONFIG_DIR: AUTH_DIR };
if (process.versions.electron) {
  childEnv.ELECTRON_RUN_AS_NODE = '1';
}

const child = spawn(
  process.execPath,
  [proxy, MCP_URL, '--transport', 'http-only', '--auth-timeout', '600', ...process.argv.slice(2)],
  { stdio: 'inherit', env: childEnv },
);

child.on('error', (err) => {
  console.error('dsh-cloudflare-api-mcp: failed to start mcp-remote:', err.message);
  process.exit(1);
});

const forward = (signal) => {
  if (!child.killed) child.kill(signal);
};

process.on('SIGINT', () => forward('SIGINT'));
process.on('SIGTERM', () => forward('SIGTERM'));

child.on('exit', (code, signal) => {
  if (signal) {
    process.exit(1);
  }
  process.exit(code ?? 1);
});
