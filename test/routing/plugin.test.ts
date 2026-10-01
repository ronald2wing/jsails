/**
 * Routing plugin tests.
 *
 * The routing plugin is auto-injected by createApplication, so these tests
 * verify the plugin's contract directly and its integration at the application
 * level. File-based route discovery is exercised through the real
 * discoverRoutes (covered by routing.test.ts); the focus here is the
 * service-token plumbing and the boot-order inversion.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { createApplication } from '../../src/app/application.js';
import { AppConfigError, validateAppConfig } from '../../src/app/config/index.js';
import type { JsailsPlugin } from '../../src/extensions/plugin-contract.js';
import type { ServiceToken } from '../../src/extensions/services.js';
import { createInterceptorRegistry } from '../../src/extensions/index.js';
import { definePlugin } from '../../src/extensions/plugin-contract.js';
import { routingPlugin, routeManifestToken } from '../../src/routing/plugin.js';
import type { RouteManifest } from '../../src/routing/routes.js';

const root = mkdtempSync(join(tmpdir(), 'jsails-routing-plugin-'));
after(() => {
  rmSync(root, { recursive: true, force: true });
});

const PAGE_SOURCE = 'export default function Page() { return null; };\n';

function writeFixture(dir: string, rel: string, content: string): void {
  const full = join(dir, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
}

function makeConfig(dir: string, overrides: Record<string, unknown> = {}) {
  return validateAppConfig({ rootDir: dir, port: 0, ...overrides }, { cwd: dir });
}

// ---------------------------------------------------------------------------
// Plugin contract
// ---------------------------------------------------------------------------

describe('routingPlugin', () => {
  it('is a well-formed JsailsPlugin with the expected shape', () => {
    const plugin = routingPlugin({ rootDir: '/tmp' });

    assert.equal(typeof plugin.name, 'string');
    assert.equal(plugin.name, 'routing');
    assert.equal(typeof plugin.setup, 'function');
    assert.equal(typeof plugin.priority, 'number');
  });

  it('provides the route manifest under routeManifestToken during setup', () => {
    const dir = join(root, 'plugin-setup');
    writeFixture(dir, 'pages/index.js', PAGE_SOURCE);
    writeFixture(dir, 'pages/about.js', PAGE_SOURCE);

    // Run a minimal extension setup manually to prove the plugin provides the
    // manifest through the service registry.
    let resolvedManifest: RouteManifest | undefined;
    const plugin = routingPlugin({ rootDir: dir });
    const collector: JsailsPlugin = {
      name: 'collector',
      requires: [routeManifestToken],
      setup({ services }) {
        resolvedManifest = services.get(routeManifestToken);
      },
    };

    // Simulate what runExtensions does: run setup of each extension in order.
    // The Map stores services indexed by their identity. ServiceToken's identity
    // is the token object itself (not its phantom type), so indexing by the
    // token as a raw key is correct — Map.get takes `unknown` anyway.
    const store = new Map<ServiceToken<unknown>, unknown>();
    const context = {
      services: {
        get<T>(token: ServiceToken<T>): T {
          const value = store.get(token);
          if (value === undefined) {
            throw new Error(`service not found: ${token.name}`);
          }
          return value as T;
        },
        tryGet<T>(token: ServiceToken<T>): T | undefined {
          return store.get(token) as T | undefined;
        },
        has(token: ServiceToken<unknown>): boolean {
          return store.has(token);
        },
        provide<T>(token: ServiceToken<T>, value: T): void {
          store.set(token, value);
        },
      },
      configureHttp() {},
      configureMiddleware() {},
      onServe() {},
      // PluginContext extras; unused by the routing plugin's setup.
      intercept() {},
      observe() {},
      interceptorRegistry: createInterceptorRegistry(),
    };

    plugin.setup(context);
    collector.setup(context);

    assert.ok(resolvedManifest !== undefined, 'the collector should resolve the manifest');
    assert.ok(resolvedManifest.byRoute.has('/'));
    assert.ok(resolvedManifest.byRoute.has('/about'));
  });
});

// ---------------------------------------------------------------------------
// Integration: auto-injected default plugin
// ---------------------------------------------------------------------------

describe('createApplication: routing plugin injection', () => {
  it('discovers routes through the auto-injected routing plugin', async () => {
    const dir = join(root, 'injection');
    writeFixture(dir, 'pages/index.js', PAGE_SOURCE);
    writeFixture(dir, 'pages/about.js', PAGE_SOURCE);

    const config = makeConfig(dir);
    // extensions is empty — only the auto-injected routing plugin runs.
    const app = await createApplication(config);

    const manifest = app.manifest;
    assert.ok(manifest.byRoute.has('/'));
    assert.ok(manifest.byRoute.has('/about'));
    assert.equal(manifest.entries.length, 2);

    await app.close();
  });

  it('keeps working with config.extensions alongside the auto-injected plugin', async () => {
    const dir = join(root, 'with-extensions');
    writeFixture(dir, 'pages/index.js', PAGE_SOURCE);

    const events: string[] = [];
    const config = makeConfig(dir, {
      extensions: [
        {
          name: 'test-ext',
          setup() {
            events.push('test-ext');
            return () => events.push('test-ext-dispose');
          },
        },
      ],
    });

    const app = await createApplication(config);

    assert.ok(app.manifest.byRoute.has('/'));
    assert.deepEqual(events, ['test-ext']);

    await app.close();
    assert.deepEqual(events, ['test-ext', 'test-ext-dispose']);
  });

  it('an extension can read the manifest from the registry during its setup', async () => {
    const dir = join(root, 'consume-manifest');
    writeFixture(dir, 'pages/index.js', PAGE_SOURCE);

    let consumedManifest: RouteManifest | undefined;
    const config = makeConfig(dir, {
      extensions: [
        definePlugin({
          name: 'consumer',
          requires: [routeManifestToken],
          setup({ services }) {
            consumedManifest = services.get(routeManifestToken);
          },
        }),
      ],
    });

    const app = await createApplication(config);

    assert.ok(consumedManifest !== undefined, 'extension should read the manifest');
    assert.ok(consumedManifest.byRoute.has('/'));
    assert.equal(consumedManifest, app.manifest);

    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Health-route collision
// ---------------------------------------------------------------------------

describe('createApplication: health-path collision', () => {
  it('rejects a health path that collides with a discovered route, naming the file', async () => {
    const dir = join(root, 'health-collision');
    writeFixture(dir, 'pages/health.js', PAGE_SOURCE);

    await assert.rejects(
      createApplication(makeConfig(dir, { healthPath: '/health' })),
      (error: unknown) => {
        assert.ok(error instanceof AppConfigError);
        assert.match(error.message, /collides with the page route "\/health"/);
        assert.match(error.message, /health\.js/);
        return true;
      },
    );
  });

  it('allows a health path that does not collide', async () => {
    const dir = join(root, 'health-ok');
    writeFixture(dir, 'pages/index.js', PAGE_SOURCE);

    const app = await createApplication(makeConfig(dir, { healthPath: '/up' }));
    assert.ok(app.manifest.byRoute.has('/'));
    await app.close();
  });

  it('allows a disabled health path', async () => {
    const dir = join(root, 'health-disabled');
    writeFixture(dir, 'pages/index.js', PAGE_SOURCE);

    const app = await createApplication(makeConfig(dir, { healthPath: false }));
    assert.ok(app.manifest.byRoute.has('/'));
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Backward compatibility: config.extensions-only apps
// ---------------------------------------------------------------------------

describe('createApplication: backward compatibility', () => {
  it('an app with only config.extensions still discovers routes', async () => {
    const dir = join(root, 'backcompat');
    writeFixture(dir, 'pages/index.js', PAGE_SOURCE);
    writeFixture(dir, 'pages/blog/[id].js', PAGE_SOURCE);

    const events: string[] = [];
    const config = makeConfig(dir, {
      extensions: [
        {
          name: 'greeter',
          setup() {
            events.push('greeter');
            return () => events.push('greeter-dispose');
          },
        },
      ],
    });

    const app = await createApplication(config);

    assert.ok(app.manifest.byRoute.has('/'));
    assert.ok(app.manifest.byRoute.has('/blog/:id'));
    assert.deepEqual(events, ['greeter']);

    await app.close();
    assert.deepEqual(events, ['greeter', 'greeter-dispose']);
  });

  it('an app with neither plugins.use nor extensions still boots and discovers routes', async () => {
    const dir = join(root, 'no-extensions');
    writeFixture(dir, 'pages/index.js', PAGE_SOURCE);

    const config = makeConfig(dir);
    const app = await createApplication(config);

    assert.ok(app.manifest.byRoute.has('/'));
    await app.close();
  });
});
