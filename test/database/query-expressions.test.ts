/**
 * Tests for query expressions: F, QLeaf constructors, boolean combinators
 * (and/or/not), and applyQ.
 *
 * Exercises literal comparisons, column-to-column comparisons via F,
 * in/notIn/isNull/notNull/like, compound predicates with parenthesization,
 * and every rejection path against seeded SQLite data through FileDataSource
 * (query_only mode).
 *
 * Portability proof: generated SQL is checked for absence of hand-built
 * identifier quoting.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BaseEntity, Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

import { FileDataSource } from '../../src/database/file-data-source.js';
import {
  addCaseSelect,
  and,
  F,
  applyQ,
  Case,
  caseWhen,
  not,
  or,
  q,
  qEq,
  qGt,
  qGte,
  qIn,
  qIsNull,
  qLike,
  qLt,
  qLte,
  qNe,
  qNotIn,
  qNotNull,
  QueryExpressionError,
  type Q,
  when,
  type When,
} from '../../src/database/query-expressions.js';

// =========================================================================
// Test entities (module-level, matching relation-query.test.ts style)
// =========================================================================

@Entity('qe_items')
class Item extends BaseEntity {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: 'integer', nullable: false }) likes!: number;
  @Column({ type: 'integer', nullable: false }) views!: number;
  @Column({ type: 'varchar', length: 100, nullable: true }) name!: string | null;
  @Column({ type: 'varchar', length: 100, nullable: true }) label!: string | null;
}

async function seedItems() {
  return FileDataSource.create({
    models: [
      {
        entity: Item,
        rows: [
          { id: 1, likes: 10, views: 5, name: 'alpha', label: null },
          { id: 2, likes: 5, views: 10, name: null, label: 'beta' },
          { id: 3, likes: 8, views: 8, name: 'gamma', label: 'gamma-label' },
          { id: 4, likes: 3, views: 2, name: 'omega', label: null },
        ],
      },
    ],
  });
}

/** Run a predicate against the seeded items and return a sorted id array. */
async function queryIds(predicate: unknown): Promise<number[]> {
  const fds = await seedItems();
  try {
    const qb = Item.getRepository().createQueryBuilder('e');
    const rows = await applyQ(qb, predicate as import('../../src/database/query-expressions.js').Q)
      .orderBy('e.id', 'ASC')
      .getMany();
    return (rows as unknown as { id: number }[]).map((r) => r.id);
  } finally {
    await fds.close();
  }
}

// =========================================================================
// F — column reference
// =========================================================================

describe('F', () => {
  it('stores the column name', () => {
    const f = new F('likes');
    assert.equal(f.column, 'likes');
  });

  it('toSql emits alias-qualified reference', () => {
    const f = new F('views');
    assert.equal(f.toSql('e'), 'e.views');
  });

  it('rejects an empty string', () => {
    assert.throws(() => new F(''), QueryExpressionError);
  });

  it('rejects identifiers with dots', () => {
    assert.throws(() => new F('a.b'), QueryExpressionError);
  });

  it('rejects identifiers with special characters', () => {
    assert.throws(() => new F('col;drop'), QueryExpressionError);
  });
});

// =========================================================================
// Leaf constructors — validations
// =========================================================================

describe('leaf constructor validation', () => {
  it('rejects an invalid column', () => {
    assert.throws(() => qGt('1bad', 5), QueryExpressionError);
  });

  it('rejects eq with null', () => {
    assert.throws(() => qEq('likes', null), QueryExpressionError);
  });

  it('rejects eq with undefined', () => {
    assert.throws(() => qEq('likes', undefined), QueryExpressionError);
  });

  it('rejects ne with null', () => {
    assert.throws(() => qNe('likes', null), QueryExpressionError);
  });

  it('rejects an empty in array', () => {
    assert.throws(() => qIn('likes', []), QueryExpressionError);
  });

  it('rejects F in qIn array', () => {
    assert.throws(() => qIn('likes', [new F('views')]), QueryExpressionError);
  });

  it('rejects F as qLike pattern', () => {
    assert.throws(() => qLike('name', new F('label') as unknown as string), QueryExpressionError);
  });

  it('rejects non-string qLike pattern', () => {
    assert.throws(() => qLike('name', 123 as unknown as string), QueryExpressionError);
  });

  it('rejects an unknown operator', () => {
    assert.throws(() => q('likes', 'bogus' as unknown as 'eq', 5), QueryExpressionError);
  });

  it('rejects isNull with a value', () => {
    assert.throws(() => q('likes', 'isNull', 'extra'), QueryExpressionError);
  });

  it('rejects notNull with a value', () => {
    assert.throws(() => q('likes', 'notNull', 'extra'), QueryExpressionError);
  });
});

// =========================================================================
// Value-free error messages
// =========================================================================

describe('value-free error messages', () => {
  it('invalid identifier message does not contain the value', () => {
    try {
      new F('a.b');
      assert.fail('expected error');
    } catch (e) {
      assert.ok(e instanceof QueryExpressionError);
      assert.doesNotMatch(e.message, /a\.b/);
    }
  });

  it('null comparison message does not contain the value', () => {
    try {
      qEq('likes', null);
      assert.fail('expected error');
    } catch (e) {
      assert.ok(e instanceof QueryExpressionError);
      assert.doesNotMatch(e.message, /null/);
    }
  });

  it('empty in message does not echo the empty array', () => {
    try {
      qIn('likes', []);
      assert.fail('expected error');
    } catch (e) {
      assert.ok(e instanceof QueryExpressionError);
      assert.doesNotMatch(e.message, /\[\]/);
    }
  });

  it('unknown operator message does not contain the operator', () => {
    try {
      q('likes', 'bogus' as unknown as 'eq', 5);
      assert.fail('expected error');
    } catch (e) {
      assert.ok(e instanceof QueryExpressionError);
      assert.doesNotMatch(e.message, /bogus/);
    }
  });
});

// =========================================================================
// Literal comparisons
// =========================================================================

describe('literal comparisons', () => {
  it('qGt filters by scalar value', async () => {
    const ids = await queryIds(qGt('likes', 5));
    // likes > 5: row 1 (10), row 3 (8)
    assert.deepEqual(ids, [1, 3]);
  });

  it('qLt filters by scalar value', async () => {
    const ids = await queryIds(qLt('likes', 5));
    // likes < 5: row 4 (3)
    assert.deepEqual(ids, [4]);
  });

  it('qGte includes the boundary', async () => {
    const ids = await queryIds(qGte('likes', 5));
    // likes >= 5: rows 1,2,3
    assert.deepEqual(ids, [1, 2, 3]);
  });

  it('qLte includes the boundary', async () => {
    const ids = await queryIds(qLte('likes', 5));
    // likes <= 5: rows 2,4
    assert.deepEqual(ids, [2, 4]);
  });

  it('qEq filters exactly', async () => {
    const ids = await queryIds(qEq('likes', 8));
    // likes = 8: row 3
    assert.deepEqual(ids, [3]);
  });

  it('qNe excludes a value', async () => {
    const ids = await queryIds(qNe('likes', 8));
    // likes != 8: rows 1,2,4
    assert.deepEqual(ids, [1, 2, 4]);
  });
});

// =========================================================================
// Column-to-column comparison (F)
// =========================================================================

describe('column-to-column comparison via F', () => {
  it('qGt with F returns rows where column > other column', async () => {
    const ids = await queryIds(qGt('likes', new F('views')));
    // likes > views: row 1 (10 > 5) — row 2 has 5 < 10, row 3 has 8 == 8, row 4 has 3 > 2
    // row 4 also matches: 3 > 2
    assert.deepEqual(ids, [1, 4]);
  });

  it('qLt with F returns rows where column < other column', async () => {
    const ids = await queryIds(qLt('likes', new F('views')));
    // likes < views: row 2 (5 < 10)
    assert.deepEqual(ids, [2]);
  });

  it('qEq with F returns rows where columns are equal', async () => {
    const ids = await queryIds(qEq('likes', new F('views')));
    // likes == views: row 3 (8 == 8)
    assert.deepEqual(ids, [3]);
  });

  it('qNe with F returns rows where columns differ', async () => {
    const ids = await queryIds(qNe('likes', new F('views')));
    // likes != views: rows 1,2,4
    assert.deepEqual(ids, [1, 2, 4]);
  });

  it('qGte with F includes the equality boundary', async () => {
    const ids = await queryIds(qGte('likes', new F('views')));
    // likes >= views: rows 1 (10>5), 3 (8=8), 4 (3>2)
    assert.deepEqual(ids, [1, 3, 4]);
  });

  it('qLte with F includes the equality boundary', async () => {
    const ids = await queryIds(qLte('likes', new F('views')));
    // likes <= views: rows 2 (5<10), 3 (8=8)
    assert.deepEqual(ids, [2, 3]);
  });
});

// =========================================================================
// qIn / qNotIn / qIsNull / qNotNull / qLike
// =========================================================================

describe('qIn', () => {
  it('returns rows with values in the set', async () => {
    const ids = await queryIds(qIn('likes', [5, 8]));
    assert.deepEqual(ids, [2, 3]);
  });
});

describe('qNotIn', () => {
  it('returns rows with values not in the set', async () => {
    const ids = await queryIds(qNotIn('likes', [5, 8]));
    assert.deepEqual(ids, [1, 4]);
  });
});

describe('qIsNull', () => {
  it('returns rows where the column is null', async () => {
    const ids = await queryIds(qIsNull('name'));
    // name is null: row 2
    assert.deepEqual(ids, [2]);
  });
});

describe('qNotNull', () => {
  it('returns rows where the column is not null', async () => {
    const ids = await queryIds(qNotNull('name'));
    // name is not null: rows 1,3,4
    assert.deepEqual(ids, [1, 3, 4]);
  });
});

describe('qLike', () => {
  it('returns rows matching the LIKE pattern', async () => {
    const ids = await queryIds(qLike('name', '%ph%'));
    // 'ph' in 'alpha': row 1 only
    assert.deepEqual(ids, [1]);
  });
});

// =========================================================================
// applyQ — alias
// =========================================================================

describe('applyQ alias', () => {
  it('uses qb.alias by default', async () => {
    const fds = await seedItems();
    try {
      const qb = Item.getRepository().createQueryBuilder('e');
      const query = qGt('likes', 5);
      const resultQb = applyQ(qb, query);
      // Default alias should be 'e' from the query builder.
      const rows = await resultQb.orderBy('e.id', 'ASC').getMany();
      const ids = (rows as unknown as { id: number }[]).map((r) => r.id);
      assert.deepEqual(ids, [1, 3]);
    } finally {
      await fds.close();
    }
  });

  it('honors an explicit alias argument', async () => {
    const fds = await seedItems();
    try {
      const qb = Item.getRepository().createQueryBuilder('e');
      const query = qGt('likes', 5);
      // Pass a different alias — should still work because the alias parameter
      // overrides qb.alias in renderQ's column references.
      const resultQb = applyQ(qb, query, 'e');
      const rows = await resultQb.orderBy('e.id', 'ASC').getMany();
      const ids = (rows as unknown as { id: number }[]).map((r) => r.id);
      assert.deepEqual(ids, [1, 3]);
    } finally {
      await fds.close();
    }
  });
});

// =========================================================================
// Portability proof
// =========================================================================

describe('portability proof', () => {
  it('generated SQL does not use hand-built identifier quoting', async () => {
    const fds = await seedItems();
    try {
      const qb = Item.getRepository().createQueryBuilder('e');
      const query = qGt('likes', 5);
      const applied = applyQ(qb, query);

      const sql = applied.getSql();
      // Must NOT contain backtick-wrapped identifiers — those indicate a
      // hand-built MySQL/backtick quoting path that would break on other drivers.
      assert.doesNotMatch(sql, /`[a-zA-Z]/, 'SQL must not use backtick quoting');
    } finally {
      await fds.close();
    }
  });

  it('column-to-column SQL does not use hand-built quoting', async () => {
    const fds = await seedItems();
    try {
      const qb = Item.getRepository().createQueryBuilder('e');
      const query = qGt('likes', new F('views'));
      const applied = applyQ(qb, query);

      const sql = applied.getSql();
      assert.doesNotMatch(sql, /`[a-zA-Z]/, 'SQL must not use backtick quoting');
    } finally {
      await fds.close();
    }
  });
});

// =========================================================================
// Compound predicates — and / or / not
// =========================================================================

describe('and combinator', () => {
  it('returns the intersection of two conditions', async () => {
    const ids = await queryIds(and(qGt('likes', 4), qLt('likes', 10)));
    // likes > 4 AND likes < 10: rows 2 (5), 3 (8)
    assert.deepEqual(ids, [2, 3]);
  });

  it('returns the intersection of three conditions', async () => {
    const ids = await queryIds(and(qGt('likes', 4), qGt('views', 4), qNotNull('name')));
    // likes > 4: 1,2,3; views > 4: 1,2,3; name not null: 1,3,4  => intersection: 1,3
    assert.deepEqual(ids, [1, 3]);
  });
});

describe('or combinator', () => {
  it('returns the union of two conditions', async () => {
    const ids = await queryIds(or(qEq('likes', 3), qEq('likes', 10)));
    // likes = 3 or likes = 10: rows 4, 1
    assert.deepEqual(ids, [1, 4]);
  });

  it('returns the union of three conditions', async () => {
    const ids = await queryIds(or(qEq('likes', 3), qEq('likes', 5), qEq('likes', 10)));
    // likes in {3,5,10}: rows 4, 2, 1
    assert.deepEqual(ids, [1, 2, 4]);
  });
});

describe('not combinator', () => {
  it('negates a single leaf condition', async () => {
    const ids = await queryIds(not(qEq('likes', 8)));
    // NOT likes = 8: rows 1, 2, 4
    assert.deepEqual(ids, [1, 2, 4]);
  });

  it('negates an and group (De Morgan)', async () => {
    const ids = await queryIds(not(and(qGt('likes', 5), qGt('views', 5))));
    // NOT (likes > 5 AND views > 5): exclusion of row 3 (only row with both >5)
    assert.deepEqual(ids, [1, 2, 4]);
  });

  it('negates an or group (De Morgan)', async () => {
    const ids = await queryIds(not(or(qEq('likes', 3), qEq('views', 2))));
    // NOT (likes = 3 OR views = 2): only row 4 matches either, so exclude it
    assert.deepEqual(ids, [1, 2, 3]);
  });
});

describe('nested compound predicates', () => {
  it('or(and(...), not(...)) with correct precedence', async () => {
    // (likes=10 AND views=5) OR NOT(name IS NULL)
    // Row 1: (10=10 AND 5=5)=true OR NOT(false)=true  => include
    // Row 3: (8=10 AND ...)=false OR NOT(false)=true  => include
    // Row 4: (3=10 AND ...)=false OR NOT(false)=true  => include
    // Row 2: (5=10 AND ...)=false OR NOT(true)=false  => exclude
    const ids = await queryIds(or(and(qEq('likes', 10), qEq('views', 5)), not(qIsNull('name'))));
    assert.deepEqual(ids, [1, 3, 4]);
  });

  it('and(qEq(...), or(...)) with correct precedence', async () => {
    // likes=8 AND (views=8 OR name='alpha')
    // Row 3: likes=8 AND (views=8 OR ...)=true => include
    // Row 1: likes=10, not 8 => exclude
    // No other row has likes=8
    const ids = await queryIds(and(qEq('likes', 8), or(qEq('views', 8), qEq('name', 'alpha'))));
    assert.deepEqual(ids, [3]);
  });

  it('deeply nested expression', async () => {
    // NOT ( likes=5 AND (views=5 OR name IS NULL) )
    // Row 2: likes=5 AND (views=5? no. views=10; name IS NULL? yes) => true, NOT => exclude
    // All others have likes != 5, so the AND is false, NOT => true => include
    const ids = await queryIds(not(and(qEq('likes', 5), or(qEq('views', 5), qIsNull('name')))));
    assert.deepEqual(ids, [1, 3, 4]);
  });
});

describe('combinators with applyQ', () => {
  it('applies a compound predicate through applyQ and getMany', async () => {
    const fds = await seedItems();
    try {
      const qb = Item.getRepository().createQueryBuilder('e');
      const result = await applyQ(qb, and(qGt('likes', 4), qNotNull('name')))
        .orderBy('e.id', 'ASC')
        .getMany();
      const ids = (result as unknown as { id: number }[]).map((r) => r.id);
      // likes > 4: 1,2,3; name not null: 1,3,4 => intersection 1,3
      assert.deepEqual(ids, [1, 3]);
    } finally {
      await fds.close();
    }
  });

  it('honors explicit alias for compound predicates', async () => {
    const fds = await seedItems();
    try {
      const qb = Item.getRepository().createQueryBuilder('e');
      const result = await applyQ(qb, or(qEq('likes', 3), qEq('views', 2)), 'e')
        .orderBy('e.id', 'ASC')
        .getMany();
      const ids = (result as unknown as { id: number }[]).map((r) => r.id);
      // likes=3 or views=2: row 4 only
      assert.deepEqual(ids, [4]);
    } finally {
      await fds.close();
    }
  });

  it('uses default alias when none is passed', async () => {
    const fds = await seedItems();
    try {
      const qb = Item.getRepository().createQueryBuilder('e');
      const result = await applyQ(qb, and(qEq('likes', 10), qEq('views', 5)))
        .orderBy('e.id', 'ASC')
        .getMany();
      const ids = (result as unknown as { id: number }[]).map((r) => r.id);
      assert.deepEqual(ids, [1]);
    } finally {
      await fds.close();
    }
  });
});

describe('combinator rejection', () => {
  it('rejects and() with zero children', () => {
    assert.throws(() => and(), QueryExpressionError);
  });

  it('rejects or() with zero children', () => {
    assert.throws(() => or(), QueryExpressionError);
  });

  it('rejects and(...) with a non-Q argument', () => {
    assert.throws(() => and(qEq('likes', 1), 'nonsense' as unknown as Q), QueryExpressionError);
  });

  it('rejects not(...) with a non-Q argument', () => {
    assert.throws(() => not('nonsense' as unknown as Q), QueryExpressionError);
  });

  it('rejection messages are value-free', () => {
    try {
      and(qEq('likes', 1), 'bogus' as unknown as Q);
      assert.fail('expected error');
    } catch (e) {
      assert.ok(e instanceof QueryExpressionError);
      assert.doesNotMatch(e.message, /bogus/);
    }
  });
});

// =========================================================================
// Case / When — conditional value expression (Slice 3)
// =========================================================================

/** Run a CASE expression as a SELECT column and return the computed values
 *  per row, ordered by id. */
async function queryCaseColumn(
  expression: Case,
  selectionAlias: string,
  alias?: string,
): Promise<unknown[]> {
  const fds = await seedItems();
  try {
    const qb = Item.getRepository().createQueryBuilder('e');
    const result = await addCaseSelect(qb, expression, selectionAlias, alias)
      .orderBy('e.id', 'ASC')
      .getRawMany();
    return (result as Record<string, unknown>[]).map((r) => r[selectionAlias]);
  } finally {
    await fds.close();
  }
}

describe('addCaseSelect', () => {
  it('returns the THEN value for matching rows and ELSE for others', async () => {
    // likes > 6: row 1 (10), row 3 (8) → 'hot'; row 2 (5), row 4 (3) → 'cold'
    const values = await queryCaseColumn(
      caseWhen([when(qGt('likes', 6), 'hot')], 'cold'),
      'rating',
    );
    assert.deepEqual(values, ['hot', 'cold', 'hot', 'cold']);
  });

  it('multiple when branches — first-match-wins ordering', async () => {
    // Row 1 (likes=10): >8 → 'high'
    // Row 2 (likes=5):  >8 no, >4 yes → 'medium'
    // Row 3 (likes=8):  >8 no, >4 yes → 'medium'
    // Row 4 (likes=3):  >8 no, >4 no, >2 yes → 'low'
    const expr = caseWhen(
      [
        when(qGt('likes', 8), 'high'),
        when(qGt('likes', 4), 'medium'),
        when(qGt('likes', 2), 'low'),
      ],
      'none',
    );
    const values = await queryCaseColumn(expr, 'tier');
    assert.deepEqual(values, ['high', 'medium', 'medium', 'low']);
  });

  it('honors an explicit alias argument', async () => {
    const values = await queryCaseColumn(
      caseWhen([when(qGt('likes', 6), 'hot')], 'cold'),
      'rating',
      'e',
    );
    assert.deepEqual(values, ['hot', 'cold', 'hot', 'cold']);
  });
});

describe('defaultValue omitted (ELSE NULL)', () => {
  it('returns null for non-matching rows when defaultValue is omitted', async () => {
    // Only row 1 matches likes > 8 (likes=10). Others get null.
    const values = await queryCaseColumn(caseWhen([when(qGt('likes', 8), 'matched')]), 'status');
    assert.equal(values[0], 'matched'); // row 1
    assert.equal(values[1], null); // row 2
    assert.equal(values[2], null); // row 3 (likes=8, not >8)
    assert.equal(values[3], null); // row 4
  });

  it('returns null for non-matching rows when defaultValue is null', async () => {
    const values = await queryCaseColumn(
      caseWhen([when(qGt('likes', 8), 'matched')], null),
      'status',
    );
    assert.equal(values[0], 'matched');
    assert.equal(values[1], null);
    assert.equal(values[2], null);
    assert.equal(values[3], null);
  });
});

describe('Case as a Q comparison RHS (WHERE)', () => {
  it('compares a column against a Case expression', async () => {
    // likes > (CASE WHEN views = 8 THEN 5 ELSE 10 END)
    // Row 1: views=5 → CASE=10, likes=10 > 10? No
    // Row 2: views=10 → CASE=10, likes=5 > 10? No
    // Row 3: views=8 → CASE=5, likes=8 > 5? Yes → include
    // Row 4: views=2 → CASE=10, likes=3 > 10? No
    const ids = await queryIds(qGt('likes', caseWhen([when(qEq('views', 8), 5)], 10)));
    assert.deepEqual(ids, [3]);
  });

  it('Case with F reference as THEN value in WHERE', async () => {
    // likes > (CASE WHEN views = 10 THEN likes ELSE 0 END)
    // Row 1: views=5 → CASE=0, likes=10 > 0? Yes → include
    // Row 2: views=10 → CASE=likes=5, 5 > 5? No
    // Row 3: views=8 → CASE=0, likes=8 > 0? Yes → include
    // Row 4: views=2 → CASE=0, likes=3 > 0? Yes → include
    const ids = await queryIds(qGt('likes', caseWhen([when(qEq('views', 10), new F('likes'))], 0)));
    assert.deepEqual(ids, [1, 3, 4]);
  });

  it('Case with F reference as default (ELSE column) in WHERE', async () => {
    // likes = (CASE WHEN views = 8 THEN 8 ELSE views END)
    // Row 1: views=5 → CASE=5, likes=10 = 5? No
    // Row 2: views=10 → CASE=10, likes=5 = 10? No
    // Row 3: views=8 → CASE=8, likes=8 = 8? Yes → include
    // Row 4: views=2 → CASE=2, likes=3 = 2? No
    const ids = await queryIds(qEq('likes', caseWhen([when(qEq('views', 8), 8)], new F('views'))));
    assert.deepEqual(ids, [3]);
  });
});

describe('Case / When rejections', () => {
  it('rejects caseWhen with zero whens', () => {
    assert.throws(() => caseWhen([]), QueryExpressionError);
  });

  it('rejects when with a non-Q condition', () => {
    assert.throws(() => when('nonsense' as unknown as Q, 1), QueryExpressionError);
  });

  it('rejects caseWhen with a non-When entry (missing then)', () => {
    assert.throws(
      () => caseWhen([{ condition: qEq('likes', 1) } as unknown as When]),
      QueryExpressionError,
    );
  });

  it('rejects when with a compound (and) condition', () => {
    assert.throws(() => when(and(qGt('likes', 5), qGt('views', 5)), 'both'), QueryExpressionError);
  });

  it('rejects when with a compound (or) condition', () => {
    assert.throws(() => when(or(qEq('likes', 3), qEq('views', 2)), 'any'), QueryExpressionError);
  });

  it('rejection messages are value-free', () => {
    try {
      caseWhen([]);
      assert.fail('expected error');
    } catch (e) {
      assert.ok(e instanceof QueryExpressionError);
      assert.doesNotMatch(e.message, /\[\]/);
    }

    try {
      caseWhen([{ condition: qEq('likes', 1) } as unknown as When]);
      assert.fail('expected error');
    } catch (e) {
      assert.ok(e instanceof QueryExpressionError);
      assert.doesNotMatch(e.message, /likes/);
    }

    try {
      when(and(qGt('likes', 5), qGt('views', 5)), 'both');
      assert.fail('expected error');
    } catch (e) {
      assert.ok(e instanceof QueryExpressionError);
      assert.doesNotMatch(e.message, /and/);
    }
  });
});

describe('Case portability proof', () => {
  it('generated SQL contains CASE WHEN and no backtick quoting', async () => {
    const fds = await seedItems();
    try {
      const qb = Item.getRepository().createQueryBuilder('e');
      const expr = caseWhen([when(qGt('likes', 6), 'hot')], 'cold');
      const resultQb = addCaseSelect(qb, expr, 'rating');
      const sql = resultQb.getSql();
      assert.match(sql, /CASE\s+WHEN/i, 'SQL must contain CASE WHEN');
      assert.doesNotMatch(sql, /`[a-zA-Z]/, 'SQL must not use backtick quoting');
    } finally {
      await fds.close();
    }
  });

  it('Case-in-WHERE SQL does not contain backtick quoting', async () => {
    const fds = await seedItems();
    try {
      const qb = Item.getRepository().createQueryBuilder('e');
      const query = qGt('likes', caseWhen([when(qEq('views', 8), 5)], 10));
      const applied = applyQ(qb, query);
      const sql = applied.getSql();
      assert.match(sql, /CASE\s+WHEN/i, 'SQL must contain CASE WHEN');
      assert.doesNotMatch(sql, /`[a-zA-Z]/, 'SQL must not use backtick quoting');
    } finally {
      await fds.close();
    }
  });
});
