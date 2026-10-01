/**
 * In-process test application (`jsails/testing`) tests.
 *
 * Fixtures are real compiled ESM modules written under the build output (so
 * they inherit `"type": "module"`) and imported through Node's normal module
 * loader. Everything runs in-process against the real Hono pipeline and the
 * built-in Preact renderer: no browser, no external service, no listening
 * server, and no broadcast attachment. Nothing here connects to a database or
 * Valkey.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server as NodeHttpServer } from 'node:http';
import { Server } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { AppConfigError } from '../src/app/config.js';
import type { BroadcastAdapter } from '../src/broadcast/server.js';
import type { JsailsExtension } from '../src/extensions/index.js';
import { createServiceToken } from '../src/extensions/index.js';
import {
  createTestApp,
  DEFAULT_TEST_ORIGIN,
  TEST_ORIGIN_ENV,
  TestRequestError,
  type JsailsAppConfig,
} from '../src/testing/index.js';

const fixturesRoot = mkdtempSync(
  join(fileURLToPath(new URL('..', import.meta.url)), 'testing-fixture-'),
);

after(() => {
  rmSync(fixturesRoot, { recursive: true, force: true });
});

let sequence = 0;

/** Write a file (creating parent directories) and return its absolute path. */
function writeFile(path: string, content: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

/** Create an isolated case directory with optional page/api/public fixtures. */
function makeCase(assets: Record<string, Record<string, string>> = {}): string {
  const dir = mkdtempSync(join(fixturesRoot, `case-${sequence++}-`));
  for (const [subdir, files] of Object.entries(assets)) {
    for (const [rel, content] of Object.entries(files)) {
      writeFile(join(dir, subdir, rel), content);
    }
  }
  return dir;
}

/** A raw app-config object rooted at `dir`. */
function rawConfig(dir: string, overrides: JsailsAppConfig = {}): JsailsAppConfig {
  return { rootDir: dir, port: 0, ...overrides };
}

/** A page module rendered through the real Preact renderer. */
const PAGE_SOURCE = `import { h } from 'preact';
export default function Page() { return h('h1', null, 'Hello from page'); }
`;

const HELLO_SOURCE = `export async function GET() {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
}
`;

const MUTATE_SOURCE = `export async function POST(request, context) {
  return new Response(JSON.stringify({ session: context.session?.id ?? null }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
}
`;

const ECHO_SOURCE = `export async function GET(request, context) {
  return new Response(JSON.stringify({
    params: context.params,
    pathname: context.url.pathname,
    search: context.url.search,
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}
`;

const USER_SOURCE = `export async function GET(request, context) {
  return new Response(JSON.stringify({ id: context.params.id }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
}
`;

const BAD_JSON_SOURCE = `export async function GET() {
  return new Response('not-json-body', { status: 200 });
}
`;

const SECRET_SOURCE = `export async function GET() {
  return new Response('secret-body-value', { status: 500 });
}
`;

const CONCURRENT_SOURCE = `let active = 0;
let peak = 0;
export async function GET() {
  active += 1;
  peak = Math.max(peak, active);
  await new Promise((resolve) => setTimeout(resolve, 20));
  active -= 1;
  return new Response(JSON.stringify({ peak }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
}
`;

/** An extension that records setup/teardown order. */
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

/** State a fake broadcast adapter records for lifecycle assertions. */
interface FakeAdapterState {
  attachCalls: number;
  closeCalls: number;
}

function fakeAdapter(state: FakeAdapterState): BroadcastAdapter {
  return {
    name: 'fake',
    attach() {
      state.attachCalls += 1;
      return {
        closesHttpServer: false,
        broadcast() {},
        close() {
          state.closeCalls += 1;
          return Promise.resolve();
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Requests: HTML, API, static, and fetch
// ---------------------------------------------------------------------------

describe('createTestApp requests', () => {
  it('renders an HTML page through the real Preact renderer', async () => {
    const dir = makeCase({ pages: { 'index.mjs': PAGE_SOURCE } });
    const app = await createTestApp({ config: rawConfig(dir) });

    const res = await app.request('/');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    const html = await res.text();
    assert.match(html, /Hello from page/);
    assert.match(html, /<h1>/);

    await app.close();
  });

  it('serves an API route and parses JSON through json()', async () => {
    const dir = makeCase({ api: { 'hello.mjs': HELLO_SOURCE } });
    const app = await createTestApp({ config: rawConfig(dir, { authorize: () => true }) });

    const res = await app.request('/api/hello');
    assert.equal(res.status, 200);

    const body = await app.json<{ ok: boolean }>('/api/hello');
    assert.deepEqual(body, { ok: true });

    await app.close();
  });

  it('serves public static assets', async () => {
    const dir = makeCase({ public: { 'robots.txt': 'User-agent: *\n' } });
    const app = await createTestApp({ config: rawConfig(dir) });

    const res = await app.request('/robots.txt');
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'User-agent: *\n');

    await app.close();
  });

  it('routes a native Request through fetch', async () => {
    const dir = makeCase({ api: { 'hello.mjs': HELLO_SOURCE } });
    const app = await createTestApp({ config: rawConfig(dir, { authorize: () => true }) });

    const res = await app.fetch(new Request('http://localhost/api/hello'));
    assert.equal(res.status, 200);

    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Security: default-deny and session CSRF
// ---------------------------------------------------------------------------

describe('createTestApp security', () => {
  it('default-deny: rejects API requests without an authorize callback', async () => {
    const dir = makeCase({ api: { 'hello.mjs': HELLO_SOURCE } });
    const app = await createTestApp({ config: rawConfig(dir) });

    const res = await app.request('/api/hello');
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error.code, 'forbidden');

    await app.close();
  });

  it('enforces same-origin and CSRF for session-authenticated mutations', async () => {
    const dir = makeCase({ api: { 'mutate.mjs': MUTATE_SOURCE } });
    const session = {
      id: 'session-id',
      csrfToken: 'csrf-token-value',
      data: {},
      expiresAt: Date.now() + 60_000,
    };
    const app = await createTestApp({
      config: rawConfig(dir, { authorize: () => true, resolveSession: () => session }),
    });

    const cross = await app.request('/api/mutate', { method: 'POST' });
    assert.equal(cross.status, 403);

    const noToken = await app.request('/api/mutate', {
      method: 'POST',
      headers: { origin: app.origin },
    });
    assert.equal(noToken.status, 403);

    const ok = await app.request('/api/mutate', {
      method: 'POST',
      headers: { origin: app.origin, 'X-CSRF-Token': 'csrf-token-value' },
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { session: 'session-id' });

    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Path, query, and parameters
// ---------------------------------------------------------------------------

describe('createTestApp path/query', () => {
  it('preserves the pathname, query string, and route parameters', async () => {
    const dir = makeCase({
      api: { 'echo.mjs': ECHO_SOURCE, 'users/[id].mjs': USER_SOURCE },
    });
    const app = await createTestApp({ config: rawConfig(dir, { authorize: () => true }) });

    const echo = await app.json<{
      params: Record<string, string>;
      pathname: string;
      search: string;
    }>('/api/echo?x=1&y=two');
    assert.equal(echo.pathname, '/api/echo');
    assert.equal(echo.search, '?x=1&y=two');

    const user = await app.json<{ id: string }>('/api/users/42');
    assert.deepEqual(user, { id: '42' });

    await app.close();
  });
});

// ---------------------------------------------------------------------------
// json() error behavior
// ---------------------------------------------------------------------------

describe('createTestApp json() errors', () => {
  it('rejects a non-2xx response with a TestRequestError carrying status/operation', async () => {
    const dir = makeCase({ api: { 'hello.mjs': HELLO_SOURCE } });
    const app = await createTestApp({ config: rawConfig(dir) }); // default-deny

    await assert.rejects(app.json('/api/hello'), (error: unknown) => {
      assert.ok(error instanceof TestRequestError);
      assert.equal(error.status, 403);
      assert.equal(error.operation, 'json');
      return true;
    });

    await app.close();
  });

  it('rejects an invalid JSON body without leaking body, cause, or URL', async () => {
    const dir = makeCase({ api: { 'bad.mjs': BAD_JSON_SOURCE } });
    const app = await createTestApp({ config: rawConfig(dir, { authorize: () => true }) });

    await assert.rejects(app.json('/api/bad?token=s3cr3t'), (error: unknown) => {
      assert.ok(error instanceof TestRequestError);
      assert.equal(error.status, 200);
      assert.equal(error.cause, undefined);
      assert.doesNotMatch(error.message, /not-json|api\/bad|s3cr3t/);
      return true;
    });

    await app.close();
  });

  it('never echoes a secret response body on a server error', async () => {
    const dir = makeCase({ api: { 'secret.mjs': SECRET_SOURCE } });
    const app = await createTestApp({ config: rawConfig(dir, { authorize: () => true }) });

    await assert.rejects(app.json('/api/secret?token=s3cr3t'), (error: unknown) => {
      assert.ok(error instanceof TestRequestError);
      assert.equal(error.status, 500);
      assert.equal(error.cause, undefined);
      assert.doesNotMatch(error.message, /secret-body|token|s3cr3t/);
      return true;
    });

    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Concurrency and isolation
// ---------------------------------------------------------------------------

describe('createTestApp concurrency and isolation', () => {
  it('handles concurrent requests without serializing them', async () => {
    const dir = makeCase({ api: { 'concurrent.mjs': CONCURRENT_SOURCE } });
    const app = await createTestApp({ config: rawConfig(dir, { authorize: () => true }) });

    const [a, b] = await Promise.all([
      app.request('/api/concurrent'),
      app.request('/api/concurrent'),
    ]);

    assert.equal((await a.json()).peak, 2);
    assert.equal((await b.json()).peak, 2);

    await app.close();
  });

  it('gives each app a fresh service registry and cleans up on close', async () => {
    const dir = makeCase();
    const STORE = createServiceToken<{ id: number }>('store');
    const events: string[] = [];
    let nextId = 0;
    const storeExtension: JsailsExtension = {
      name: 'store',
      setup(context) {
        nextId += 1;
        context.services.provide(STORE, { id: nextId });
        return () => {
          events.push('dispose');
        };
      },
    };

    const app1 = await createTestApp({ config: rawConfig(dir, { extensions: [storeExtension] }) });
    const app2 = await createTestApp({ config: rawConfig(dir, { extensions: [storeExtension] }) });

    assert.equal(app1.application.services.get(STORE).id, 1);
    assert.equal(app2.application.services.get(STORE).id, 2);
    assert.notEqual(app1.application.services, app2.application.services);

    await app1.close();
    assert.deepEqual(events, ['dispose']);

    await app2.close();
    assert.deepEqual(events, ['dispose', 'dispose']);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle (node:test-compatible after hook)
// ---------------------------------------------------------------------------

describe('createTestApp lifecycle', () => {
  it('registers close via the lifecycle and the callback closes the app', async () => {
    const dir = makeCase({ api: { 'hello.mjs': HELLO_SOURCE } });
    const events: string[] = [];
    const registered: Array<() => void | Promise<void>> = [];

    const app = await createTestApp({
      config: rawConfig(dir, { authorize: () => true, extensions: [orderExtension('a', events)] }),
      lifecycle: {
        after(fn) {
          registered.push(fn);
        },
      },
    });

    assert.equal(registered.length, 1);
    assert.equal((await app.request('/api/hello')).status, 200);

    await registered[0]!();
    assert.deepEqual(events, ['a', 'dispose-a']);
    await assert.rejects(app.request('/api/hello'), /application is closed/);

    // close is idempotent even after the auto-close already ran.
    await app.close();
  });

  it('accepts a real node:test context and close is idempotent', async (t) => {
    const dir = makeCase({ api: { 'hello.mjs': HELLO_SOURCE } });
    const app = await createTestApp({
      config: rawConfig(dir, { authorize: () => true }),
      lifecycle: t,
    });

    assert.equal((await app.request('/api/hello')).status, 200);

    await app.close();
    await app.close();
  });

  it('disposes the app and propagates when lifecycle registration throws', async () => {
    const dir = makeCase();
    const events: string[] = [];

    await assert.rejects(
      createTestApp({
        config: rawConfig(dir, { extensions: [orderExtension('a', events)] }),
        lifecycle: {
          after() {
            throw new Error('register boom');
          },
        },
      }),
      /register boom/,
    );

    assert.deepEqual(events, ['a', 'dispose-a']);
  });
});

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

describe('createTestApp config', () => {
  it('loads jsails.app.js from cwd by default', async () => {
    const dir = makeCase({ pages: { 'index.mjs': PAGE_SOURCE } });
    writeFile(join(dir, 'jsails.app.js'), 'export default { port: 0 };\n');

    const app = await createTestApp({ cwd: dir });

    assert.equal(app.config.rootDir, dir);
    assert.equal(app.config.port, 0);
    assert.match(await (await app.request('/')).text(), /Hello from page/);

    await app.close();
  });

  it('loads an explicit configPath', async () => {
    const dir = makeCase({ pages: { 'index.mjs': PAGE_SOURCE } });
    const configPath = writeFile(join(dir, 'jsails.app.js'), 'export default { port: 0 };\n');

    const app = await createTestApp({ configPath });

    assert.equal(app.config.configPath, configPath);
    assert.equal(app.config.rootDir, dir);

    await app.close();
  });

  it('validates a raw config object', async () => {
    const dir = makeCase({ api: { 'hello.mjs': HELLO_SOURCE } });
    const app = await createTestApp({
      config: { rootDir: dir, port: 0, authorize: () => true },
    });

    assert.equal(app.config.rootDir, dir);
    assert.equal(app.config.port, 0);
    assert.equal((await app.request('/api/hello')).status, 200);

    await app.close();
  });

  it('rejects config and configPath together', async () => {
    await assert.rejects(
      createTestApp({ config: { rootDir: '/x' }, configPath: 'jsails.app.js' }),
      /mutually exclusive/,
    );
  });

  it('rejects an invalid raw config', async () => {
    await assert.rejects(
      createTestApp({ config: { rootDir: '/x', port: 99_999 } }),
      (error: unknown) => error instanceof AppConfigError,
    );
  });
});

// ---------------------------------------------------------------------------
// Origin resolution
// ---------------------------------------------------------------------------

describe('createTestApp origin', () => {
  it('uses the configured publicOrigin when no override is given', async () => {
    const dir = makeCase();
    const app = await createTestApp({
      config: { rootDir: dir, publicOrigin: 'https://app.example' },
    });
    assert.equal(app.origin, 'https://app.example');
    await app.close();
  });

  it('prefers an explicit override over publicOrigin', async () => {
    const dir = makeCase();
    const app = await createTestApp({
      config: { rootDir: dir, publicOrigin: 'https://app.example' },
      origin: 'http://test.local',
    });
    assert.equal(app.origin, 'http://test.local');
    await app.close();
  });

  it('falls back to TEST_ORIGIN, then http://localhost', async () => {
    const dir = makeCase();
    const previous = process.env[TEST_ORIGIN_ENV];
    try {
      const app1 = await createTestApp({ config: { rootDir: dir } });
      assert.equal(app1.origin, DEFAULT_TEST_ORIGIN);
      await app1.close();

      process.env[TEST_ORIGIN_ENV] = 'https://env.example';
      const app2 = await createTestApp({ config: { rootDir: dir } });
      assert.equal(app2.origin, 'https://env.example');
      await app2.close();
    } finally {
      if (previous === undefined) delete process.env[TEST_ORIGIN_ENV];
      else process.env[TEST_ORIGIN_ENV] = previous;
    }
  });

  it('rejects invalid origins', async () => {
    const dir = makeCase();
    await assert.rejects(
      createTestApp({ config: { rootDir: dir }, origin: 'ftp://example.com' }),
      /http or https/,
    );
    await assert.rejects(
      createTestApp({ config: { rootDir: dir }, origin: 'http://user:pw@example.com' }),
      /credentials/,
    );
    await assert.rejects(
      createTestApp({ config: { rootDir: dir }, origin: 'http://example.com/path' }),
      /origin only/,
    );
  });
});

// ---------------------------------------------------------------------------
// Origin pinning
// ---------------------------------------------------------------------------

describe('createTestApp origin pinning', () => {
  it('allows relative and same-origin absolute request paths', async () => {
    const dir = makeCase({ api: { 'echo.mjs': ECHO_SOURCE } });
    const app = await createTestApp({ config: rawConfig(dir, { authorize: () => true }) });

    const relative = await app.json<{ pathname: string; search: string }>('/api/echo?x=1');
    assert.equal(relative.pathname, '/api/echo');
    assert.equal(relative.search, '?x=1');

    const absolute = await app.json<{ pathname: string; search: string }>(
      `${app.origin}/api/echo?y=2`,
    );
    assert.equal(absolute.pathname, '/api/echo');
    assert.equal(absolute.search, '?y=2');

    await app.close();
  });

  it('rejects a cross-origin path before the handler runs', async () => {
    const dir = makeCase({ api: { 'echo.mjs': ECHO_SOURCE } });
    const app = await createTestApp({ config: rawConfig(dir, { authorize: () => true }) });

    // Spy on the shared pipeline so a reached handler is observable.
    let reached = 0;
    const originalFetch = app.application.fetch.bind(app.application);
    app.application.fetch = (request: Request) => {
      reached += 1;
      return originalFetch(request);
    };

    await assert.rejects(
      async () => app.request('http://evil.example/api/echo?token=s3cr3t'),
      (error: unknown) => {
        assert.ok(error instanceof TypeError);
        assert.doesNotMatch(error.message, /evil|s3cr3t|api\/echo/);
        return true;
      },
    );
    assert.equal(reached, 0, 'cross-origin request must not reach the handler');

    await app.close();
  });

  it('rejects credentials, unsupported schemes, and malformed paths without leaking', async () => {
    const dir = makeCase({ api: { 'echo.mjs': ECHO_SOURCE } });
    const app = await createTestApp({ config: rawConfig(dir, { authorize: () => true }) });

    const cases = [
      'http://user:secret-password@localhost/api/echo?token=s3cr3t',
      'ftp://localhost/api/echo?token=s3cr3t',
      'http://[not-a-host/api/echo?token=s3cr3t',
    ];
    for (const bad of cases) {
      await assert.rejects(
        async () => app.request(bad),
        (error: unknown) => {
          assert.ok(error instanceof TypeError);
          assert.doesNotMatch(error.message, /secret-password|s3cr3t|not-a-host|localhost/);
          assert.equal(error.cause, undefined);
          return true;
        },
      );
    }

    await app.close();
  });

  it('does not leak init values when Request construction fails', async () => {
    const dir = makeCase({ api: { 'echo.mjs': ECHO_SOURCE } });
    const app = await createTestApp({ config: rawConfig(dir, { authorize: () => true }) });

    await assert.rejects(
      // GET with a body is invalid at Request construction.
      async () => app.request('/api/echo', { method: 'GET', body: 'secret-body' }),
      (error: unknown) => {
        assert.ok(error instanceof TypeError);
        assert.doesNotMatch(error.message, /secret-body/);
        assert.equal(error.cause, undefined);
        return true;
      },
    );

    await app.close();
  });

  it('applies the same origin guard to json() without leaking', async () => {
    const dir = makeCase({ api: { 'echo.mjs': ECHO_SOURCE } });
    const app = await createTestApp({ config: rawConfig(dir, { authorize: () => true }) });

    await assert.rejects(
      app.json('http://evil.example/api/echo?token=s3cr3t'),
      (error: unknown) => {
        assert.ok(error instanceof TypeError);
        assert.doesNotMatch(error.message, /evil|s3cr3t/);
        return true;
      },
    );

    await app.close();
  });

  it('still routes an arbitrary Request through the fetch() escape hatch', async () => {
    const dir = makeCase({ api: { 'echo.mjs': ECHO_SOURCE } });
    const app = await createTestApp({ config: rawConfig(dir, { authorize: () => true }) });

    const res = await app.fetch(new Request('http://other.example/api/echo?z=1'));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { pathname: string; search: string };
    assert.equal(body.pathname, '/api/echo');
    assert.equal(body.search, '?z=1');

    await app.close();
  });
});

// ---------------------------------------------------------------------------
// No server, no broadcast
// ---------------------------------------------------------------------------

describe('createTestApp stays serverless', () => {
  it('never listens and never attaches broadcast', async () => {
    const dir = makeCase({ pages: { 'index.mjs': PAGE_SOURCE } });
    const state: FakeAdapterState = { attachCalls: 0, closeCalls: 0 };

    const originalListen = Server.prototype.listen;
    let listenCalls = 0;
    const spy = function listen(this: NodeHttpServer, ...args: unknown[]): unknown {
      listenCalls += 1;
      return (originalListen as (this: NodeHttpServer, ...a: unknown[]) => unknown).apply(
        this,
        args,
      );
    };
    Server.prototype.listen = spy as typeof Server.prototype.listen;

    try {
      const app = await createTestApp({
        config: rawConfig(dir, { broadcast: { adapter: fakeAdapter(state) } }),
      });

      assert.equal((await app.request('/')).status, 200);
      assert.equal(state.attachCalls, 0, 'broadcast must never attach');
      assert.equal(listenCalls, 0, 'the server must never listen');

      await app.close();
      assert.equal(state.closeCalls, 0, 'broadcast was never attached, so close is a no-op');
    } finally {
      Server.prototype.listen = originalListen;
    }
  });
});
