# Cloudflare for DeepSeek Harness

[English](README.md)

`dsh-cloudflare` 将 DeepSeek Harness（DSH）接入 Cloudflare 官方 API MCP。可以在 DSH 设置中绑定多个 Cloudflare 账号，让 Agent 在各连接的授权范围内管理域名站点、DNS 解析、Workers、R2 等资源。 [Cloudflare API MCP](https://github.com/cloudflare/mcp)

## 安装

1. 在 DSH 桌面端打开 **插件 → 添加插件**。
2. 在插件输入框粘贴仓库地址。

   ```text
   https://github.com/LastDreamTeam/dsh-cloudflare
   ```

3. 点击 **安装**，按需启用插件。如果 DSH 提示重启，重启后打开 **设置 → Cloudflare**。

独立运行的 DSH Web 配置也可以用命令行安装。

```sh
dsh plugin --profile web add github:LastDreamTeam/dsh-cloudflare
```

在命令行地址末尾加 `#<commit-sha>` 可以固定到指定提交。插件从 GitHub 分发，目标宿主版本为 DSH 0.2.2-rc.1。独立运行 DSH 需要 Node.js 24.9 或更高版本。

### 从 1.x 升级

先在目标配置中卸载 `dsh-cloudflare-api-mcp`，再安装 `dsh-cloudflare`，并在设置面板重新授权。2.0.0 使用新的包名，在当前 DSH 配置目录存储凭据。如需清理原来的 `mcp-remote` 凭据，请单独处理旧目录。

## 绑定 Cloudflare 账号

打开 **设置 → Cloudflare**，添加连接并起一个便于在对话中指明的名称，例如 `生产` 或 `预发布`。选择浏览器 OAuth，在 Cloudflare 页面授权该连接需要的权限。请在运行 DSH 的同一台机器上打开浏览器，以便完成本机回调。绑定另一位 Cloudflare 用户时，可以切换登录账号或使用独立的浏览器配置。

OAuth 表单默认填入 `zone.read` 和 `dns.write`，用于查找域名站点和修改 DNS。可按需求调整权限，再到 Cloudflare 授权页核对。**Minimal** 用于识别登录身份和账号，展开 **Advanced** 可查看各项权限。如果后续操作需要额外权限，请用所需权限重新授权。绑定不同的 Cloudflare 身份时，请新建连接。 [Cloudflare MCP 授权说明](https://github.com/cloudflare/mcp/blob/main/AGENTS.md#authentication)

也可以在设置面板添加限定权限的 Cloudflare API Token，只授权该连接实际需要的账号、Zone 和操作。如果使用账号级 Token，请授予 **Account Resources → Read**，以便官方 MCP 自动识别账号。官方 MCP 当前不支持启用了客户端 IP 地址限制的 API Token。 [Cloudflare MCP Token 设置](https://github.com/cloudflare/mcp#option-2-api-token)

可在设置面板逐个重命名、测试或移除连接。凭据保存在当前 DSH 配置目录，Agent 工具的输入和响应均不会包含凭据。POSIX 系统上的凭据文件仅允许所有者访问，Windows 则使用配置目录的访问权限。移除连接会清除本地凭据。Cloudflare 端的 OAuth 授权或 API Token 可在 Cloudflare 中管理。

## 让 Agent 管理资源

| 工具 | 用途 |
| --- | --- |
| `mcp__cfapi__list_connections` | 列出已配置的连接和连接 ID。 |
| `mcp__cfapi__whoami` | 查看该连接认证的 Cloudflare 身份。 |
| `mcp__cfapi__docs` | 搜索 Cloudflare 开发者文档。 |
| `mcp__cfapi__search` | 查询 Cloudflare API 操作、权限要求和请求结构。 |
| `mcp__cfapi__execute` | 在 Cloudflare 官方 Code Mode 沙箱中调用相应 API。 |

绑定多个连接后，调用 Cloudflare 接口时需要指定 `connection_id`。同一连接可以有权访问多个 Cloudflare 账号。进行账号级操作时，确认目标 Cloudflare 账号，并根据官方工具的要求向 `execute` 提供 `account_id`。连接 ID 选择授权凭据，Cloudflare 账号 ID 指定资源所属账号。

可以直接用自然语言指定连接、域名、记录及改动。

> 用「预发布」连接，在目标 Cloudflare 账号里找到 `example.com`，先查看 `app.example.com` 现有的 A 记录。把这条记录的地址改成 `192.0.2.10`，保留 TTL 和代理设置，再读回结果验证。

管理 DNS 时，可用 **Zone Read** 查找域名站点，用 **DNS Write** 新增、修改或删除记录。创建或管理站点本身需要 **Zone Write**。Workers、存储、缓存和 SSL/TLS 等产品有各自的权限，可以用 `search` 查询对应接口的要求。 [API Token 权限](https://developers.cloudflare.com/fundamentals/api/reference/permissions/) · [DNS API](https://developers.cloudflare.com/api/resources/dns/subresources/records/)

Cloudflare 的托管站点（Zone）和域名注册（Registrar）是独立资源。可以通过 Zone API 修改站点设置。迁移到另一个域名时，需要管理对应的新站点。Registrar 使用当前的 `/registrar/registrations` API，需要受支持的用户级凭据，注册更新接口目前可修改自动续费（`auto_renew`）。 [Zone API](https://developers.cloudflare.com/api/resources/zones/) · [Registrar API](https://developers.cloudflare.com/api/resources/registrar/) · [账号级 Token 兼容性](https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/#compatibility-matrix)

## 许可证

[MIT](LICENSE)
