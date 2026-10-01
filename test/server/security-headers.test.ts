/**
 * Tests for the default security-headers constant (`DEFAULT_SECURITY_HEADERS`)
 * and the live HTTP injection middleware.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_SECURITY_HEADERS } from '../../src/server/security-headers.js';

import type { Hono } from 'hono';

import { createApp } from '../../src/server/app.js';
import type { AppEnv } from '../../src/server/env.js';
import { discoverRoutes, type RouteManifest } from '../../src/routing/routes.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after } from 'node:test';

const distDir = fileURLToPath(new URL('../../', import.meta.url));
const fixturesRoot = mkdtempSync(join(distDir, 'sec-headers-'));

after(() => {
  rmSync(fixturesRoot, { recursive: true, force: true });
});

function writeFixture(root: string, relative: string, content: string): void {
  const full = join(root, relative);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

writeFixture(fixturesRoot, 'pages/index.mjs', `export default () => null;\n`);

const SEC_HEADERS_MANIFEST: RouteManifest = discoverRoutes(fixturesRoot);

const ORIGIN = 'http://127.0.0.1:9999';

async function appRequest(app: Hono<AppEnv>, path: string, init?: RequestInit): Promise<Response> {
  return app.fetch(new Request(`${ORIGIN}${path}`, init));
}

describe('DEFAULT_SECURITY_HEADERS constant', () => {
  it('has exactly the three documented entries', () => {
    const entries = Object.entries(DEFAULT_SECURITY_HEADERS);
    assert.equal(entries.length, 3);
  });

  it('is frozen (immutable)', () => {
    assert.ok(Object.isFrozen(DEFAULT_SECURITY_HEADERS));
  });

  it('contains X-Content-Type-Options: nosniff', () => {
    assert.equal(DEFAULT_SECURITY_HEADERS['X-Content-Type-Options'], 'nosniff');
  });

  it('contains X-Frame-Options: SAMEORIGIN', () => {
    assert.equal(DEFAULT_SECURITY_HEADERS['X-Frame-Options'], 'SAMEORIGIN');
  });

  it('contains Referrer-Policy: strict-origin-when-cross-origin', () => {
    assert.equal(DEFAULT_SECURITY_HEADERS['Referrer-Policy'], 'strict-origin-when-cross-origin');
  });

  it('does NOT contain CSP, HSTS, X-XSS-Protection, or X-Permitted-Cross-Domain-Policies', () => {
    const keys = Object.keys(DEFAULT_SECURITY_HEADERS);
    assert.ok(!keys.includes('Content-Security-Policy'));
    assert.ok(!keys.includes('Strict-Transport-Security'));
    assert.ok(!keys.includes('X-XSS-Protection'));
    assert.ok(!keys.includes('X-Permitted-Cross-Domain-Policies'));
  });
});

describe('live HTTP security headers', () => {
  it('adds the three security headers to the health endpoint response', async () => {
    const app = await createApp({
      manifest: SEC_HEADERS_MANIFEST,
      healthPath: '/up',
    });
    const response = await appRequest(app, '/up');

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.equal(response.headers.get('X-Frame-Options'), 'SAMEORIGIN');
    assert.equal(response.headers.get('Referrer-Policy'), 'strict-origin-when-cross-origin');
  });

  it('preserves the health endpoint own Cache-Control header', async () => {
    const app = await createApp({
      manifest: SEC_HEADERS_MANIFEST,
      healthPath: '/up',
    });
    const response = await appRequest(app, '/up');

    // The health route sets Cache-Control: no-store; the security middleware
    // must NOT overwrite it.
    assert.equal(response.headers.get('cache-control'), 'no-store');
    // The three security headers must still be present.
    assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  });

  it('adds security headers to API error responses', async () => {
    const app = await createApp({
      manifest: SEC_HEADERS_MANIFEST,
    });
    const response = await appRequest(app, '/api/nonexistent');

    assert.equal(response.status, 404);
    assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.equal(response.headers.get('X-Frame-Options'), 'SAMEORIGIN');
    assert.equal(response.headers.get('Referrer-Policy'), 'strict-origin-when-cross-origin');
  });

  it('does NOT overwrite an X-Frame-Options header explicitly set by a handler', async () => {
    // Simulate an extension hook that sets its own X-Frame-Options.
    const app = await createApp({
      manifest: SEC_HEADERS_MANIFEST,
      httpHooks: [
        (hono) => {
          hono.get('/custom-headers', (c) => {
            return c.text('custom', 200, {
              'X-Frame-Options': 'DENY',
              'X-Content-Type-Options': 'nosniff',
            });
          });
        },
      ],
    });

    const response = await appRequest(app, '/custom-headers');
    assert.equal(response.status, 200);

    // The handler explicitly set X-Frame-Options: DENY — the middleware must
    // preserve it.
    assert.equal(response.headers.get('X-Frame-Options'), 'DENY');

    // X-Content-Type-Options matches the default value, so it is present.
    assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');

    // Referrer-Policy was NOT set by the handler, so the middleware sets it.
    assert.equal(response.headers.get('Referrer-Policy'), 'strict-origin-when-cross-origin');
  });

  it('adds security headers to page responses via structured renderer', async () => {
    const app = await createApp({
      manifest: SEC_HEADERS_MANIFEST,
      renderer: {
        render: () => '<!doctype html><h1>Hello</h1>',
      },
    });
    const response = await appRequest(app, '/');

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.equal(response.headers.get('X-Frame-Options'), 'SAMEORIGIN');
    assert.equal(response.headers.get('Referrer-Policy'), 'strict-origin-when-cross-origin');
  });
});
