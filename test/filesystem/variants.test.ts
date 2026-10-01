/**
 * Tests for the variants surface: key determinism, lazy materialization,
 * cache hits, and value-free errors for unknown variants, missing sources,
 * and transform failures.
 *
 * No external services required — everything runs against an in-memory disk.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createMemoryDisk, type Disk } from '../../src/filesystem/index.js';
import {
  VariantError,
  createVariantResolver,
  defineVariant,
  type VariantDescriptor,
  type VariantResolver,
} from '../../src/filesystem/variants.js';

/** Identity transform: returns bytes unchanged. */
function identity(input: Uint8Array): Uint8Array {
  return input;
}

/** Produces a text-based transform for readable assertions. */
function suffixText(input: Uint8Array, params: { suffix: string }): Uint8Array {
  return Buffer.from(`${Buffer.from(input).toString('utf8')}${params.suffix}`, 'utf8');
}

/** Create a resolver with the given variants and an in-memory disk. */
function setup(variants: Record<string, VariantDescriptor>): {
  disk: Disk;
  resolver: VariantResolver;
} {
  const disk = createMemoryDisk();
  const resolver = createVariantResolver({ disk, variants });
  return { disk, resolver };
}

// ---------------------------------------------------------------------------
// Key determinism
// ---------------------------------------------------------------------------

describe('variant key determinism', () => {
  it('produces the same key for the same source + variant', () => {
    const { resolver } = setup({
      thumb: defineVariant({ name: 'thumb', transform: identity, params: {} }),
    });

    const a = resolver.keyFor('photos/cat.jpg', 'thumb');
    const b = resolver.keyFor('photos/cat.jpg', 'thumb');

    assert.equal(a, b);
    assert.ok(a.startsWith('_variants/'), 'keys must use the _variants/ prefix');
    assert.equal(a.length, '_variants/'.length + 64, 'key is prefix + 64 hex chars (SHA-256)');
  });

  it('produces different keys for different source keys', () => {
    const { resolver } = setup({
      thumb: defineVariant({ name: 'thumb', transform: identity, params: {} }),
    });

    assert.notEqual(
      resolver.keyFor('photos/cat.jpg', 'thumb'),
      resolver.keyFor('photos/dog.jpg', 'thumb'),
    );
  });

  it('produces different keys for different variant names', () => {
    const { resolver } = setup({
      thumb: defineVariant({ name: 'thumb', transform: identity, params: {} }),
      large: defineVariant({ name: 'large', transform: identity, params: {} }),
    });

    assert.notEqual(
      resolver.keyFor('photos/cat.jpg', 'thumb'),
      resolver.keyFor('photos/cat.jpg', 'large'),
    );
  });

  it('produces different keys when params differ', () => {
    setup({
      suffixA: defineVariant({
        name: 'suffix',
        transform: suffixText,
        params: { suffix: '-a' },
      }),
      suffixB: defineVariant({
        name: 'suffix',
        transform: suffixText,
        params: { suffix: '-b' },
      }),
    });

    // Same source, same name, different params → different keys.
    // Because registry keys must be unique, we register under distinct names
    // but verify that different params on otherwise identical variants yield
    // different keys.
    const vA = defineVariant({ name: 'suffix', transform: suffixText, params: { suffix: '-x' } });
    const vB = defineVariant({ name: 'suffix', transform: suffixText, params: { suffix: '-y' } });

    const resolver2 = createVariantResolver({
      disk: createMemoryDisk(),
      variants: { 'suffix-x': vA, 'suffix-y': vB },
    });

    assert.notEqual(
      resolver2.keyFor('doc.txt', 'suffix-x'),
      resolver2.keyFor('doc.txt', 'suffix-y'),
    );
  });

  it('is stable — same inputs always produce the same hex digest', () => {
    const variants = {
      thumb: defineVariant({ name: 'thumb', transform: identity, params: { w: 100, h: 80 } }),
    };

    const r1 = createVariantResolver({ disk: createMemoryDisk(), variants });
    const r2 = createVariantResolver({ disk: createMemoryDisk(), variants });

    assert.equal(r1.keyFor('a/b.png', 'thumb'), r2.keyFor('a/b.png', 'thumb'));
  });
});

// ---------------------------------------------------------------------------
// Lazy materialization
// ---------------------------------------------------------------------------

describe('lazy materialization', () => {
  it('materializes on first resolve, returns cached key on second', async () => {
    let transformCalls = 0;
    const transform = (input: Uint8Array): Uint8Array => {
      transformCalls++;
      return Buffer.concat([input, Buffer.from('-variant')]);
    };

    const { disk, resolver } = setup({
      thumb: defineVariant({ name: 'thumb', transform, params: {} }),
    });

    await disk.put('a.txt', 'source-content');

    // First resolve — must materialize.
    const key1 = await resolver.resolve('a.txt', 'thumb');
    assert.equal(transformCalls, 1);

    // Verify the stored content.
    const stored = await disk.get(key1);
    assert.equal(Buffer.from(stored).toString('utf8'), 'source-content-variant');

    // Second resolve — must be a cache hit (no transform call).
    const key2 = await resolver.resolve('a.txt', 'thumb');
    assert.equal(transformCalls, 1, 'transform must not be called on cache hit');
    assert.equal(key1, key2);
  });

  it('keyFor returns the same key as resolve without materializing', async () => {
    const { disk, resolver } = setup({
      thumb: defineVariant({ name: 'thumb', transform: identity, params: {} }),
    });

    const key = resolver.keyFor('a.txt', 'thumb');
    assert.equal(await disk.exists(key), false, 'keyFor must not touch the disk');

    await disk.put('a.txt', 'data');
    const resolvedKey = await resolver.resolve('a.txt', 'thumb');
    assert.equal(key, resolvedKey);
  });

  it('handles async transforms', async () => {
    const { disk, resolver } = setup({
      delayed: defineVariant({
        name: 'delayed',
        transform: async (input: Uint8Array) => {
          await new Promise((r) => setTimeout(r, 5));
          return input;
        },
        params: {},
      }),
    });

    await disk.put('a.txt', 'async-test');
    const key = await resolver.resolve('a.txt', 'delayed');
    assert.equal(Buffer.from(await disk.get(key)).toString('utf8'), 'async-test');
  });

  it('re-materializes when the cached variant key is deleted', async () => {
    let transformCalls = 0;
    const transform = (input: Uint8Array): Uint8Array => {
      transformCalls++;
      return Buffer.concat([input, Buffer.from('-v2')]);
    };

    const { disk, resolver } = setup({
      thumb: defineVariant({ name: 'thumb', transform, params: {} }),
    });

    await disk.put('a.txt', 'src');

    const key1 = await resolver.resolve('a.txt', 'thumb');
    assert.equal(transformCalls, 1);

    // Delete the cached variant to simulate cache eviction.
    await disk.delete(key1);
    assert.equal(await disk.exists(key1), false);

    const key2 = await resolver.resolve('a.txt', 'thumb');
    assert.equal(transformCalls, 2, 'must re-transform after cache eviction');
    assert.equal(key1, key2);
  });
});

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

describe('variant errors', () => {
  it('rejects an unknown variant name with a value-free error', async () => {
    const { resolver } = setup({
      thumb: defineVariant({ name: 'thumb', transform: identity, params: {} }),
    });

    await assert.rejects(resolver.resolve('a.txt', 'nonexistent'), (error: unknown) => {
      assert.ok(error instanceof VariantError);
      assert.equal(error.code, 'unknown_variant');
      assert.equal(error.message, 'unknown variant');
      return true;
    });

    assert.throws(
      () => resolver.keyFor('a.txt', 'nonexistent'),
      (error: unknown) => {
        assert.ok(error instanceof VariantError);
        assert.equal(error.code, 'unknown_variant');
        return true;
      },
    );
  });

  it('rejects a missing source with a value-free error', async () => {
    const { resolver } = setup({
      thumb: defineVariant({ name: 'thumb', transform: identity, params: {} }),
    });

    await assert.rejects(resolver.resolve('missing-file.txt', 'thumb'), (error: unknown) => {
      assert.ok(error instanceof VariantError);
      assert.equal(error.code, 'missing_source');
      assert.ok(!error.message.includes('missing-file'), 'error must not echo the key');
      return true;
    });
  });

  it('rejects a failed transform with a value-free error', async () => {
    const { disk, resolver } = setup({
      broken: defineVariant({
        name: 'broken',
        transform: () => {
          throw new Error('boom');
        },
        params: {},
      }),
    });

    await disk.put('a.txt', 'data');

    await assert.rejects(resolver.resolve('a.txt', 'broken'), (error: unknown) => {
      assert.ok(error instanceof VariantError);
      assert.equal(error.code, 'transform_failed');
      assert.ok(!error.message.includes('boom'), 'error must not echo the original cause');
      return true;
    });
  });

  it('rejects an async transform that rejects', async () => {
    const { disk, resolver } = setup({
      broken: defineVariant({
        name: 'broken',
        transform: async () => {
          throw new Error('async-boom');
        },
        params: {},
      }),
    });

    await disk.put('a.txt', 'data');

    await assert.rejects(resolver.resolve('a.txt', 'broken'), (error: unknown) => {
      assert.ok(error instanceof VariantError);
      assert.equal(error.code, 'transform_failed');
      return true;
    });
  });

  it('error messages are value-free — no keys, paths, or data', async () => {
    const { resolver } = setup({
      thumb: defineVariant({ name: 'thumb', transform: identity, params: {} }),
    });

    const secretKey = 'super-secret-key.txt';

    for (const fn of [
      () => resolver.resolve(secretKey, 'unknown'),
      () => resolver.resolve(secretKey, 'thumb'),
      () => resolver.keyFor(secretKey, 'unknown'),
    ]) {
      try {
        await fn();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        assert.ok(
          !message.includes(secretKey),
          `error message must not contain the key: ${JSON.stringify(message)}`,
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// defineVariant validation
// ---------------------------------------------------------------------------

describe('defineVariant', () => {
  it('rejects an empty name', () => {
    assert.throws(
      () => defineVariant({ name: '', transform: identity, params: {} }),
      /variant name must be a non-empty string/,
    );
  });

  it('rejects a non-function transform', () => {
    assert.throws(
      () =>
        defineVariant({
          name: 'x',
          transform: 'not-a-function' as unknown as typeof identity,
          params: {},
        }),
      /variant transform must be a function/,
    );
  });

  it('returns the definition by identity', () => {
    const def = { name: 'thumb', transform: identity, params: {} as Record<string, unknown> };
    assert.equal(defineVariant(def), def);
  });

  it('accepts params of any shape', () => {
    const withMeta = defineVariant({
      name: 'meta',
      transform: identity,
      params: { width: 200, height: 150, format: 'webp' },
    });
    assert.deepEqual(withMeta.params, { width: 200, height: 150, format: 'webp' });
  });
});
