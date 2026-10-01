/**
 * Dev live-reload: the reload SSE route and the inline subscriber script.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { devReloadScript, liveReloadResponse } from '../../src/dev/live-reload.js';
import { devPlugin } from '../../src/dev/plugin.js';

const openStreams: ReadableStream<Uint8Array>[] = [];

function track(response: Response): Response {
  if (response.body !== null) openStreams.push(response.body);
  return response;
}

afterEach(async () => {
  for (const stream of openStreams.splice(0)) {
    await stream.cancel();
  }
});

describe('dev live reload', () => {
  it('emits an SSE response with the event-stream content type', () => {
    const response = track(liveReloadResponse());
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  });

  it('streams a keep-alive channel (readable, retry hint)', async () => {
    const response = track(liveReloadResponse({ retryMs: 500 }));
    const reader = response.body!.getReader();
    const { value } = await reader.read();
    const chunk = new TextDecoder().decode(value);
    assert.match(chunk, /retry: 500/);
    reader.releaseLock();
  });

  it('emits a self-contained subscriber script that reloads on reconnect', () => {
    const script = devReloadScript();
    assert.match(script, /EventSource/);
    assert.match(script, /location\.reload/);
    assert.match(script, /_jsails\/dev\/reload/);
  });

  it('devPlugin is a no-op when disabled (no http hook)', async () => {
    const plugin = devPlugin({ enabled: false });
    const hooks: unknown[] = [];
    await plugin.setup?.({ configureHttp: (hook: unknown) => hooks.push(hook) } as never);
    assert.equal(hooks.length, 0);
  });
});
