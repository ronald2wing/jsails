/**
 * MCP client: in-process client over a local tool registry (zero I/O).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createInProcessMcpClient, McpClientError } from '../../src/mcp/client.js';
import { createMcpToolRegistry, defineMcpTool } from '../../src/mcp/tool.js';

function sampleRegistry() {
  return createMcpToolRegistry([
    defineMcpTool({
      name: 'greet',
      description: 'Return a greeting',
      handler: async (args) => ({ greeting: `hello ${String(args.name)}` }),
    }),
    defineMcpTool({
      name: 'add',
      description: 'Add two numbers',
      handler: async (args) => Number(args.a) + Number(args.b),
    }),
  ]);
}

describe('MCP client (in-process)', () => {
  it('lists tools', async () => {
    const client = createInProcessMcpClient(sampleRegistry());
    const tools = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ['add', 'greet']);
  });

  it('calls a tool and serializes its result as JSON text', async () => {
    const client = createInProcessMcpClient(sampleRegistry());
    const result = await client.callTool('greet', { name: 'world' });
    assert.deepEqual(result.content, [{ type: 'text', text: '{"greeting":"hello world"}' }]);
  });

  it('surfaces an unknown tool as a value-free McpClientError', async () => {
    const client = createInProcessMcpClient(sampleRegistry());
    await assert.rejects(
      client.callTool('missing', {}),
      (e: unknown) => e instanceof McpClientError && e.message === 'tool call failed',
    );
  });

  it('serializes a string result without JSON-wrapping', async () => {
    const client = createInProcessMcpClient(sampleRegistry());
    const result = await client.callTool('add', { a: 2, b: 3 });
    assert.deepEqual(result.content, [{ type: 'text', text: '5' }]);
  });
});
