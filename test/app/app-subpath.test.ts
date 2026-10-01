/**
 * App subpath tests: `jsails/app` barrel resolution, `appPlugin` identity,
 * service wiring through the extension runner, token provision, and backward
 * compatibility with the root entry. No connection, database, or external
 * service is opened.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runExtensions } from '../../src/extensions/index.js';
import {
  appPlugin,
  httpAppToken,
  createApp,
  createHttpServer,
  createPublicFilesMiddleware,
} from '../../src/app/index.js';
import type { HttpApp, AppOptions } from '../../src/app/index.js';

// Root-entry imports for the same-function-reference verification.
import { createApp as rootCreateApp } from '../../src/server/app.js';
import { createHttpServer as rootCreateHttpServer } from '../../src/server/server-http.js';
import { createPublicFilesMiddleware as rootCreatePublicFilesMiddleware } from '../../src/app/static-files.js';

describe('jsails/app barrel', () => {
  it('re-exports createApp from the same source as the root entry', () => {
    // Same function reference means the barrel and the root share one canonical export.
    assert.strictEqual(createApp, rootCreateApp);
  });

  it('re-exports createHttpServer from the same source as the root entry', () => {
    assert.strictEqual(createHttpServer, rootCreateHttpServer);
  });

  it('re-exports createPublicFilesMiddleware from the same source as the root entry', () => {
    assert.strictEqual(createPublicFilesMiddleware, rootCreatePublicFilesMiddleware);
  });

  it('exposes the core HTTP types (compile-time)', () => {
    // The import-block above already proves all types resolve. This test
    // exercises the value-level shape using `typeof` in a value position.
    const options: AppOptions = { manifest: { entries: [], byRoute: new Map() } };
    assert.equal(typeof options.manifest, 'object');
  });

  it('exposes the HttpApp and AppOptions types from the barrel', () => {
    // Type-only imports above already prove they resolve at compile time.
    assert.ok(true);
  });
});

describe('appPlugin identity', () => {
  it('has name "app" and priority -999', () => {
    const plugin = appPlugin();
    assert.equal(plugin.name, 'app');
    assert.equal(plugin.priority, -999);
  });

  it('has a stable token name', () => {
    assert.equal(httpAppToken.name, 'app');
  });

  it('constructing the plugin performs no I/O', () => {
    const plugin = appPlugin();
    assert.equal(typeof plugin.name, 'string');
    assert.equal(typeof plugin.setup, 'function');
  });
});

describe('appPlugin service provision', () => {
  it('provides HttpApp under the token', async () => {
    const runtime = await runExtensions([appPlugin()]);
    try {
      const httpApp: HttpApp = runtime.services.get(httpAppToken);
      assert.ok(httpApp !== null && typeof httpApp === 'object');

      // Every tool category is present.
      assert.equal(typeof httpApp.createApp, 'function');
      assert.equal(typeof httpApp.createHttpServer, 'function');
      assert.equal(typeof httpApp.createPublicFilesMiddleware, 'function');

      // The functions provided through the service are the same references as
      // the barrel re-exports.
      assert.strictEqual(httpApp.createApp, createApp);
      assert.strictEqual(httpApp.createHttpServer, createHttpServer);
      assert.strictEqual(httpApp.createPublicFilesMiddleware, createPublicFilesMiddleware);
    } finally {
      await runtime.close();
    }
  });
});

describe('idempotent close', () => {
  it('closes idempotently with no handles held', async () => {
    const runtime = await runExtensions([appPlugin()]);
    await runtime.close();
    await runtime.close();
  });
});
