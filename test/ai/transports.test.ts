/**
 * AI transports: HttpTransport (fetch) and McpTransport (MCP client adapter).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createHttpTransport,
  createMcpTransport,
  AiError,
  type McpLikeClient,
} from '../../src/ai/index.js';

describe('createHttpTransport', () => {
  it('POSTs messages and returns the assistant reply', async () => {
    const requests: { url: string; body: unknown }[] = [];
    const transport = createHttpTransport({
      endpoint: 'https://example.test/chat',
      fetch: async (url, init) => {
        requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        return new Response(
          JSON.stringify({ message: { role: 'assistant', content: 'hi back' } }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        );
      },
    });
    const reply = await transport.complete({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
    });
    assert.deepEqual(reply.message, { role: 'assistant', content: 'hi back' });
    assert.equal(requests[0]?.url, 'https://example.test/chat');
  });

  it('throws transport_failed on a non-2xx response', async () => {
    const transport = createHttpTransport({
      endpoint: 'https://example.test/chat',
      fetch: async () => new Response('no', { status: 500 }),
    });
    await assert.rejects(
      transport.complete({ messages: [{ role: 'user', content: 'hi' }], tools: [] }),
      (e: unknown) => e instanceof AiError && e.code === 'transport_failed',
    );
  });
});

describe('createMcpTransport', () => {
  it('routes chat through the configured chat tool and unwraps text', async () => {
    const client: McpLikeClient = {
      async listTools() {
        return [];
      },
      async callTool(name) {
        assert.equal(name, 'chat');
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                message: { role: 'assistant', content: 'yo' },
                toolCalls: [],
              }),
            },
          ],
        };
      },
    };
    const transport = createMcpTransport({ client });
    const reply = await transport.complete({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
    });
    assert.deepEqual(reply.message, { role: 'assistant', content: 'yo' });
  });

  it('treats plain-text chat output as an assistant message', async () => {
    const client: McpLikeClient = {
      async listTools() {
        return [];
      },
      async callTool() {
        return { content: [{ type: 'text', text: 'plain reply' }] };
      },
    };
    const transport = createMcpTransport({ client });
    const reply = await transport.complete({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
    });
    assert.deepEqual(reply.message, { role: 'assistant', content: 'plain reply' });
  });
});
