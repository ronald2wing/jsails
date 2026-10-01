/**
 * Tests for the default-deny cache-control middleware and the route-level
 * public-caching opt-in.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import type { Hono } from 'hono';
import { createApp } from '../../src/server/app.js';
import type { AppEnv } from '../../src/server/env.js';
import { discoverRoutes, type RouteManifest } from '../../src/routing/routes.js';
import {
  DEFAULT_CACHE_CONTROL,
  applyCacheControl,
  applyDefaultCacheControl,
  extractCacheControlDeclaration,
  resolveCacheControl,
  wrapPublicResponse,
  type CacheControlDeclaration,
} from '../../src/server/cache-control.js';

const distDir = fileURLToPath(new URL('../../', import.meta.url));
const fixturesRoot = mkdtempSync(join(distDir, 'cc-test-'));

after(() => {
  rmSync(fixturesRoot, { recursive: true, force: true });
});

function writeFixture(root: string, relative: string, content: string): void {
  const full = join(root, relative);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

const ORIGIN = 'http://127.0.0.1:9999';

async function appRequest(app: Hono<AppEnv>, path: string, init?: RequestInit): Promise<Response> {
  return app.fetch(new Request(`${ORIGIN}${path}`, init));
}

// ---------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------

describe('extractCacheControlDeclaration', () => {
  it('returns undefined when cacheControl export is absent', () => {
    assert.equal(extractCacheControlDeclaration('/test', {}), undefined);
  });

  it('rejects a non-object cacheControl export', () => {
    assert.throws(
      () => extractCacheControlDeclaration('/test', { cacheControl: 'bad' }),
      /route "\/test" exports "cacheControl" as a non-object value/,
    );
  });

  it('rejects a non-integer maxAge', () => {
    assert.throws(
      () => extractCacheControlDeclaration('/test', { cacheControl: { maxAge: 3.5 } }),
      /cacheControl.maxAge must be a positive integer/,
    );
  });

  it('accepts a valid declaration with maxAge only', () => {
    const result = extractCacheControlDeclaration('/test', { cacheControl: { maxAge: 300 } });
    assert.ok(result !== undefined);
    assert.equal(result.maxAge, 300);
    assert.equal(result.staleWhileRevalidate, undefined);
  });

  it('accepts a valid declaration with both fields', () => {
    const result = extractCacheControlDeclaration('/test', {
      cacheControl: { maxAge: 300, staleWhileRevalidate: 60 },
    });
    assert.ok(result !== undefined);
    assert.equal(result.maxAge, 300);
    assert.equal(result.staleWhileRevalidate, 60);
  });
});

describe('resolveCacheControl', () => {
  it('returns private no-store for a non-GET method', () => {
    const decision = resolveCacheControl(undefined, 'POST', false);
    assert.equal(decision.value, 'private, no-store');
    assert.equal(decision.vary, undefined);
  });

  it('returns private no-store with Vary: Cookie when Set-Cookie is present', () => {
    const decision = resolveCacheControl(undefined, 'GET', true);
    assert.equal(decision.value, 'private, no-store');
    assert.equal(decision.vary, 'Cookie');
  });

  it('returns private no-store when no declaration and no cookie', () => {
    const decision = resolveCacheControl(undefined, 'GET', false);
    assert.equal(decision.value, 'private, no-store');
    assert.equal(decision.vary, undefined);
  });

  it('returns public headers with s-maxage and Surrogate-Control when declared', () => {
    const decl: CacheControlDeclaration = { maxAge: 300, staleWhileRevalidate: 60 };
    const decision = resolveCacheControl(decl, 'GET', false);
    assert.match(decision.value, /public, max-age=0, s-maxage=300, stale-while-revalidate=60/);
    assert.match(decision.surrogateControl!, /max-age=300, stale-while-revalidate=60/);
    assert.equal(decision.vary, 'Accept-Encoding');
  });

  it('session cookie overrides a declaration', () => {
    const decl: CacheControlDeclaration = { maxAge: 300 };
    const decision = resolveCacheControl(decl, 'GET', true);
    assert.equal(decision.value, 'private, no-store');
    assert.equal(decision.vary, 'Cookie');
  });
});

describe('applyCacheControl', () => {
  it('sets cache-control on headers', () => {
    const headers = new Headers();
    applyCacheControl(headers, { value: 'public, max-age=0, s-maxage=300' });
    assert.equal(headers.get('cache-control'), 'public, max-age=0, s-maxage=300');
  });

  it('does NOT overwrite an explicit cache-control header', () => {
    const headers = new Headers({ 'cache-control': 'no-cache' });
    applyCacheControl(headers, { value: 'public' });
    assert.equal(headers.get('cache-control'), 'no-cache');
  });
});

describe('applyDefaultCacheControl', () => {
  it('sets Cache-Control: private, no-store when no explicit header', () => {
    const headers = new Headers();
    applyDefaultCacheControl(headers);
    assert.equal(headers.get('cache-control'), 'private, no-store');
  });

  it('does NOT overwrite an explicit cache-control header', () => {
    const headers = new Headers({ 'cache-control': 'public, max-age=3600' });
    applyDefaultCacheControl(headers);
    assert.equal(headers.get('cache-control'), 'public, max-age=3600');
  });

  it('sets Vary: Cookie when Set-Cookie is present', () => {
    const headers = new Headers({ 'set-cookie': 'session=abc' });
    applyDefaultCacheControl(headers);
    assert.equal(headers.get('cache-control'), 'private, no-store');
    assert.equal(headers.get('vary'), 'Cookie');
  });
});

describe('wrapPublicResponse', () => {
  it('does nothing for a non-GET method', () => {
    const response = new Response('ok', { status: 200 });
    const decl: CacheControlDeclaration = { maxAge: 300 };
    const wrapped = wrapPublicResponse(response, decl, 'POST');
    assert.equal(wrapped.headers.get('cache-control'), null);
  });

  it('does nothing when Cache-Control is already set', () => {
    const response = new Response('ok', {
      status: 200,
      headers: { 'cache-control': 'no-cache' },
    });
    const decl: CacheControlDeclaration = { maxAge: 300 };
    const wrapped = wrapPublicResponse(response, decl, 'GET');
    assert.equal(wrapped.headers.get('cache-control'), 'no-cache');
  });

  it('does nothing when Set-Cookie is present', () => {
    const response = new Response('ok', {
      status: 200,
      headers: { 'set-cookie': 'session=abc' },
    });
    const decl: CacheControlDeclaration = { maxAge: 300 };
    const wrapped = wrapPublicResponse(response, decl, 'GET');
    assert.equal(wrapped.headers.get('cache-control'), null);
  });

  it('applies public caching headers for a GET response', () => {
    const response = new Response('ok', { status: 200 });
    const decl: CacheControlDeclaration = { maxAge: 300 };
    const wrapped = wrapPublicResponse(response, decl, 'GET');
    assert.match(
      wrapped.headers.get('cache-control') ?? '',
      /public, max-age=0, s-maxage=300, stale-while-revalidate=0/,
    );
    assert.equal(wrapped.headers.get('surrogate-control'), 'max-age=300, stale-while-revalidate=0');
    assert.equal(wrapped.headers.get('vary'), 'Accept-Encoding');
  });
});

describe('DEFAULT_CACHE_CONTROL constant', () => {
  it('is frozen', () => {
    assert.ok(Object.isFrozen(DEFAULT_CACHE_CONTROL));
  });

  it('has the expected value', () => {
    assert.equal(DEFAULT_CACHE_CONTROL.value, 'private, no-store');
  });
});

// ---------------------------------------------------------------
// Integration tests: live HTTP caching behaviour
// ---------------------------------------------------------------

describe('live HTTP cache-control -- default deny', () => {
  it('preserves the health endpoint explicit Cache-Control: no-store', async () => {
    writeFixture(fixturesRoot, 'pages/index.mjs', `export default () => null;\n`);

    const manifest: RouteManifest = discoverRoutes(fixturesRoot);
    const app = await createApp({ manifest, healthPath: '/up' });
    const response = await appRequest(app, '/up');
    assert.equal(response.headers.get('cache-control'), 'no-store');
  });

  it('sets Cache-Control: private, no-store on an API 404 response', async () => {
    const apiDir = join(fixturesRoot, 'api');
    mkdirSync(apiDir, { recursive: true });
    writeFixture(fixturesRoot, 'pages/index.mjs', `export default () => null;\n`);

    const manifest: RouteManifest = discoverRoutes(fixturesRoot);
    const app = await createApp({ manifest });
    const response = await appRequest(app, '/api/nonexistent');
    assert.equal(response.status, 404);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
  });

  it('sets Cache-Control: private, no-store on a standard page', async () => {
    writeFixture(fixturesRoot, 'pages/index.mjs', `export default () => null;\n`);

    const manifest: RouteManifest = discoverRoutes(fixturesRoot);
    const app = await createApp({
      manifest,
      renderer: { render: () => '<!doctype html><h1>Hello</h1>' },
    });

    const response = await appRequest(app, '/');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
  });
});

describe('live HTTP cache-control -- explicit header wins', () => {
  it('preserves an explicit Cache-Control set by the handler', async () => {
    const app = await createApp({
      manifest: { entries: [], byRoute: new Map() },
      httpHooks: [
        (hono) => {
          hono.get('/custom', (c) => {
            return c.text('custom', 200, { 'cache-control': 'public, max-age=3600' });
          });
        },
      ],
    });

    const response = await appRequest(app, '/custom');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'public, max-age=3600');
  });
});

describe('live HTTP cache-control -- route-level opt-in page', () => {
  it('applies public caching headers for a page that exports cacheControl', async () => {
    writeFixture(
      fixturesRoot,
      'pages/cacheable.mjs',
      'export const cacheControl = { maxAge: 300, staleWhileRevalidate: 60 };\nexport default () => null;\n',
    );

    const manifest: RouteManifest = discoverRoutes(fixturesRoot);
    const app = await createApp({
      manifest,
      renderer: { render: () => '<!doctype html><h1>Cacheable</h1>' },
    });

    const response = await appRequest(app, '/cacheable');
    assert.equal(response.status, 200);
    const cc = response.headers.get('cache-control') ?? '';
    assert.match(cc, /public, max-age=0, s-maxage=300, stale-while-revalidate=60/);
    assert.equal(
      response.headers.get('surrogate-control'),
      'max-age=300, stale-while-revalidate=60',
    );
    assert.equal(response.headers.get('vary'), 'Accept-Encoding');
  });

  it('does NOT have Vary: Cookie on a public page', async () => {
    writeFixture(
      fixturesRoot,
      'pages/public.mjs',
      'export const cacheControl = { maxAge: 300 };\nexport default () => null;\n',
    );

    const manifest: RouteManifest = discoverRoutes(fixturesRoot);
    const app = await createApp({
      manifest,
      renderer: { render: () => '<!doctype html><h1>Cacheable</h1>' },
    });

    const response = await appRequest(app, '/public');
    assert.equal(response.status, 200);
    const vary = response.headers.get('vary') ?? '';
    assert.ok(!vary.includes('Cookie'));
  });
});

describe('live HTTP cache-control -- route-level opt-in API', () => {
  it('applies public caching to a GET API route that exports cacheControl', async () => {
    const apiDir = join(fixturesRoot, 'api');
    mkdirSync(apiDir, { recursive: true });
    writeFixture(
      fixturesRoot,
      'api/json.mjs',
      "export const cacheControl = { maxAge: 600 };\nexport function GET() { return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }); }\n",
    );

    const manifest: RouteManifest = discoverRoutes(fixturesRoot);
    const app = await createApp({
      manifest,
      authorize: () => true,
    });

    const response = await appRequest(app, '/api/json');
    assert.equal(response.status, 200);
    assert.match(
      response.headers.get('cache-control') ?? '',
      /public, max-age=0, s-maxage=600, stale-while-revalidate=0/,
    );
    assert.equal(
      response.headers.get('surrogate-control'),
      'max-age=600, stale-while-revalidate=0',
    );
    assert.equal(response.headers.get('vary'), 'Accept-Encoding');
  });
});

describe('live HTTP cache-control -- cookie forces private', () => {
  it('page with Set-Cookie gets private, no-store despite cacheControl export', async () => {
    writeFixture(
      fixturesRoot,
      'pages/cookie.mjs',
      'export const cacheControl = { maxAge: 300 };\nexport default () => null;\n',
    );

    const manifest: RouteManifest = discoverRoutes(fixturesRoot);
    const app = await createApp({
      manifest,
      renderer: { render: () => '<!doctype html><h1>With Cookie</h1>' },
      httpHooks: [
        (hono) => {
          hono.use('*', async (c, next) => {
            await next();
            c.res.headers.set('set-cookie', 'session=abc; HttpOnly');
          });
        },
      ],
    });

    const response = await appRequest(app, '/cookie');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    // Both `Cookie` (from the Set-Cookie vault) and `Accept-Encoding` (from the
    // compression middleware) must be advertised — the response varies on both.
    const vary = response.headers.get('vary') ?? '';
    assert.ok(vary.includes('Cookie'), `Vary must include Cookie, got "${vary}"`);
    assert.ok(vary.includes('Accept-Encoding'), `Vary must include Accept-Encoding, got "${vary}"`);
  });
});
