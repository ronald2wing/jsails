/**
 * First-party `auth` plugin tests.
 *
 * These prove the plugin seam without a database, Valkey, browser, or listener:
 *
 * - `resolveSessionFromRequest` maps a Better Auth session to the JSails
 *   `Session` shape (and `null` when unauthenticated), deriving the CSRF token
 *   from the signing secret when one is configured;
 * - `authPlugin` provides an `AuthSessionService` under `authSessionToken` and
 *   resolves sessions through the injected `createAuth` instance;
 * - the `admin` plugin built from `auth: authSessionToken` derives its session
 *   resolver from that service and gates routes on it, and is rejected with a
 *   value-free error when no `auth` plugin is declared;
 * - `defineAdminPanel` enforces exactly one of `resolveSession` / `auth`.
 */

import { createHmac } from 'node:crypto';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AdminPanelError, adminPlugin, defineAdminPanel } from '../../src/admin/index.js';
import {
  authPlugin,
  authSessionToken,
  handleLogin,
  resolveSessionFromRequest,
  type Auth,
} from '../../src/auth/index.js';
import type { Session } from '../../src/contracts/http.js';
import { createTestApp } from '../../src/testing/app.js';

const SESSION: Session = {
  id: 'auth-session-1',
  csrfToken: 'csrf-token',
  data: { userId: 'u1' },
  expiresAt: 2_000_000_000_000,
};

const EXPIRY = new Date('2025-01-01T00:00:00.000Z');

/** A Better Auth instance stub for tests: no pool, no database, no network. */
const fakeAuth = {
  handler: async () => new Response('ok'),
  api: {
    getSession: async () => ({
      session: { id: 'session-1', expiresAt: EXPIRY },
      user: { id: 'u1', name: 'Ada', email: 'ada@example.com' },
    }),
    signInEmail: async () => ({ headers: new Headers({ 'set-cookie': 'session=abc' }) }),
    signOut: async () => ({ headers: new Headers({ 'set-cookie': 'session=; Max-Age=0' }) }),
  },
} as unknown as Auth;

describe('resolveSessionFromRequest', () => {
  it('maps a Better Auth session to the JSails Session shape', async () => {
    const request = new Request('http://localhost/', { headers: { cookie: 'session=abc' } });
    const session = await resolveSessionFromRequest(fakeAuth, request, 'secret-key');
    assert.ok(session);
    assert.equal(session.id, 'session-1');
    assert.equal(session.expiresAt, EXPIRY.getTime());
    assert.deepEqual(session.data, {
      user: { id: 'u1', name: 'Ada', email: 'ada@example.com' },
    });
    assert.equal(
      session.csrfToken,
      createHmac('sha256', 'secret-key')
        .update('jsails.session.csrf:session-1')
        .digest('base64url'),
    );
  });

  it('derives a deterministic CSRF token without a secret', async () => {
    const request = new Request('http://localhost/');
    const session = await resolveSessionFromRequest(fakeAuth, request, undefined);
    assert.equal(session?.csrfToken, 'csrf:session-1');
  });

  it('returns null for an unauthenticated request', async () => {
    const unauthenticated = {
      api: { getSession: async () => null },
    } as unknown as Auth;
    const request = new Request('http://localhost/');
    assert.equal(await resolveSessionFromRequest(unauthenticated, request, undefined), null);
  });
});

describe('handleLogin', () => {
  it('rejects a cross-origin request before touching Better Auth', async () => {
    const request = new Request('http://localhost/api/login', {
      method: 'POST',
      headers: { origin: 'http://evil.example' },
      body: new URLSearchParams({ email: 'a@b.c', password: 'pw' }).toString(),
    });
    const response = await handleLogin(request, fakeAuth, 'http://localhost');
    assert.equal(response.status, 403);
  });

  it('redirects to the dashboard and forwards the session cookie on success', async () => {
    const request = new Request('http://localhost/api/login', {
      method: 'POST',
      headers: {
        origin: 'http://localhost',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ email: 'a@b.c', password: 'pw' }).toString(),
    });
    const response = await handleLogin(request, fakeAuth, 'http://localhost');
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), '/dashboard');
    assert.equal(response.headers.get('set-cookie'), 'session=abc');
  });
});

describe('authPlugin', () => {
  it('defers Better Auth construction until first use (setup needs no database)', async () => {
    // No `createAuth` override and no database variables: assembly must not
    // build the instance (which would throw on the missing MariaDB env vars), so
    // `jsails build` / static export works without a database. Only a live
    // request or consumer that resolves a session forces construction.
    const app = await createTestApp({
      config: { port: 0, extensions: [authPlugin()] },
    });
    await app.close();
  });

  it('provides an auth session service under authSessionToken', async () => {
    const app = await createTestApp({
      config: {
        port: 0,
        extensions: [
          authPlugin({ createAuth: () => fakeAuth }),
          adminPlugin(
            defineAdminPanel({ auth: authSessionToken, authorize: (session) => session !== null }),
          ),
        ],
      },
    });

    // The admin panel derives its resolver from the auth service, so an
    // authorized request reaches the dashboard (200) rather than the gate (403).
    const response = await app.request('/admin');
    assert.equal(response.status, 200);

    await app.close();
  });

  it('denies the admin surface when the auth service yields no session', async () => {
    const unauthenticated = { api: { getSession: async () => null } } as unknown as Auth;
    const app = await createTestApp({
      config: {
        port: 0,
        extensions: [
          authPlugin({ createAuth: () => unauthenticated }),
          adminPlugin(
            defineAdminPanel({ auth: authSessionToken, authorize: (session) => session !== null }),
          ),
        ],
      },
    });

    const response = await app.request('/admin');
    assert.equal(response.status, 403);

    await app.close();
  });

  it('rejects an admin panel built from auth when no auth plugin is declared', async () => {
    await assert.rejects(
      createTestApp({
        config: {
          port: 0,
          extensions: [
            adminPlugin(defineAdminPanel({ auth: authSessionToken, authorize: () => true })),
          ],
        },
      }),
      /requires service/,
    );
  });
});

describe('defineAdminPanel auth option', () => {
  it('rejects both resolveSession and auth together', () => {
    assert.throws(
      () =>
        defineAdminPanel({
          resolveSession: () => SESSION,
          auth: authSessionToken,
          authorize: () => true,
        }),
      AdminPanelError,
    );
  });

  it('rejects neither resolveSession nor auth', () => {
    assert.throws(() => defineAdminPanel({ authorize: () => true }), AdminPanelError);
  });

  it('accepts a panel built from auth alone and leaves resolveSession absent', () => {
    const panel = defineAdminPanel({ auth: authSessionToken, authorize: () => true });
    assert.equal(panel.auth, authSessionToken);
    assert.equal(panel.resolveSession, undefined);
  });
});
