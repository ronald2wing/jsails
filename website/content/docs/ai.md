---
title: AI
order: 28
section: Reference
---

# AI

`jsails/ai` is a provider-neutral AI runtime: define tools, send messages, and run
an agent loop — the runtime owns message validation, the tool-calling loop, and
bounds; the transport owns the wire. There are no bundled provider SDKs. The
same neutral-contract + injectable-transport philosophy that `jsails/jobs` and
`jsails/mail` follow applies here too.

The types are browser-safe (`AiMessage`, `AiTool`, `AiToolCall`); the built-in
transports (`createHttpTransport`, `createMcpTransport`) lean server-side (they
use `fetch` or pass through to an MCP client) but are otherwise dependency-free.

## The runtime

`createAiRuntime(transport)` builds a runtime over an `AiTransport`. The
transport is any object with a `complete` method (and an optional `stream`
method); the runtime never assumes a backend. Three methods are exposed:

- **`chat(messages, options?)`** — one assistant reply. If the backend returns
  tool calls, `chat` throws `AiError('invalid_tool')` — use `run` for the agent
  loop.
- **`stream(messages, options?)`** — `AsyncIterable<AiStreamEvent>`. Emits
  `text` deltas, `tool_call` events, then a `message` event followed by `done`.
  When the transport has no streaming backend, the runtime falls back to a
  single completion emitted as one `message` + `done` pair.
- **`run(messages, options?)`** — the agent tool-calling loop. Resolves tool
  calls returned by the backend against the provided `tools`, feeds results back,
  and repeats until a final assistant message without tool calls. Bounded by
  `maxSteps` (default 8, configurable in `AiRunOptions`).

```ts
import { createAiRuntime, createHttpTransport } from 'jsails/ai';

const runtime = createAiRuntime(
  createHttpTransport({
    endpoint: 'https://api.example.com/v1/chat',
    headers: { authorization: `Bearer ${process.env.API_KEY}` },
  }),
);

const reply = await runtime.chat([
  { role: 'user', content: 'What is the weather in London?' },
]);
```

## Messages

`AiMessage` carries a `role` (`'system' | 'user' | 'assistant' | 'tool'`), a
string `content`, and — for `role: 'tool'` — an optional `toolCallId` linking
the result to the call that produced it. The runtime validates that every
message has a `role` and string `content` before any transport call, throwing
`AiError('invalid_messages')` on a malformed array.

## Tools

An `AiTool` is a name, a description, an optional JSON Schema `parameters`
object, and a `call` function the runtime invokes during the agent loop. A tool
may return any value (serialized as JSON back to the model; strings are passed
through verbatim).

`AiToolCall` represents a tool invocation the model requested: an `id`, a
`name`, and the `arguments` map.

```ts
const weatherTool = {
  name: 'get_weather',
  description: 'Get the current weather for a city',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
  },
  call: async (args) => {
    // Return any value; strings pass through, objects are JSON-stringified.
    return { city: args.city, temp: 18, unit: 'celsius' };
  },
};

const reply = await runtime.run(
  [{ role: 'user', content: 'What is the weather in London?' }],
  { tools: [weatherTool] },
);
```

## The transport contract

`AiTransport` is the provider-neutral seam. A transport is any object with:

```ts
interface AiTransport {
  readonly complete: (request: AiTransportRequest) => Promise<AiTransportReply>;
  readonly stream?: (request: AiTransportRequest) => AsyncIterable<AiStreamEvent>;
}
```

`AiTransportRequest` carries `messages`, `tools`, and an optional `temperature`.
`AiTransportReply` carries one assistant `message` plus any `toolCalls` the
backend chose to issue. The runtime owns the agent loop (resolving tool calls
and feeding results back); the transport owns the wire. There is no provider
coupling in the contract — swap transports by swapping implementations.

## Built-in transports

Two transports ship, each a pure factory function:

### `createHttpTransport(options)`

A fetch-based backend. Sends `{ messages, tools }` as JSON to a chat-completion
endpoint and parses the JSON response as `{ message, toolCalls }`. The `stream`
method is not negotiated — the runtime falls back to the `complete`-based
streaming normalisation for this transport.

```ts
import { createHttpTransport } from 'jsails/ai';

const transport = createHttpTransport({
  endpoint: 'https://api.example.com/v1/chat',
  headers: { authorization: `Bearer ${process.env.API_KEY}` },
  fetch: customFetch, // injectable fetch (defaults to globalThis.fetch)
});
```

### `createMcpTransport(options)`

Adapts an MCP client as the AI transport. The model is reached through a `chat`
tool the MCP server exposes (tool name configurable via `chatTool`, default
`'chat'`). The MCP server's other advertised tools become the tools the agent
loop can call.

```ts
import { createMcpTransport } from 'jsails/ai';
import { createInProcessMcpClient } from 'jsails/mcp';

const client = createInProcessMcpClient(registry);
const transport = createMcpTransport({ client });
const runtime = createAiRuntime(transport);
```

The `McpLikeClient` shape the transport consumes is deliberately minimal:
`listTools()` and `callTool(name, args)` — no JSON-RPC, no transport coupling.
This is the same shape `src/mcp/client.ts`'s `createInProcessMcpClient`
produces, so the two compose with zero I/O.

## Run options

`AiRunOptions` is the optional second argument to `chat`, `stream`, and `run`:

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `tools` | `AiTool[]` | `[]` | Tools the agent loop may call |
| `temperature` | `number` | omitted | Model sampling temperature |
| `maxSteps` | `number` | `8` | Maximum tool-calling rounds in `run` |

## Errors

Every failure is a value-free `AiError` with one of the codes:

| Code | When |
| --- | --- |
| `invalid_messages` | Message array empty or a message missing a `role`/`content` |
| `invalid_tool` | `chat` received tool calls (use `run` for the loop) |
| `unknown_tool` | The model requested a tool not in the local `tools` array |
| `loop_exceeded` | The agent loop exhausted `maxSteps` without a final message |
| `transport_failed` | Backend error (bad status, tool execution failure, no text from MCP) |

Errors never echo message content, tool arguments, or backend responses.

## Honest limits

- **No bundled provider SDKs.** A transport or an MCP server must be supplied by
  the caller — the runtime ships no OpenAI, Anthropic, or other provider client.
  The `HttpTransport` talks to any OpenAI-compatible endpoint; the `McpTransport`
  talks to any MCP server with a `chat` tool.
- **`stream` is best-effort.** The HTTP transport has no native streaming
  negotiation; the runtime falls back to the `complete`-based normalisation.
- **No multi-turn conversation management.** The runtime does not persist
  conversation history or manage thread ids — the caller owns the messages array.

## Next steps

- [MCP](/docs/mcp) — the `jsails mcp` CLI and the built-in JSails MCP tools.
- [Jobs](/docs/jobs) — same neutral-contract + injectable-transport philosophy.