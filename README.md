# dsh-cloudflare-api-mcp

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that connects agents to the official [Cloudflare API MCP](https://mcp.cloudflare.com/mcp) (DNS, Workers, R2, and more) through `mcp-remote` and browser OAuth.

## Install

This package is distributed from GitHub (it is not published to npm).

```bash
# Web profile
dsh plugin --profile web add github:LastDreamTeam/dsh-cloudflare-api-mcp

# Desktop profile
dsh plugin --profile desktop add github:LastDreamTeam/dsh-cloudflare-api-mcp
```

To pin a specific commit:

```bash
dsh plugin --profile web add github:LastDreamTeam/dsh-cloudflare-api-mcp#COMMIT_SHA
```

Restart the profile after installation.

## First-run authorization

The first time the MCP client starts, `mcp-remote` opens a browser window so you can sign in with your Cloudflare account and grant access. After that, tokens are stored under `~/.mcp-auth/cloudflare-api` in the user home directory (the same path on Windows). Re-authorization uses the same flow if the stored tokens expire.

The official endpoint is `https://mcp.cloudflare.com/mcp` (HTTP-only transport). The plugin waits up to 10 minutes for the first-run sign-in.

## Requirements

- DeepSeek Harness with `@deepseek-ai/dsh-mcp-client` available in the target profile (ships with current DSH releases).
- A Cloudflare account that can authorize the official API MCP.
- The plugin launches `mcp-remote` with the same runtime that started DSH (`process.execPath`). No machine-specific Node or `mcp-remote` paths are required.

## Check the launcher

After dependencies are installed:

```bash
node bin/launch.mjs --check
```

This prints the resolved `mcp-remote` proxy path and the auth directory, then exits without starting OAuth.

## License

MIT
