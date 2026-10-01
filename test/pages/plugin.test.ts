/**
 * Pages plugin tests.
 *
 * The pages plugin is auto-injected by createApplication, so these tests
 * verify the plugin's contract directly and its integration at the application
 * level. Page rendering and static-export behavior is exercised through the
 * real preactPageRenderer and generateStaticSite (covered by pages/ tests);
 * the focus here is the service-token plumbing and the default-override seam.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { createApplication } from '../../src/app/application.js';
import { validateAppConfig } from '../../src/app/config/index.js';
import {
  createInterceptorRegistry,
  type JsailsExtension,
  type PluginContext,
} from '../../src/extensions/index.js';
import type { ServiceToken } from '../../src/extensions/services.js';
import type { PageRenderer } from '../../src/contracts/render.js';
import type { RouteManifestEntry } from '../../src/routing/routes.js';
import { pagesPlugin, pageRendererToken, staticSiteToken } from '../../src/pages/plugin.js';
import type {
  GenerateStaticSiteOptions,
  GenerateStaticSiteResult,
} from '../../src/pages/static-site/index.js';

const root = mkdtempSync(join(tmpdir(), 'jsails-pages-plugin-'));
after(() => {
  rmSync(root, { recursive: true, force: true });
});

// A minimal page that returns a plain string — no Preact import needed because
// the default renderer handles strings/promises/text through renderToString.
// The Preact runtime (h/Fragment) is called by the renderer, not by the page.
const PAGE_SOURCE = "export default function Page() { return 'hello-from-default-renderer'; }\n";

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

describe('pagesPlugin', () => {
  it('is a well-formed JsailsPlugin with the expected shape', () => {
    const plugin = pagesPlugin();

    assert.equal(typeof plugin.name, 'string');
    assert.equal(plugin.name, 'pages');
    assert.equal(typeof plugin.setup, 'function');
  });

  it('provides the page renderer under pageRendererToken during setup', () => {
    const plugin = pagesPlugin();

    let resolvedRenderer: PageRenderer | undefined;
    const collector: JsailsExtension = {
      name: 'collector',
      setup({ services }: PluginContext) {
        resolvedRenderer = services.get(pageRendererToken);
      },
    };

    // Minimal service registry — keyed by token identity, like runExtensions.
    const store = new Map<ServiceToken<unknown>, unknown>();
    const context: PluginContext = {
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
      intercept() {},
      observe() {},
      interceptorRegistry: createInterceptorRegistry(),
    };

    plugin.setup(context);
    collector.setup(context);

    assert.ok(resolvedRenderer !== undefined, 'the collector should resolve the page renderer');
    assert.equal(typeof resolvedRenderer.render, 'function');
  });

  it('provides the static-site generator under staticSiteToken during setup', () => {
    const plugin = pagesPlugin();

    let resolvedFn:
      ((options: GenerateStaticSiteOptions) => Promise<GenerateStaticSiteResult>) | undefined;
    const collector: JsailsExtension = {
      name: 'collector',
      setup({ services }: PluginContext) {
        resolvedFn = services.get(staticSiteToken);
      },
    };

    const store = new Map<ServiceToken<unknown>, unknown>();
    const context: PluginContext = {
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
      intercept() {},
      observe() {},
      interceptorRegistry: createInterceptorRegistry(),
    };

    plugin.setup(context);
    collector.setup(context);

    assert.ok(resolvedFn !== undefined, 'the collector should resolve the static-site generator');
    assert.equal(typeof resolvedFn, 'function');
  });
});

// ---------------------------------------------------------------------------
// Integration: default renderer (no config.renderer)
// ---------------------------------------------------------------------------

describe('createApplication: default renderer auto-injection', () => {
  it('renders a page with the default Preact renderer when config.renderer is absent', async () => {
    const dir = join(root, 'default-renderer-fetch');
    writeFixture(dir, 'pages/index.js', PAGE_SOURCE);

    // No renderer in config — the auto-injected pages plugin provides it.
    const config = makeConfig(dir);
    const app = await createApplication(config);

    const response = await app.fetch(new Request('http://localhost/'));

    assert.equal(response.status, 200);
    const html = await response.text();
    // The Preact renderer emits the page wrapped in a minimal document shell.
    assert.match(html, /hello-from-default-renderer/);
    assert.match(html, /<!DOCTYPE html/);

    await app.close();
  });

  it('static-exports pages with the default renderer when config.renderer is absent', async () => {
    const dir = join(root, 'default-renderer-build');
    writeFixture(dir, 'pages/index.js', PAGE_SOURCE);

    const config = makeConfig(dir);
    const app = await createApplication(config);
    const result = await app.build();

    assert.deepEqual(result.written, [join(dir, 'out', 'index.html')]);
    assert.deepEqual(result.skipped, []);

    const html = readFileSync(join(dir, 'out', 'index.html'), 'utf8');
    assert.match(html, /hello-from-default-renderer/);
    assert.match(html, /<!DOCTYPE html/);

    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Integration: config.renderer overrides the default
// ---------------------------------------------------------------------------

describe('createApplication: config.renderer override', () => {
  it('uses config.renderer instead of the default when one is set', async () => {
    const dir = join(root, 'override-renderer');
    writeFixture(dir, 'pages/index.js', PAGE_SOURCE);

    const calls: Array<{ route: string }> = [];
    const customRenderer: PageRenderer = {
      render(entry: RouteManifestEntry): string {
        calls.push({ route: entry.route });
        return '<html><body><p>custom-renderer-output</p></body></html>';
      },
    };

    const config = makeConfig(dir, { renderer: customRenderer });
    const app = await createApplication(config);

    const response = await app.fetch(new Request('http://localhost/'));
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /custom-renderer-output/);
    // The default renderer's <h1> must not appear.
    assert.equal(html.includes('hello-from-default-renderer'), false);

    assert.deepEqual(calls, [{ route: '/' }]);

    await app.close();
  });

  it('config.renderer also overrides the static-export renderer', async () => {
    const dir = join(root, 'override-build');
    writeFixture(dir, 'pages/index.js', PAGE_SOURCE);

    const customRenderer: PageRenderer = {
      render(entry: RouteManifestEntry): string {
        return `<html><body><p>custom-static-${entry.route}</p></body></html>`;
      },
    };

    const config = makeConfig(dir, { renderer: customRenderer });
    const app = await createApplication(config);
    await app.build();

    const html = readFileSync(join(dir, 'out', 'index.html'), 'utf8');
    assert.match(html, /custom-static-\//);
    assert.equal(html.includes('hello-from-default-renderer'), false);

    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Backward compatibility: config.extensions-only apps
// ---------------------------------------------------------------------------

describe('createApplication: backward compatibility', () => {
  it('an app with only config.extensions still renders pages with the default renderer', async () => {
    const dir = join(root, 'extensions-only-render');
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

    const response = await app.fetch(new Request('http://localhost/'));
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /hello-from-default-renderer/);

    assert.deepEqual(events, ['test-ext']);

    await app.close();
    assert.deepEqual(events, ['test-ext', 'test-ext-dispose']);
  });

  it('an app with neither plugins.use nor extensions still renders + static-exports', async () => {
    const dir = join(root, 'no-extensions-render');
    writeFixture(dir, 'pages/index.js', PAGE_SOURCE);

    const config = makeConfig(dir);
    const app = await createApplication(config);

    // Fetch a page through the default renderer.
    const response = await app.fetch(new Request('http://localhost/'));
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /hello-from-default-renderer/);

    // Static-export.
    const result = await app.build();
    assert.equal(result.written.length, 1);
    const fileHtml = readFileSync(join(dir, 'out', 'index.html'), 'utf8');
    assert.match(fileHtml, /hello-from-default-renderer/);

    await app.close();
  });

  it('an extension can consume the page renderer from the registry during its setup', async () => {
    const dir = join(root, 'consume-renderer');
    writeFixture(dir, 'pages/index.js', PAGE_SOURCE);

    let consumedRenderer: PageRenderer | undefined;
    const config = makeConfig(dir, {
      extensions: [
        {
          name: 'consumer',
          requires: [pageRendererToken],
          setup({ services }: PluginContext) {
            consumedRenderer = services.get(pageRendererToken);
          },
        },
      ],
    });

    const app = await createApplication(config);

    assert.ok(consumedRenderer !== undefined, 'extension should read the page renderer');
    assert.equal(typeof consumedRenderer.render, 'function');

    await app.close();
  });
});
