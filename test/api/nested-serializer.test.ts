import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { defineNestedSerializer, NestedSerializerError } from '../../src/api/nested-serializer.js';
import { defineSerializer } from '../../src/api/serialization.js';
import { integer, string, ValidationError } from '../../src/api/validation.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const authorSerializer = defineSerializer({
  id: { schema: integer(), readOnly: true },
  name: string({ min: 1 }),
});

const commentSerializer = defineSerializer({
  id: { schema: integer(), readOnly: true },
  body: string({ min: 1 }),
});

const postSerializer = defineSerializer({
  id: { schema: integer(), readOnly: true },
  title: string({ min: 1 }),
});

const nestedPost = defineNestedSerializer({
  base: postSerializer,
  relations: {
    author: { serializer: authorSerializer, key: 'authorId' },
    comments: { serializer: commentSerializer, key: 'commentIds' },
  },
});

// A base that declares the FK column readOnly, so the raw id stays visible
// until the relation is loaded and replaces it.
const postWithReadonlyFk = defineSerializer({
  id: { schema: integer(), readOnly: true },
  title: string({ min: 1 }),
  authorId: { schema: integer(), readOnly: true },
});

const nestedReadonlyFk = defineNestedSerializer({
  base: postWithReadonlyFk,
  relations: { author: { serializer: authorSerializer, key: 'authorId' } },
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('defineNestedSerializer', () => {
  it('serializes a parent by inlining loaded nested object(s)', () => {
    const representation = nestedPost.toRepresentation({
      id: 1,
      title: 'Hello',
      author: { id: 7, name: 'Ada', extra: 'must not leak' },
      comments: [
        { id: 1, body: 'first' },
        { id: 2, body: 'second' },
      ],
    });

    assert.deepEqual(representation, {
      id: 1,
      title: 'Hello',
      author: { id: 7, name: 'Ada' },
      comments: [
        { id: 1, body: 'first' },
        { id: 2, body: 'second' },
      ],
    });
  });

  it('parses nested input back to the flat FK/array columns', () => {
    const input = nestedPost.validate({
      title: 'Hello',
      author: { name: 'Ada' },
      comments: [{ body: 'first' }, { body: 'second' }],
    });

    assert.deepEqual(input, {
      title: 'Hello',
      authorId: { name: 'Ada' },
      commentIds: [{ body: 'first' }, { body: 'second' }],
    });
  });

  it('round-trips: nested write form survives serialize after a naive store round-trip', () => {
    const validated = nestedPost.validate({
      title: 'Hello',
      author: { name: 'Ada' },
      comments: [{ body: 'first' }],
    }) as Record<string, unknown>;

    // A naive store persists the flattened record, then returns it with the
    // relations re-loaded under their relation names.
    const stored = {
      id: 1,
      ...validated,
      author: { id: 7, name: 'Ada' },
      comments: [{ id: 1, body: 'first' }],
    };

    assert.deepEqual(nestedPost.toRepresentation(stored), {
      id: 1,
      title: 'Hello',
      author: { id: 7, name: 'Ada' },
      comments: [{ id: 1, body: 'first' }],
    });
  });

  it('skips absent relations under partial validation without fabricating keys', () => {
    const partial = nestedPost.validate({ title: 'Updated' }, { partial: true });

    assert.deepEqual(partial, { title: 'Updated' });
    assert.ok(!('authorId' in partial));
    assert.ok(!('commentIds' in partial));
  });

  it('defaults the relation key to the field name', () => {
    const inline = defineNestedSerializer({
      base: postSerializer,
      relations: { author: { serializer: authorSerializer } },
    });

    assert.deepEqual(inline.validate({ title: 'x', author: { name: 'Ada' } }), {
      title: 'x',
      author: { name: 'Ada' },
    });
    assert.deepEqual(inline.toRepresentation({ title: 'x', author: { id: 1, name: 'Ada' } }), {
      title: 'x',
      author: { id: 1, name: 'Ada' },
    });
  });

  it('maps a null relation to a null FK column', () => {
    const input = nestedPost.validate({ title: 'x', author: null });
    assert.deepEqual(input, { title: 'x', authorId: null });
  });

  it('replaces a readOnly FK column with the inlined object when loaded, keeps it otherwise', () => {
    // Not loaded: the flat readOnly FK id stays visible.
    const unloaded = nestedReadonlyFk.toRepresentation({
      id: 1,
      title: 'x',
      authorId: 5,
    }) as Record<string, unknown>;
    assert.deepEqual(unloaded, { id: 1, title: 'x', authorId: 5 });
    assert.ok(!('author' in unloaded));

    // Loaded: the FK column is dropped and the nested object inlined.
    const loaded = nestedReadonlyFk.toRepresentation({
      id: 1,
      title: 'x',
      authorId: 5,
      author: { id: 7, name: 'Ada' },
    }) as Record<string, unknown>;
    assert.deepEqual(loaded, { id: 1, title: 'x', author: { id: 7, name: 'Ada' } });
    assert.ok(!('authorId' in loaded));
  });

  it('rejects a nested object that fails its own validation', () => {
    assert.throws(() => nestedPost.validate({ title: 'x', author: { name: '' } }), ValidationError);
  });

  it('exposes the base serializer fields', () => {
    assert.equal(nestedPost.fields, postSerializer.fields);
  });

  it('throws a value-free NestedSerializerError for an empty relation name', () => {
    assert.throws(
      () =>
        defineNestedSerializer({
          base: postSerializer,
          relations: { '': { serializer: authorSerializer } },
        }),
      NestedSerializerError,
    );
  });

  it('throws a value-free NestedSerializerError for a missing serializer', () => {
    assert.throws(
      () =>
        defineNestedSerializer({
          base: postSerializer,
          relations: {
            author: { serializer: undefined as unknown as typeof authorSerializer },
          },
        }),
      NestedSerializerError,
    );
  });

  it('never echoes descriptor input in its error message', () => {
    const secret = 'secret-relation-name';
    try {
      defineNestedSerializer({
        base: postSerializer,
        relations: {
          [secret]: { serializer: undefined as unknown as typeof authorSerializer },
        },
      });
      assert.fail('expected a NestedSerializerError');
    } catch (error) {
      assert.ok(error instanceof NestedSerializerError);
      assert.ok(!error.message.includes(secret), `message must not echo input: ${error.message}`);
    }
  });
});
