/**
 * AI runtime — barrel.
 *
 * Browser-safe runtime + types, plus the built-in transports (server-leaning,
 * but dependency-free beyond `fetch`). Import the pure runtime:
 *
 * ```ts
 * import { createAiRuntime, createMcpTransport, createInProcessMcpClient } from 'jsails/ai';
 * const runtime = createAiRuntime(createMcpTransport({
 *   client: createInProcessMcpClient(registry),
 * }));
 * const reply = await runtime.chat([{ role: 'user', content: 'hi' }]);
 * ```
 */

export { createAiRuntime, assertValidMessages } from './runtime.js';
export type { AiRuntime, AiTransport, AiTransportReply, AiTransportRequest } from './runtime.js';

export { createHttpTransport, createMcpTransport } from './transports.js';
export type { HttpTransportOptions, McpTransportOptions, McpLikeClient } from './transports.js';

export { AiError } from './types.js';
export type { AiMessage, AiRunOptions, AiStreamEvent, AiTool, AiToolCall } from './types.js';
