/**
 * MCP tool registry + in-process client tests (the JSails-owned surface).
 *
 * The JSON-RPC/stdio transport is now the official `@modelcontextprotocol`
 * SDK; what remains JSails-owned — and what these tests cover — is the tool
 * registry (duplicate rejection) and the in-process client (list/call).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createInProcessMcpClient } from '../../src/mcp/client.js';
import { createMcpToolRegistry, defineMcpTool, McpToolError } from '../../src/mcp/tool.js';
import { jsailsMcpTools } from '../../src/mcp/tools.js';

describe('McpToolRegistry', () => {
  it('rejects duplicate tool names', () => {
    const tool = defineMcpTool({
      name: 'dup',
      description: 'first',
      async handler() {
        return {};
      },
    });
    assert.throws(() => createMcpToolRegistry([tool, tool]), McpToolError);
  });

  it('lists definitions with name + description', () => {
    const registry = createMcpToolRegistry([
      defineMcpTool({ name: 'a', description: 'A', async handler() {} }),
    ]);
    assert.deepEqual(
      registry.list().map((t) => t.name),
      ['a'],
    );
  });
});

describe('in-process MCP client', () => {
  it('lists and calls a tool', async () => {
    const registry = createMcpToolRegistry([
      defineMcpTool({
        name: 'greet',
        description: 'greet',
        async handler(args) {
          return { greeting: `hello ${String(args.name)}` };
        },
      }),
    ]);
    const client = createInProcessMcpClient(registry);
    assert.equal((await client.listTools()).length, 1);
    const result = await client.callTool('greet', { name: 'x' });
    assert.deepEqual(result.content, [{ type: 'text', text: '{"greeting":"hello x"}' }]);
  });
});

describe('jsails built-in tools', () => {
  it('ships the introspection tool set', () => {
    const names = jsailsMcpTools.map((tool) => tool.definition.name).sort();
    assert.ok(names.includes('jsails_describe'));
    assert.ok(names.includes('jsails_inspect_routes'));
    assert.ok(names.includes('jsails_explain_route'));
    assert.ok(names.includes('jsails_schema'));
  });
});
