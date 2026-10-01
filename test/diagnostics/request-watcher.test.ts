/**
 * Request watcher tests: recording on requestFinished / requestFailed via a
 * real SignalBus backed by an in-process InterceptorRegistry. Verifies
 * value-free entries (no headers, body, url, or params), slow flag
 * threshold, and unsubscribe behaviour.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createInterceptorRegistry,
  type InterceptorRegistry,
} from '../../src/extensions/interceptors.js';
import { createSignalBus } from '../../src/signals/signal-bus.js';
import { requestFailed, requestFinished } from '../../src/signals/request-signals.js';
import type { RequestSignalPayload } from '../../src/signals/request-signals.js';
import type { DiagnosticsEntry } from '../../src/diagnostics/recorder.js';
import type { WatcherContext } from '../../src/diagnostics/watchers.js';
import { createRequestWatcher } from '../../src/diagnostics/watchers/request.js';

/** Minimal request payload with only the fields the watcher observes. */
function makePayload(overrides: Partial<RequestSignalPayload> = {}): RequestSignalPayload {
  return {
    request: new Request('http://localhost/api/users'),
    url: new URL('http://localhost/api/users'),
    params: { id: '42' },
    session: { userId: 1 },
    method: 'GET',
    route: '/api/users',
    status: 200,
    durationMs: 50,
    ...overrides,
  };
}

function setup() {
  const registry: InterceptorRegistry = createInterceptorRegistry();
  const bus = createSignalBus(registry);

  const recorded: DiagnosticsEntry[] = [];
  const now = (): number => Date.now();

  const ctx: WatcherContext = {
    record: (entry) => recorded.push(entry as DiagnosticsEntry),
    now,
  };

  const watcher = createRequestWatcher({ signals: bus });
  const unsub = watcher.register(ctx);

  return { registry, bus, recorded, unsub };
}

describe('createRequestWatcher', () => {
  it('records a request on requestFinished with method/route/status/duration', async () => {
    const { registry, recorded } = setup();

    const payload = makePayload({
      method: 'POST',
      route: '/api/posts',
      status: 201,
      durationMs: 42,
    });
    await registry.emit(requestFinished, payload);

    assert.equal(recorded.length, 1);
    const entry = recorded[0]!;
    assert.equal(entry.type, 'request');
    assert.deepEqual(entry.data, {
      method: 'POST',
      route: '/api/posts',
      status: 201,
      durationMs: 42,
      slow: false,
    });
  });

  it('records a failed:request on requestFailed', async () => {
    const { registry, recorded } = setup();

    const payload = makePayload({
      method: 'DELETE',
      route: '/api/posts/1',
      status: 500,
      durationMs: 150,
    });
    await registry.emit(requestFailed, payload);

    assert.equal(recorded.length, 1);
    const entry = recorded[0]!;
    assert.equal(entry.type, 'failed:request');
    assert.deepEqual(entry.data, {
      method: 'DELETE',
      route: '/api/posts/1',
      status: 500,
      durationMs: 150,
      slow: false,
    });
  });

  it('sets slow to true when durationMs meets or exceeds slowMs (default 1000)', async () => {
    const { registry, recorded } = setup();

    await registry.emit(requestFinished, makePayload({ durationMs: 1000 }));

    assert.equal(recorded.length, 1);
    assert.equal(recorded[0]!.data?.slow, true);
  });

  it('sets slow to false when durationMs is under slowMs (default 1000)', async () => {
    const { registry, recorded } = setup();

    await registry.emit(requestFinished, makePayload({ durationMs: 999 }));

    assert.equal(recorded.length, 1);
    assert.equal(recorded[0]!.data?.slow, false);
  });

  it('respects a custom slowMs threshold', async () => {
    const registry = createInterceptorRegistry();
    const bus = createSignalBus(registry);
    const recorded: DiagnosticsEntry[] = [];

    const watcher = createRequestWatcher({ signals: bus, slowMs: 200 });
    watcher.register({
      record: (e) => recorded.push(e as DiagnosticsEntry),
      now: () => Date.now(),
    });

    await registry.emit(requestFinished, makePayload({ durationMs: 200 }));
    assert.equal(recorded[0]!.data?.slow, true);

    await registry.emit(requestFinished, makePayload({ durationMs: 199 }));
    assert.equal(recorded[1]!.data?.slow, false);
  });

  it('never records headers, body, url, params, or request in data', async () => {
    const { registry, recorded } = setup();

    const payload = makePayload({
      method: 'GET',
      route: '/api/secrets',
      status: 200,
      durationMs: 10,
    });

    await registry.emit(requestFinished, payload);

    const data = recorded[0]!.data!;
    assert.ok(!Object.hasOwn(data, 'headers'));
    assert.ok(!Object.hasOwn(data, 'body'));
    assert.ok(!Object.hasOwn(data, 'url'));
    assert.ok(!Object.hasOwn(data, 'params'));
    assert.ok(!Object.hasOwn(data, 'request'));
    assert.ok(!Object.hasOwn(data, 'session'));

    // Only the five known fields exist.
    const keys = Object.keys(data).sort();
    assert.deepEqual(keys, ['durationMs', 'method', 'route', 'slow', 'status']);
  });

  it('unsubscribe stops further recording', async () => {
    const { registry, recorded, unsub } = setup();

    await registry.emit(requestFinished, makePayload());
    assert.equal(recorded.length, 1);

    unsub();

    await registry.emit(requestFinished, makePayload());
    await registry.emit(requestFailed, makePayload());

    assert.equal(recorded.length, 1);
  });

  it('continuously records multiple events before unsub', async () => {
    const { registry, recorded } = setup();

    await registry.emit(requestFinished, makePayload({ method: 'GET' }));
    await registry.emit(requestFailed, makePayload({ method: 'POST' }));
    await registry.emit(requestFinished, makePayload({ method: 'PUT' }));

    assert.equal(recorded.length, 3);
    assert.equal(recorded[0]!.type, 'request');
    assert.equal(recorded[1]!.type, 'failed:request');
    assert.equal(recorded[2]!.type, 'request');
  });
});
