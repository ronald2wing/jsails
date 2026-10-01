/**
 * JSails MCP introspection server — barrel.
 *
 * Re-exports the tool definition, server (official MCP SDK), the in-process
 * client, and the built-in JSails tool set:
 *
 * ```ts
 * import { createMcpServer, createMcpToolRegistry, jsailsMcpTools } from 'jsails/mcp';
 * await createMcpServer({
 *   name: 'jsails',
 *   version: '1.0.0',
 *   tools: createMcpToolRegistry(jsailsMcpTools),
 * });
 * ```
 *
 * Server-only: `createMcpServer` imports the MCP SDK's stdio transport.
 */

export { createMcpServer } from './server.js';
export type { McpServerOptions } from './server.js';

export { createInProcessMcpClient, McpClientError } from './client.js';
export type { McpClient, McpCallResult } from './client.js';

export { defineMcpTool, createMcpToolRegistry, McpToolError } from './tool.js';
export type {
  McpTool,
  McpToolOptions,
  McpToolRegistry,
  McpToolResult,
  ToolDefinition,
  ToolInputSchema,
} from './tool.js';

export {
  jsailsMcpTools,
  jsailsDescribeTool,
  jsailsInspectRoutesTool,
  jsailsExplainRouteTool,
  jsailsSchemaTool,
} from './tools.js';

/**
 * Build a ready-to-run MCP stdio server for a JSails project with the built-in
 * tool set.
 */
export async function buildJsailsMcpServer(options?: { readonly version?: string }): Promise<void> {
  const { createMcpToolRegistry } = await import('./tool.js');
  const { createMcpServer } = await import('./server.js');
  const { jsailsMcpTools } = await import('./tools.js');

  return createMcpServer({
    name: 'jsails',
    version: options?.version ?? '1.0.0',
    tools: createMcpToolRegistry(jsailsMcpTools),
  });
}
