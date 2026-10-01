/**
 * MCP tool definition and registry.
 *
 * A {@link McpTool} is a name, a description, a JSON-schema `inputSchema`,
 * and an async handler returning any value. The registry is JSails-owned and
 * dependency-free; the MCP protocol/transport layer (JSON-RPC, initialize,
 * tools/list, tools/call) is owned by the official `@modelcontextprotocol`
 * SDK in `server.ts`.
 *
 * Dependency-free — no `node:*` imports.
 */

/** A JSON-schema-shaped tool argument descriptor (plain data, no Zod). */
export interface ToolInputSchema {
  readonly type: string;
  readonly properties?: Record<string, unknown>;
  readonly required?: readonly string[];
}

/** The wire definition of a tool (name + description + input schema). */
export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: ToolInputSchema;
}

/** A handler result: serialized as JSON text in the MCP response. */
export type McpToolResult = unknown;

/** Options for {@link defineMcpTool}. */
export interface McpToolOptions {
  readonly name: string;
  readonly description: string;
  readonly inputSchema?: ToolInputSchema;
  readonly handler: (args: Record<string, unknown>) => Promise<McpToolResult>;
}

/** A registered tool: definition + handler. */
export interface McpTool {
  readonly definition: ToolDefinition;
  readonly handler: (args: Record<string, unknown>) => Promise<McpToolResult>;
}

/** A read-only registry of named tools. */
export interface McpToolRegistry {
  /** Call a tool by name, returning the raw handler result. */
  call(name: string, args: Record<string, unknown>): Promise<McpToolResult>;
  /** List every registered tool definition. */
  list(): readonly ToolDefinition[];
}

/** Value-free registry/tool error. */
export class McpToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpToolError';
  }
}

/**
 * Create a type-safe MCP tool from a plain descriptor. The `handler` is
 * called with the arguments; its return value is serialized as JSON.
 */
export function defineMcpTool(options: McpToolOptions): McpTool {
  return {
    definition: {
      name: options.name,
      description: options.description,
      inputSchema: options.inputSchema ?? { type: 'object' },
    },
    handler: options.handler,
  };
}

/**
 * Build an immutable tool registry from a list of {@link McpTool} objects.
 * Tools are keyed by name; duplicates are rejected at construction time.
 */
export function createMcpToolRegistry(tools: readonly McpTool[]): McpToolRegistry {
  const map = new Map<string, McpTool>();
  for (const tool of tools) {
    if (map.has(tool.definition.name)) {
      throw new McpToolError('duplicate tool name');
    }
    map.set(tool.definition.name, tool);
  }

  return {
    async call(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
      const tool = map.get(name);
      if (tool === undefined) {
        throw new McpToolError('unknown tool');
      }
      return tool.handler(args);
    },

    list(): readonly ToolDefinition[] {
      return Object.freeze([...map.values()].map((tool) => tool.definition));
    },
  };
}
