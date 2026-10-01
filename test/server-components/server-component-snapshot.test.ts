/**
 * Component snapshot signer tests.
 *
 * These tests cover `src/server-components/snapshot.ts` in isolation: key
 * validation, round-tripping, tamper rejection, expiry, scope checks, size and
 * depth bounds, prototype/plain-object/finiteness defenses, malformed tokens,
 * and value-free error messages. No state store, cookie, Valkey, or HTTP
 * transport is involved — the signer is pure relative to its key and options.
 */

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  createComponentSigner,
  SnapshotError,
  type ComponentSigner,
  type SnapshotPayloadWithoutExpiry,
} from '../../src/server-components/snapshot.js';

/** A 32-byte key (minimum allowed length). */
const KEY = '0123456789abcdef0123456789abcdef';

function makeSigner(
  overrides: Partial<Parameters<typeof createComponentSigner>[0]> = {},
): ComponentSigner {
  return createComponentSigner({ key: KEY, ...overrides });
}

/** A valid, minimal payload. */
function basePayload(overrides: Record<string, unknown> = {}): SnapshotPayloadWithoutExpiry {
  return {
    v: 1,
    component: 'Counter',
    id: 'instance-1',
    state: { count: 3, label: 'héllo 😀' },
    page: { path: '/counter', params: { id: '42' } },
    origin: 'https://example.com',
    subject: null,
    ...overrides,
  };
}

/** Cast a deliberately-invalid payload past the type checker. */
function invalid(payload: unknown): SnapshotPayloadWithoutExpiry {
  return payload as SnapshotPayloadWithoutExpiry;
}

/** Capture the message an error-throwing call produces, failing if it did not throw. */
function thrown(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected the call to throw');
}

/**
 * Build a validly-signed token for an arbitrary JSON document, replicating the
 * wire format (`base64url(JSON).base64url(HMAC-SHA256)`). This exercises
 * `verify`'s post-MAC structural defenses with payloads the signer itself
 * refuses to produce (forbidden keys, non-finite numbers, wrong version).
 */
function craftToken(json: string, key: string = KEY): string {
  const signKey = createHmac('sha256', Buffer.from(key, 'utf8'))
    .update('jsails.snapshot.sign.v1')
    .digest();
  const payload = Buffer.from(json, 'utf8');
  const signature = createHmac('sha256', signKey).update(payload).digest('base64url');
  return `${payload.toString('base64url')}.${signature}`;
}

describe('createComponentSigner key validation', () => {
  it('rejects missing or short keys', () => {
    assert.match(
      thrown(() => createComponentSigner({ key: '' })),
      /32 bytes/,
    );
    assert.match(
      thrown(() => createComponentSigner({ key: 'short' })),
      /32 bytes/,
    );
    assert.match(
      thrown(() => createComponentSigner({ key: new Uint8Array(31) })),
      /32 bytes/,
    );
    // The key is never generated: omitting it throws rather than defaulting.
    assert.match(
      thrown(() => createComponentSigner({} as never)),
      /key must be a string or Uint8Array/,
    );
  });

  it('accepts string and Uint8Array keys of at least 32 bytes', () => {
    assert.ok(createComponentSigner({ key: KEY }));
    assert.ok(createComponentSigner({ key: Buffer.alloc(32, 1) }));
    assert.ok(createComponentSigner({ key: new Uint8Array(64) }));
  });

  it('rejects invalid ttlMs and maxBytes', () => {
    assert.throws(() => createComponentSigner({ key: KEY, ttlMs: 0 }), SnapshotError);
    assert.throws(() => createComponentSigner({ key: KEY, ttlMs: -1 }), SnapshotError);
    assert.throws(() => createComponentSigner({ key: KEY, ttlMs: NaN }), SnapshotError);
    assert.throws(() => createComponentSigner({ key: KEY, maxBytes: 0 }), SnapshotError);
    assert.throws(() => createComponentSigner({ key: KEY, maxBytes: 1.5 }), SnapshotError);
  });
});

describe('round-trip', () => {
  it('preserves every field, including Unicode, across sign and verify', () => {
    const signer = makeSigner({ now: () => 1_000_000, ttlMs: 5000 });
    const payload = basePayload({
      component: 'Counter 😀',
      state: {
        count: 3,
        items: ['a', 'b'],
        nested: { flag: true, unicode: '你好 🌍', nothing: null },
      },
      page: { path: '/counter/detail', params: { id: '42', slug: 'héllo' } },
      revision: 7,
    });

    const token = signer.sign(payload);
    const verified = signer.verify(token);

    assert.equal(verified.v, 1);
    assert.equal(verified.component, 'Counter 😀');
    assert.equal(verified.id, 'instance-1');
    assert.deepEqual(verified.state, payload.state);
    assert.deepEqual(verified.page, {
      path: '/counter/detail',
      params: { id: '42', slug: 'héllo' },
    });
    assert.equal(verified.origin, 'https://example.com');
    assert.equal(verified.subject, null);
    assert.equal(verified.expiresAt, 1_000_000 + 5000);
    assert.equal(verified.revision, 7);
  });

  it('omits revision when absent', () => {
    const signer = makeSigner({ now: () => 0, ttlMs: 1000 });
    const verified = signer.verify(signer.sign(basePayload()));
    assert.equal('revision' in verified, false);
    assert.equal(verified.revision, undefined);
  });

  it('produces a two-part base64url token', () => {
    const token = makeSigner().sign(basePayload());
    const [payload, signature] = token.split('.');
    assert.ok(payload);
    assert.ok(signature);
    assert.match(payload, /^[A-Za-z0-9_-]+$/);
    assert.match(signature, /^[A-Za-z0-9_-]{43}$/);
  });
});

describe('tamper detection', () => {
  function flip(ch: string): string {
    return ch === 'A' ? 'B' : 'A';
  }

  it('rejects a flipped payload character', () => {
    const signer = makeSigner();
    const token = signer.sign(basePayload());
    const dot = token.indexOf('.');
    const tampered = `${flip(token[0]!)}${token.slice(1, dot)}.${token.slice(dot + 1)}`;
    assert.throws(() => signer.verify(tampered), SnapshotError);
  });

  it('rejects a flipped signature character', () => {
    const signer = makeSigner();
    const token = signer.sign(basePayload());
    const dot = token.indexOf('.');
    const signature = token.slice(dot + 1);
    const tampered = `${token.slice(0, dot + 1)}${flip(signature[0]!)}${signature.slice(1)}`;
    assert.throws(() => signer.verify(tampered), SnapshotError);
  });

  it('rejects a token signed by a different key', () => {
    const signer = makeSigner();
    const other = createComponentSigner({ key: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' });
    assert.throws(() => signer.verify(other.sign(basePayload())), SnapshotError);
  });
});

describe('expiry', () => {
  it('rejects at the exact expiry boundary', () => {
    let now = 0;
    const signer = makeSigner({ now: () => now, ttlMs: 1000 });
    const token = signer.sign(basePayload());
    assert.equal(signer.verify(token).expiresAt, 1000);

    now = 999;
    assert.ok(signer.verify(token));
    now = 1000;
    assert.throws(() => signer.verify(token), SnapshotError);
  });
});

describe('scope checks', () => {
  it('verifies component and origin when provided', () => {
    const signer = makeSigner();
    const token = signer.sign(basePayload());
    assert.ok(signer.verify(token, { component: 'Counter', origin: 'https://example.com' }));
    assert.throws(() => signer.verify(token, { component: 'Other' }), SnapshotError);
    assert.throws(() => signer.verify(token, { origin: 'https://evil.example' }), SnapshotError);
  });

  it('verifies subject scope when provided', () => {
    const signer = makeSigner();
    const tag = signer.subjectFor('session-raw-123')!;
    const token = signer.sign(basePayload({ subject: tag }));
    assert.ok(signer.verify(token, { subject: tag }));
    assert.throws(
      () => signer.verify(token, { subject: signer.subjectFor('other') }),
      SnapshotError,
    );
  });

  it('supports anonymous (null) subject scope', () => {
    const signer = makeSigner();
    const token = signer.sign(basePayload({ subject: null }));
    assert.equal(signer.verify(token, { subject: null }).subject, null);
    assert.throws(
      () => signer.verify(token, { subject: signer.subjectFor('someone') }),
      SnapshotError,
    );
  });
});

describe('subjectFor', () => {
  it('derives a stable, key-bound tag and never serializes the raw id', () => {
    const signer = makeSigner();
    const other = createComponentSigner({ key: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });

    const tag = signer.subjectFor('session-raw-123')!;
    assert.equal(tag, signer.subjectFor('session-raw-123'));
    assert.notEqual(tag, signer.subjectFor('session-raw-999'));
    assert.notEqual(tag, other.subjectFor('session-raw-123'));
    assert.match(tag, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(signer.subjectFor(null), null);

    const token = signer.sign(basePayload({ subject: tag }));
    assert.equal(token.includes('session-raw-123'), false);
    assert.equal(signer.verify(token, { subject: tag }).subject, tag);
  });

  it('rejects an empty or oversized subject id', () => {
    const signer = makeSigner();
    assert.throws(() => signer.subjectFor(''), SnapshotError);
    assert.throws(() => signer.subjectFor('x'.repeat(5000)), SnapshotError);
  });
});

describe('size and depth bounds', () => {
  it('rejects a payload that exceeds maxBytes at sign time', () => {
    const signer = createComponentSigner({ key: KEY, maxBytes: 1000 });
    assert.throws(
      () => signer.sign(basePayload({ state: { blob: 'x'.repeat(5000) } })),
      SnapshotError,
    );
  });

  it('accepts a payload within maxBytes', () => {
    const signer = createComponentSigner({ key: KEY, maxBytes: 100_000 });
    assert.ok(signer.sign(basePayload()));
  });

  it('rejects an oversized token before parsing', () => {
    const signer = createComponentSigner({ key: KEY, maxBytes: 1024 });
    const oversized = `${'A'.repeat(100_000)}.${'A'.repeat(43)}`;
    assert.throws(() => signer.verify(oversized), SnapshotError);
  });

  it('rejects state deeper than the maximum nesting depth', () => {
    const signer = makeSigner();
    let deep: unknown = { end: 1 };
    for (let i = 0; i < 200; i += 1) {
      deep = { nested: deep };
    }
    assert.throws(() => signer.sign(basePayload({ state: deep })), SnapshotError);
  });
});

describe('plain JSON and prototype defenses', () => {
  it('rejects a non-object state', () => {
    const signer = makeSigner();
    assert.throws(() => signer.sign(invalid({ ...basePayload(), state: [] })), SnapshotError);
    assert.throws(() => signer.sign(invalid({ ...basePayload(), state: 'x' })), SnapshotError);
    assert.throws(() => signer.sign(invalid({ ...basePayload(), state: null })), SnapshotError);
  });

  it('rejects forbidden own keys in state', () => {
    const signer = makeSigner();
    const proto = JSON.parse('{"__proto__": {"polluted": true}}');
    assert.throws(() => signer.sign(basePayload({ state: proto })), SnapshotError);
    assert.throws(() => signer.sign(basePayload({ state: { constructor: 1 } })), SnapshotError);
    assert.throws(() => signer.sign(basePayload({ state: { prototype: 1 } })), SnapshotError);
  });

  it('rejects non-finite numbers in state', () => {
    const signer = makeSigner();
    assert.throws(() => signer.sign(basePayload({ state: { n: NaN } })), SnapshotError);
    assert.throws(() => signer.sign(basePayload({ state: { n: Infinity } })), SnapshotError);
    assert.throws(() => signer.sign(basePayload({ state: { n: -Infinity } })), SnapshotError);
  });

  it('rejects non-JSON values in state', () => {
    const signer = makeSigner();
    assert.throws(() => signer.sign(basePayload({ state: { fn: () => {} } })), SnapshotError);
    assert.throws(() => signer.sign(basePayload({ state: { u: undefined } })), SnapshotError);
    assert.throws(() => signer.sign(basePayload({ state: { b: 1n } })), SnapshotError);
  });

  it('rejects a circular state reference', () => {
    const signer = makeSigner();
    const state: Record<string, unknown> = {};
    state.self = state;
    assert.throws(() => signer.sign(basePayload({ state })), SnapshotError);
  });

  it('verify rejects a validly-signed payload carrying a forbidden key', () => {
    const signer = makeSigner();
    const payload = { ...basePayload(), state: JSON.parse('{"__proto__": {"x": 1}}') };
    assert.throws(() => signer.verify(craftToken(JSON.stringify(payload))), SnapshotError);
  });

  it('verify rejects a validly-signed payload carrying a non-finite number', () => {
    const signer = makeSigner();
    const json =
      '{"v":1,"component":"Counter","id":"instance-1","state":{},' +
      '"page":{"path":"/counter","params":{}},"origin":"https://example.com",' +
      '"subject":null,"expiresAt":1e999}';
    assert.throws(() => signer.verify(craftToken(json)), SnapshotError);
  });

  it('verify rejects a validly-signed payload with an unsupported version', () => {
    const signer = makeSigner();
    assert.throws(
      () => signer.verify(craftToken(JSON.stringify(basePayload({ v: 2 })))),
      SnapshotError,
    );
  });
});

describe('sign validates the payload', () => {
  it('rejects invalid component, id, origin, page, and revision fields', () => {
    const signer = makeSigner();
    assert.throws(() => signer.sign(basePayload({ component: '   ' })), SnapshotError);
    assert.throws(() => signer.sign(basePayload({ id: '' })), SnapshotError);
    assert.throws(() => signer.sign(basePayload({ origin: 'not a url' })), SnapshotError);
    assert.throws(
      () => signer.sign(basePayload({ origin: 'https://example.com/path' })),
      SnapshotError,
    );
    assert.throws(() => signer.sign(basePayload({ origin: 'ftp://example.com' })), SnapshotError);
    assert.throws(
      () => signer.sign(basePayload({ page: { path: '../etc/passwd', params: {} } })),
      SnapshotError,
    );
    assert.throws(
      () => signer.sign(basePayload({ page: { path: '/ok\\evil', params: {} } })),
      SnapshotError,
    );
    assert.throws(
      () => signer.sign(basePayload({ page: { path: '//evil.example', params: {} } })),
      SnapshotError,
    );
    assert.throws(
      () => signer.sign(basePayload({ page: { path: '/ok', params: { n: 42 } } })),
      SnapshotError,
    );
    assert.throws(() => signer.sign(basePayload({ revision: 1.5 })), SnapshotError);
    assert.throws(() => signer.sign(basePayload({ revision: -1 })), SnapshotError);
  });
});

describe('malformed tokens', () => {
  it('rejects structurally invalid tokens', () => {
    const signer = makeSigner();
    const cases = ['', 'no-dot', 'a.b.c', '.sig', 'payload.', '!!!.sig', 'payload.!!!'];
    for (const candidate of cases) {
      assert.throws(() => signer.verify(candidate), SnapshotError, candidate);
    }
  });

  it('rejects a signature of the wrong length', () => {
    const signer = makeSigner();
    const token = signer.sign(basePayload());
    const payload = token.slice(0, token.indexOf('.'));
    assert.throws(() => signer.verify(`${payload}.${'A'.repeat(42)}`), SnapshotError);
  });
});

describe('value-free errors', () => {
  const KEY_MARKER = 'SECRET-KEY-MARKER-0123456789abcdefghijkl';
  const STATE_MARKER = 'SECRET-STATE-LEAK-MARKER';

  it('never echoes the key, state, or token', () => {
    const signer = createComponentSigner({ key: KEY_MARKER });
    const token = signer.sign(basePayload({ state: { secret: STATE_MARKER } }));

    const tampered = token.slice(0, -2) + 'AA';
    const verifyMessage = thrown(() => signer.verify(tampered));
    assert.equal(verifyMessage.includes(KEY_MARKER), false);
    assert.equal(verifyMessage.includes(STATE_MARKER), false);
    assert.equal(verifyMessage.includes(token), false);

    const tiny = createComponentSigner({ key: KEY_MARKER, maxBytes: 32 });
    const signMessage = thrown(() => tiny.sign(basePayload({ state: { secret: STATE_MARKER } })));
    assert.equal(signMessage.includes(STATE_MARKER), false);
    assert.equal(signMessage.includes(KEY_MARKER), false);

    const keyMessage = thrown(() => createComponentSigner({ key: 'x'.repeat(10) }));
    assert.equal(keyMessage.includes('xxxxxxxx'), false);
  });
});
