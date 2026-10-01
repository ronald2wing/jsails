import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MigrationError } from '../../src/migrations/schema-types.js';
import {
  type DataMigration,
  defineDataMigration,
  createDataMigrationRegistry,
} from '../../src/migrations/data.js';

// ---------------------------------------------------------------------------
// defineDataMigration
// ---------------------------------------------------------------------------

describe('defineDataMigration', () => {
  it('creates a data migration with up and down handlers', () => {
    const dm = defineDataMigration({
      name: 'backfill',
      up: async () => {},
      down: async () => {},
    });
    assert.equal(dm.name, 'backfill');
    assert.equal(typeof dm.up, 'function');
    assert.equal(typeof dm.down, 'function');
  });

  it('rejects invalid identifiers', () => {
    assert.throws(
      () =>
        defineDataMigration({
          name: 'bad name',
          up: async () => {},
          down: async () => {},
        }),
      MigrationError,
    );
  });
});

// ---------------------------------------------------------------------------
// createDataMigrationRegistry
// ---------------------------------------------------------------------------

describe('createDataMigrationRegistry', () => {
  it('validates and indexes data migrations by name', () => {
    const a = defineDataMigration({
      name: 'a',
      up: () => Promise.resolve(),
      down: () => Promise.resolve(),
    });
    const b = defineDataMigration({
      name: 'b',
      up: () => Promise.resolve(),
      down: () => Promise.resolve(),
    });
    const registry = createDataMigrationRegistry({ a, b });
    assert.equal(registry.size, 2);
  });

  it('rejects a key that does not match the migration name', () => {
    const a = defineDataMigration({
      name: 'real',
      up: () => Promise.resolve(),
      down: () => Promise.resolve(),
    });
    assert.throws(() => createDataMigrationRegistry({ wrong: a }), /does not match/);
  });

  it('rejects duplicate names', () => {
    const a = defineDataMigration({
      name: 'dup',
      up: () => Promise.resolve(),
      down: () => Promise.resolve(),
    });
    // Use a type assertion so we can supply entries with different keys but the
    // same DataMigration object; the duplicate check fires on the name before
    // the key/name mismatch check.
    assert.throws(() => createDataMigrationRegistry({ dup: a, other_key: a }), /duplicate/);
  });

  it('rejects a migration without an up function', () => {
    assert.throws(
      () =>
        createDataMigrationRegistry({
          bad: { name: 'bad', down: () => Promise.resolve() } as unknown as DataMigration,
        }),
      /"up" function/,
    );
  });

  it('rejects a migration without a down function', () => {
    assert.throws(
      () =>
        createDataMigrationRegistry({
          bad: { name: 'bad', up: () => Promise.resolve() } as unknown as DataMigration,
        }),
      /"down" function/,
    );
  });
});
