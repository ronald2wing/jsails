/**
 * MCP client — an in-process client over a local {@link McpToolRegistry}.
 *
 * The in-process path binds a registry directly (zero I/O, zero JSON round-
 * trip): `listTools` returns the registry's definitions and `callTool` invokes
 * the handler. This is the fast path the `ai()` runtime's `McpTransport` uses.
 *
 * A *remote* MCP client (over stdio/HTTP to another server, now that the server
 * speaks the official protocol) is out of scope here — callers reaching a real
 * remote server use the `@modelcontextprotocol/sdk` `Client`. This module only
 * needs the in-process seam.
 */

import type { McpToolRegistry, ToolDefinition } from './tool.js';

/** A tool result: text content, matching what a call produces. */
export interface McpCallResult {
  readonly content: readonly { readonly type: string; readonly text?: string }[];
}

/** The client surface the `ai()` runtime consumes. */
export interface McpClient {
  listTools(): Promise<readonly ToolDefinition[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult>;
}

/** Value-free client error. */
export class McpClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpClientError';
  }
}

/**
 * Build an in-process MCP client over a local tool registry. No I/O: a call
 * invokes the handler synchronously (well, awaited) and serializes the result
 * as JSON text content.
 */
export function createInProcessMcpClient(registry: McpToolRegistry): McpClient {
  return {
    async listTools(): Promise<readonly ToolDefinition[]> {
      return registry.list();
    },

    async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
      let result: unknown;
      try {
        result = await registry.call(name, args);
      } catch {
        // Uniform, value-free client error — never echo the registry's message.
        throw new McpClientError('tool call failed');
      }
      const text = typeof result === 'string' ? result : JSON.stringify(result);
      return { content: [{ type: 'text', text }] };
    },
  };
}
