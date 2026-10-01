import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AuthError,
  InMemorySessionStore,
  SessionManager,
  assertCsrfToken,
  parseSessionCookie,
  serializeSessionCookie,
} from '../../src/auth/csrf.js';
import type { JsonObject, Session } from '../../src/contracts/http.js';

describe('session manager', () => {
  it('creates sessions with random, distinct ids and csrf tokens', async () => {
    const manager = new SessionManager(new InMemorySessionStore());
    const a = await manager.create({ userId: 'u1' });
    const b = await manager.create({ userId: 'u1' });
    assert.notEqual(a.id, b.id);
    assert.notEqual(a.csrfToken, b.csrfToken);
    assert.ok(a.id.length > 20);
    assert.ok(a.csrfToken.length > 20);
  });

  it('snapshots data on create so caller input is never aliased', async () => {
    const manager = new SessionManager(new InMemorySessionStore());
    const input: JsonObject = { count: 1 };
    const session = await manager.create(input);
    input.count = 999;
    session.data.count = 888;
    const loaded = await manager.get(session.id);
    assert.deepEqual(loaded?.data, { count: 1 });
  });

  it('loads a valid id and returns null for absent or malformed ids', async () => {
    const manager = new SessionManager(new InMemorySessionStore());
    const session = await manager.create();
    assert.equal((await manager.get(session.id))?.id, session.id);
    assert.equal(await manager.get('x'.repeat(43)), null); // valid shape, absent
    assert.equal(await manager.get('short'), null);
    assert.equal(await manager.get(''), null);
    assert.equal(await manager.get('../../etc/passwd'), null);
    assert.equal(await manager.get(session.id + 'a'), null); // wrong length
  });

  it('expires sessions after the TTL and deletes them', async () => {
    let now = 1_000_000;
    const store = new InMemorySessionStore({ clock: () => now });
    const manager = new SessionManager(store, { clock: () => now, ttlMs: 1000 });
    const session = await manager.create();
    assert.ok(await manager.get(session.id));

    now += 1001;
    assert.equal(await manager.get(session.id), null);
    assert.equal(await store.get(session.id), null);
  });

  it('regenerates on login: deletes prior id, rotates id and csrf, preserves data', async () => {
    const store = new InMemorySessionStore();
    const manager = new SessionManager(store);
    const old = await manager.create({ userId: 'u1' });

    const fresh = await manager.regenerate(old.id);

    assert.notEqual(fresh.id, old.id);
    assert.notEqual(fresh.csrfToken, old.csrfToken);
    assert.equal(await manager.get(old.id), null); // prior id invalidated
    assert.deepEqual((await manager.get(fresh.id))?.data, { userId: 'u1' });
  });

  it('regenerate accepts replacement data', async () => {
    const manager = new SessionManager(new InMemorySessionStore());
    const old = await manager.create({ userId: 'u1' });
    const fresh = await manager.regenerate(old.id, { userId: 'u2' });
    assert.deepEqual((await manager.get(fresh.id))?.data, { userId: 'u2' });
  });

  it('logout deletes the session', async () => {
    const manager = new SessionManager(new InMemorySessionStore());
    const session = await manager.create();
    await manager.logout(session.id);
    assert.equal(await manager.get(session.id), null);
  });
});

describe('in-memory session store', () => {
  function session(id: string, expiresAt: number, data: JsonObject = { x: 1 }): Session {
    return { id, csrfToken: 'csrf', data, expiresAt };
  }

  it('deep-clones on get so callers cannot mutate live state', async () => {
    const store = new InMemorySessionStore();
    await store.set(session('s1', 2_000_000_000_000, { nested: { x: 1 } }));

    const first = await store.get('s1');
    (first!.data as { nested: { x: number } }).nested.x = 99;

    const second = await store.get('s1');
    assert.deepEqual(second?.data, { nested: { x: 1 } });
  });

  it('deep-clones on set so later mutation of the source object does not leak', async () => {
    const store = new InMemorySessionStore();
    const original = session('s1', 2_000_000_000_000, { list: [1, 2, 3] });
    await store.set(original);
    (original.data as { list: number[] }).list.push(4);

    assert.deepEqual((await store.get('s1'))?.data, { list: [1, 2, 3] });
  });

  it('evicts expired entries', async () => {
    let now = 0;
    const store = new InMemorySessionStore({ clock: () => now });
    await store.set(session('s1', 100));
    await store.set(session('s2', 200));
    now = 150;

    assert.equal(await store.get('s1'), null); // expired
    assert.ok(await store.get('s2')); // still valid
  });

  it('enforces a hard capacity cap by evicting the soonest-expiring entry', async () => {
    const now = 0;
    const store = new InMemorySessionStore({ capacity: 2, clock: () => now });
    await store.set(session('s1', 1000));
    await store.set(session('s2', 3000));
    await store.set(session('s3', 2000)); // over capacity -> evict soonest (s1)

    assert.equal(await store.get('s1'), null);
    assert.ok(await store.get('s2'));
    assert.ok(await store.get('s3'));
  });
});

describe('cookie serialization and parsing', () => {
  const ID = 'A'.repeat(43); // 32 zero bytes in base64url -> valid session id shape

  it('serializes with HttpOnly, SameSite=Lax, Path=/, and Secure by default', () => {
    const cookie = serializeSessionCookie(ID);
    assert.ok(cookie.startsWith('session='));
    assert.ok(cookie.includes('HttpOnly'));
    assert.ok(cookie.includes('SameSite=Lax'));
    assert.ok(cookie.includes('Path=/'));
    assert.ok(cookie.includes('Secure'));
  });

  it('omits Secure only when explicitly disabled for dev', () => {
    const cookie = serializeSessionCookie(ID, { secure: false });
    assert.ok(!cookie.includes('Secure'));
    assert.ok(cookie.includes('HttpOnly'));
  });

  it('honors an explicit Max-Age and custom name', () => {
    const cookie = serializeSessionCookie(ID, { name: 'sid', maxAgeSeconds: 3600 });
    assert.ok(cookie.startsWith('sid='));
    assert.ok(cookie.includes('Max-Age=3600'));
  });

  it('refuses to serialize a non-session-id value', () => {
    assert.throws(() => serializeSessionCookie('user=admin; HttpOnly'), /valid session id/);
  });

  it('parses a valid id and ignores other cookies', () => {
    assert.equal(parseSessionCookie(`session=${ID}`), ID);
    assert.equal(parseSessionCookie(`session=${ID}; theme=dark`), ID);
    assert.equal(parseSessionCookie(`theme=dark; session=${ID}`), ID);
  });

  it('rejects malformed ids and user-supplied data', () => {
    assert.equal(parseSessionCookie('session=not-a-real-id'), null);
    assert.equal(parseSessionCookie('session='), null);
    assert.equal(parseSessionCookie('session=' + 'A'.repeat(20)), null);
    assert.equal(parseSessionCookie('other=' + ID), null);
    assert.equal(parseSessionCookie(null), null);
    assert.equal(parseSessionCookie('session=' + ID + '=extra'), null);
  });
});

describe('csrf token verification', () => {
  async function makeSession(): Promise<Session> {
    return new SessionManager(new InMemorySessionStore()).create();
  }

  it('accepts the matching token', async () => {
    const session = await makeSession();
    assert.doesNotThrow(() => assertCsrfToken(session, session.csrfToken));
  });

  it('throws a structured AuthError on mismatch, missing, or non-string tokens', async () => {
    const session = await makeSession();
    for (const bad of [undefined, null, 123, 'wrong', session.csrfToken + 'x']) {
      assert.throws(
        () => assertCsrfToken(session, bad),
        (err: unknown) => {
          assert.ok(err instanceof AuthError);
          assert.equal(err.code, 'csrf-mismatch');
          assert.equal(err.status, 403);
          return true;
        },
      );
    }
  });
});
