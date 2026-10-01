/**
 * First-party API-token tests.
 *
 * These prove the token surface without a database, Valkey, browser, or
 * listener:
 *
 * - the real `createApiTokenStore` mints a tagged session whose secret is
 *   returned exactly once, lists only tokens (no secrets), revokes by id, and
 *   resolves only live token credentials;
 * - `createApiTokenManager` enforces a signed-in session and validates names
 *   and lifetimes, and resolves a request cookie-first then by token, failing
 *   closed when the token is unknown;
 * - the `authPlugin` mounts `/api/tokens` only when enabled and protects
 *   mutations with the same-origin + CSRF boundary.
 */

import { createHmac } from 'node:crypto';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ApiTokenError,
  createApiTokenManager,
  createApiTokenStore,
  type ApiTokenStore,
  type CreatedApiToken,
  type ResolvedApiToken,
} from '../../src/auth/api-tokens.js';
import { authPlugin, type Auth } from '../../src/auth/index.js';
import type { RequestContext, Session } from '../../src/contracts/http.js';
import { createTestApp } from '../../src/testing/app.js';

const SECRET = 'secret-key';
const USER_ID = 'u1';

/** A session as `resolveSessionFromRequest` would produce for the test user. */
function cookieSession(): Session {
  return {
    id: 'session-1',
    csrfToken: deriveCsrf('session-1'),
    data: { user: { id: USER_ID, name: 'Ada', email: 'ada@example.com' } },
    expiresAt: 2_000_000_000_000,
  };
}

/** The deterministic CSRF token `resolveSessionFromRequest` derives with `SECRET`. */
function deriveCsrf(sessionId: string): string {
  return createHmac('sha256', SECRET)
    .update(`jsails.session.csrf:${sessionId}`)
    .digest('base64url');
}

/** A minimal request context carrying the test session. */
function context(session: Session | null, services?: RequestContext['services']): RequestContext {
  return {
    request: new Request('http://localhost/'),
    url: new URL('http://localhost/'),
    params: {},
    session,
    services,
  };
}

interface SessionRow {
  id: string;
  token: string;
  userId: string;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
  userAgent: string;
  ipAddress: string;
}

/**
 * A Better Auth stub whose `$context.internalAdapter` is an in-memory session
 * table, so `createApiTokenStore` runs against a real (fake) adapter.
 */
function createFakeAuth(
  users: Map<string, { id: string; name: string; email: string }> = new Map(),
) {
  users.set(USER_ID, { id: USER_ID, name: 'Ada', email: 'ada@example.com' });

  const sessions = new Map<string, SessionRow>();
  let counter = 0;

  const adapter = {
    async createSession(
      userId: string,
      _dontRememberMe: boolean | undefined,
      override: { expiresAt?: Date; userAgent?: string } | undefined,
    ): Promise<SessionRow> {
      counter += 1;
      const now = new Date();
      const row: SessionRow = {
        id: `session-${counter}`,
        token: `token-${counter}`,
        userId,
        createdAt: now,
        updatedAt: now,
        expiresAt: override?.expiresAt ?? new Date(Date.now() + 86_400_000),
        userAgent: override?.userAgent ?? '',
        ipAddress: '',
      };
      sessions.set(row.token, row);
      return row;
    },

    async listSessions(
      userId: string,
      options?: { onlyActiveSessions?: boolean },
    ): Promise<SessionRow[]> {
      const now = Date.now();
      return [...sessions.values()]
        .filter((s) => s.userId === userId)
        .filter((s) => !options?.onlyActiveSessions || s.expiresAt.getTime() > now);
    },

    async findSession(token: string) {
      const row = sessions.get(token);
      if (row === undefined) return null;
      const user = users.get(row.userId);
      if (user === undefined) return null;
      return { session: { ...row }, user: { ...user } };
    },

    async deleteSession(token: string): Promise<void> {
      sessions.delete(token);
    },
  };

  const auth = { $context: Promise.resolve({ internalAdapter: adapter }) } as unknown as Auth;

  return { auth, sessions, adapter };
}

describe('createApiTokenStore', () => {
  it('mints a tagged session and returns the secret exactly once', async () => {
    const { auth, sessions } = createFakeAuth();
    const store = createApiTokenStore(auth);

    const created = await store.create(USER_ID, 'ci', new Date(Date.now() + 30 * 86_400_000));

    assert.equal(created.name, 'ci');
    assert.equal(created.id, 'session-1');
    assert.equal(created.token, 'token-1');
    assert.ok(created.expiresAt > created.createdAt);

    // The backing session carries the sentinel plus the name, never the secret.
    const row = sessions.get(created.token);
    assert.ok(row);
    assert.equal(row.userAgent, 'jsails/api-token:ci');
  });

  it('lists only token sessions, without exposing secrets', async () => {
    const { auth, adapter } = createFakeAuth();
    const store = createApiTokenStore(auth);

    // A browser session (no sentinel) must be excluded.
    await adapter.createSession(USER_ID, undefined, { userAgent: 'Mozilla/5.0' });
    const created = await store.create(USER_ID, 'ci', new Date(Date.now() + 86_400_000));

    const list = await store.list(USER_ID);
    assert.deepEqual(list, [
      { id: created.id, name: 'ci', createdAt: created.createdAt, expiresAt: created.expiresAt },
    ]);
    // The secret never appears on the listed shape.
    assert.ok(!Object.prototype.hasOwnProperty.call(list[0], 'token'));
  });

  it('revokes by id and reports a missing id', async () => {
    const { auth } = createFakeAuth();
    const store = createApiTokenStore(auth);

    const created = await store.create(USER_ID, 'ci', new Date(Date.now() + 86_400_000));

    assert.equal(await store.revoke(USER_ID, created.id), true);
    assert.equal(await store.revoke(USER_ID, created.id), false);
    assert.equal(await store.resolve(created.token), null);
  });

  it('resolves a live token but rejects expired or non-token sessions', async () => {
    const { auth, adapter } = createFakeAuth();
    const store = createApiTokenStore(auth);

    const live = await store.create(USER_ID, 'ci', new Date(Date.now() + 86_400_000));
    const expired = await adapter.createSession(USER_ID, undefined, {
      userAgent: 'jsails/api-token:old',
      expiresAt: new Date(Date.now() - 1000),
    });
    const browser = await adapter.createSession(USER_ID, undefined, { userAgent: 'Mozilla/5.0' });

    const resolved = await store.resolve(live.token);
    assert.ok(resolved);
    assert.equal(resolved.userId, USER_ID);
    assert.equal(resolved.name, 'Ada');
    assert.equal(resolved.email, 'ada@example.com');

    assert.equal(await store.resolve(expired.token), null);
    // A browser session's token is not a valid API-token credential.
    assert.equal(await store.resolve(browser.token), null);
    assert.equal(await store.resolve('missing'), null);
  });
});

/** An in-memory `ApiTokenStore` for manager and handler tests. */
function createInMemoryStore(): ApiTokenStore & {
  rows: Map<string, { token: string; userId: string }>;
} {
  const rows = new Map<
    string,
    {
      id: string;
      name: string;
      createdAt: number;
      expiresAt: number;
      token: string;
      userId: string;
    }
  >();
  let counter = 0;

  return {
    rows,
    async create(userId, name, expiresAt) {
      counter += 1;
      const id = `tok-${counter}`;
      const token = `secret-${counter}`;
      const createdAt = Date.now();
      rows.set(id, { id, name, createdAt, expiresAt: expiresAt.getTime(), token, userId });
      return { id, name, createdAt, expiresAt: expiresAt.getTime(), token };
    },
    async list(userId) {
      const now = Date.now();
      return [...rows.values()]
        .filter((r) => r.userId === userId && r.expiresAt > now)
        .map(({ id, name, createdAt, expiresAt }) => ({ id, name, createdAt, expiresAt }));
    },
    async revoke(userId, id) {
      const row = rows.get(id);
      if (row === undefined || row.userId !== userId) return false;
      rows.delete(id);
      return true;
    },
    async resolve(token): Promise<ResolvedApiToken | null> {
      for (const row of rows.values()) {
        if (row.token === token && row.expiresAt > Date.now()) {
          return {
            sessionId: row.id,
            userId: row.userId,
            name: 'Ada',
            email: 'ada@example.com',
            expiresAt: row.expiresAt,
          };
        }
      }
      return null;
    },
  };
}

describe('createApiTokenManager', () => {
  function buildManager(store: ApiTokenStore) {
    const manager = createApiTokenManager({
      store,
      cookieSession: async (request) => {
        const cookie = request.headers.get('cookie');
        return cookie === 'session=abc' ? cookieSession() : null;
      },
      secret: SECRET,
      headerName: 'authorization',
      expiresInDays: 30,
    });
    return manager;
  }

  it('creates, lists, and revokes a token for a signed-in session', async () => {
    const store = createInMemoryStore();
    const manager = buildManager(store);

    const created = await manager.createApiToken(context(cookieSession()), { name: '  ci  ' });
    assert.equal(created.name, 'ci');
    assert.equal(typeof created.token, 'string');

    const listed = await manager.listApiTokens(context(cookieSession()));
    assert.equal(listed.length, 1);
    assert.ok(!Object.prototype.hasOwnProperty.call(listed[0], 'token'));

    assert.equal(await manager.revokeApiToken(context(cookieSession()), created.id), true);
    assert.equal(await manager.revokeApiToken(context(cookieSession()), created.id), false);
  });

  it('rejects an unauthenticated session', async () => {
    const manager = buildManager(createInMemoryStore());
    await assert.rejects(
      manager.createApiToken(context(null), { name: 'ci' }),
      (error: unknown) => error instanceof ApiTokenError && error.status === 401,
    );
  });

  it('validates names and lifetimes', async () => {
    const manager = buildManager(createInMemoryStore());
    const session = cookieSession();

    for (const name of ['', '   ', 'a'.repeat(201), 'bad\nname']) {
      await assert.rejects(
        manager.createApiToken(context(session), { name }),
        (error: unknown) => error instanceof ApiTokenError && error.status === 400,
      );
    }

    for (const expiresInDays of [0, -1, 3651, 1.5]) {
      await assert.rejects(
        manager.createApiToken(context(session), { name: 'ci', expiresInDays }),
        (error: unknown) => error instanceof ApiTokenError && error.status === 400,
      );
    }
  });

  it('resolves a request cookie-first, then by token, failing closed', async () => {
    const store = createInMemoryStore();
    const manager = buildManager(store);
    const created = await manager.createApiToken(context(cookieSession()), { name: 'ci' });

    // Cookie wins even when a token is also present.
    const cookieRequest = new Request('http://localhost/', {
      headers: { cookie: 'session=abc', authorization: `Bearer ${created.token}` },
    });
    const viaCookie = await manager.resolveSessionWithApiToken(cookieRequest);
    assert.equal(viaCookie?.id, 'session-1');

    // No cookie: the token resolves.
    const tokenRequest = new Request('http://localhost/', {
      headers: { authorization: `Bearer ${created.token}` },
    });
    const viaToken = await manager.resolveSessionWithApiToken(tokenRequest);
    assert.equal(viaToken?.id, created.id);
    assert.equal(viaToken?.csrfToken, deriveCsrf(created.id));
    assert.deepEqual(viaToken?.data, {
      user: { id: USER_ID, name: 'Ada', email: 'ada@example.com' },
    });

    // Unknown or absent token: fail closed.
    assert.equal(
      await manager.resolveSessionWithApiToken(
        new Request('http://localhost/', { headers: { authorization: 'Bearer nope' } }),
      ),
      null,
    );
    assert.equal(await manager.resolveSessionWithApiToken(new Request('http://localhost/')), null);
  });
});

describe('authPlugin api tokens', () => {
  function fakeAuth(authenticated: boolean): Auth {
    return {
      api: {
        getSession: async () =>
          authenticated
            ? {
                session: { id: 'session-1', expiresAt: new Date('2099-01-01T00:00:00.000Z') },
                user: { id: USER_ID, name: 'Ada', email: 'ada@example.com' },
              }
            : null,
      },
    } as unknown as Auth;
  }

  async function buildApp(options: { enabled: boolean; authenticated?: boolean }) {
    const store = createInMemoryStore();
    const app = await createTestApp({
      config: {
        port: 0,
        extensions: [
          authPlugin({
            createAuth: () => fakeAuth(options.authenticated ?? true),
            secret: SECRET,
            publicOrigin: 'http://localhost',
            apiTokens: { enabled: options.enabled, store },
          }),
        ],
      },
    });
    return { app, store };
  }

  const csrf = deriveCsrf('session-1');

  it('mints, lists, and revokes a token over the mounted routes', async () => {
    const { app } = await buildApp({ enabled: true });

    const created = await app.json<CreatedApiToken>('/api/tokens', {
      method: 'POST',
      headers: {
        origin: 'http://localhost',
        'content-type': 'application/json',
        'x-csrf-token': csrf,
        cookie: 'session=abc',
      },
      body: JSON.stringify({ name: 'ci' }),
    });

    assert.equal(created.name, 'ci');
    assert.equal(typeof created.token, 'string');
    assert.equal(typeof created.id, 'string');

    const listed = await app.json<Array<{ id: string; token?: string }>>('/api/tokens', {
      headers: { cookie: 'session=abc' },
    });
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.id, created.id);
    assert.equal('token' in (listed[0] ?? {}), false);

    const removed = await app.json<{ revoked: boolean }>(`/api/tokens/${created.id}`, {
      method: 'DELETE',
      headers: { origin: 'http://localhost', 'x-csrf-token': csrf, cookie: 'session=abc' },
    });
    assert.equal(removed.revoked, true);

    const gone = await app.request(`/api/tokens/${created.id}`, {
      method: 'DELETE',
      headers: { origin: 'http://localhost', 'x-csrf-token': csrf, cookie: 'session=abc' },
    });
    assert.equal(gone.status, 404);

    await app.close();
  });

  it('rejects an unauthenticated management request', async () => {
    const { app } = await buildApp({ enabled: true, authenticated: false });

    const response = await app.request('/api/tokens', {
      method: 'POST',
      headers: { origin: 'http://localhost', 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'ci' }),
    });
    assert.equal(response.status, 401);

    await app.close();
  });

  it('rejects a mutation without a valid CSRF token', async () => {
    const { app } = await buildApp({ enabled: true });

    const response = await app.request('/api/tokens', {
      method: 'POST',
      headers: {
        origin: 'http://localhost',
        'content-type': 'application/json',
        cookie: 'session=abc',
      },
      body: JSON.stringify({ name: 'ci' }),
    });
    assert.equal(response.status, 403);

    await app.close();
  });

  it('does not mount the token surface when disabled (default)', async () => {
    const { app } = await buildApp({ enabled: false });

    const response = await app.request('/api/tokens', {
      method: 'POST',
      headers: {
        origin: 'http://localhost',
        'content-type': 'application/json',
        cookie: 'session=abc',
      },
      body: JSON.stringify({ name: 'ci' }),
    });
    assert.equal(response.status, 404);

    await app.close();
  });
});
