/**
 * AI transport contract — the provider-neutral seam the runtime talks to.
 *
 * A transport moves {@link AiMessage}s to a backend and returns assistant
 * replies or streamed events. The runtime owns the agent loop (tool-calling,
 * retry, bounds); the transport owns the wire. This is the same
 * "neutral contract + injectable transport" shape as `jsails/jobs`/`jsails/mail`.
 */

import type { AiMessage, AiStreamEvent, AiTool } from './types.js';
import { AiError } from './types.js';

/** A single non-streaming completion request to the backend. */
export interface AiTransportRequest {
  readonly messages: readonly AiMessage[];
  readonly tools: readonly AiTool[];
  readonly temperature?: number;
}

/** One assistant reply (may carry tool calls). */
export interface AiTransportReply {
  readonly message: AiMessage;
  readonly toolCalls: readonly { id: string; name: string; arguments: Record<string, unknown> }[];
}

/** The transport contract. */
export interface AiTransport {
  /**
   * Produce one assistant reply for the request. When the backend chooses to
   * call tools, the reply carries `toolCalls` (which the runtime then resolves
   * and feeds back). When there are no tool calls, `message` is the final reply.
   */
  readonly complete: (request: AiTransportRequest) => Promise<AiTransportReply>;
  /**
   * Stream events for the request. `stream: true` backends emit text deltas and
   * tool calls incrementally; a backend without streaming may emit a single
   * `message` event then `done` (the runtime normalizes both).
   */
  readonly stream?: (request: AiTransportRequest) => AsyncIterable<AiStreamEvent>;
}

/** Validate a request's shape before handing it to a transport. */
export function assertValidMessages(messages: readonly AiMessage[]): void {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new AiError('invalid_messages', 'messages must be a non-empty array');
  }
  for (const message of messages) {
    if (typeof message.role !== 'string' || typeof message.content !== 'string') {
      throw new AiError('invalid_messages', 'each message needs a role and string content');
    }
  }
}
