import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MAX_PASSWORD_BYTES, hashPassword, verifyPassword } from '../src/auth/password.js';
import {
  AuthError,
  InMemorySessionStore,
  SessionManager,
  assertCsrfToken,
  parseSessionCookie,
  serializeSessionCookie,
} from '../src/auth/session.js';
import type { JsonObject, Session } from '../src/contracts/http.js';

/** Low-cost params so the suite stays fast; one test still exercises the default. */
const FAST = { N: 1024 };

/** A structurally well-formed encoded hash with zeroed salt/key (64-byte key). */
function enc(
  overrides: {
    algo?: string;
    version?: string;
    N?: string;
    r?: string;
    p?: string;
    salt?: string;
    key?: string;
  } = {},
): string {
  return [
    overrides.algo ?? 'scrypt',
    overrides.version ?? '1',
    overrides.N ?? '1024',
    overrides.r ?? '8',
    overrides.p ?? '1',
    overrides.salt ?? 'A'.repeat(22),
    overrides.key ?? 'A'.repeat(86),
  ].join('$');
}

describe('password hashing', () => {
  it('hashes and verifies a correct password', async () => {
    const hash = await hashPassword('correct horse battery staple', FAST);
    assert.equal(await verifyPassword('correct horse battery staple', hash), true);
  });

  it('rejects a wrong password', async () => {
    const hash = await hashPassword('right', FAST);
    assert.equal(await verifyPassword('wrong', hash), false);
  });

  it('uses the default cost parameters end-to-end', async () => {
    const hash = await hashPassword('default-cost', {});
    assert.equal(await verifyPassword('default-cost', hash), true);
  });

  it('salts each hash independently', async () => {
    const a = await hashPassword('same', FAST);
    const b = await hashPassword('same', FAST);
    assert.notEqual(a, b);
  });

  it('encodes a versioned, parameterized format', async () => {
    const hash = await hashPassword('pw', { N: 1024, r: 4, p: 2 });
    const parts = hash.split('$');
    assert.equal(parts.length, 7);
    assert.equal(parts[0], 'scrypt');
    assert.equal(parts[1], '1');
    assert.equal(parts[2], '1024');
    assert.equal(parts[3], '4');
    assert.equal(parts[4], '2');
  });

  it('rejects a constructed hash whose key does not match', async () => {
    assert.equal(await verifyPassword('pw', enc()), false);
  });

  it('returns false for malformed hashes instead of throwing', async () => {
    const malformed = [
      '', // empty
      'scrypt', // too few fields
      `bcrypt$1$1024$8$1${'$'.repeat(2)}`, // wrong algorithm
      enc({ version: '2' }), // unknown version
      enc({ N: '1048576' }), // N above trusted max (DoS bound)
      enc({ N: '1000' }), // N not a power of two
      enc({ N: '0' }), // N below minimum
      enc({ N: '3.5' }), // N not an integer
      enc({ r: '0' }), // r below minimum
      enc({ p: '99' }), // p above maximum
      enc({ salt: 'A'.repeat(21) }), // salt too short
      enc({ salt: 'A'.repeat(23) }), // salt too long
      enc({ salt: 'A'.repeat(21) + '!' }), // salt with invalid char
      enc({ key: 'A'.repeat(85) }), // key too short
      enc({ key: 'A'.repeat(87) }), // key too long
      'scrypt$1$1024$8$1$' + 'A'.repeat(22) + '$' + 'A'.repeat(86) + '$extra', // too many fields
    ];
    for (const candidate of malformed) {
      assert.equal(await verifyPassword('pw', candidate), false, `should reject: ${candidate}`);
    }
  });

  it('returns false for an oversized password', async () => {
    const oversized = 'a'.repeat(MAX_PASSWORD_BYTES + 1);
    assert.equal(await verifyPassword(oversized, enc()), false);
  });

  it('returns false for non-string inputs', async () => {
    assert.equal(await verifyPassword(123 as unknown as string, enc()), false);
    assert.equal(await verifyPassword('pw', 42 as unknown as string), false);
  });

  it('rejects invalid cost options when hashing', async () => {
    await assert.rejects(hashPassword('pw', { N: 1000 }), RangeError); // not power of two
    await assert.rejects(hashPassword('pw', { N: 1048576 }), RangeError); // above max
    await assert.rejects(hashPassword('pw', { N: 8 }), RangeError); // below min
    await assert.rejects(hashPassword('pw', { r: 0 }), RangeError);
    await assert.rejects(hashPassword('pw', { p: 99 }), RangeError);
  });

  it('rejects an oversized password when hashing', async () => {
    await assert.rejects(hashPassword('a'.repeat(MAX_PASSWORD_BYTES + 1), FAST), RangeError);
  });
});

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
