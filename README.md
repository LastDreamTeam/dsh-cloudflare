# Cloudflare for DeepSeek Harness

[简体中文](README.zh.md)

`dsh-cloudflare` connects DeepSeek Harness (DSH) to the official Cloudflare API MCP server. Bind multiple Cloudflare identities in DSH settings, then let the Agent manage zones, DNS, Workers, R2, and other Cloudflare resources through the permissions granted to each connection. [Cloudflare API MCP](https://github.com/cloudflare/mcp)

## Install

1. Open **Plugins → Add plugin** in DSH Desktop.
2. Paste the repository URL into the package input.

   ```text
   https://github.com/LastDreamTeam/dsh-cloudflare
   ```

3. Click **Install** and enable the plugin if needed. If DSH prompts you to restart, restart it before opening **Settings → Cloudflare**.

Install into a standalone DSH web profile with the CLI.

```sh
dsh plugin --profile web add github:LastDreamTeam/dsh-cloudflare
```

Add `#<commit-sha>` to the CLI package spec to pin a commit. The plugin is distributed from GitHub. DSH 0.2.2-rc.1 is the target host version. Running DSH outside Desktop requires Node.js 24.9 or later.

### Update the plugin

To update a GitHub installation, remove the package from the DSH plugin list and install it again using the same link and profile. Saved Cloudflare connections stay in the profile.

### Upgrade from 1.x

Remove `dsh-cloudflare-api-mcp` from the target profile, install `dsh-cloudflare`, then authorize again in its settings. Version 2.0.0 uses the new package name and profile-local credential storage. The old `mcp-remote` credentials are left in their original directory and must be removed separately if desired.

## Connect Cloudflare accounts

Open **Settings → Cloudflare** and select **Add account** to start browser authorization. The account appears with its verified Cloudflare name or email after sign-in. Use a separate browser profile or switch Cloudflare users when adding another identity. The browser must run on the same machine as DSH to complete the local callback.

Choose permissions on Cloudflare’s own consent page. Its templates cover minimal identity and account discovery, read-only access, and full access. Expand **Advanced** to grant specific permissions such as `zone.read` and `dns.write` for DNS edits. After sign-in, DSH displays the OAuth scopes reported by Cloudflare. Reauthorize the connection if you need additional permissions later. [Cloudflare MCP consent](https://github.com/cloudflare/mcp/blob/main/AGENTS.md#authentication)

While DSH is waiting for authorization, complete sign-in in the browser. If the browser did not open, select **Open Cloudflare authorization** in the settings panel. Use **Test connection** to check the current status. DSH shows the verified identity on success and guidance if authorization is pending or the connection fails.

Choose **Add API token** to add an access token with a display name such as `staging`. You can rename token connections in the settings panel. Scope the token to the intended accounts, zones, and permissions. Account-owned tokens need **Account Resources → Read** for account discovery. The Cloudflare MCP server currently requires client IP address filtering to be disabled for API tokens. [Cloudflare MCP token setup](https://github.com/cloudflare/mcp#option-2-api-token)

Credentials stay in the current DSH profile and are kept out of Agent tool arguments and responses. The credential file uses owner-only permissions on POSIX and inherits the profile directory’s access controls on Windows. Removing a connection removes its local credential. Manage upstream OAuth grants or API tokens from Cloudflare.

## Use with an Agent

| Tool | Purpose |
| --- | --- |
| `mcp__cfapi__list_connections` | List the configured connections and their IDs. |
| `mcp__cfapi__whoami` | Verify the credential’s Cloudflare identity. |
| `mcp__cfapi__docs` | Search Cloudflare developer documentation. |
| `mcp__cfapi__search` | Find operations, permission requirements, and request schemas in the Cloudflare API specification. |
| `mcp__cfapi__execute` | Run the selected operations through Cloudflare’s Code Mode sandbox. |

When more than one connection exists, supply `connection_id` when calling a tool against Cloudflare. A single connection can have access to more than one Cloudflare account. For an account-scoped operation, identify the intended Cloudflare account and supply its `account_id` to `execute` when required by the upstream server. A local connection ID selects a credential and a Cloudflare account ID selects a resource namespace.

Name the connection, zone, record, and intended change in your prompt.

> Use the Cloudflare connection for `staging@example.com`. In the intended Cloudflare account, find the `example.com` zone and show the current A record for `app.example.com`. Update that specific record to `192.0.2.10`, keeping its TTL and proxy setting, and read it back to verify the change.

For DNS management, grant **Zone Read** to discover the zone and **DNS Write** to create, update, or delete its records. Add **Zone Write** to create or manage the zone itself. Workers, storage, cache, SSL/TLS, and other products use their own scopes. Use `search` to check the permission for the selected endpoint. [API token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/) · [DNS API](https://developers.cloudflare.com/api/resources/dns/subresources/records/)

Cloudflare treats hosted zones and Registrar registrations as separate resources. A zone’s settings can be changed through the zone API. Moving to a different domain name requires managing a separate zone. Registrar operations use the current `/registrar/registrations` API and require a supported user-scoped credential. The current registration update endpoint supports `auto_renew`. [Zone API](https://developers.cloudflare.com/api/resources/zones/) · [Registrar API](https://developers.cloudflare.com/api/resources/registrar/) · [Account token compatibility](https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/#compatibility-matrix)

## License

[MIT](LICENSE)
