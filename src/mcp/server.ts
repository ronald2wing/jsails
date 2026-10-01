/**
 * MCP server — the official `@modelcontextprotocol/server` SDK.
 *
 * `createMcpServer({ name, version, tools })` builds a spec-current MCP stdio
 * server over the maintained SDK: each {@link McpToolRegistry} entry is
 * registered via `McpServer.registerTool`, and the SDK owns the JSON-RPC
 * lifecycle (initialize, tools/list, tools/call, pings, notifications, and
 * protocol-version negotiation) instead of a hand-rolled subset. The tool
 * registry stays JSails-owned.
 *
 * Server-only: imports the SDK's stdio transport.
 */

import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

import type { McpToolRegistry } from './tool.js';

/** Options for {@link createMcpServer}. */
export interface McpServerOptions {
  readonly name: string;
  readonly version: string;
  readonly tools: McpToolRegistry;
}

/**
 * Serve the tool registry over MCP stdio. Resolves once the transport closes
 * (the SDK's stdio transport closes when stdin reaches EOF).
 */
export async function createMcpServer(options: McpServerOptions): Promise<void> {
  const server = new McpServer(
    { name: options.name, version: options.version },
    { capabilities: { tools: {} } },
  );

  for (const tool of options.tools.list()) {
    server.registerTool(
      tool.name,
      { description: tool.description },
      async (args: Record<string, unknown>) => {
        const result = await options.tools.call(tool.name, args);
        return { content: [serializeToolResult(result)] };
      },
    );
  }

  await server.connect(new StdioServerTransport());
}

/** Serialize an arbitrary tool return value to an MCP text content block. */
function serializeToolResult(result: unknown): { type: 'text'; text: string } {
  const text = typeof result === 'string' ? result : JSON.stringify(result);
  return { type: 'text', text };
}
