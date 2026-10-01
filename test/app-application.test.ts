/**
 * Application runtime tests.
 *
 * Fixtures are real compiled ESM modules written to a temp directory and
 * imported through Node's normal module loader; the only import they carry is
 * an absolute file URL to a shared service-token module. Nothing here opens a
 * database or Valkey connection: the extension provides an in-memory service
 * that both the custom renderer (build and serve) and an API handler read, which
 * proves the plumbing is service-agnostic rather than database-specific. The
 * public-asset case only runs when the `src/app/static-files.js` helper (owned
 * by a parallel change) is present and returns middleware; otherwise it skips.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server as NodeHttpServer } from 'node:http';
import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, describe, it } from 'node:test';
import { io as createClient } from 'socket.io-client';

import { createApplication } from '../src/app/application.js';
import { AppConfigError, validateAppConfig } from '../src/app/config.js';
import { BROADCAST_PATH, type BroadcastAdapter } from '../src/broadcast/server.js';
import type { RequestContext } from '../src/contracts/http.js';
import type { PageRenderer, PageRenderOptions } from '../src/contracts/render.js';
import type { JsailsExtension, ServiceToken } from '../src/extensions/index.js';
import type { RouteManifestEntry } from '../src/routing/manifest.js';

const root = mkdtempSync(join(tmpdir(), 'jsails-app-'));
after(() => {
  rmSync(root, { recursive: true, force: true });
});

interface GreetingService {
  readonly greeting: string;
}

const GREETING: GreetingService = { greeting: 'hello-from-service' };

// A shared module is the only way an on-disk API module and the in-process test
// can resolve the same service-token identity (the registry keys by identity).
const tokensFile = writeFile(
  join(root, 'tokens.js'),
  'export const GREETER = { name: "greeter" };\n',
);
const tokensUrl = pathToFileURL(tokensFile).href;
const tokens = (await import(tokensUrl)) as { GREETER: ServiceToken<GreetingService> };
const GREETER = tokens.GREETER;

// A second shared module lets an on-disk API module block on a test-controlled
// gate, so the close-vs-in-flight-fetch coordination is deterministic.
const gateFile = writeFile(join(root, 'gate.js'), 'export const GATE = { name: "gate" };\n');
const gateUrl = pathToFileURL(gateFile).href;
const gateTokens = (await import(gateUrl)) as { GATE: ServiceToken<unknown> };
const GATE = gateTokens.GATE;

let sequence = 0;

/** Write a file (creating parent directories) and return its absolute path. */
function writeFile(path: string, content: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

/** Create an isolated case directory with optional page/api/public fixtures. */
function setupCase(
  assets: {
    pages?: Record<string, string>;
    api?: Record<string, string>;
    public?: Record<string, string>;
  } = {},
): string {
  const dir = mkdtempSync(join(root, `case-${sequence++}-`));
  for (const [subdir, files] of Object.entries(assets)) {
    for (const [rel, content] of Object.entries(files)) {
      writeFile(join(dir, subdir, rel), content);
    }
  }
  return dir;
}

/** A page module that is only ever discovered, never imported (custom renderer). */
const PAGE_SOURCE = 'export default function Page() { return null; };\n';

/** An API module that reads the extension-provided service from the context. */
const API_SOURCE = `import { GREETER } from ${JSON.stringify(tokensUrl)};
export async function GET(request, context) {
  const service = context.services.get(GREETER);
  return new Response(JSON.stringify({ greeting: service.greeting, route: 'api' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
`;

/** A mutating API module that echoes the resolved session id. */
const POST_SOURCE = `
export async function POST(request, context) {
  return new Response(JSON.stringify({ session: context.session?.id ?? null }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
`;

/** An API module that reports the peak concurrency it observed. */
const CONCURRENT_SOURCE = `
let active = 0;
let peak = 0;
export async function GET() {
  active += 1;
  peak = Math.max(peak, active);
  await new Promise((resolve) => setTimeout(resolve, 20));
  active -= 1;
  return new Response(JSON.stringify({ peak }), {
    headers: { 'content-type': 'application/json' },
  });
}
`;

/** An API module that blocks on a shared test-controlled gate. */
const GATED_SOURCE = `import { GATE } from ${JSON.stringify(gateUrl)};
export async function GET(request, context) {
  const gate = context.services.get(GATE);
  gate.markStarted();
  await gate.wait();
  return new Response('done', { status: 200 });
}
`;

/** A renderer that records each render and reads the service from the context. */
class RecordingRenderer implements PageRenderer {
  readonly calls: Array<{ route: string; staticMode: boolean | undefined; greeting: string }> = [];
  render(entry: RouteManifestEntry, context: RequestContext, options?: PageRenderOptions): string {
    const greeting = context.services?.tryGet(GREETER)?.greeting ?? 'missing';
    this.calls.push({ route: entry.route, staticMode: options?.staticMode, greeting });
    return `<div>${greeting}:${entry.route}</div>`;
  }
}

/** An extension that records setup/teardown order (and optionally provides). */
function orderExtension(name: string, events: string[]): JsailsExtension {
  return {
    name,
    setup() {
      events.push(name);
      return () => {
        events.push(`dispose-${name}`);
      };
    },
  };
}

/** An extension that provides the shared service token. */
const greeterExtension: JsailsExtension = {
  name: 'greeter',
  setup(context) {
    context.services.provide(GREETER, GREETING);
    return () => {};
  },
};

/** An extension whose HTTP hook records each invocation and adds a route. */
function hookExtension(counter: { value: number }): JsailsExtension {
  return {
    name: 'hooker',
    setup(context) {
      context.configureHttp((app) => {
        counter.value += 1;
        app.get('/hook-route', (c) => c.json({ hooked: true }));
      });
    },
  };
}

/** A test-controlled gate shared with an on-disk API module. */
function makeGate(): {
  readonly started: () => boolean;
  markStarted(): void;
  wait(): Promise<void>;
  release(): void;
} {
  let started = false;
  let release: (() => void) | undefined;
  const done = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    started: () => started,
    markStarted() {
      started = true;
    },
    wait: () => done,
    release: () => release?.(),
  };
}

function makeConfig(dir: string, overrides: Record<string, unknown> = {}) {
  return validateAppConfig({ rootDir: dir, port: 0, ...overrides }, { cwd: dir });
}

/** State a fake broadcast adapter records for lifecycle assertions. */
interface FakeAdapterState {
  attachCalls: number;
  attachedServer: NodeHttpServer | undefined;
  closeCalls: number;
}

function makeFakeState(): FakeAdapterState {
  return { attachCalls: 0, attachedServer: undefined, closeCalls: 0 };
}

/** A real, in-process custom transport that only records attach/close calls. */
function fakeAdapter(state: FakeAdapterState, opts: { closeError?: Error } = {}): BroadcastAdapter {
  return {
    name: 'fake',
    attach(server) {
      state.attachCalls += 1;
      state.attachedServer = server;
      return {
        closesHttpServer: false,
        broadcast() {},
        close() {
          state.closeCalls += 1;
          return opts.closeError === undefined
            ? Promise.resolve()
            : Promise.reject(opts.closeError);
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Static helper probe (owned by a parallel change; skip when unavailable)
// ---------------------------------------------------------------------------

interface StaticHelper {
  createPublicFilesMiddleware: (publicDir: string) => Promise<unknown>;
}

async function loadStaticHelper(): Promise<StaticHelper | undefined> {
  try {
    return await import('../src/app/static-files.js');
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe('createApplication lifecycle', () => {
  it('runs extensions and app setup in order, and tears down in reverse', async () => {
    const dir = setupCase();
    const events: string[] = [];
    const config = makeConfig(dir, {
      setup() {
        events.push('app-setup');
        return () => {
          events.push('app-cleanup');
        };
      },
      extensions: [orderExtension('a', events), orderExtension('b', events)],
    });

    const app = await createApplication(config);

    assert.deepEqual(events, ['a', 'b', 'app-setup']);
    await app.close();
    assert.deepEqual(events, ['a', 'b', 'app-setup', 'app-cleanup', 'dispose-b', 'dispose-a']);
  });

  it('closes already-open extensions when the app setup hook fails', async () => {
    const dir = setupCase();
    const events: string[] = [];
    const config = makeConfig(dir, {
      setup() {
        throw new Error('setup boom');
      },
      extensions: [orderExtension('a', events), orderExtension('b', events)],
    });

    await assert.rejects(createApplication(config), /setup boom/);
    assert.deepEqual(events, ['a', 'b', 'dispose-b', 'dispose-a']);
  });

  it('close is idempotent and rejects further build/serve', async () => {
    const dir = setupCase();
    const app = await createApplication(makeConfig(dir));

    await app.close();
    await app.close();

    await assert.rejects(app.build(), /application is closed/);
    await assert.rejects(app.serve(), /application is closed/);
  });
});

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

describe('Application.build', () => {
  it('renders pages and copies assets through the custom renderer + services without listening', async () => {
    const dir = setupCase({
      pages: { 'index.js': PAGE_SOURCE },
      public: { 'robots.txt': 'User-agent: *\n' },
    });
    const renderer = new RecordingRenderer();
    const config = makeConfig(dir, { renderer, extensions: [greeterExtension] });

    const app = await createApplication(config);
    const result = await app.build();

    assert.deepEqual(result.skipped, []);
    assert.deepEqual(result.written, [join(dir, 'out', 'index.html')]);
    assert.deepEqual(result.copied, [join(dir, 'out', 'robots.txt')]);

    const html = readFileSync(join(dir, 'out', 'index.html'), 'utf8');
    assert.match(html, /hello-from-service:\//);
    assert.equal(readFileSync(join(dir, 'out', 'robots.txt'), 'utf8'), 'User-agent: *\n');

    // The build renders in static mode and reads the service from the context.
    assert.deepEqual(renderer.calls, [
      { route: '/', staticMode: true, greeting: 'hello-from-service' },
    ]);

    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Serve
// ---------------------------------------------------------------------------

describe('Application.serve', () => {
  it('serves page and API routes over loopback with extension services', async () => {
    const dir = setupCase({
      pages: { 'index.js': PAGE_SOURCE },
      api: { 'hello.js': API_SOURCE },
    });
    const renderer = new RecordingRenderer();
    const config = makeConfig(dir, {
      renderer,
      extensions: [greeterExtension],
      authorize: () => true,
    });

    const app = await createApplication(config);
    assert.equal(app.services.get(GREETER).greeting, 'hello-from-service');

    const handle = await app.serve();
    try {
      const page = await fetch(new URL('/', handle.url));
      assert.equal(page.status, 200);
      assert.match(await page.text(), /hello-from-service:\//);

      const api = await fetch(new URL('/api/hello', handle.url));
      assert.equal(api.status, 200);
      assert.deepEqual(await api.json(), { greeting: 'hello-from-service', route: 'api' });

      assert.equal(handle.port, (handle.server.address() as AddressInfo).port);
      assert.match(handle.url, new RegExp(`http://127\\.0\\.0\\.1:${handle.port}/$`));

      // Serve renders in request mode (staticMode false) and reads the service.
      assert.ok(renderer.calls.some((call) => call.staticMode === false && call.route === '/'));
    } finally {
      await handle.close();
    }
  });

  it('serves public assets when the static-files helper provides middleware', async (t) => {
    const helper = await loadStaticHelper();
    if (helper === undefined) {
      t.skip('static-files helper not available');
      return;
    }

    const dir = setupCase({ public: { 'robots.txt': 'User-agent: *\n' } });
    const config = makeConfig(dir);
    const app = await createApplication(config);

    if ((await helper.createPublicFilesMiddleware(config.publicDir)) === undefined) {
      t.skip('static-files helper returned no middleware');
      await app.close();
      return;
    }

    const handle = await app.serve();
    try {
      const res = await fetch(new URL('/robots.txt', handle.url));
      assert.equal(res.status, 200);
      assert.equal(await res.text(), 'User-agent: *\n');
    } finally {
      await handle.close();
    }
  });

  it('attaches broadcast to the same server and port when configured', async () => {
    const dir = setupCase({ pages: { 'index.js': PAGE_SOURCE } });
    const config = makeConfig(dir, {
      renderer: new RecordingRenderer(),
      broadcast: {
        allowedOrigins: ['https://app.example'],
        authenticate: () => 'user',
      },
    });

    const app = await createApplication(config);
    const handle = await app.serve();
    try {
      await connectSocket(handle.port);
      // The same server still serves HTTP.
      const res = await fetch(new URL('/', handle.url));
      assert.equal(res.status, 200);
    } finally {
      await handle.close();
    }
  });

  it('cleans up owned resources when listen fails and leaves the app usable', async () => {
    // Occupy an ephemeral port, then ask the app to bind the same one.
    const blocker = createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once('error', reject);
      blocker.listen(0, '127.0.0.1', () => resolve());
    });
    const port = (blocker.address() as AddressInfo).port;

    const dir = setupCase({ pages: { 'index.js': PAGE_SOURCE } });
    const renderer = new RecordingRenderer();
    const config = makeConfig(dir, { port, renderer, extensions: [greeterExtension] });

    const app = await createApplication(config);

    await assert.rejects(
      app.serve(),
      (error: unknown) => (error as NodeJS.ErrnoException).code === 'EADDRINUSE',
    );

    // The failed serve did not close the app: it can still build, then close.
    const result = await app.build();
    assert.deepEqual(result.written, [join(dir, 'out', 'index.html')]);
    assert.ok(renderer.calls.some((call) => call.staticMode === true));

    await app.close();
    blocker.close();
  });
});

// ---------------------------------------------------------------------------
// Serve: custom broadcast adapter
// ---------------------------------------------------------------------------

describe('Application.serve: custom broadcast adapter', () => {
  it('attaches a custom adapter to the app-owned server, serves HTTP on the same port, and closes both on close', async () => {
    const dir = setupCase({ pages: { 'index.js': PAGE_SOURCE } });
    const state = makeFakeState();
    const config = makeConfig(dir, {
      renderer: new RecordingRenderer(),
      broadcast: { adapter: fakeAdapter(state) },
    });

    const app = await createApplication(config);
    const handle = await app.serve();
    try {
      assert.equal(state.attachCalls, 1, 'the adapter attach runs exactly once');
      assert.equal(state.attachedServer, handle.server, 'attach receives the app-owned server');

      // The same port still serves the HTTP application.
      const res = await fetch(new URL('/', handle.url));
      assert.equal(res.status, 200);
    } finally {
      await handle.close();
    }

    // `closesHttpServer: false` means the transport stops itself and leaves the
    // server to the application, which must close it.
    assert.equal(state.closeCalls, 1, 'the transport was disposed exactly once');
    assert.equal(handle.server.listening, false, 'the app closes the HTTP server itself');
  });

  it('closes the HTTP server and extensions when a custom adapter close throws', async () => {
    const dir = setupCase({ pages: { 'index.js': PAGE_SOURCE } });
    const events: string[] = [];
    const state = makeFakeState();
    const config = makeConfig(dir, {
      renderer: new RecordingRenderer(),
      extensions: [orderExtension('a', events)],
      broadcast: { adapter: fakeAdapter(state, { closeError: new Error('transport boom') }) },
    });

    const app = await createApplication(config);
    const handle = await app.serve();

    await assert.rejects(handle.close(), /transport boom/);

    assert.equal(state.closeCalls, 1, 'the transport close was attempted');
    assert.equal(
      handle.server.listening,
      false,
      'the HTTP server is closed despite the transport error',
    );
    assert.deepEqual(
      events,
      ['a', 'dispose-a'],
      'extensions are cleaned up after the transport error',
    );
  });

  it('disposes the app-owned server and stays usable when a custom adapter attach fails', async () => {
    const dir = setupCase({ pages: { 'index.js': PAGE_SOURCE } });
    const renderer = new RecordingRenderer();
    const config = makeConfig(dir, {
      renderer,
      broadcast: {
        adapter: {
          name: 'failing',
          attach() {
            throw new Error('attach boom');
          },
        },
      },
    });

    const app = await createApplication(config);

    await assert.rejects(app.serve(), /attach boom/);

    // The failed serve did not close the app: it can still build, then close.
    const result = await app.build();
    assert.deepEqual(result.written, [join(dir, 'out', 'index.html')]);
    assert.ok(renderer.calls.some((call) => call.staticMode === true));

    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Health endpoint
// ---------------------------------------------------------------------------

describe('health endpoint', () => {
  it('serves GET /up through fetch and serve, independent of the default-deny API', async () => {
    const dir = setupCase({ pages: { 'index.js': PAGE_SOURCE } });
    const config = makeConfig(dir, { renderer: new RecordingRenderer() });

    const app = await createApplication(config);

    const viaFetch = await app.fetch(new Request('http://localhost/up'));
    assert.equal(viaFetch.status, 200);
    assert.equal(viaFetch.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.equal(viaFetch.headers.get('cache-control'), 'no-store');
    assert.equal(await viaFetch.text(), 'OK');

    const handle = await app.serve();
    try {
      const viaHttp = await fetch(new URL('/up', handle.url));
      assert.equal(viaHttp.status, 200);
      assert.equal(await viaHttp.text(), 'OK');
    } finally {
      await handle.close();
    }
    await app.close();
  });

  it('rejects a health path that collides with a discovered route, naming the file', async () => {
    const dir = setupCase({ pages: { 'health.js': PAGE_SOURCE } });
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

  it('serves a 404 when the health path is disabled', async () => {
    const dir = setupCase({ pages: { 'index.js': PAGE_SOURCE } });
    const config = makeConfig(dir, { renderer: new RecordingRenderer(), healthPath: false });
    const app = await createApplication(config);

    assert.equal((await app.fetch(new Request('http://localhost/up'))).status, 404);

    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Storage directory lifecycle
// ---------------------------------------------------------------------------

describe('storage directory lifecycle', () => {
  it('creates the storage directory on serve, not on build or fetch', async () => {
    const dir = setupCase({ pages: { 'index.js': PAGE_SOURCE } });
    const config = makeConfig(dir, { renderer: new RecordingRenderer() });
    const storageDir = config.storageDir;

    assert.equal(existsSync(storageDir), false, 'storage must not exist before serving');

    const app = await createApplication(config);

    await app.fetch(new Request('http://localhost/'));
    assert.equal(existsSync(storageDir), false, 'fetch must not create storage');

    await app.build();
    assert.equal(existsSync(storageDir), false, 'build must not create storage');

    const handle = await app.serve();
    try {
      assert.equal(existsSync(storageDir), true, 'serve must create storage');
    } finally {
      await handle.close();
    }
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Fetch (serverless request routing through the shared Hono pipeline)
// ---------------------------------------------------------------------------

describe('Application.fetch', () => {
  it('serves page and API routes with extension services, without a server', async () => {
    const dir = setupCase({
      pages: { 'index.js': PAGE_SOURCE },
      api: { 'hello.js': API_SOURCE },
    });
    const renderer = new RecordingRenderer();
    const config = makeConfig(dir, {
      renderer,
      extensions: [greeterExtension],
      authorize: () => true,
    });

    const app = await createApplication(config);

    const page = await app.fetch(new Request('http://localhost/'));
    assert.equal(page.status, 200);
    assert.match(await page.text(), /hello-from-service:\//);

    const api = await app.fetch(new Request('http://localhost/api/hello'));
    assert.equal(api.status, 200);
    assert.deepEqual(await api.json(), { greeting: 'hello-from-service', route: 'api' });

    // Fetch renders in request mode (staticMode false) and reads the service.
    assert.ok(renderer.calls.some((call) => call.staticMode === false && call.route === '/'));

    await app.close();
  });

  it('serves public assets when the static-files helper provides middleware', async (t) => {
    const helper = await loadStaticHelper();
    if (helper === undefined) {
      t.skip('static-files helper not available');
      return;
    }

    const dir = setupCase({ public: { 'robots.txt': 'User-agent: *\n' } });
    const config = makeConfig(dir);
    const app = await createApplication(config);

    if ((await helper.createPublicFilesMiddleware(config.publicDir)) === undefined) {
      t.skip('static-files helper returned no middleware');
      await app.close();
      return;
    }

    const res = await app.fetch(new Request('http://localhost/robots.txt'));
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'User-agent: *\n');

    await app.close();
  });

  it('default-deny: rejects an API request when no authorize callback is configured', async () => {
    const dir = setupCase({ api: { 'hello.js': API_SOURCE } });
    const app = await createApplication(makeConfig(dir));

    const res = await app.fetch(new Request('http://localhost/api/hello'));
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error.code, 'forbidden');

    await app.close();
  });

  it('enforces same-origin and CSRF for cookie-authenticated mutations', async () => {
    const dir = setupCase({ api: { 'mutate.js': POST_SOURCE } });
    const session = {
      id: 'session-id',
      csrfToken: 'csrf-token-value',
      data: {},
      expiresAt: Date.now() + 60_000,
    };
    const config = makeConfig(dir, {
      authorize: () => true,
      resolveSession: () => session,
    });

    const app = await createApplication(config);

    // No Origin header: cross-origin mutation is rejected.
    const cross = await app.fetch(new Request('http://localhost/api/mutate', { method: 'POST' }));
    assert.equal(cross.status, 403);

    // Same-origin but missing CSRF token: rejected.
    const noToken = await app.fetch(
      new Request('http://localhost/api/mutate', {
        method: 'POST',
        headers: { origin: 'http://localhost' },
      }),
    );
    assert.equal(noToken.status, 403);

    // Same-origin with the correct CSRF token: the handler runs with the session.
    const ok = await app.fetch(
      new Request('http://localhost/api/mutate', {
        method: 'POST',
        headers: { origin: 'http://localhost', 'X-CSRF-Token': 'csrf-token-value' },
      }),
    );
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { session: 'session-id' });

    await app.close();
  });

  it('does not attach broadcast or open a server when fetching', async () => {
    const dir = setupCase({ pages: { 'index.js': PAGE_SOURCE } });
    const state = makeFakeState();
    const config = makeConfig(dir, {
      renderer: new RecordingRenderer(),
      broadcast: { adapter: fakeAdapter(state) },
    });

    const app = await createApplication(config);

    const res = await app.fetch(new Request('http://localhost/'));
    assert.equal(res.status, 200);
    assert.equal(state.attachCalls, 0, 'fetch must never attach broadcast');
    assert.equal(state.attachedServer, undefined, 'fetch must never create a server');

    await app.close();
    assert.equal(state.closeCalls, 0, 'broadcast was never attached, so close is a no-op for it');
  });

  it('runs configureHttp hooks exactly once across fetch and serve', async () => {
    const dir = setupCase({ pages: { 'index.js': PAGE_SOURCE } });
    const counter = { value: 0 };
    const config = makeConfig(dir, {
      renderer: new RecordingRenderer(),
      extensions: [hookExtension(counter)],
    });

    const app = await createApplication(config);

    // The first fetch assembles the pipeline and runs the hook once.
    const first = await app.fetch(new Request('http://localhost/hook-route'));
    assert.equal(first.status, 200);
    assert.equal(counter.value, 1);

    // A second fetch reuses the memoized pipeline.
    const second = await app.fetch(new Request('http://localhost/hook-route'));
    assert.equal(second.status, 200);
    assert.equal(counter.value, 1);

    // serve shares the same pipeline; no extra hook run.
    const handle = await app.serve();
    const served = await fetch(new URL('/hook-route', handle.url));
    assert.equal(served.status, 200);
    assert.equal(counter.value, 1);

    // A fetch after serve still reuses the same assembled app.
    const after = await app.fetch(new Request('http://localhost/hook-route'));
    assert.equal(after.status, 200);
    assert.equal(counter.value, 1);

    await handle.close();
  });

  it('handles two concurrent requests without serializing them', async () => {
    const dir = setupCase({ api: { 'concurrent.js': CONCURRENT_SOURCE } });
    const config = makeConfig(dir, { authorize: () => true });

    const app = await createApplication(config);

    const [a, b] = await Promise.all([
      app.fetch(new Request('http://localhost/api/concurrent')),
      app.fetch(new Request('http://localhost/api/concurrent')),
    ]);

    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    // Both handlers overlap, so the peak concurrency reaches 2. A serialized
    // implementation would cap it at 1.
    assert.equal((await a.json()).peak, 2);
    assert.equal((await b.json()).peak, 2);

    await app.close();
  });

  it('rejects fetch after close', async () => {
    const dir = setupCase({ pages: { 'index.js': PAGE_SOURCE } });
    const app = await createApplication(makeConfig(dir, { renderer: new RecordingRenderer() }));

    await app.close();
    await assert.rejects(app.fetch(new Request('http://localhost/')), /application is closed/);
  });

  it('forgets a failed assembly and retries it on the next request', async () => {
    const dir = setupCase({ pages: { 'index.js': PAGE_SOURCE } });
    const attempts = { value: 0 };
    const flaky = (): JsailsExtension => ({
      name: 'flaky',
      setup(context) {
        context.configureHttp(() => {
          attempts.value += 1;
          if (attempts.value === 1) {
            throw new Error('assembly boom');
          }
        });
      },
    });
    const config = makeConfig(dir, {
      renderer: new RecordingRenderer(),
      extensions: [flaky()],
    });

    const app = await createApplication(config);

    await assert.rejects(app.fetch(new Request('http://localhost/')), /assembly boom/);
    assert.equal(attempts.value, 1);

    // The failed assembly was forgotten, so the retry re-runs the hook and
    // succeeds this time.
    const res = await app.fetch(new Request('http://localhost/'));
    assert.equal(res.status, 200);
    assert.equal(attempts.value, 2);

    // A further request reuses the now-memoized pipeline.
    await app.fetch(new Request('http://localhost/'));
    assert.equal(attempts.value, 2);

    await app.close();
  });

  it('close waits for an in-flight fetch before tearing down extensions', async () => {
    const dir = setupCase({ api: { 'gated.js': GATED_SOURCE } });
    const events: string[] = [];
    const gate = makeGate();
    const gateExtension: JsailsExtension = {
      name: 'gate',
      setup(context) {
        context.services.provide(GATE, gate);
      },
    };
    const config = makeConfig(dir, {
      authorize: () => true,
      extensions: [gateExtension, orderExtension('a', events)],
    });

    const app = await createApplication(config);

    const pending = app.fetch(new Request('http://localhost/api/gated'));
    await waitFor(() => gate.started());

    const closing = app.close();
    // Teardown must not run while the handler is still in flight.
    assert.deepEqual(events, ['a']);

    gate.release();
    assert.equal(await pending.then((res) => res.text()), 'done');
    await closing;

    assert.deepEqual(events, ['a', 'dispose-a']);
  });
});

// ---------------------------------------------------------------------------
// Close: bounded transport shutdown
// ---------------------------------------------------------------------------

describe('Application.close: shutdown timeout', () => {
  it('forces the deadline on a lingering non-Socket.IO upgraded socket and still tears down', async () => {
    const dir = setupCase({ pages: { 'index.js': PAGE_SOURCE } });
    const events: string[] = [];
    const config = makeConfig(dir, {
      shutdownTimeoutMs: 30,
      setup() {
        events.push('app-setup');
        return () => {
          events.push('app-cleanup');
        };
      },
      extensions: [orderExtension('a', events)],
      broadcast: {
        allowedOrigins: ['https://app.example'],
        authenticate: () => 'user',
      },
    });

    const app = await createApplication(config);
    const handle = await app.serve();

    // Open a raw TCP connection and send a WebSocket upgrade to a path Socket.IO
    // does not own. Socket.IO never closes it, so `broadcast.close()` would wait
    // on it forever; the shutdown deadline must force it instead.
    const stuck = connect(handle.port, '127.0.0.1');
    // Wait until the server has processed the upgrade request: only then is the
    // socket a genuine "upgraded" connection that neither closeIdleConnections
    // nor closeAllConnections touches, so the deadline (not a forced close) must
    // be what ends it.
    const upgraded = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('upgrade not processed')), 3000);
      handle.server.once('upgrade', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    stuck.write(
      'GET /not-socket-io HTTP/1.1\r\n' +
        'Host: 127.0.0.1\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
        'Sec-WebSocket-Version: 13\r\n' +
        '\r\n',
    );
    await upgraded;

    // Wait until the server has accepted and tracked the connection.
    await waitForConnections(handle.server, 1);

    await assert.rejects(app.close(), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /shutdown exceeded the configured timeout/);
      return true;
    });

    // Transport teardown was forced, but the app cleanup and reverse extension
    // teardown still ran.
    assert.deepEqual(events, ['a', 'app-setup', 'app-cleanup', 'dispose-a']);

    // The server owns no active connection afterward.
    await waitForConnections(handle.server, 0);
    stuck.destroy();
  });

  it('closes normally without a lingering connection and without a timeout', async () => {
    const dir = setupCase({ pages: { 'index.js': PAGE_SOURCE } });
    const config = makeConfig(dir, {
      shutdownTimeoutMs: 30,
      broadcast: {
        allowedOrigins: ['https://app.example'],
        authenticate: () => 'user',
      },
    });

    const app = await createApplication(config);
    await app.serve();
    await app.close();
  });
});

/** Poll a synchronous predicate until it is true (or time out). */
async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error('timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Poll `server.getConnections` until the count matches `expected`. */
function waitForConnections(server: NodeHttpServer, expected: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const check = (): void => {
      server.getConnections((error, count) => {
        if (error) {
          reject(error);
          return;
        }
        if (count === expected) {
          resolve();
          return;
        }
        if (Date.now() - started > 3000) {
          reject(new Error(`timed out waiting for ${expected} connections (have ${count})`));
          return;
        }
        setTimeout(check, 5);
      });
    };
    check();
  });
}

/** Connect a Socket.IO client to the broadcast path on `port`. */
function connectSocket(port: number): Promise<void> {
  const socket = createClient(`http://127.0.0.1:${port}`, {
    path: BROADCAST_PATH,
    transports: ['websocket'],
    reconnection: false,
    timeout: 2000,
    extraHeaders: { Origin: 'https://app.example' },
  });
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('socket connect timed out'));
    }, 3000);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.close();
      resolve();
    });
    socket.once('connect_error', (error: Error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}
