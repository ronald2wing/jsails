import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type CheckDefinition,
  type ColumnDefinition,
  checksEqual,
  columnsEqual,
  normalizeCheck,
  normalizeColumn,
  normalizeSchemaState,
} from '../../src/migrations/schema-state.js';

function col(overrides: Partial<ColumnDefinition> & { name: string }): ColumnDefinition {
  return {
    name: overrides.name,
    type: overrides.type ?? 'integer',
    nullable: overrides.nullable ?? true,
    length: overrides.length,
    precision: overrides.precision,
    scale: overrides.scale,
    primaryKey: overrides.primaryKey,
    default: overrides.default,
  };
}

describe('new scalar types: normalization', () => {
  it('normalizes a decimal column with precision and scale', () => {
    const result = normalizeColumn(
      col({ name: 'price', type: 'decimal', precision: 10, scale: 2, nullable: false }),
    );
    assert.equal(result.type, 'decimal');
    assert.equal(result.precision, 10);
    assert.equal(result.scale, 2);
  });

  it('normalizes a decimal column with precision only (scale omitted)', () => {
    const result = normalizeColumn(
      col({ name: 'rating', type: 'decimal', precision: 5, nullable: true }),
    );
    assert.equal(result.type, 'decimal');
    assert.equal(result.precision, 5);
    assert.equal(result.scale, undefined);
  });

  it('rejects decimal without precision', () => {
    assert.throws(
      () => normalizeColumn(col({ name: 'price', type: 'decimal', nullable: false })),
      /requires a positive integer "precision"/,
    );
  });

  it('rejects scale > precision on decimal', () => {
    assert.throws(
      () =>
        normalizeColumn(
          col({ name: 'price', type: 'decimal', precision: 5, scale: 10, nullable: false }),
        ),
      /must not exceed "precision"/,
    );
  });

  it('rejects precision on non-decimal types', () => {
    for (const type of ['integer', 'float', 'bigint', 'uuid', 'json', 'date', 'time'] as const) {
      assert.throws(
        () => normalizeColumn(col({ name: 'x', type, precision: 5, nullable: true })),
        /may only declare "precision" when type is decimal/,
      );
    }
  });

  it('rejects scale on non-decimal types', () => {
    for (const type of ['integer', 'float', 'bigint', 'uuid', 'json', 'date', 'time'] as const) {
      assert.throws(
        () => normalizeColumn(col({ name: 'x', type, scale: 2, nullable: true })),
        /may only declare "scale" when type is decimal/,
      );
    }
  });

  it('rejects length on non-varchar types (new types included)', () => {
    for (const type of ['decimal', 'float', 'bigint', 'uuid', 'json', 'date', 'time'] as const) {
      assert.throws(
        () => normalizeColumn(col({ name: 'x', type, length: 10, nullable: true })),
        /may only declare "length" when type is varchar/,
      );
    }
  });

  it('normalizes float, bigint, uuid, json, date, time columns without extra fields', () => {
    const types = ['float', 'bigint', 'uuid', 'json', 'date', 'time'] as const;
    for (const type of types) {
      const result = normalizeColumn(col({ name: 'x', type, nullable: true }));
      assert.equal(result.type, type);
      assert.equal(result.length, undefined);
      assert.equal(result.precision, undefined);
      assert.equal(result.scale, undefined);
    }
  });

  it('accepts integer default on bigint column', () => {
    const result = normalizeColumn(
      col({ name: 'count', type: 'bigint', nullable: false, default: 0 }),
    );
    assert.equal(result.default, 0);
  });

  it('accepts number default on decimal column', () => {
    const result = normalizeColumn(
      col({ name: 'price', type: 'decimal', precision: 10, scale: 2, nullable: false, default: 0 }),
    );
    assert.equal(result.default, 0);
  });

  it('accepts string default on date column', () => {
    const result = normalizeColumn(
      col({ name: 'birth', type: 'date', nullable: true, default: '2024-01-15' }),
    );
    assert.equal(result.default, '2024-01-15');
  });

  it('rejects invalid date default format', () => {
    assert.throws(
      () =>
        normalizeColumn(
          col({ name: 'birth', type: 'date', nullable: true, default: '01/15/2024' }),
        ),
      /must be exactly "YYYY-MM-DD"/,
    );
  });

  it('rejects out-of-range year in date default', () => {
    assert.throws(
      () =>
        normalizeColumn(
          col({ name: 'birth', type: 'date', nullable: true, default: '0500-01-15' }),
        ),
      /outside the portable range 1000..9999/,
    );
  });

  it('accepts string default on time column', () => {
    const result = normalizeColumn(
      col({ name: 'opens_at', type: 'time', nullable: true, default: '09:00:00' }),
    );
    assert.equal(result.default, '09:00:00');
  });

  it('rejects invalid time default format', () => {
    assert.throws(
      () =>
        normalizeColumn(col({ name: 'opens_at', type: 'time', nullable: true, default: '9:00' })),
      /must be exactly "HH:MM:SS"/,
    );
  });

  it('accepts string default on uuid column', () => {
    const result = normalizeColumn(
      col({
        name: 'ref',
        type: 'uuid',
        nullable: true,
        default: '550e8400-e29b-41d4-a716-446655440000',
      }),
    );
    assert.equal(result.default, '550e8400-e29b-41d4-a716-446655440000');
  });

  it('accepts string, number, and boolean defaults on json column', () => {
    assert.equal(
      normalizeColumn(col({ name: 'meta', type: 'json', nullable: true, default: '{}' })).default,
      '{}',
    );
    assert.equal(
      normalizeColumn(col({ name: 'meta', type: 'json', nullable: true, default: 42 })).default,
      42,
    );
    assert.equal(
      normalizeColumn(col({ name: 'meta', type: 'json', nullable: true, default: true })).default,
      true,
    );
  });

  it('rejects object-like defaults on json column', () => {
    assert.throws(
      () =>
        normalizeColumn({
          name: 'meta',
          type: 'json',
          nullable: true,
          default: null as unknown as never,
        }),
      /does not match its type/,
    );
  });
});

describe('new scalar types: columnsEqual round-trip', () => {
  it('identical decimal columns are equal', () => {
    const a = normalizeColumn(
      col({ name: 'price', type: 'decimal', precision: 10, scale: 2, nullable: false }),
    );
    const b = normalizeColumn(
      col({ name: 'price', type: 'decimal', precision: 10, scale: 2, nullable: false }),
    );
    assert.ok(columnsEqual(a, b));
  });

  it('decimal columns with different precision are not equal', () => {
    const a = normalizeColumn(
      col({ name: 'price', type: 'decimal', precision: 10, scale: 2, nullable: false }),
    );
    const b = normalizeColumn(
      col({ name: 'price', type: 'decimal', precision: 8, scale: 2, nullable: false }),
    );
    assert.ok(!columnsEqual(a, b));
  });

  it('decimal columns with different scale are not equal', () => {
    const a = normalizeColumn(
      col({ name: 'price', type: 'decimal', precision: 10, scale: 2, nullable: false }),
    );
    const b = normalizeColumn(
      col({ name: 'price', type: 'decimal', precision: 10, scale: 4, nullable: false }),
    );
    assert.ok(!columnsEqual(a, b));
  });

  it('decimal with scale vs without scale are not equal', () => {
    const a = normalizeColumn(
      col({ name: 'price', type: 'decimal', precision: 10, scale: 2, nullable: false }),
    );
    const b = normalizeColumn(
      col({ name: 'price', type: 'decimal', precision: 10, nullable: false }),
    );
    assert.ok(!columnsEqual(a, b));
  });

  it('each new scalar type round-trips through normalizeColumn', () => {
    const types: ColumnDefinition[] = [
      col({ name: 'f', type: 'float', nullable: true }),
      col({ name: 'b', type: 'bigint', nullable: true }),
      col({ name: 'u', type: 'uuid', nullable: true }),
      col({ name: 'j', type: 'json', nullable: true }),
      col({ name: 'd', type: 'date', nullable: true }),
      col({ name: 't', type: 'time', nullable: true }),
      col({ name: 'p', type: 'decimal', precision: 10, scale: 2, nullable: false }),
    ];
    for (const column of types) {
      const normalized = normalizeColumn(column);
      assert.ok(columnsEqual(normalized, normalized));
    }
  });

  it('different types are not equal', () => {
    assert.ok(
      !columnsEqual(
        normalizeColumn(col({ name: 'x', type: 'float', nullable: true })),
        normalizeColumn(col({ name: 'x', type: 'bigint', nullable: true })),
      ),
    );
    assert.ok(
      !columnsEqual(
        normalizeColumn(col({ name: 'x', type: 'date', nullable: true })),
        normalizeColumn(col({ name: 'x', type: 'time', nullable: true })),
      ),
    );
  });
});

describe('new scalar types: schema-state round-trip', () => {
  it('normalizeSchemaState accepts tables with all new types', () => {
    const result = normalizeSchemaState({
      tables: [
        {
          name: 'products',
          columns: [
            { name: 'id', type: 'integer', nullable: false, primaryKey: true },
            { name: 'price', type: 'decimal', precision: 10, scale: 2, nullable: false },
            { name: 'rating', type: 'float', nullable: true },
            { name: 'sku', type: 'uuid', nullable: false },
            { name: 'tags', type: 'json', nullable: true },
            { name: 'release_date', type: 'date', nullable: true },
            { name: 'opens_at', type: 'time', nullable: true },
            { name: 'view_count', type: 'bigint', nullable: true },
          ],
        },
      ],
    });
    assert.equal(result.tables.length, 1);
    const columns = result.tables[0]!.columns;
    assert.equal(columns.length, 8);
    const types = columns.map((c) => c.type).sort();
    assert.deepEqual(types, [
      'bigint',
      'date',
      'decimal',
      'float',
      'integer',
      'json',
      'time',
      'uuid',
    ]);
  });
});

describe('check constraints', () => {
  it('normalizes a valid check constraint', () => {
    const result = normalizeCheck({ name: 'positive_price', expression: 'price > 0' });
    assert.equal(result.name, 'positive_price');
    assert.equal(result.expression, 'price > 0');
  });

  it('rejects a check with an invalid name', () => {
    assert.throws(() => normalizeCheck({ name: '', expression: 'x > 0' }), /invalid identifier/);
  });

  it('rejects a check with an empty expression', () => {
    assert.throws(
      () => normalizeCheck({ name: 'chk', expression: '' }),
      /check constraint "chk" must have a non-empty "expression" string/,
    );
  });

  it('rejects a missing expression', () => {
    assert.throws(
      () => normalizeCheck({ name: 'chk' } as unknown as CheckDefinition),
      /check constraint "chk" must have a non-empty "expression" string/,
    );
  });

  it('rejects a non-object', () => {
    assert.throws(
      () => normalizeCheck(null as unknown as CheckDefinition),
      /check constraint definition must be an object/,
    );
  });

  it('round-trips a check through normalize', () => {
    const a = normalizeCheck({ name: 'chk', expression: 'col > 0' });
    const b = normalizeCheck({ name: 'chk', expression: 'col > 0' });
    assert.equal(checksEqual(a, b), true);
  });

  it('detects unequal checks by expression', () => {
    const a = normalizeCheck({ name: 'chk', expression: 'col > 0' });
    const b = normalizeCheck({ name: 'chk', expression: 'col >= 0' });
    assert.equal(checksEqual(a, b), false);
  });

  it('detects unequal checks by name', () => {
    const a = normalizeCheck({ name: 'chk_a', expression: 'col > 0' });
    const b = normalizeCheck({ name: 'chk_b', expression: 'col > 0' });
    assert.equal(checksEqual(a, b), false);
  });

  it('preserves raw SQL expression verbatim', () => {
    // The expression is caller-owned and never validated/sanitized.
    const raw = "price BETWEEN 0 AND 1000 AND status != 'deleted'";
    const result = normalizeCheck({ name: 'valid_price', expression: raw });
    assert.equal(result.expression, raw);
  });

  it('normalizes checks into a table definition sorted by name', () => {
    const schema = normalizeSchemaState({
      tables: [
        {
          name: 'products',
          columns: [
            { name: 'id', type: 'integer', nullable: false, primaryKey: true },
            { name: 'price', type: 'integer', nullable: false },
          ],
          checks: [
            { name: 'z_price', expression: 'price > 0' },
            { name: 'a_range', expression: 'price < 1000' },
          ],
        },
      ],
    });
    const checks = schema.tables[0]!.checks;
    assert.ok(checks);
    assert.equal(checks.length, 2);
    assert.equal(checks[0]?.name, 'a_range');
    assert.equal(checks[1]?.name, 'z_price');
  });

  it('rejects duplicate check names on a table', () => {
    assert.throws(
      () =>
        normalizeSchemaState({
          tables: [
            {
              name: 't',
              columns: [{ name: 'x', type: 'integer', nullable: true }],
              checks: [
                { name: 'chk', expression: 'x > 0' },
                { name: 'chk', expression: 'x < 10' },
              ],
            },
          ],
        }),
      /declares more than one check constraint named "chk"/,
    );
  });
});
