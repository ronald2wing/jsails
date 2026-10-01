/**
 * AI runtime — the neutral, provider-agnostic chat/stream/agent surface.
 *
 * `createAiRuntime(transport)` returns a runtime over an {@link AiTransport}:
 *
 * - `chat(messages, options)` — one assistant reply.
 * - `stream(messages, options)` — `AsyncIterable<AiStreamEvent>` (deltas, tool
 *   calls, then the final message).
 * - `run(messages, options)` — the agent loop: resolve tool calls against the
 *   local `tools` and feed results back, bounded by `maxSteps`, until a final
 *   assistant message without tool calls.
 *
 * The runtime owns message validation, the tool-call loop, and bounds; the
 * transport owns the wire. Browser-safe (no `node:*`).
 */

import type { AiMessage, AiRunOptions, AiStreamEvent } from './types.js';
import { AiError } from './types.js';
import { assertValidMessages, type AiTransport, type AiTransportRequest } from './transport.js';

/** The runtime surface. */
export interface AiRuntime {
  chat(messages: readonly AiMessage[], options?: AiRunOptions): Promise<AiMessage>;
  stream(messages: readonly AiMessage[], options?: AiRunOptions): AsyncIterable<AiStreamEvent>;
  run(messages: readonly AiMessage[], options?: AiRunOptions): Promise<AiMessage>;
}

const DEFAULT_MAX_STEPS = 8;

/** Build a neutral AI runtime over a transport. */
export function createAiRuntime(transport: AiTransport): AiRuntime {
  return {
    chat(messages, options) {
      assertValidMessages(messages);
      return chatOnce(transport, messages, options);
    },

    async *stream(messages, options) {
      assertValidMessages(messages);
      if (transport.stream !== undefined) {
        yield* transport.stream(toRequest(messages, options));
        return;
      }
      // No streaming backend: fall back to a single completion, emitted as one
      // message event then done.
      const { message } = await transport.complete(toRequest(messages, options));
      yield { type: 'message', message };
      yield { type: 'done', message };
    },

    run(messages, options) {
      assertValidMessages(messages);
      return runLoop(transport, messages, options);
    },
  };
}

/** One non-streaming completion, filtering out any tool calls. */
async function chatOnce(
  transport: AiTransport,
  messages: readonly AiMessage[],
  options?: AiRunOptions,
): Promise<AiMessage> {
  const reply = await transport.complete(toRequest(messages, options));
  if (reply.toolCalls.length > 0) {
    // A bare `chat` does not run tools; surface the tool call transparently so
    // the caller can decide (use `run` for the loop).
    const calls = reply.toolCalls.map((c) => c.name).join(', ');
    throw new AiError('invalid_tool', `completion requested tool calls (${calls}) — use run()`);
  }
  return reply.message;
}

/** The agent loop: resolve tool calls locally until a final message. */
async function runLoop(
  transport: AiTransport,
  messages: readonly AiMessage[],
  options?: AiRunOptions,
): Promise<AiMessage> {
  const tools = options?.tools ?? [];
  const toolMap = new Map(tools.map((tool) => [tool.name, tool]));
  const maxSteps = options?.maxSteps ?? DEFAULT_MAX_STEPS;

  let conversation = [...messages];
  for (let step = 0; step < maxSteps; step += 1) {
    const reply = await transport.complete(toRequest(conversation, options));
    if (reply.toolCalls.length === 0) {
      return reply.message;
    }

    conversation = [...conversation, reply.message];

    for (const call of reply.toolCalls) {
      const tool = toolMap.get(call.name);
      if (tool === undefined) {
        throw new AiError('unknown_tool', 'the model requested an unknown tool');
      }
      let result: unknown;
      try {
        result = await tool.call(call.arguments);
      } catch (error) {
        throw new AiError(
          'transport_failed',
          `tool execution failed${error instanceof Error ? `: ${error.message}` : ''}`,
        );
      }
      conversation = [
        ...conversation,
        {
          role: 'tool' as const,
          content: stringifyToolResult(result),
          toolCallId: call.id,
        },
      ];
    }
  }

  throw new AiError('loop_exceeded', 'the agent loop exceeded its step bound');
}

/** Serialize a tool result back to the model as a JSON string. */
function stringifyToolResult(result: unknown): string {
  if (typeof result === 'string') return result;
  let serialized: string;
  try {
    serialized = JSON.stringify(result);
  } catch {
    serialized = String(result);
  }
  return serialized;
}

function toRequest(messages: readonly AiMessage[], options?: AiRunOptions): AiTransportRequest {
  return {
    messages,
    tools: options?.tools ?? [],
    ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
  };
}

export type { AiTransport, AiTransportRequest, AiTransportReply } from './transport.js';
export { assertValidMessages } from './transport.js';
export type { AiMessage, AiStreamEvent, AiTool, AiToolCall, AiRunOptions } from './types.js';
export { AiError } from './types.js';
