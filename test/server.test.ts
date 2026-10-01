/**
 * End-to-end tests for the Hono HTTP integration (`createApp`,
 * `createHttpServer`) against real on-disk compiled ESM fixtures. Method
 * dispatch, routing specificity, authorization, CSRF, body limits, and error
 * sanitization are exercised in-process through `app.fetch`; the final cases
 * bind an ephemeral loopback port and prove one `node:http.Server` serves both
 * HTTP and Socket.IO broadcast. No live Valkey, database, or external service
 * is used.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server as HttpServer } from 'node:http';
import { io as createClient } from 'socket.io-client';
import type { Socket as ClientSocket } from 'socket.io-client';
import type { Hono } from 'hono';

import { CSRF_HEADER, createApp, readJson, type CreateAppOptions } from '../src/server/app.js';
import { createHttpServer } from '../src/server/http.js';
import { discoverRoutes, type RouteManifest } from '../src/routing/manifest.js';
import { attachBroadcast, BROADCAST_PATH } from '../src/broadcast/server.js';
import type { Session } from '../src/contracts/http.js';
import type { PageRenderer } from '../src/contracts/render.js';
import {
  createServiceRegistry,
  createServiceToken,
  runExtensions,
  type HttpExtensionHook,
  type ServiceRegistry,
} from '../src/extensions/index.js';

// ---------------------------------------------------------------------------
// Fixtures: compiled ESM route modules written to a real temp tree.
// ---------------------------------------------------------------------------

const distDir = fileURLToPath(new URL('../', import.meta.url));
const fixturesRoot = mkdtempSync(join(distDir, 'server-'));
const badRoot = mkdtempSync(join(distDir, 'server-bad-'));

after(() => {
  rmSync(fixturesRoot, { recursive: true, force: true });
  rmSync(badRoot, { recursive: true, force: true });
});

function writeFixture(root: string, relative: string, content: string): void {
  const full = join(root, relative);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

/** Absolute `file://` URL to a built framework module, importable from a fixture. */
function frameworkUrl(rel: string): string {
  return pathToFileURL(join(distDir, rel)).href;
}

const VALIDATION_URL = frameworkUrl('src/api/validation.js');
const APP_URL = frameworkUrl('src/server/app.js');

writeFixture(
  fixturesRoot,
  'api/users.mjs',
  `export const GET = (request, context) => Response.json({
  route: 'users',
  method: 'GET',
  session: context.session ? context.session.id : null,
  q: context.url.searchParams.get('q') ?? null,
});

export const POST = (request, context) => Response.json({
  route: 'users',
  method: 'POST',
  session: context.session ? context.session.id : null,
});
`,
);

writeFixture(
  fixturesRoot,
  'api/users/[id].mjs',
  `export const GET = (request, context) => Response.json({
  route: 'user',
  id: context.params.id,
  q: context.url.searchParams.get('q') ?? null,
});
`,
);

writeFixture(
  fixturesRoot,
  'api/methods.mjs',
  `const respond = (method) => new Response(JSON.stringify({ method }), {
  status: 200,
  headers: { 'content-type': 'application/json', 'x-method': method },
});

export const GET = () => respond('GET');
export const POST = () => respond('POST');
export const PUT = () => respond('PUT');
export const PATCH = () => respond('PATCH');
export const DELETE = () => respond('DELETE');
export const OPTIONS = () => respond('OPTIONS');
export const HEAD = () => new Response(null, { status: 204, headers: { 'x-method': 'HEAD' } });
`,
);

writeFixture(
  fixturesRoot,
  'api/guarded.mjs',
  `export const GET = () => Response.json({ route: 'guarded' });

export const authorize = (context) => context.session !== null;
`,
);

writeFixture(
  fixturesRoot,
  'api/head-only.mjs',
  `export const HEAD = () => new Response(null, {
  status: 204,
  headers: { 'x-method': 'HEAD-ONLY' },
});
`,
);

writeFixture(
  fixturesRoot,
  'api/throw.mjs',
  `export const GET = () => {
  throw new Error('secret credential /home/alice/.ssh/id_rsa leaked');
};
`,
);

writeFixture(
  fixturesRoot,
  'api/validate.mjs',
  `import { ValidationError } from ${JSON.stringify(VALIDATION_URL)};

export const POST = () => {
  throw new ValidationError([
    { path: ['name'], code: 'min_length', message: 'Must be at least 3 characters' },
  ]);
};
`,
);

writeFixture(
  fixturesRoot,
  'api/echo.mjs',
  `import { readJson } from ${JSON.stringify(APP_URL)};

export const POST = async (request) => {
  const body = await readJson(request);
  return Response.json({ echoed: body });
};
`,
);

writeFixture(
  fixturesRoot,
  'api/default-only.mjs',
  `export default () => new Response('should never be dispatched');
`,
);

// Reports whether the request context carries a services registry and resolves
// one probe value from it; the registry is duck-typed by the test.
writeFixture(
  fixturesRoot,
  'api/services.mjs',
  `export const GET = (request, context) => Response.json({
  hasServices: context.services !== undefined,
  value: context.services ? context.services.get('probe') : null,
});
`,
);

writeFixture(fixturesRoot, 'pages/index.mjs', `export default () => null;\n`);

writeFixture(badRoot, 'api/badget.mjs', `export const GET = 'not a function';\n`);

const mainManifest: RouteManifest = discoverRoutes(fixturesRoot);
const badManifest: RouteManifest = discoverRoutes(badRoot);

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const ORIGIN = 'http://127.0.0.1:9999';

const SESSION: Session = {
  id: 'session-1',
  csrfToken: 'csrf-secret-token',
  data: { userId: 'u1' },
  expiresAt: 2_000_000_000_000,
};

function buildApp(overrides: Partial<CreateAppOptions> = {}): Promise<Hono> {
  return createApp({ manifest: mainManifest, ...overrides });
}

async function request(app: Hono, path: string, init: RequestInit = {}): Promise<Response> {
  return app.fetch(new Request(`${ORIGIN}${path}`, init));
}

async function jsonOf(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

interface ErrorEnvelope {
  error: {
    status: number;
    code: string;
    message: string;
    issues?: Array<{ path: (string | number)[]; code: string; message: string }>;
    allow?: string;
  };
}

async function errorOf(response: Response): Promise<ErrorEnvelope['error']> {
  return ((await response.json()) as ErrorEnvelope).error;
}

// ---------------------------------------------------------------------------
// Setup validation
// ---------------------------------------------------------------------------

describe('createApp setup validation', () => {
  it('rejects a missing or malformed options object', async () => {
    await assert.rejects(createApp(undefined as unknown as CreateAppOptions), TypeError);
    await assert.rejects(createApp({} as CreateAppOptions), TypeError);
  });

  it('rejects non-function option callbacks', async () => {
    await assert.rejects(
      createApp({
        manifest: mainManifest,
        authorize: 'yes' as unknown as CreateAppOptions['authorize'],
      }),
      TypeError,
    );
    await assert.rejects(
      createApp({
        manifest: mainManifest,
        resolveSession: 42 as unknown as CreateAppOptions['resolveSession'],
      }),
      TypeError,
    );
    await assert.rejects(createApp({ manifest: mainManifest, maxBodyBytes: 0 }), TypeError);
  });

  it('rejects a method export that is not a function', async () => {
    await assert.rejects(
      createApp({ manifest: badManifest, authorize: () => true }),
      /non-function value/,
    );
  });

  it('rejects a non-function module authorize export', async () => {
    writeFixture(
      badRoot,
      'api/badauth.mjs',
      `export const GET = () => new Response();
export const authorize = 'nope';
`,
    );
    const manifest = discoverRoutes(badRoot);
    await assert.rejects(createApp({ manifest, authorize: () => true }), /non-function value/);
  });

  it('rejects a malformed publicOrigin', async () => {
    for (const publicOrigin of [
      'not-a-url',
      'ftp://example.com',
      'https://example.com/path',
      'https://example.com/path/',
      'https://user:pass@example.com',
      'https://example.com?q=1',
      'https://example.com#frag',
      42,
    ]) {
      await assert.rejects(
        createApp({
          manifest: mainManifest,
          authorize: () => true,
          publicOrigin: publicOrigin as unknown as string,
        }),
        TypeError,
        `expected TypeError for ${String(publicOrigin)}`,
      );
    }
  });

  it('does not guess a default export as a handler', async () => {
    const app = await buildApp({ authorize: () => true });
    const response = await request(app, '/api/default-only');
    assert.equal(response.status, 404);
  });

  it('rejects malformed renderer, services, and httpHooks options', async () => {
    await assert.rejects(
      createApp({ manifest: mainManifest, renderer: 'no' as unknown as PageRenderer }),
      TypeError,
    );
    await assert.rejects(
      createApp({ manifest: mainManifest, renderer: {} as unknown as PageRenderer }),
      TypeError,
    );
    await assert.rejects(
      createApp({ manifest: mainManifest, services: {} as unknown as ServiceRegistry }),
      TypeError,
    );
    await assert.rejects(
      createApp({
        manifest: mainManifest,
        httpHooks: 'no' as unknown as readonly HttpExtensionHook[],
      }),
      TypeError,
    );
    await assert.rejects(
      createApp({
        manifest: mainManifest,
        httpHooks: [42] as unknown as readonly HttpExtensionHook[],
      }),
      TypeError,
    );
  });

  it('rejects supplying both renderer and renderPage as ambiguous', async () => {
    await assert.rejects(
      createApp({
        manifest: mainManifest,
        renderer: { render: () => '<html></html>' },
        renderPage: () => new Response(),
      }),
      /mutually exclusive/,
    );
  });
});

// ---------------------------------------------------------------------------
// Method dispatch and routing
// ---------------------------------------------------------------------------

describe('method dispatch and routing', () => {
  it('dispatches every recognized HTTP method export', async () => {
    const app = await buildApp({ authorize: () => true });
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      const response = await request(app, '/api/methods', { method });
      assert.equal(response.status, 200, method);
      const body = await jsonOf(response);
      assert.equal(body.method, method);
    }
  });

  it('serves HEAD through the explicit HEAD export when present', async () => {
    const app = await buildApp({ authorize: () => true });
    const response = await request(app, '/api/methods', { method: 'HEAD' });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('x-method'), 'HEAD');
    assert.equal(await response.text(), '');
  });

  it('falls back to the GET handler for HEAD when no HEAD export exists', async () => {
    const app = await buildApp({ authorize: () => true });
    const response = await request(app, '/api/users', { method: 'HEAD' });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), '');
  });

  it('serves a HEAD-only module for HEAD and answers GET with 405 Allow: HEAD', async () => {
    const app = await buildApp({ authorize: () => true });

    const head = await request(app, '/api/head-only', { method: 'HEAD' });
    assert.equal(head.status, 204);
    assert.equal(head.headers.get('x-method'), 'HEAD-ONLY');

    const get = await request(app, '/api/head-only');
    assert.equal(get.status, 405);
    assert.equal((await errorOf(get)).code, 'method_not_allowed');
    assert.equal(get.headers.get('allow'), 'HEAD');
  });

  it('routes static segments before parameter segments', async () => {
    const app = await buildApp({ authorize: () => true });
    const list = await jsonOf(await request(app, '/api/users'));
    assert.equal(list.route, 'users');

    const one = await jsonOf(await request(app, '/api/users/42'));
    assert.equal(one.route, 'user');
    assert.equal(one.id, '42');
  });

  it('exposes query and path params in the request context', async () => {
    const app = await buildApp({ authorize: () => true });
    const body = await jsonOf(await request(app, '/api/users/7?q=hello'));
    assert.equal(body.route, 'user');
    assert.equal(body.id, '7');
    assert.equal(body.q, 'hello');
  });
});

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

describe('API authorization', () => {
  it('denies by default when no authorize callback is provided', async () => {
    const app = await buildApp();
    const response = await request(app, '/api/users');
    assert.equal(response.status, 403);
    assert.equal((await errorOf(response)).code, 'forbidden');
  });

  it('denies when authorize returns false', async () => {
    const app = await buildApp({ authorize: () => false });
    assert.equal((await request(app, '/api/users')).status, 403);
  });

  it('denies when authorize returns a truthy non-boolean value', async () => {
    for (const value of [1, 'yes', {}, []]) {
      const app = await buildApp({
        authorize: (() => value) as unknown as CreateAppOptions['authorize'],
      });
      assert.equal((await request(app, '/api/users')).status, 403, JSON.stringify(value));
    }
  });

  it('denies when authorize throws', async () => {
    const app = await buildApp({
      authorize: () => {
        throw new Error('boom');
      },
    });
    assert.equal((await request(app, '/api/users')).status, 403);
  });

  it('allows when authorize resolves true', async () => {
    const app = await buildApp({ authorize: () => true });
    assert.equal((await request(app, '/api/users')).status, 200);
  });

  it('lets a module authorize further restrict an allowed request', async () => {
    const app = await buildApp({ authorize: () => true });
    // No resolveSession -> session null -> module authorize denies.
    assert.equal((await request(app, '/api/guarded')).status, 403);
  });

  it('never lets a module authorize bypass the global default deny', async () => {
    // No global authorize, but resolveSession yields a session the module
    // authorize would accept: the global default deny still wins.
    const app = await buildApp({ resolveSession: () => SESSION });
    assert.equal((await request(app, '/api/guarded')).status, 403);
  });

  it('allows when both global and module authorize pass', async () => {
    const app = await buildApp({ authorize: () => true, resolveSession: () => SESSION });
    assert.equal((await request(app, '/api/guarded')).status, 200);
  });
});

// ---------------------------------------------------------------------------
// Session context and CSRF
// ---------------------------------------------------------------------------

describe('session context and CSRF enforcement', () => {
  const mutatingInit = (csrf: string | undefined): RequestInit => ({
    method: 'POST',
    headers: {
      origin: ORIGIN,
      ...(csrf === undefined ? {} : { [CSRF_HEADER]: csrf }),
    },
  });

  it('exposes the resolved session on read requests', async () => {
    const app = await buildApp({ authorize: () => true, resolveSession: () => SESSION });
    const body = await jsonOf(await request(app, '/api/users'));
    assert.equal(body.session, 'session-1');
  });

  it('defaults session to null when no resolver is provided', async () => {
    const app = await buildApp({ authorize: () => true });
    const body = await jsonOf(await request(app, '/api/users'));
    assert.equal(body.session, null);
  });

  it('fails closed to null when resolveSession throws', async () => {
    const app = await buildApp({
      authorize: () => true,
      resolveSession: () => {
        throw new Error('store down');
      },
    });
    const body = await jsonOf(await request(app, '/api/users'));
    assert.equal(body.session, null);
  });

  it('accepts a mutation with matching origin and CSRF token', async () => {
    const app = await buildApp({ authorize: () => true, resolveSession: () => SESSION });
    const response = await request(app, '/api/users', mutatingInit(SESSION.csrfToken));
    assert.equal(response.status, 200);
    assert.equal((await jsonOf(response)).session, 'session-1');
  });

  it('rejects a mutation missing the CSRF token', async () => {
    const app = await buildApp({ authorize: () => true, resolveSession: () => SESSION });
    const response = await request(app, '/api/users', mutatingInit(undefined));
    assert.equal(response.status, 403);
    assert.equal((await errorOf(response)).code, 'csrf-mismatch');
  });

  it('rejects a mutation with a mismatched CSRF token', async () => {
    const app = await buildApp({ authorize: () => true, resolveSession: () => SESSION });
    const response = await request(app, '/api/users', mutatingInit('wrong-token'));
    assert.equal(response.status, 403);
    assert.equal((await errorOf(response)).code, 'csrf-mismatch');
  });

  it('rejects a mutation with a mismatched origin', async () => {
    const app = await buildApp({ authorize: () => true, resolveSession: () => SESSION });
    const response = await request(app, '/api/users', {
      method: 'POST',
      headers: { origin: 'https://evil.example', [CSRF_HEADER]: SESSION.csrfToken },
    });
    assert.equal(response.status, 403);
    assert.equal((await errorOf(response)).code, 'origin-mismatch');
  });
});

// ---------------------------------------------------------------------------
// publicOrigin behind a TLS-terminating proxy
// ---------------------------------------------------------------------------

describe('publicOrigin (TLS-terminating proxy)', () => {
  const PUBLIC_ORIGIN = 'https://example.com';

  it('accepts an HTTPS Origin against a configured publicOrigin with a valid CSRF token', async () => {
    const app = await buildApp({
      authorize: () => true,
      resolveSession: () => SESSION,
      publicOrigin: PUBLIC_ORIGIN,
    });
    const response = await request(app, '/api/users', {
      method: 'POST',
      headers: { origin: PUBLIC_ORIGIN, [CSRF_HEADER]: SESSION.csrfToken },
    });
    assert.equal(response.status, 200);
    assert.equal((await jsonOf(response)).session, 'session-1');
  });

  it('rejects a valid publicOrigin with a missing CSRF token', async () => {
    const app = await buildApp({
      authorize: () => true,
      resolveSession: () => SESSION,
      publicOrigin: PUBLIC_ORIGIN,
    });
    const response = await request(app, '/api/users', {
      method: 'POST',
      headers: { origin: PUBLIC_ORIGIN },
    });
    assert.equal(response.status, 403);
    assert.equal((await errorOf(response)).code, 'csrf-mismatch');
  });

  it('rejects an Origin that mismatches the configured publicOrigin', async () => {
    const app = await buildApp({
      authorize: () => true,
      resolveSession: () => SESSION,
      publicOrigin: PUBLIC_ORIGIN,
    });
    const response = await request(app, '/api/users', {
      method: 'POST',
      headers: { origin: 'https://evil.example', [CSRF_HEADER]: SESSION.csrfToken },
    });
    assert.equal(response.status, 403);
    assert.equal((await errorOf(response)).code, 'origin-mismatch');
  });

  it('never trusts forwarded headers alone to satisfy the origin check', async () => {
    const app = await buildApp({
      authorize: () => true,
      resolveSession: () => SESSION,
      publicOrigin: PUBLIC_ORIGIN,
    });
    // Forwarded headers claim the public origin but no Origin header is sent:
    // the CSRF origin check must still reject (it only reads the Origin header).
    const response = await request(app, '/api/users', {
      method: 'POST',
      headers: {
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'example.com',
        [CSRF_HEADER]: SESSION.csrfToken,
      },
    });
    assert.equal(response.status, 403);
    assert.equal((await errorOf(response)).code, 'origin-mismatch');
  });

  it('leaves context.url as the request URL, not the publicOrigin', async () => {
    const app = await buildApp({ authorize: () => true, publicOrigin: PUBLIC_ORIGIN });
    const body = await jsonOf(await request(app, '/api/users?q=kept'));
    assert.equal(body.q, 'kept');
  });
});

// ---------------------------------------------------------------------------
// Body limit and JSON parsing
// ---------------------------------------------------------------------------

describe('body limit and JSON parsing', () => {
  it('rejects an oversized request body before the handler runs', async () => {
    const app = await buildApp({ authorize: () => true, maxBodyBytes: 32 });
    const response = await request(app, '/api/users', {
      method: 'POST',
      body: 'x'.repeat(100),
      headers: { origin: ORIGIN, [CSRF_HEADER]: SESSION.csrfToken },
    });
    assert.equal(response.status, 413);
    assert.equal((await errorOf(response)).code, 'payload_too_large');
  });

  it('maps malformed JSON to a 400 validation error through the handler', async () => {
    const app = await buildApp({ authorize: () => true });
    const response = await request(app, '/api/echo', {
      method: 'POST',
      body: '{not valid json',
      headers: { origin: ORIGIN },
    });
    assert.equal(response.status, 400);
    const error = await errorOf(response);
    assert.equal(error.code, 'validation_error');
    assert.equal(error.issues?.[0]?.code, 'invalid_json');
  });

  it('echoes a valid JSON body', async () => {
    const app = await buildApp({ authorize: () => true });
    const response = await request(app, '/api/echo', {
      method: 'POST',
      body: JSON.stringify({ a: 1 }),
      headers: { origin: ORIGIN },
    });
    assert.equal(response.status, 200);
    assert.deepEqual((await jsonOf(response)).echoed, { a: 1 });
  });
});

describe('readJson helper', () => {
  const url = `${ORIGIN}/x`;

  it('parses valid JSON', async () => {
    const value = await readJson(new Request(url, { method: 'POST', body: '{"a":1}' }));
    assert.deepEqual(value, { a: 1 });
  });

  it('rejects malformed JSON with a ValidationError', async () => {
    await assert.rejects(
      readJson(new Request(url, { method: 'POST', body: '{oops' })),
      (error: unknown) => error instanceof Error && error.name === 'ValidationError',
    );
  });

  it('rejects an empty body with a ValidationError', async () => {
    await assert.rejects(
      readJson(new Request(url, { method: 'POST' })),
      (error: unknown) => error instanceof Error && error.name === 'ValidationError',
    );
  });
});

// ---------------------------------------------------------------------------
// Error envelope and sanitization
// ---------------------------------------------------------------------------

describe('error envelope and sanitization', () => {
  it('returns a 404 envelope for an unknown route', async () => {
    const app = await buildApp({ authorize: () => true });
    const response = await request(app, '/api/nope');
    assert.equal(response.status, 404);
    assert.equal((await errorOf(response)).code, 'not_found');
  });

  it('returns a 405 with an Allow header for a wrong method', async () => {
    const app = await buildApp({ authorize: () => true });
    const response = await request(app, '/api/users/42', { method: 'POST' });
    assert.equal(response.status, 405);
    assert.equal((await errorOf(response)).code, 'method_not_allowed');
    assert.match(response.headers.get('allow') ?? '', /GET/);
  });

  it('maps a thrown ValidationError to 400 with structured issues', async () => {
    const app = await buildApp({ authorize: () => true });
    const response = await request(app, '/api/validate', {
      method: 'POST',
      headers: { origin: ORIGIN },
    });
    assert.equal(response.status, 400);
    const error = await errorOf(response);
    assert.equal(error.code, 'validation_error');
    assert.deepEqual(error.issues, [
      { path: ['name'], code: 'min_length', message: 'Must be at least 3 characters' },
    ]);
  });

  it('sanitizes unexpected handler errors without leaking message, stack, or file paths', async () => {
    const app = await buildApp({ authorize: () => true });
    const response = await request(app, '/api/throw');
    assert.equal(response.status, 500);
    const raw = await response.text();
    assert.doesNotMatch(raw, /id_rsa/);
    assert.doesNotMatch(raw, /alice/);
    assert.doesNotMatch(raw, /\.ssh/);
    assert.doesNotMatch(raw, /stack/i);
    const body = JSON.parse(raw) as ErrorEnvelope;
    assert.deepEqual(body.error, {
      status: 500,
      code: 'internal_error',
      message: 'Internal Server Error',
    });
  });
});

// ---------------------------------------------------------------------------
// Pages (renderPage injection)
// ---------------------------------------------------------------------------

describe('page rendering', () => {
  it('delegates rendering to the injected callback with the request context', async () => {
    const app = await buildApp({
      resolveSession: () => SESSION,
      renderPage: async (entry, context) =>
        Response.json({ page: entry.route, session: context.session?.id ?? null }),
    });
    const body = await jsonOf(await request(app, '/'));
    assert.equal(body.page, '/');
    assert.equal(body.session, 'session-1');
  });

  it('does not serve pages when no renderPage callback is injected', async () => {
    const app = await buildApp({ authorize: () => true });
    assert.equal((await request(app, '/')).status, 404);
  });
});

// ---------------------------------------------------------------------------
// Structured renderer injection
// ---------------------------------------------------------------------------

describe('structured renderer', () => {
  it('serves a page as HTML with typed no-DB services and staticMode false', async () => {
    const site = createServiceToken<{ title: string }>('site');
    const controller = createServiceRegistry();
    controller.registrar.provide(site, { title: 'Hello' });

    const seen: Array<{ staticMode: boolean | undefined; title: string }> = [];
    const renderer: PageRenderer = {
      render(_entry, context, options) {
        const title = context.services?.get(site).title ?? '';
        seen.push({ staticMode: options?.staticMode, title });
        return `<!doctype html><h1>${title}</h1>`;
      },
    };

    const app = await buildApp({
      resolveSession: () => SESSION,
      services: controller.services,
      renderer,
    });
    const response = await request(app, '/');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(await response.text(), '<!doctype html><h1>Hello</h1>');
    assert.deepEqual(seen, [{ staticMode: false, title: 'Hello' }]);
  });

  it('reduces a non-string renderer result to the generic 500 envelope', async () => {
    const app = await buildApp({
      renderer: { render: (() => undefined) as unknown as PageRenderer['render'] },
    });
    const response = await request(app, '/');
    assert.equal(response.status, 500);
    assert.deepEqual(await errorOf(response), {
      status: 500,
      code: 'internal_error',
      message: 'Internal Server Error',
    });
  });
});

// ---------------------------------------------------------------------------
// Services threading into request contexts
// ---------------------------------------------------------------------------

describe('services threading', () => {
  it('passes services into normal API request contexts', async () => {
    const services = {
      has: () => true,
      tryGet: () => 'svc',
      get: () => 'svc',
    } as unknown as ServiceRegistry;
    const app = await buildApp({ authorize: () => true, services });
    const body = await jsonOf(await request(app, '/api/services'));
    assert.equal(body.hasServices, true);
    assert.equal(body.value, 'svc');
  });

  it('leaves services absent from request contexts when none is supplied', async () => {
    const app = await buildApp({ authorize: () => true });
    const body = await jsonOf(await request(app, '/api/services'));
    assert.equal(body.hasServices, false);
  });
});

// ---------------------------------------------------------------------------
// Health endpoint
// ---------------------------------------------------------------------------

describe('health endpoint', () => {
  it('serves GET and HEAD with plain-text OK and no-store', async () => {
    const app = await buildApp({ healthPath: '/up' });

    const get = await request(app, '/up');
    assert.equal(get.status, 200);
    assert.equal(get.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.equal(get.headers.get('cache-control'), 'no-store');
    assert.equal(await get.text(), 'OK');

    const head = await request(app, '/up', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.equal(head.headers.get('cache-control'), 'no-store');
    assert.equal((await head.arrayBuffer()).byteLength, 0);
  });

  it('serves a custom path and leaves the default path unregistered', async () => {
    const app = await buildApp({ healthPath: '/healthz' });
    assert.equal((await request(app, '/healthz')).status, 200);
    assert.equal((await request(app, '/up')).status, 404);
  });

  it('is disabled when no healthPath is supplied', async () => {
    const app = await buildApp();
    assert.equal((await request(app, '/up')).status, 404);
  });

  it('is open even when the filesystem API is default-denied', async () => {
    const app = await buildApp({ healthPath: '/up' });
    assert.equal((await request(app, '/up')).status, 200);
    assert.equal((await request(app, '/api/users')).status, 403);
  });

  it('rejects an empty healthPath option', async () => {
    await assert.rejects(buildApp({ healthPath: '' }), /healthPath must be a non-empty string/);
  });
});

// ---------------------------------------------------------------------------
// HTTP extension hooks
// ---------------------------------------------------------------------------

describe('HTTP extension hooks', () => {
  it('runs extension hooks that install native Hono middleware and routes', async () => {
    const greeting = createServiceToken<{ text: string }>('greeting');
    const runtime = await runExtensions([
      {
        name: 'plugin',
        setup: ({ services, configureHttp }) => {
          services.provide(greeting, { text: 'hi' });
          configureHttp((app, ...extra) => {
            // The hook receives the Hono app only — no services or DB context.
            assert.equal(extra.length, 0);
            app.use('/plugin/*', async (c, next) => {
              await next();
              c.res.headers.set('x-plugin', 'on');
            });
            app.get('/plugin/health', (c) =>
              c.json({ ok: true, greeting: services.get(greeting).text }),
            );
          });
        },
      },
    ]);

    const app = await createApp({
      manifest: mainManifest,
      authorize: () => true,
      httpHooks: runtime.httpHooks,
    });
    const response = await request(app, '/plugin/health');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-plugin'), 'on');
    assert.deepEqual(await jsonOf(response), { ok: true, greeting: 'hi' });

    await runtime.close();
  });

  it('keeps the filesystem API default-deny while hook routes stay open', async () => {
    const runtime = await runExtensions([
      {
        name: 'plugin',
        setup: ({ configureHttp }) =>
          configureHttp((app) => {
            app.get('/plugin/open', (c) => c.text('open'));
          }),
      },
    ]);

    // No `authorize`: the filesystem API is denied, but the hook route owns its
    // own authorization and is not wrapped by the API default-deny pipeline.
    const app = await createApp({ manifest: mainManifest, httpHooks: runtime.httpHooks });
    assert.equal((await request(app, '/plugin/open')).status, 200);
    assert.equal((await request(app, '/api/users')).status, 403);

    await runtime.close();
  });

  it('awaits hooks in declaration order', async () => {
    const order: string[] = [];
    const hooks: readonly HttpExtensionHook[] = [
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        order.push('first');
      },
      () => {
        order.push('second');
      },
    ];

    await createApp({ manifest: mainManifest, httpHooks: hooks });
    assert.deepEqual(order, ['first', 'second']);
  });

  it('rejects createApp when a hook throws', async () => {
    await assert.rejects(
      createApp({
        manifest: mainManifest,
        httpHooks: [
          () => {
            throw new Error('hook setup failed');
          },
        ],
      }),
      /hook setup failed/,
    );
  });
});

// ---------------------------------------------------------------------------
// HTTP server factory and one-port broadcast smoke test
// ---------------------------------------------------------------------------

function listen(server: HttpServer): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

function closeServer(server: HttpServer): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function connectSocket(port: number, origin: string): Promise<ClientSocket> {
  const socket = createClient(`http://127.0.0.1:${port}`, {
    path: BROADCAST_PATH,
    transports: ['websocket'],
    reconnection: false,
    timeout: 2000,
    extraHeaders: { Origin: origin },
  });
  return new Promise<ClientSocket>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('connect timed out'));
    }, 3000);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('connect_error', (error: Error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

describe('createHttpServer', () => {
  it('rejects a non-Hono app', () => {
    assert.throws(() => createHttpServer({} as Hono), TypeError);
  });

  it('serves a real HTTP request on a bound ephemeral port', async () => {
    const app = await buildApp({ authorize: () => true });
    const server = createHttpServer(app);
    const port = await listen(server);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/users/9?q=real`, {
        headers: { origin: `http://127.0.0.1:${port}` },
      });
      assert.equal(response.status, 200);
      const body = (await response.json()) as { route: string; id: string; q: string };
      assert.equal(body.route, 'user');
      assert.equal(body.id, '9');
      assert.equal(body.q, 'real');
    } finally {
      await closeServer(server);
    }
  });

  it('shares one port between HTTP and Socket.IO broadcast', async () => {
    const app = await buildApp({ authorize: () => true, resolveSession: () => SESSION });
    const server = createHttpServer(app);
    const port = await listen(server);
    const origin = `http://127.0.0.1:${port}`;

    const broadcast = await attachBroadcast(server, {
      allowedOrigins: [origin],
      authenticate: () => ({ id: 'user-1' }),
      authorizeChannel: () => true,
    });

    let socket: ClientSocket | undefined;
    try {
      // HTTP still works on the shared port.
      const httpResponse = await fetch(`${origin}/api/users`, { headers: { origin } });
      assert.equal(httpResponse.status, 200);

      // Socket.IO connects on the same port.
      socket = await connectSocket(port, origin);
      const event = new Promise<{ value: number }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('broadcast event timed out')), 3000);
        socket!.on('jsails:event', (payload: { data: { value: number } }) => {
          clearTimeout(timer);
          resolve(payload.data);
        });
      });

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('subscribe ack timed out')), 3000);
        socket!.emit('jsails:subscribe', { channels: ['room-1'] }, (ack: { ok: boolean }) => {
          clearTimeout(timer);
          if (ack?.ok) resolve();
          else reject(new Error(`subscribe denied: ${JSON.stringify(ack)}`));
        });
      });

      broadcast.emit('room-1', 'ping', { value: 42 });
      assert.deepEqual(await event, { value: 42 });
    } finally {
      socket?.close();
      await broadcast.close();
    }
  });
});
