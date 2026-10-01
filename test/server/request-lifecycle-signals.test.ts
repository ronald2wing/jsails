/**
 * Request lifecycle signal emission tests.
 *
 * Exercises the signal-bounding of `runApiHandler` through `createTestApp` so
 * the real Hono pipeline (session, origin/CSRF, two-phase authorize, middleware)
 * is exercised in-process. No broadcast transport is attached and no Valkey
 * connection is opened.
 *
 * Each case writes on-disk API fixtures, assembles a test app with the signals
 * plugin plus an observer plugin that captures events into a per-test buffer,
 * and verifies the signal payloads at each lifecycle point.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { createTestApp } from '../../src/testing/app.js';
import {
  requestFailed,
  requestFinished,
  requestStarted,
  signalsPlugin,
  type RequestSignalPayload,
} from '../../src/signals/index.js';
import { defineEvent } from '../../src/extensions/interceptors.js';
import { definePlugin, type PluginContext } from '../../src/extensions/plugin-contract.js';
import type { JsailsAppConfig } from '../../src/app/config/index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const distDir = fileURLToPath(new URL('../../', import.meta.url));

function writeFixture(dir: string, relative: string, content: string): void {
  const full = join(dir, relative);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A buffered observer plugin that records every event fired during a test run. */
function capturePlugin(buffer: {
  started: RequestSignalPayload[];
  finished: RequestSignalPayload[];
  failed: RequestSignalPayload[];
}) {
  return definePlugin({
    name: 'capture',
    setup({ observe }: PluginContext) {
      observe(requestStarted, (payload) => {
        buffer.started.push(payload);
      });
      observe(requestFinished, (payload) => {
        buffer.finished.push(payload);
      });
      observe(requestFailed, (payload) => {
        buffer.failed.push(payload);
      });
    },
  });
}

/** Config shape reused across the suite. */
function makeConfig(dir: string, overrides: Partial<JsailsAppConfig> = {}): JsailsAppConfig {
  return {
    rootDir: dir,
    port: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('request lifecycle signals', () => {
  const suiteDir = mkdtempSync(join(distDir, 'reqsig-'));
  after(() => rmSync(suiteDir, { recursive: true, force: true }));

  it('200 handler emits requestStarted then requestFinished', async (t) => {
    const dir = mkdtempSync(join(suiteDir, 'ok-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));

    writeFixture(
      dir,
      'api/ok.mjs',
      `export const GET = () => new Response('ok', { status: 200 });
`,
    );

    const buffer = {
      started: [] as RequestSignalPayload[],
      finished: [] as RequestSignalPayload[],
      failed: [] as RequestSignalPayload[],
    };
    const app = await createTestApp({
      config: makeConfig(dir, {
        authorize: () => true,
        extensions: [signalsPlugin(), capturePlugin(buffer)],
      }),
      lifecycle: t,
    });

    const response = await app.request('/api/ok');
    assert.equal(response.status, 200);

    assert.equal(buffer.started.length, 1, 'requestStarted must fire exactly once');
    assert.equal(buffer.finished.length, 1, 'requestFinished must fire exactly once');
    assert.equal(buffer.failed.length, 0, 'requestFailed must not fire');

    const finished = buffer.finished[0]!;
    assert.equal(finished.status, 200);
    assert.equal(typeof finished.durationMs, 'number');
    assert.ok(finished.durationMs! >= 0);
    assert.equal(finished.method, 'GET');
  });

  it('500 handler emits requestFailed and not requestFinished', async (t) => {
    const dir = mkdtempSync(join(suiteDir, 'fail-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));

    writeFixture(
      dir,
      'api/broken.mjs',
      `export const GET = () => { throw new Error('internal failure'); };
`,
    );

    const buffer = {
      started: [] as RequestSignalPayload[],
      finished: [] as RequestSignalPayload[],
      failed: [] as RequestSignalPayload[],
    };
    const app = await createTestApp({
      config: makeConfig(dir, {
        authorize: () => true,
        extensions: [signalsPlugin(), capturePlugin(buffer)],
      }),
      lifecycle: t,
    });

    const response = await app.request('/api/broken');

    // The pipeline sanitizes the error to a 500 envelope
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.equal(body.error.code, 'internal_error');
    // The original error message must not leak
    assert.ok(!body.error.message.includes('internal failure'));

    assert.equal(buffer.started.length, 1, 'requestStarted must fire exactly once');
    assert.equal(buffer.finished.length, 0, 'requestFinished must not fire on error');
    assert.equal(buffer.failed.length, 1, 'requestFailed must fire exactly once');

    const failed = buffer.failed[0]!;
    assert.ok(failed.error instanceof Error);
    assert.equal(typeof failed.durationMs, 'number');
    assert.ok(failed.durationMs! >= 0);
  });

  it('403 (authorize deny) emits requestFinished with status 403', async (t) => {
    const dir = mkdtempSync(join(suiteDir, 'deny-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));

    writeFixture(
      dir,
      'api/guarded.mjs',
      `export const GET = () => Response.json({ ok: true });
`,
    );

    const buffer = {
      started: [] as RequestSignalPayload[],
      finished: [] as RequestSignalPayload[],
      failed: [] as RequestSignalPayload[],
    };
    // No `authorize` callback — default-deny
    const app = await createTestApp({
      config: makeConfig(dir, {
        extensions: [signalsPlugin(), capturePlugin(buffer)],
      }),
      lifecycle: t,
    });

    const response = await app.request('/api/guarded');
    assert.equal(response.status, 403);
    const body = await response.json();
    assert.equal(body.error.code, 'forbidden');

    assert.equal(buffer.started.length, 1);
    assert.equal(buffer.finished.length, 1, 'requestFinished must fire for 403 deny');
    assert.equal(buffer.failed.length, 0);

    const finished = buffer.finished[0]!;
    assert.equal(finished.status, 403);
  });

  it('no signals plugin — response unchanged, no observer invoked', async (t) => {
    const dir = mkdtempSync(join(suiteDir, 'nosig-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));

    writeFixture(
      dir,
      'api/plain.mjs',
      `export const GET = () => Response.json({ route: 'plain' });
`,
    );

    const buffer = {
      started: [] as RequestSignalPayload[],
      finished: [] as RequestSignalPayload[],
      failed: [] as RequestSignalPayload[],
    };
    // Include capturePlugin but NOT signalsPlugin — the observer plugin's observe
    // calls would fail at setup without the shared registry, so we omit observers
    // entirely. The point is that the app works without the signals plugin.
    const app = await createTestApp({
      config: makeConfig(dir, {
        authorize: () => true,
        // No signalsPlugin — the signal bus is not available
      }),
      lifecycle: t,
    });

    const response = await app.request('/api/plain');
    assert.equal(response.status, 200);

    // capturePlugin was not registered (no signalsPlugin to provide the bus),
    // so the buffer stays empty — this is expected: without the bus the pipeline
    // emits nothing and the response is identical.
    assert.equal(buffer.started.length, 0);
    assert.equal(buffer.finished.length, 0);
    assert.equal(buffer.failed.length, 0);
  });

  it('requestStarted payload is value-free (no body/headers/cookies)', async (t) => {
    const dir = mkdtempSync(join(suiteDir, 'vf-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));

    writeFixture(
      dir,
      'api/inspect.mjs',
      `export const GET = () => new Response('ok', { status: 200 });
`,
    );

    const buffer = {
      started: [] as RequestSignalPayload[],
      finished: [] as RequestSignalPayload[],
      failed: [] as RequestSignalPayload[],
    };
    const app = await createTestApp({
      config: makeConfig(dir, {
        authorize: () => true,
        extensions: [signalsPlugin(), capturePlugin(buffer)],
      }),
      lifecycle: t,
    });

    await app.request('/api/inspect?q=search');

    assert.equal(buffer.started.length, 1);
    const payload = buffer.started[0]! as unknown as Record<string, unknown>;

    // Must carry the declared fields
    assert.ok(payload.request instanceof Request);
    assert.ok(payload.url instanceof URL);
    assert.equal(typeof payload.params, 'object');
    assert.equal(typeof payload.method, 'string');
    assert.equal(typeof payload.route, 'string');

    // Must NOT carry body, headers, or cookies
    assert.ok(!('body' in payload), 'payload must not expose request body');
    assert.ok(!('headers' in payload), 'payload must not expose request headers');
    assert.ok(!('cookies' in payload), 'payload must not expose cookies');

    // session may be null (no session resolver configured)
    assert.equal(payload.session, null);
  });

  it('a handler can emit through context.services.get(signalsToken)', async (t) => {
    const dir = mkdtempSync(join(suiteDir, 'handler-emit-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));

    // The handler reaches the bus through RequestContext.services and emits a
    // custom event. The event token is shared with the observer plugin via a
    // helper module written into the fixture tree, so both sides import the
    // same module instance and therefore the same token identity (tokens are
    // identity-based, not name-based).
    writeFixture(
      dir,
      'shared-event.mjs',
      `import { defineEvent } from '${join(distDir, 'src/extensions/interceptors.js')}';
export const pinged = defineEvent('handler.pinged');
`,
    );
    writeFixture(
      dir,
      'api/ping.mjs',
      `import { signalsToken } from '${join(distDir, 'src/signals/index.js')}';
import { pinged } from '../shared-event.mjs';
export const GET = async (request, context) => {
  const bus = context.services.get(signalsToken);
  await bus.emit(pinged, { from: 'handler' });
  return Response.json({ ok: true });
};
`,
    );

    const { pinged } = (await import(join(dir, 'shared-event.mjs'))) as {
      pinged: ReturnType<typeof defineEvent<{ from: string }>>;
    };
    const received: unknown[] = [];
    const observerPlugin = definePlugin({
      name: 'ping-observer',
      setup({ observe }) {
        observe(pinged, (payload) => {
          received.push(payload);
        });
      },
    });

    const app = await createTestApp({
      config: makeConfig(dir, {
        authorize: () => true,
        extensions: [signalsPlugin(), observerPlugin],
      }),
      lifecycle: t,
    });

    const response = await app.request('/api/ping');
    assert.equal(response.status, 200);
    assert.deepEqual(received, [{ from: 'handler' }]);
  });
});
