/**
 * Unit tests for `src/server-components/url-binding.ts` — the pure
 * `seedFromUrl` function and its `schemaKind` logic.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { z } from 'zod';

import { seedFromUrl } from '../../src/server-components/url-binding.js';
import type { ServerComponentState } from '../../src/server-components/component.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function urlWith(params: Record<string, string>): URL {
  const url = new URL('http://localhost/page');
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url;
}

// ---------------------------------------------------------------------------
// seedFromUrl
// ---------------------------------------------------------------------------

describe('seedFromUrl', () => {
  it('seeds a string field verbatim from the query string', () => {
    const schema = z.object({ title: z.string() }).strict();
    const state = { title: 'default' };
    const url = urlWith({ title: 'from-url' });
    const result = seedFromUrl(state, schema, url, new Set(['title']));
    assert.equal(result.title, 'from-url');
  });

  it('leaves state untouched when the declared field is absent from the query', () => {
    const schema = z.object({ title: z.string() }).strict();
    const state = { title: 'default' };
    const url = urlWith({});
    const result = seedFromUrl(state, schema, url, new Set(['title']));
    assert.equal(result.title, 'default');
  });

  it('coerces a numeric string to a number', () => {
    const schema = z.object({ count: z.number() }).strict();
    const state = { count: 0 };
    const url = urlWith({ count: '42' });
    const result = seedFromUrl(state, schema, url, new Set(['count']));
    assert.equal(result.count, 42);
    assert.equal(typeof result.count, 'number');
  });

  it('skips a NaN coercible number field', () => {
    const schema = z.object({ count: z.number() }).strict();
    const state = { count: 0 };
    const url = urlWith({ count: 'not-a-number' });
    const result = seedFromUrl(state, schema, url, new Set(['count']));
    assert.equal(result.count, 0);
  });

  it('coerces "true" to boolean true', () => {
    const schema = z.object({ active: z.boolean() }).strict();
    const state = { active: false };
    const result = seedFromUrl(state, schema, urlWith({ active: 'true' }), new Set(['active']));
    assert.equal(result.active, true);
  });

  it('coerces "false" to boolean false', () => {
    const schema = z.object({ active: z.boolean() }).strict();
    const state = { active: true };
    const result = seedFromUrl(state, schema, urlWith({ active: 'false' }), new Set(['active']));
    assert.equal(result.active, false);
  });

  it('skips garbage boolean input (not "true"/"false")', () => {
    const schema = z.object({ active: z.boolean() }).strict();
    const state = { active: true };
    const result = seedFromUrl(state, schema, urlWith({ active: 'yes' }), new Set(['active']));
    assert.equal(result.active, true);
  });

  it('skips enum fields silently (unsupported schema kind)', () => {
    const schema = z.object({ role: z.enum(['admin', 'user']) }).strict();
    const state: ServerComponentState = { role: 'user' };
    const result = seedFromUrl(state, schema, urlWith({ role: 'admin' }), new Set(['role']));
    assert.equal(result.role, 'user');
  });

  it('skips object fields silently', () => {
    const schema = z.object({ meta: z.object({ x: z.number() }) }).strict();
    const state = { meta: { x: 1 } };
    const result = seedFromUrl(state, schema, urlWith({ meta: '{"x":2}' }), new Set(['meta']));
    assert.deepEqual(result.meta, { x: 1 });
  });

  it('seeds an optional string field (optional wrapper unwraps to ZodString)', () => {
    // z.string().optional() is ZodOptional<ZodString> — the base type is still
    // ZodString, so seeding from the URL is valid.
    const schema = z.object({ name: z.string().optional() }).strict();
    const state: ServerComponentState = { name: 'default' };
    const result = seedFromUrl(state, schema, urlWith({ name: 'override' }), new Set(['name']));
    assert.equal(result.name, 'override');
  });

  it('does NOT mutate the original state object (shallow copy)', () => {
    const schema = z.object({ title: z.string() }).strict();
    const state = { title: 'original' };
    const result = seedFromUrl(state, schema, urlWith({ title: 'seeded' }), new Set(['title']));
    assert.equal(state.title, 'original');
    assert.equal(result.title, 'seeded');
    assert.notStrictEqual(state, result);
  });

  it('returns the same object reference when no fields are seeded', () => {
    const schema = z.object({ title: z.string() }).strict();
    const state = { title: 'original' };
    // No matching fields in urlBinding set.
    const result = seedFromUrl(state, schema, urlWith({}), new Set(['title']));
    assert.strictEqual(state, result);
  });

  it('does not throw on a hostile query string (empty, missing, weird)', () => {
    const schema = z.object({ count: z.number() }).strict();
    const state = { count: 0 };

    // Missing param.
    assert.doesNotThrow(() => {
      seedFromUrl(state, schema, urlWith({}), new Set(['count']));
    });

    // Garbage value.
    assert.doesNotThrow(() => {
      seedFromUrl(state, schema, urlWith({ count: 'garbage!' }), new Set(['count']));
    });

    // Empty string for number.
    assert.doesNotThrow(() => {
      seedFromUrl(state, schema, urlWith({ count: '' }), new Set(['count']));
    });
  });

  it('seeds multiple fields when all are declarable', () => {
    const schema = z.object({ title: z.string(), count: z.number(), active: z.boolean() }).strict();
    const state = { title: 'x', count: 0, active: false };
    const result = seedFromUrl(
      state,
      schema,
      urlWith({ title: 'seeded', count: '10', active: 'true' }),
      new Set(['title', 'count', 'active']),
    );
    assert.equal(result.title, 'seeded');
    assert.equal(result.count, 10);
    assert.equal(result.active, true);
  });

  it('seeds only declared fields, leaving unrelated fields alone', () => {
    const schema = z.object({ title: z.string(), note: z.string() }).strict();
    const state = { title: 't', note: 'n' };
    const result = seedFromUrl(state, schema, urlWith({ title: 'seeded' }), new Set(['title']));
    assert.equal(result.title, 'seeded');
    assert.equal(result.note, 'n');
  });

  it('seeds a z.coerce.number() field (direct ZodNumber instance in Zod 4)', () => {
    const schema = z.object({ count: z.coerce.number() }).strict();
    const state = { count: 0 };
    const result = seedFromUrl(state, schema, urlWith({ count: '7' }), new Set(['count']));
    assert.equal(result.count, 7);
    assert.equal(typeof result.count, 'number');
  });

  it('seeds a z.coerce.boolean() field', () => {
    const schema = z.object({ flag: z.coerce.boolean() }).strict();
    const state = { flag: false };
    const result = seedFromUrl(state, schema, urlWith({ flag: 'true' }), new Set(['flag']));
    assert.equal(result.flag, true);
  });

  it('does not throw when urlBinding references a field not in the schema', () => {
    const schema = z.object({ title: z.string() }).strict();
    const state = { title: 'default' };
    // schemaKind returns 'other' for undefined, so it is silently skipped.
    assert.doesNotThrow(() => {
      seedFromUrl(state, schema, urlWith({ missing: 'x' }), new Set(['missing']));
    });
  });

  it('returns the state unchanged for an empty fields set', () => {
    const schema = z.object({ title: z.string() }).strict();
    const state = { title: 'x' };
    const result = seedFromUrl(state, schema, urlWith({ title: 'override' }), new Set());
    assert.strictEqual(state, result);
  });
});
