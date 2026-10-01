/**
 * AI transports — built-in backends over the {@link AiTransport} contract.
 *
 * - {@link createHttpTransport} — a fetch-based backend (the zero-ceremony
 *   "talk to a model" path).
 * - {@link createMcpTransport} — adapter over an MCP client, so an LLM
 *   reachable through an MCP server (the Option-1 story) is one transport.
 *
 * Server-only where it uses `fetch` (global) — otherwise dependency-free.
 */

import type { AiMessage } from './types.js';
import { AiError } from './types.js';
import type { AiTransport, AiTransportReply, AiTransportRequest } from './transport.js';

export { AiError } from './types.js';
export type { AiTransport, AiTransportReply, AiTransportRequest } from './transport.js';
export type { AiMessage } from './types.js';

// ---------------------------------------------------------------------------
// HTTP transport (fetch)
// ---------------------------------------------------------------------------

/** Options for {@link createHttpTransport}. */
export interface HttpTransportOptions {
  /** The chat-completion endpoint (POST `{ messages }`). */
  readonly endpoint: string;
  /** Headers (auth) to send on every request. */
  readonly headers?: Record<string, string>;
  /** Injectable fetch (defaults to `globalThis.fetch`). */
  readonly fetch?: typeof fetch;
}

/**
 * A fetch-based backend. Sends `{ messages }` (plus tools when present) as JSON;
 * a JSON response is the assistant reply. `stream` is not negotiated here —
 * the runtime falls back to `complete` for this transport.
 */
export function createHttpTransport(options: HttpTransportOptions): AiTransport {
  const fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);

  return {
    async complete(request: AiTransportRequest): Promise<AiTransportReply> {
      const response = await fetchFn(options.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(options.headers ?? {}),
        },
        body: JSON.stringify({
          messages: request.messages,
          ...(request.tools.length > 0 ? { tools: request.tools.map(toolSchema) } : {}),
        }),
      });
      if (!response.ok) {
        throw new AiError('transport_failed', `backend responded ${response.status}`);
      }
      const data = (await response.json()) as {
        message?: AiMessage;
        toolCalls?: readonly { id: string; name: string; arguments: Record<string, unknown> }[];
      };
      return {
        message: data.message ?? { role: 'assistant', content: '' },
        toolCalls: data.toolCalls ?? [],
      };
    },
  };
}

/** Reduce a tool to its wire shape (name/description/parameters). */
function toolSchema(tool: {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    ...(tool.parameters !== undefined ? { parameters: tool.parameters } : {}),
  };
}

// ---------------------------------------------------------------------------
// MCP transport
// ---------------------------------------------------------------------------

/** Minimal MCP client shape the MCP transport consumes. */
export interface McpLikeClient {
  listTools(): Promise<readonly { name: string; description: string }[]>;
  callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{
    content: readonly { type: string; text?: string }[];
  }>;
}

/** Options for {@link createMcpTransport}. */
export interface McpTransportOptions {
  /** The MCP client (or registry-wrapping client) to talk to. */
  readonly client: McpLikeClient;
  /** The chat-completion tool name on the MCP server (default `chat`). */
  readonly chatTool?: string;
}

/**
 * Adapt an MCP client as the AI backend. The chat model is reached through a
 * `chat` tool the MCP server exposes; tool calls are the server's advertised
 * tools. This expresses Option 1 as one transport with no provider coupling.
 */
export function createMcpTransport(options: McpTransportOptions): AiTransport {
  const chatTool = options.chatTool ?? 'chat';
  return {
    async complete(request: AiTransportRequest): Promise<AiTransportReply> {
      const result = await options.client.callTool(chatTool, { messages: request.messages });
      const text = result.content.find((c) => c.type === 'text' && c.text !== undefined)?.text;
      if (text === undefined) {
        throw new AiError('transport_failed', 'MCP chat tool returned no text');
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { message: { role: 'assistant', content: text }, toolCalls: [] };
      }
      const data = parsed as {
        message?: AiMessage;
        toolCalls?: readonly { id: string; name: string; arguments: Record<string, unknown> }[];
      };
      return {
        message: data.message ?? { role: 'assistant', content: text },
        toolCalls: data.toolCalls ?? [],
      };
    },
  };
}
