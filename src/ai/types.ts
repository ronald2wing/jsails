/**
 * AI runtime types — the neutral, provider-agnostic message/tool surface.
 *
 * Browser-safe (no `node:*`): these are data shapes + contracts only. The
 * transports that move them over a wire live in `transports.ts` (server-only
 * where they need `node:*` / `fetch`).
 */

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** One message in a conversation. */
export interface AiMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string;
  /** For `role: 'tool'`, the id of the tool call this result answers. */
  readonly toolCallId?: string;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/**
 * A callable tool exposed to the agent loop. `parameters` is a JSON Schema
 * object describing the arguments; `call` invokes it and returns a value that
 * is serialized back to the model.
 */
export interface AiTool {
  readonly name: string;
  readonly description: string;
  readonly parameters?: Record<string, unknown>;
  readonly call: (args: Record<string, unknown>) => unknown;
}

/** A tool invocation the model requested. */
export interface AiToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Run options + results
// ---------------------------------------------------------------------------

/** Options for a chat/stream/run call. */
export interface AiRunOptions {
  readonly tools?: readonly AiTool[];
  readonly temperature?: number;
  /** Maximum tool-calling rounds in `run` (default 8). */
  readonly maxSteps?: number;
}

/** A streamed event in the order it is produced. */
export type AiStreamEvent =
  | { readonly type: 'text'; readonly delta: string }
  | { readonly type: 'tool_call'; readonly toolCall: AiToolCall }
  | { readonly type: 'message'; readonly message: AiMessage }
  | { readonly type: 'done'; readonly message: AiMessage };

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

type AiErrorCode =
  'invalid_messages' | 'invalid_tool' | 'unknown_tool' | 'loop_exceeded' | 'transport_failed';

/** Value-free AI runtime error. */
export class AiError extends Error {
  readonly code: AiErrorCode;

  constructor(code: AiErrorCode, message: string) {
    super(message);
    this.name = 'AiError';
    this.code = code;
  }
}
