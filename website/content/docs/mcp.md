---
title: MCP
order: 29
section: Reference
---

# MCP

`jsails/mcp` is the Model Context Protocol surface: a stdio MCP server, a
dependency-free tool definition and registry, an in-process MCP client for
testing and AI-runtime composition, and a built-in set of JSails introspection
tools (`jsails_describe`, `jsails_inspect_routes`, `jsails_explain_route`,
`jsails_schema`).

The server uses the official `@modelcontextprotocol/server` SDK for the
JSON-RPC lifecycle (initialize, tools/list, tools/call, protocol-version
negotiation). The tool registry and the in-process client are JSails-owned and
dependency-free.

## `jsails mcp` CLI

The `jsails mcp` CLI command starts a ready-to-run MCP stdio server with the
built-in JSails tool set:

```sh
jsails mcp
```

It reads `jsails.app.js` (and, for `jsails_schema`, `jsails.config.js`) from
the current directory. The server's stdout is the MCP JSON-RPC stream;
configure your agent or editor to point at the `jsails mcp` binary as an MCP
server. Programmatic use calls `buildJsailsMcpServer({ version })`, which runs
the same built-in tool set over stdio.

## Defining a tool

`defineMcpTool(options)` builds a type-safe MCP tool from a plain descriptor:

```ts
import { defineMcpTool } from 'jsails/mcp';

const echo = defineMcpTool({
  name: 'echo',
  description: 'Echo the input back',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
  },
  handler: async (args) => {
    return { echo: args.text };
  },
});
```

The `handler` is called with the raw arguments map; its return value is
serialized as JSON text in the MCP response. Strings pass through verbatim.

- `inputSchema` defaults to `{ type: 'object' }` when omitted. It is a plain
  JSON Schema object (no Zod dependency).
- `McpTool` carries the `definition` (name, description, `inputSchema`) plus
  the `handler`.

## The registry

`createMcpToolRegistry(tools)` builds an immutable registry from a list of
`McpTool` objects:

```ts
import { createMcpToolRegistry } from 'jsails/mcp';

const registry = createMcpToolRegistry([echo]);

// List every tool definition.
const definitions = registry.list();

// Call a tool by name.
const result = await registry.call('echo', { text: 'hello' });
```

Tools are keyed by name; duplicates are rejected at construction time with a
value-free `McpToolError`. The registry carries `call(name, args)` →
`McpToolResult` and `list()` → `ToolDefinition[]` — no JSON-RPC, no transport,
no `node:*` imports.

## The server

`createMcpServer({ name, version, tools })` builds a spec-current MCP stdio
server over the official `@modelcontextprotocol/server` SDK:

```ts
import { createMcpServer, createMcpToolRegistry } from 'jsails/mcp';

await createMcpServer({
  name: 'my-app',
  version: '1.0.0',
  tools: createMcpToolRegistry([echo]),
});
```

Each registry entry is registered via the SDK's `McpServer.registerTool`. The
SDK owns the JSON-RPC lifecycle (initialize, tools/list, tools/call, pings,
notifications, and protocol-version negotiation). The server resolves once the
transport closes (the SDK's stdio transport closes when stdin reaches EOF).

## In-process client

`createInProcessMcpClient(registry)` wraps a local `McpToolRegistry` as a
`McpClient` for in-process use:

```ts
import { createInProcessMcpClient } from 'jsails/mcp';

const client = createInProcessMcpClient(registry);

const tools = await client.listTools();
const result = await client.callTool('echo', { text: 'hello' });
// result.content[0] → { type: 'text', text: '{"echo":"hello"}' }
```

No I/O, no JSON round-trip — `callTool` invokes the handler directly and
serializes the result as JSON text content. This is the same `McpClient` shape
the `jsails/ai` `createMcpTransport` consumes, so the two compose with zero
overhead. A handler throw produces a uniform, value-free `McpClientError` (the
registry's error message is never echoed).

## Built-in tools

Four read-only JSails introspection tools ship, each wrapping an existing
read-only `jsails describe`/`inspect`/`explain` function — never reimplementing
discovery or schema extraction:

| Tool | Description |
| --- | --- |
| `jsails_describe` | Full app definition: routes, plugins, commands, server components, entity schema. Accepts optional `configPath` and `dbConfigPath`. |
| `jsails_inspect_routes` | List every filesystem route (page / API) discovered from the compiled `pages/` and `api/` directories. |
| `jsails_explain_route` | Resolve which route handles a request path, show matched params, and list the fixed pipeline stages. Requires `path`. |
| `jsails_schema` | Extract the declared entity schema (tables, columns, indexes, foreign keys) from model metadata without connecting to a database. Returns an empty `tables` array when no database config exists. |

All four are available individually (`jsailsDescribeTool`,
`jsailsInspectRoutesTool`, `jsailsExplainRouteTool`, `jsailsSchemaTool`) and as
the frozen array `jsailsMcpTools`.

```ts
import { jsailsMcpTools, createMcpToolRegistry, createMcpServer } from 'jsails/mcp';

const registry = createMcpToolRegistry([
  // All four built-in tools:
  ...jsailsMcpTools,
  // Plus your own:
  echo,
]);

await createMcpServer({ name: 'jsails', version: '1.0.0', tools: registry });
```

### Shared config resolution

Every built-in tool accepts an optional `configPath` (defaults to
`jsails.app.js`) and, for `jsails_describe` and `jsails_schema`, an optional
`dbConfigPath` (defaults to `jsails.config.js`). Tools that need no database
config (`jsails_inspect_routes`, `jsails_explain_route`) ignore `dbConfigPath`.

## Errors

- `McpToolError` — raised by the registry for duplicate tool names or an unknown
  tool name. Value-free.
- `McpClientError` — raised by the in-process client when a tool call's handler
  throws. Value-free (the handler's error is not echoed).

## Honest limits

- **Stdio only.** `createMcpServer` connects over stdio via the official SDK's
  `StdioServerTransport`. There is no built-in HTTP/SSE MCP transport.
- **Remote MCP is out of scope.** The in-process client binds a local registry
  directly; reaching a remote MCP server (over stdio or HTTP) requires the
  `@modelcontextprotocol/sdk` `Client` directly — `jsails/mcp` provides only
  the in-process seam.
- **No real-time connection lifecycle.** The server resolves only when the
  transport closes; there is no shutdown signal or graceful-close API exposed
  to the caller beyond the SDK's own `server.close()` (which `createMcpServer`
  does not return a reference to — use the lower-level `new McpServer(...)` for
  that control).
- **Tools run synchronously from the tool's own perspective** (a handler is
  awaited), but there is no concurrency limit or request queue — the SDK owns
  that discipline.

## Next steps

- [AI](/docs/ai) — the provider-neutral AI runtime; the MCP transport composes
  an in-process MCP client as the AI backend.
- [Introspection](/docs/introspection) — the read-only `jsails describe` /
  `inspect` / `explain` commands these tools wrap.