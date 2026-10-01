# AI runtime — Option 2 (neutral runtime + injectable transport + MCP) — Implementation Plan

**Status:** plan · ready for execution
**Owner:** lead (direct implementation; deep-worker hit its step cap repeatedly)
**Date:** 2026-10-16

## Decision (locked with user)

Option 2, reconciled: a **neutral `ai()` runtime** (chat + streaming +
tool-calling) over an injectable **`AiTransport`** contract. `McpTransport` is a
built-in (wraps an MCP server — local registry or remote — as the AI backend),
and `HttpTransport` uses the existing `jsails/http` fetch seam for the
zero-ceremony "talk to a model" case. No provider SDKs in core; no new
dependencies (MCP JSON-RPC is hand-rolled, HTTP reuses `jsails/http`/`fetch`).

The runtime does NOT reimplement provider wire protocols. The neutral contract
is the design center — the same "neutral contract + injectable transport" shape
as `jsails/jobs`, `jsails/mail`, `jsails/broadcast`, `jsails/cache`.

## Build order (two slices)

1. **MCP client (#5)** — `src/mcp/client.ts`: speak the client side of the MCP
   lifecyle over an injectable transport, plus a local/in-process transport that
   reuses the existing tool registry (no process spawn, no HTTP) — so an in-app
   MCP capability is callable synchronously.
2. **`ai()` runtime (#3/#4)** — `src/ai/`: the neutral runtime over `AiTransport`,
   with `McpTransport` (built on the client) and `HttpTransport` (fetch). Minimal
   core: chat + streaming + tool-calling. Embeddings/audio/image are out of scope.

## Slice 1 — MCP client (`src/mcp/client.ts`)

- `McpClient` interface: `call(method, params): Promise<unknown>` against an
  injectable `McpClientTransport` (JSON-RPC request/response, id-correlation).
- `McpClientTransport` contract: `send(request) → Promise<response>` (the seam;
  stdio, streamable-HTTP, and in-process are all transports).
- Two built-in transports:
  - `InProcessMcpTransport` — wraps an existing `McpToolRegistry` (the thing
    `jsails mcp` serves) so a client binds an in-app tool set with **no I/O**.
  - `StdioMcpTransport` — spawn a child MCP server (`node dist/.../mcp`) and
    speak newline JSON-RPC over its stdio (for remote/cli wiring).
- High-level helpers on the client: `initialize()`, `ping()`, `listTools()`,
  `callTool(name, args)` — typed wrappers over the protocol types already in
  `protocol.ts`.
- Value-free `McpClientError` (reuse `McpError`/codes). No new deps (`node:child_process`
  only in the stdio transport, which is server-only).

## Slice 2 — `ai()` runtime (`src/ai/`)

New module `src/ai/` (server-only where transports need `node:*`; keep
`runtime.ts`/`types.ts` browser-safe like `protocol.ts`):

- `src/ai/types.ts` — `AiMessage` (`{ role: 'system'|'user'|'assistant'|'tool', content }`),
  `AiTool` (`{ name, description, parameters?: JSON Schema, call(args) }`),
  `AiToolCall`/`AiToolResult`, `AiRunOptions` (`{ messages, tools?, stream?, temperature? }`),
  `AiToolCallEvent`/`AiStreamEvent` result union. `AiError` (value-free).
- `src/ai/runtime.ts` — `createAiRuntime(transport)` returning the neutral runtime:
  - `chat(messages, options?)` → `Promise<AiMessage>` (a single assistant reply).
  - `stream(messages, options?)` → `AsyncIterable<AiStreamEvent>` (token/delta/tool-call events).
  - `run(messages, options?)` → the **agent loop**: iterate assistant replies;
    when the transport reports a tool call, invoke the local `tools[name].call`,
    feed the result back, until a final assistant message — bounded (maxSteps) +
    value-free loop/unknown-tool errors. This is the `LlmAgent`-shaped core.
  - Owns: retry/timeout policy (injectable), message-shape validation, tool-call
    request formatting, stream-event normalization.
- `src/ai/transports.ts` — `AiTransport` contract + two built-ins:
  - `McpTransport(mcpClientOrRegistry)` — adapts an MCP client/registry as the AI
    backend: `chat` → `tools/call` a chat tool; `stream` → SSE over MCP (best-effort);
    tool-calling → `tools/list` → local `AiTool` wrappers. This *is* Option 1's
    story, expressed as one transport.
  - `HttpTransport({ endpoint, fetch? })` — the fetch seam; POST `{ messages }`,
    read SSE for streaming, optional tool-calling contract. ~40 lines, zero deps.
- `src/ai/index.ts` barrel + `package.json` `./ai` subpath. Re-export from the
  root only if browser-safe (the runtime types are; transports are server-only —
  follow the `jsails/i18n` → `jsails/i18n/server` split, i.e. `jsails/ai` +
  `jsails/ai/server` if needed).

## Files

- `src/mcp/client.ts` (new)
- `src/ai/types.ts`, `src/ai/runtime.ts`, `src/ai/transports.ts`, `src/ai/index.ts` (new)
- `package.json` `exports` (`./ai`)
- `test/mcp/client.test.ts`, `test/ai/runtime.test.ts`, `test/ai/transports.test.ts` (new)

## Verification

`npm run build` → `npm run format` → `npm run lint` → `npm run check` (0
failures) per slice.

## Non-goals (this pass)

- No embeddings / audio / image / reranking (separate domains, additive later).
- No provider SDKs (openai/anthropic/gemini) — transports are user-supplied or
  MCP/fetch-based.
- No `ai()` facade global yet (final wiring + `installFacades` after the runtime
  shape settles).

## Notes

- `deep-worker` repeatedly hit its step cap this session; implement directly and
  keep slices small + independently gated.