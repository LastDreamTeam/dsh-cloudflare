import { createConnections } from './connections.mjs';
import { registerWeb } from './web.mjs';

export const name = 'dsh-cloudflare';
export const inject = ['profileContext', 'tools'];

const connectionId = {
  type: 'string',
  description: 'DSH connection ID from mcp__cfapi__list_connections. Required when more than one connection is configured.',
};
const truncate = {
  type: 'boolean',
  description: 'Keep the default output limit for replies sent to the conversation.',
};
const code = {
  type: 'string',
  description: 'An async JavaScript arrow function executed by the official Cloudflare MCP that returns a value.',
};
const text = (value) => [{ type: 'text', text: value }];

function objectSchema(properties, required = []) {
  return { type: 'object', properties, required, additionalProperties: false };
}

function renderResult(result) {
  const messages = result.content?.filter((block) => block.type === 'text') ?? [];
  return messages.length ? messages : text(JSON.stringify(result.structuredContent ?? result.content ?? []));
}

export function buildTools(connections) {
  const tools = [
    {
      name: 'mcp__cfapi__list_connections',
      description: 'List Cloudflare connections in this DSH profile with their IDs, labels, status and verified Cloudflare identities. Use the intended connection ID when calling another Cloudflare tool.',
      parameters: objectSchema({}),
      output: {
        schema: { type: 'array', items: { type: 'object', additionalProperties: true } },
        render: (_args, result) => text(JSON.stringify(result)),
      },
      execute: () => connections.listConnections(),
    },
  ];
  const upstreamTools = [
    {
      name: 'whoami',
      description: 'Verify which Cloudflare user or account the selected connection is authorized as. A user identity can manage multiple Cloudflare accounts.',
    },
    {
      name: 'docs',
      description: 'Search official Cloudflare developer documentation for products, configuration, and troubleshooting.',
      parameters: { query: { type: 'string', description: 'Search query for Cloudflare developer documentation.' } },
      required: ['query'],
    },
    {
      name: 'search',
      description: 'Search Cloudflare’s OpenAPI specification in Code Mode. Use an async arrow function that reads spec.paths[path][method] (lowercase method) or iterates Object.entries(spec.paths). Operations describe parameters, requestBody, responses, tags, and x-api-token-group permissions. Look up the endpoint before executing a request.',
      parameters: { code, truncate },
      required: ['code'],
    },
    {
      name: 'execute',
      description: 'Call the official Cloudflare API in Cloudflare Code Mode. Return cloudflare.request({method, path, query?, body?, contentType?}) from an async arrow function. Use an API path such as /zones or /accounts/<id>/workers/scripts. Bodies can be JSON, FormData, or raw content as the endpoint requires. When a connection has access to multiple Cloudflare accounts, discover them with GET /accounts and supply the intended account_id for account-scoped calls. Verify the target account, zone and resource before changing it. Read current settings first and ask the user if the intended target or change is ambiguous.',
      parameters: {
        code,
        account_id: { type: 'string', description: 'Cloudflare account ID used by the upstream accountId variable. Distinct from the DSH connection ID.' },
        truncate,
      },
      required: ['code'],
    },
  ];
  for (const tool of upstreamTools) {
    tools.push({
      name: `mcp__cfapi__${tool.name}`,
      description: tool.description,
      parameters: objectSchema({ connection_id: connectionId, ...tool.parameters }, tool.required),
      timeoutMs: 150_000,
      output: {
        schema: objectSchema({ content: { type: 'array', items: {} }, structuredContent: {} }, ['content']),
        render: (_args, result) => renderResult(result),
      },
      async execute(args, execution) {
        const result = await connections.callTool(tool.name, args, { signal: execution?.signal });
        if (result.isError) throw new Error(renderResult(result).map((block) => block.text).join('\n'));
        const value = { content: result.content ?? [] };
        if (result.structuredContent !== undefined) value.structuredContent = result.structuredContent;
        return value;
      },
    });
  }
  return tools;
}

export function apply(ctx) {
  const connections = createConnections(ctx.profileContext.dir);
  ctx.effect(() => () => { void connections.close(); }, 'dsh-cloudflare / connections');
  for (const tool of buildTools(connections)) ctx.effect(() => ctx.tools.register(tool), tool.name);
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => registerWeb(webCtx, connections), 'dsh-cloudflare / settings');
  });
}
