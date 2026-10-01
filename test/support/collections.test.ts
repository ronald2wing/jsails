import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ArrError } from '../../src/support/collections.js';
import {
  Arr,
  chunk,
  clone,
  cloneDeep,
  compact,
  equals,
  flatten,
  flattenDeep,
  get,
  groupBy,
  has,
  keyBy,
  merge,
  omit,
  pick,
  pluck,
  range,
  set,
  sortBy,
  toSentence,
  unique,
  uniqueBy,
} from '../../src/support/collections.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assertValueFreeError(fn: () => unknown, offendingValue: string) {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof ArrError);
    assert.equal(err.code, 'invalid_argument');
    const message = err.message;
    assert.ok(!message.includes(offendingValue), `message should not echo input: ${message}`);
    return true;
  });
}

// ---------------------------------------------------------------------------
// keyBy
// ---------------------------------------------------------------------------

describe('keyBy', () => {
  it('indexes array by key function', () => {
    const items = [
      { id: 1, name: 'a' },
      { id: 2, name: 'b' },
    ];
    const result = keyBy(items, (x) => x.id);
    assert.deepEqual(result, { 1: items[0], 2: items[1] });
  });

  it('handles empty array', () => {
    assert.deepEqual(
      keyBy([], (x: { id: number }) => x.id),
      {},
    );
  });

  it('later duplicate keys overwrite earlier ones', () => {
    const items = [
      { id: 1, v: 'first' },
      { id: 1, v: 'second' },
    ];
    const result = keyBy(items, (x) => x.id);
    assert.equal(result[1]!.v, 'second');
  });

  it('throws value-free on non-array', () => {
    assertValueFreeError(() => keyBy(42 as unknown as [], String), '42');
  });
});

// ---------------------------------------------------------------------------
// pluck
// ---------------------------------------------------------------------------

describe('pluck', () => {
  it('extracts property values', () => {
    const items = [
      { id: 1, name: 'a' },
      { id: 2, name: 'b' },
    ];
    assert.deepEqual(pluck(items, 'name'), ['a', 'b']);
  });

  it('handles empty array', () => {
    const empty: { name: string }[] = [];
    assert.deepEqual(pluck(empty, 'name'), []);
  });

  it('throws value-free on non-array', () => {
    assertValueFreeError(() => pluck(undefined as unknown as { id: number }[], 'id'), 'undefined');
  });
});

// ---------------------------------------------------------------------------
// unique
// ---------------------------------------------------------------------------

describe('unique', () => {
  it('removes duplicate primitive values', () => {
    assert.deepEqual(unique([1, 2, 2, 3, 1, 3]), [1, 2, 3]);
  });

  it('removes duplicate strings', () => {
    assert.deepEqual(unique(['a', 'b', 'a', 'c']), ['a', 'b', 'c']);
  });

  it('handles empty array', () => {
    assert.deepEqual(unique([]), []);
  });

  it('throws value-free on non-array', () => {
    assertValueFreeError(() => unique('abc' as unknown as []), 'abc');
  });
});

// ---------------------------------------------------------------------------
// uniqueBy
// ---------------------------------------------------------------------------

describe('uniqueBy', () => {
  it('removes duplicates by key function', () => {
    const items = [
      { id: 1, v: 'a' },
      { id: 2, v: 'b' },
      { id: 1, v: 'a2' },
    ];
    const result = uniqueBy(items, (x) => x.id);
    assert.equal(result.length, 2);
    assert.equal(result[0]!.id, 1);
    assert.equal(result[1]!.id, 2);
  });

  it('throws value-free on non-array', () => {
    assertValueFreeError(() => uniqueBy(null as unknown as [], String), 'null');
  });
});

// ---------------------------------------------------------------------------
// flatten
// ---------------------------------------------------------------------------

describe('flatten', () => {
  it('flattens one level', () => {
    assert.deepEqual(flatten([1, [2, 3], [4]]), [1, 2, 3, 4]);
  });

  it('does not flatten deeply nested arrays', () => {
    assert.deepEqual(flatten([1, [2, [3, 4]]]), [1, 2, [3, 4]]);
  });

  it('handles empty array', () => {
    assert.deepEqual(flatten([]), []);
  });

  it('throws value-free on non-array', () => {
    assertValueFreeError(() => flatten({} as unknown as []), 'object');
  });
});

// ---------------------------------------------------------------------------
// flattenDeep
// ---------------------------------------------------------------------------

describe('flattenDeep', () => {
  it('flattens all nested levels', () => {
    assert.deepEqual(flattenDeep([1, [2, [3, [4]]]]), [1, 2, 3, 4]);
  });

  it('handles already flat array', () => {
    assert.deepEqual(flattenDeep([1, 2, 3]), [1, 2, 3]);
  });

  it('handles empty array', () => {
    assert.deepEqual(flattenDeep([]), []);
  });

  it('throws value-free on non-array', () => {
    assertValueFreeError(() => flattenDeep(false as unknown as []), 'false');
  });
});

// ---------------------------------------------------------------------------
// compact
// ---------------------------------------------------------------------------

describe('compact', () => {
  it('removes falsy values', () => {
    assert.deepEqual(compact([0, 1, false, 2, '', 3, null, undefined, 4]), [1, 2, 3, 4]);
  });

  it('handles empty array', () => {
    assert.deepEqual(compact([]), []);
  });

  it('throws value-free on non-array', () => {
    assertValueFreeError(() => compact('nope' as unknown as []), 'nope');
  });
});

// ---------------------------------------------------------------------------
// pick
// ---------------------------------------------------------------------------

describe('pick', () => {
  it('selects named keys from object', () => {
    const obj = { a: 1, b: 2, c: 3 };
    assert.deepEqual(pick(obj, ['a', 'c']), { a: 1, c: 3 });
  });

  it('ignores keys not in the object', () => {
    const obj = { a: 1 } as { a: number; b?: number };
    const result = pick(obj, ['a', 'b']);
    assert.deepEqual(result, { a: 1 });
  });

  it('handles empty keys array', () => {
    assert.deepEqual(pick({ a: 1 }, []), {});
  });

  it('throws value-free on non-object', () => {
    assertValueFreeError(() => pick(null as unknown as Record<string, unknown>, ['x']), 'null');
  });
});

// ---------------------------------------------------------------------------
// omit
// ---------------------------------------------------------------------------

describe('omit', () => {
  it('excludes named keys from object', () => {
    const obj = { a: 1, b: 2, c: 3 };
    assert.deepEqual(omit(obj, ['b']), { a: 1, c: 3 });
  });

  it('handles empty keys array', () => {
    assert.deepEqual(omit({ a: 1 }, []), { a: 1 });
  });

  it('throws value-free on non-object', () => {
    assertValueFreeError(() => omit(42 as unknown as Record<string, unknown>, ['x']), '42');
  });
});

// ---------------------------------------------------------------------------
// get
// ---------------------------------------------------------------------------

describe('get', () => {
  it('reads nested property by dot-path', () => {
    const obj = { a: { b: { c: 3 } } };
    assert.equal(get(obj, 'a.b.c'), 3);
  });

  it('returns undefined for missing path', () => {
    assert.equal(get({ a: 1 }, 'b.c'), undefined);
  });

  it('returns fallback for missing path', () => {
    assert.equal(get({ a: 1 }, 'b', 'fallback'), 'fallback');
  });

  it('returns undefined for null/undefined object', () => {
    assert.equal(get(null, 'a.b'), undefined);
    assert.equal(get(undefined, 'a.b'), undefined);
  });
});

// ---------------------------------------------------------------------------
// set
// ---------------------------------------------------------------------------

describe('set', () => {
  it('sets nested property by dot-path', () => {
    const obj = { a: { b: 2 } };
    set(obj, 'a.b', 99);
    assert.equal(obj.a.b, 99);
  });

  it('creates intermediate objects', () => {
    const obj: Record<string, unknown> = {};
    set(obj, 'x.y.z', 42);
    assert.deepEqual(obj, { x: { y: { z: 42 } } });
  });

  it('returns the same object reference', () => {
    const obj = { a: 1 };
    assert.equal(set(obj, 'b', 2), obj);
  });
});

// ---------------------------------------------------------------------------
// has
// ---------------------------------------------------------------------------

describe('has', () => {
  it('returns true for existing path', () => {
    assert.equal(has({ a: { b: 2 } }, 'a.b'), true);
  });

  it('returns false for missing path', () => {
    assert.equal(has({ a: 1 }, 'a.b'), false);
  });

  it('returns false for null object', () => {
    assert.equal(has(null, 'a'), false);
  });
});

// ---------------------------------------------------------------------------
// sortBy
// ---------------------------------------------------------------------------

describe('sortBy', () => {
  it('sorts by a single iteratee', () => {
    const items = [{ n: 3 }, { n: 1 }, { n: 2 }];
    const result = sortBy(items, (x) => x.n);
    assert.deepEqual(
      result.map((x) => x.n),
      [1, 2, 3],
    );
  });

  it('does not mutate the original array', () => {
    const items = [{ n: 3 }, { n: 1 }];
    const result = sortBy(items, (x) => x.n);
    assert.equal(items[0]!.n, 3);
    assert.equal(result[0]!.n, 1);
  });

  it('handles multiple criteria', () => {
    const items = [
      { a: 1, b: 2 },
      { a: 1, b: 1 },
      { a: 2, b: 0 },
    ];
    const result = sortBy(
      items,
      (x) => x.a,
      (x) => x.b,
    );
    assert.deepEqual(result[0], { a: 1, b: 1 });
    assert.deepEqual(result[1], { a: 1, b: 2 });
    assert.deepEqual(result[2], { a: 2, b: 0 });
  });

  it('throws value-free on non-array', () => {
    assertValueFreeError(() => sortBy('abc' as unknown as [], String), 'abc');
  });
});

// ---------------------------------------------------------------------------
// range
// ---------------------------------------------------------------------------

describe('range', () => {
  it('returns range from 0 to end (exclusive) with single arg', () => {
    assert.deepEqual(range(4), [0, 1, 2, 3]);
  });

  it('returns range from start to end (exclusive)', () => {
    assert.deepEqual(range(2, 5), [2, 3, 4]);
  });

  it('returns range with custom step', () => {
    assert.deepEqual(range(0, 10, 3), [0, 3, 6, 9]);
  });

  it('returns empty array when start equals end', () => {
    assert.deepEqual(range(3, 3), []);
  });

  it('handles negative step', () => {
    assert.deepEqual(range(5, 0, -1), [5, 4, 3, 2, 1]);
  });
});

// ---------------------------------------------------------------------------
// chunk
// ---------------------------------------------------------------------------

describe('chunk', () => {
  it('splits into even chunks', () => {
    assert.deepEqual(chunk([1, 2, 3, 4], 2), [
      [1, 2],
      [3, 4],
    ]);
  });

  it('handles remaining elements in last chunk', () => {
    assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  });

  it('returns empty array for empty input', () => {
    assert.deepEqual(chunk([], 3), []);
  });

  it('size larger than length returns single chunk', () => {
    assert.deepEqual(chunk([1, 2], 10), [[1, 2]]);
  });

  it('size 1 returns each element as own chunk', () => {
    assert.deepEqual(chunk([1, 2, 3], 1), [[1], [2], [3]]);
  });

  it('throws value-free on non-array', () => {
    assertValueFreeError(() => chunk({} as unknown as [], 2), 'object');
  });

  it('throws value-free on non-integer size', () => {
    assertValueFreeError(() => chunk([1, 2, 3], 1.5), '1.5');
  });

  it('throws value-free on zero size', () => {
    assertValueFreeError(() => chunk([1, 2], 0), '0');
  });

  it('throws value-free on negative size', () => {
    assertValueFreeError(() => chunk([1, 2], -1), '-1');
  });
});

// ---------------------------------------------------------------------------
// merge
// ---------------------------------------------------------------------------

describe('merge', () => {
  it('deep-merges multiple objects', () => {
    const result = merge<Record<string, unknown>>({ a: 1, b: { x: 1 } }, { b: { y: 2 }, c: 3 });
    assert.equal(result.a, 1);
    assert.equal((result.b as Record<string, number>).x, 1);
    assert.equal((result.b as Record<string, number>).y, 2);
    assert.equal(result.c, 3);
  });

  it('preserves existing keys (defu semantics — later sources do not overwrite)', () => {
    const result = merge<Record<string, unknown>>({ a: 1 }, { a: 2 });
    assert.equal(result.a, 1);
  });

  it('returns empty object for no arguments', () => {
    assert.deepEqual(merge(), {});
  });

  it('returns a new object', () => {
    const a = { x: 1 };
    const result = merge<Record<string, unknown>>(a, { y: 2 });
    assert.notEqual(result, a);
  });
});

// ---------------------------------------------------------------------------
// clone / cloneDeep
// ---------------------------------------------------------------------------

describe('clone', () => {
  it('returns an equal but independent copy', () => {
    const source = { a: 1, b: { c: 2 } };
    const result = clone(source);
    assert.deepEqual(result, source);
    assert.notEqual(result, source);
    assert.notEqual(result.b, source.b);
  });

  it('mutating the clone does not affect the source', () => {
    const source = { a: 1, b: { c: 2 } };
    const result = clone(source);
    result.a = 99;
    result.b.c = 99;
    assert.equal(source.a, 1);
    assert.equal(source.b.c, 2);
  });

  it('handles arrays', () => {
    const source: [number, [number, number]] = [1, [2, 3]];
    const result = clone(source);
    (result as number[])[0] = 99;
    (result[1] as number[])[0] = 99;
    assert.equal(source[0], 1);
    assert.equal(source[1][0], 2);
  });

  it('handles primitive values', () => {
    assert.equal(clone(42), 42);
    assert.equal(clone('hello'), 'hello');
    assert.equal(clone(null), null);
  });

  it('throws ArrError for non-cloneable value (function)', () => {
    assert.throws(
      () => clone(function test() {}),
      (err: unknown) => {
        assert.ok(err instanceof ArrError);
        assert.equal(err.code, 'invalid_argument');
        const msg = err.message;
        // value-free: must not echo the function source
        assert.ok(!msg.includes('function'));
        assert.ok(!msg.includes('test'));
        return true;
      },
    );
  });

  it('throws ArrError for non-cloneable value (Proxy)', () => {
    const proxy = new Proxy({}, {});
    assert.throws(
      () => clone(proxy),
      (err: unknown) => {
        assert.ok(err instanceof ArrError);
        assert.equal(err.code, 'invalid_argument');
        return true;
      },
    );
  });
});

describe('cloneDeep', () => {
  it('is the same function as clone', () => {
    assert.equal(cloneDeep, clone);
  });

  it('deep-clones nested objects', () => {
    const source = { a: { b: { c: 3 } } };
    const result = cloneDeep(source);
    assert.deepEqual(result, source);
    assert.notEqual(result.a.b, source.a.b);
  });
});

// ---------------------------------------------------------------------------
// equals
// ---------------------------------------------------------------------------

describe('equals', () => {
  it('returns true for deeply equal objects', () => {
    assert.equal(equals({ a: 1, b: { c: 2 } }, { a: 1, b: { c: 2 } }), true);
  });

  it('returns false for different objects', () => {
    assert.equal(equals({ a: 1 }, { a: 2 }), false);
  });

  it('returns true for deeply equal arrays', () => {
    assert.equal(equals([1, [2, 3]], [1, [2, 3]]), true);
  });

  it('returns false for different arrays', () => {
    assert.equal(equals([1, 2, 3], [1, 2, 4]), false);
  });

  it('returns true for primitives', () => {
    assert.equal(equals(42, 42), true);
    assert.equal(equals('hello', 'hello'), true);
  });

  it('returns false for different primitives', () => {
    assert.equal(equals(42, 43), false);
  });
});

// ---------------------------------------------------------------------------
// toSentence
// ---------------------------------------------------------------------------

describe('toSentence', () => {
  it('converts list to English sentence', () => {
    const result = toSentence(['a', 'b', 'c']);
    assert.ok(typeof result === 'string');
    assert.ok(result.includes('a'));
    assert.ok(result.includes('b'));
    assert.ok(result.includes('c'));
  });

  it('handles single item', () => {
    const result = toSentence(['only']);
    assert.equal(result, 'only');
  });

  it('handles two items', () => {
    const result = toSentence(['one', 'two']);
    assert.ok(result.includes('one'));
    assert.ok(result.includes('two'));
    assert.ok(result.length > 4); // more than just the words
  });

  it('handles empty array', () => {
    assert.equal(toSentence([]), '');
  });

  it('respects disjunction type', () => {
    const result = toSentence(['a', 'b', 'c'], { type: 'disjunction' });
    assert.ok(result.includes('a'));
    assert.ok(result.includes('b'));
    assert.ok(result.includes('c'));
  });

  it('throws value-free on non-array', () => {
    assertValueFreeError(() => toSentence(123 as unknown as []), '123');
  });
});

// ---------------------------------------------------------------------------
// groupBy
// ---------------------------------------------------------------------------

describe('groupBy', () => {
  it('groups items by key function', () => {
    const items = [
      { type: 'a', val: 1 },
      { type: 'b', val: 2 },
      { type: 'a', val: 3 },
    ];
    const result = groupBy(items, (x) => x.type);
    assert.deepEqual(result.a, [items[0], items[2]]);
    assert.deepEqual(result.b, [items[1]]);
  });

  it('handles empty array', () => {
    const result = groupBy([], (x: { id: number }) => x.id);
    assert.equal(Object.keys(result).length, 0);
  });

  it('returns groups for all items', () => {
    const items = [
      { cat: 'x', n: 1 },
      { cat: 'y', n: 2 },
      { cat: 'x', n: 3 },
    ];
    const result = groupBy(items, (x) => x.cat);
    assert.equal(result.x!.length, 2);
    assert.equal(result.y!.length, 1);
  });

  it('uses native Object.groupBy when available', () => {
    // Node 22+ has Object.groupBy; assert the function works correctly
    // (the implementation selects native vs es-toolkit at module load)
    const items = [
      { k: 1, v: 'a' },
      { k: 2, v: 'b' },
      { k: 1, v: 'c' },
    ];
    const result = groupBy(items, (x) => x.k);
    assert.equal(Object.keys(result).length, 2);
    assert.equal(result[1]!.length, 2);
    assert.equal(result[2]!.length, 1);
  });

  it('throws value-free on non-array', () => {
    assertValueFreeError(() => groupBy(null as unknown as [], String), 'null');
  });
});

// ---------------------------------------------------------------------------
// Arr namespace
// ---------------------------------------------------------------------------

describe('Arr namespace', () => {
  it('is frozen', () => {
    assert.ok(Object.isFrozen(Arr));
  });

  it('exports all functions', () => {
    const expected = [
      'chunk',
      'clone',
      'cloneDeep',
      'compact',
      'equals',
      'flatten',
      'flattenDeep',
      'get',
      'groupBy',
      'has',
      'keyBy',
      'merge',
      'omit',
      'pick',
      'pluck',
      'range',
      'set',
      'sortBy',
      'toSentence',
      'unique',
      'uniqueBy',
    ];
    for (const name of expected) {
      assert.ok(typeof (Arr as Record<string, unknown>)[name] === 'function', `Arr.${name}`);
    }
  });

  it('named exports equal namespace members', () => {
    assert.equal(Arr.chunk, chunk);
    assert.equal(Arr.clone, clone);
    assert.equal(Arr.cloneDeep, cloneDeep);
    assert.equal(Arr.flatten, flatten);
    assert.equal(Arr.merge, merge);
    assert.equal(Arr.toSentence, toSentence);
    assert.equal(Arr.groupBy, groupBy);
    assert.equal(Arr.equals, equals);
  });
});
