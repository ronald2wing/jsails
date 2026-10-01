/**
 * AI runtime: chat/stream/run over an injectable transport, including the
 * agent (tool-calling) loop, bounds, and value-free errors.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createAiRuntime,
  AiError,
  type AiMessage,
  type AiTool,
  type AiTransport,
} from '../../src/ai/index.js';

/** A scripted transport: replies for the first `replies` snapshots, then free. */
function scriptedTransport(replies: readonly AiTransport['complete'][]): AiTransport {
  let index = 0;
  return {
    async complete(request) {
      const reply = replies[Math.min(index, replies.length - 1)] as AiTransport['complete'];
      if (index < replies.length) index += 1;
      return reply(request);
    },
  };
}

const user: AiMessage = { role: 'user', content: 'hi' };

describe('ai runtime — chat', () => {
  it('returns the transport reply as the assistant message', async () => {
    const runtime = createAiRuntime(
      scriptedTransport([
        async () => ({ message: { role: 'assistant', content: 'hello' }, toolCalls: [] }),
      ]),
    );
    const reply = await runtime.chat([user]);
    assert.deepEqual(reply, { role: 'assistant', content: 'hello' });
  });

  it('rejects an empty message list value-free', () => {
    const runtime = createAiRuntime(scriptedTransport([]));
    assert.throws(() => runtime.chat([]), AiError);
  });

  it('errors when a bare chat returns tool calls (use run)', async () => {
    const runtime = createAiRuntime(
      scriptedTransport([
        async () => ({
          message: { role: 'assistant', content: '' },
          toolCalls: [{ id: 't1', name: 'lookup', arguments: {} }],
        }),
      ]),
    );
    await assert.rejects(runtime.chat([user]), /use run\(\)/);
  });
});

describe('ai runtime — run (agent loop)', () => {
  it('resolves tool calls locally and returns the final message', async () => {
    const calls: string[][] = [];
    const weather: AiTool = {
      name: 'weather',
      description: 'get weather',
      call: async (args) => {
        calls.push(Object.keys(args));
        return { temp: 70 };
      },
    };
    const runtime = createAiRuntime(
      scriptedTransport([
        async () => ({
          message: { role: 'assistant', content: 'checking' },
          toolCalls: [{ id: 't1', name: 'weather', arguments: { city: 'Paris' } }],
        }),
        async () => ({ message: { role: 'assistant', content: 'it is 70' }, toolCalls: [] }),
      ]),
    );
    const final = await runtime.run([user], { tools: [weather], maxSteps: 4 });
    assert.equal(final.content, 'it is 70');
    assert.deepEqual(calls, [['city']]);
  });

  it('throws unknown_tool for a tool the caller did not provide', async () => {
    const runtime = createAiRuntime(
      scriptedTransport([
        async () => ({
          message: { role: 'assistant', content: '' },
          toolCalls: [{ id: 't1', name: 'ghost', arguments: {} }],
        }),
      ]),
    );
    await assert.rejects(runtime.run([user], { tools: [], maxSteps: 2 }), /unknown tool/);
  });

  it('throws loop_exceeded when the step bound is exhausted', async () => {
    const runtime = createAiRuntime(
      scriptedTransport([
        async () => ({
          message: { role: 'assistant', content: 'still going' },
          toolCalls: [{ id: 't1', name: 'noop', arguments: {} }],
        }),
      ]),
    );
    const noop: AiTool = { name: 'noop', description: 'nothing', call: async () => 'ok' };
    await assert.rejects(runtime.run([user], { tools: [noop], maxSteps: 1 }), /step bound/);
  });
});

describe('ai runtime — stream fallback', () => {
  it('yields message + done when the transport has no stream', async () => {
    const runtime = createAiRuntime(
      scriptedTransport([
        async () => ({ message: { role: 'assistant', content: 'ok' }, toolCalls: [] }),
      ]),
    );
    const events = [];
    for await (const event of runtime.stream([user])) {
      events.push(event);
    }
    assert.deepEqual(
      events.map((e) => e.type),
      ['message', 'done'],
    );
  });
});
