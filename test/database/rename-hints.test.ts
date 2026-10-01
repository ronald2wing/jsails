import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { BaseEntity } from 'typeorm';

import { clearModelRegistry, registeredModels } from '../../src/database/model-registry.js';
import { buildRenameHints, buildRenameHintsFromRegistry } from '../../src/database/rename-hints.js';
import { defineModel } from '../../src/models/define-model.js';
import type { ModelSpec } from '../../src/models/define-model.js';

function spec(overrides: Partial<ModelSpec> = {}): ModelSpec {
  return {
    table: 'post',
    primaryKey: { name: 'id', kind: 'integer' },
    columns: [],
    relations: [],
    ...overrides,
  };
}

afterEach(() => {
  clearModelRegistry();
});

describe('buildRenameHints', () => {
  it('maps a column marker to { table, from, to }', () => {
    const hints = buildRenameHints([
      spec({ columns: [{ name: 'title', type: 'varchar', length: 255, renamedFrom: 'headline' }] }),
    ]);
    assert.deepEqual(hints, [{ table: 'post', from: 'headline', to: 'title' }]);
  });

  it('maps a many-to-one marker to the join column', () => {
    class Author extends BaseEntity {
      declare id: number;
    }
    const hints = buildRenameHints([
      spec({
        relations: [
          {
            kind: 'many-to-one',
            name: 'author',
            target: Author,
            joinColumn: 'author_id',
            renamedFrom: 'writer_id',
          },
        ],
      }),
    ]);
    assert.deepEqual(hints, [{ table: 'post', from: 'writer_id', to: 'author_id' }]);
  });

  it('derives the FK name when a many-to-one relation has no join column', () => {
    class Author extends BaseEntity {
      declare id: number;
    }
    const hints = buildRenameHints([
      spec({
        relations: [
          { kind: 'many-to-one', name: 'author', target: Author, renamedFrom: 'writer_id' },
        ],
      }),
    ]);
    assert.deepEqual(hints, [{ table: 'post', from: 'writer_id', to: 'author_id' }]);
  });

  it('skips a one-to-many marker (no owning column)', () => {
    class Comment extends BaseEntity {
      declare id: number;
    }
    const hints = buildRenameHints([
      spec({
        relations: [
          { kind: 'one-to-many', name: 'comments', target: Comment, renamedFrom: 'old_comments' },
        ],
      }),
    ]);
    assert.deepEqual(hints, []);
  });

  it('returns [] for empty specs', () => {
    assert.deepEqual(buildRenameHints([]), []);
  });

  it('returns [] for a spec with no markers', () => {
    assert.deepEqual(
      buildRenameHints([spec({ columns: [{ name: 'title', type: 'varchar', length: 255 }] })]),
      [],
    );
  });

  it('emits in deterministic order: specs, then columns before relations', () => {
    class Author extends BaseEntity {
      declare id: number;
    }
    const hints = buildRenameHints([
      spec({
        columns: [{ name: 'title', type: 'varchar', length: 255, renamedFrom: 'headline' }],
        relations: [
          {
            kind: 'many-to-one',
            name: 'author',
            target: Author,
            joinColumn: 'author_id',
            renamedFrom: 'writer_id',
          },
        ],
      }),
    ]);
    assert.deepEqual(hints, [
      { table: 'post', from: 'headline', to: 'title' },
      { table: 'post', from: 'writer_id', to: 'author_id' },
    ]);
  });
});

describe('defineModel → registry → buildRenameHintsFromRegistry', () => {
  it('round-trips the spec and surfaces rename hints from the registry', () => {
    class Post extends BaseEntity {
      declare id: number;
      declare title: string;
    }

    const modelSpec = spec({
      columns: [{ name: 'title', type: 'varchar', length: 255, renamedFrom: 'headline' }],
    });
    defineModel(Post, modelSpec);

    assert.equal(registeredModels()[0]?.spec, modelSpec);
    assert.deepEqual(buildRenameHintsFromRegistry(), [
      { table: 'post', from: 'headline', to: 'title' },
    ]);
  });
});
