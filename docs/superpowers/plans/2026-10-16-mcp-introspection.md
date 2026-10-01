# JSails MCP introspection server (Boost-style) — Implementation Plan

**Status:** plan · ready for execution
**Owner:** lead + deep-worker
**Date:** 2026-10-16

## Goal

Give external AI coding agents (Claude Code, Cursor, Copilot, OpenCode, Gemini
CLI) first-class, read-only insight into a JSails app — the Laravel Boost analog.
JSails already has the *data* (the read-only, machine-readable `inspect` /
`describe` / `explain` commands emit `--json`); what's missing is an **MCP
(Model Context Protocol) server** that exposes those commands as tools agents
can call, plus (later) composable guidelines + docs search.

This is the concrete answer to "how come AI tools aren't there": Laravel ships
`laravel/ai` + `laravel/mcp` + `laravel/boost`; JSails ships the introspection
*data* but no MCP transport to serve it.

## Non-goals (this pass)

- No `AI`/LLM SDK (provider gateway, agents, streaming) — that is a separate,
  larger feature (`laravel/ai` analog) and is explicitly out of scope here.
- No docs-search vector index / guidelines composer (Boost's other two-thirds) —
  noted as follow-up slices, not built now.
- No writes: every tool is read-only, matching the introspection command philosophy.

## Design

### 1. MCP protocol core (JSON-RPC over stdio) — `src/mcp/`

MCP is a JSON-RPC 2.0 protocol. A minimal server needs:

- `src/mcp/protocol.ts` — value-free types: `JsonRpcRequest`/`JsonRpcResponse`,
  MCP lifecycle methods (`initialize`, `notifications/initialized`, `ping`,
  `tools/list`, `tools/call`), `MCPError` with JSON-RPC error codes.
- `src/mcp/server.ts` — `createMcpServer({ name, version, tools })`: reads newline-
  delimited JSON-RPC on `process.stdin`, writes responses on `process.stdout`,
  dispatches to a tool registry. Stdio transport only (the model MCP transport).
- `src/mcp/tool.ts` — `defineMcpTool({ name, description, inputSchema?, handler })`:
  a `McpTool` with a JSON Schema `inputSchema` (so agents see typed args) and an
  async handler returning a text/JSON `ToolResult`. `createMcpToolRegistry`.

### 2. The JSails tools — `src/mcp/tools.ts`

Wire the existing commands' underlying pure functions (NOT their CLI arg
parsers) into tools. Reuse the extracting modules directly (no process spawn):

- `jsails_describe` → `runDescribe` (app/routes/plugins/schema snapshot).
- `jsails_inspect_routes` → `discoverRoutes` (route manifest).
- `jsails_explain_route` → `runExplain` path resolution + pipeline.
- `jsails_schema` → `getModelSchema` (declarative entity schema, no connection).
- (stretch) `jsails_plugins_resolve` → `loadPluginEnablement`.

Each tool's handler runs the read-only function against the app config path the
server was told about; results are serialized as JSON text (MCP `text` content).

### 3. CLI entry — `src/cli/mcp-commands.ts`

`jsails mcp [--config jsails.app.js]` — builds the server with the standard tool
set and pumps stdio. Routed like the other read-only commands (before app config
import / no heavy deps). `--help` describes it. Output that is not JSON-RPC
(progress, startup banner) must go to `stderr`, never `stdout`.

### 4. package.json / exports

New subpath `jsails/mcp` → `src/mcp/` (server-only — imports `node:process`,
child-free but uses `process.stdin`/`readline`). Export the reusable pieces
(`createMcpServer`, `defineMcpTool`) so a third party can build their own tools,
plus the built-in tool set.

## Tests — `test/mcp/mcp.test.ts`

Drive the server **in-process**: feed a JSON-RPC `initialize` + `tools/list` +
`tools/call` stream through the dispatcher (inject the stdin/stdout as readable/
writable streams, not the real process stdio), assert:
- `initialize` returns server info + `capabilities.tools`.
- `tools/list` returns the built-in tools with JSON Schemas.
- `tools/call` `jsails_describe` returns routes/plugins/schema for a fixture app.
- Unknown tool `→` JSON-RPC `method not found`; malformed JSON `→` `parse error`
  (value-free; no stack/secret leakage).
- A read-only guard: attempting to call a non-existent "write" tool fails.

No new dependencies (MCP JSON-RPC is hand-rolled over `node:readline`; the stdio
transport is ~40 lines).

## Verification gates

`npm run format` → `npm run lint` → `npm run check` (0 failures), then an
end-to-end smoke test: `printf` a JSON-RPC `tools/list` into `node dist/src/cli/index.js mcp` and assert the response.

## Repo rules (non-negotiable)

ESM, `.js` extensions; `noUncheckedIndexedAccess` ON; NO `any`; value-free errors;
no new deps; no generic basenames (`protocol.ts`/`server.ts`/`tool.ts`/`tools.ts`
inside `src/mcp/` are distinct); server-only (no browser-safe import); read-back
+ NUL-check every edited file.

## Follow-ups (not now)

- `jsails mcp:install` — emit `.mcp.json` + a JSails `AGENTS.md` guideline
  (Boost's `boost:install` analog).
- Composable, version-aware AI guidelines + a docs-search API.
- The `AI` facade / provider gateway (`laravel/ai` analog) — a separate plan.