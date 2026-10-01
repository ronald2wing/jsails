import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseFilters } from '../../src/api/filters.js';
import { ValidationError } from '../../src/api/validation.js';

describe('advanced filters', () => {
  it('accumulates repeated filter[field][] values into an array', () => {
    const q = parseFilters(new URL('http://x/?filter[tag][]=a&filter[tag][]=b'), {
      fields: { tag: { type: 'string', operators: ['in'] } },
    });
    assert.deepEqual(q.filterClauses, [{ field: 'tag', operator: 'in', value: ['a', 'b'] }]);
  });

  it('parses an operator form filter[age][gt]=18', () => {
    const q = parseFilters(new URL('http://x/?filter[age][gt]=18'), {
      fields: { age: { type: 'integer', operators: ['gt'] } },
    });
    assert.deepEqual(q.filterClauses, [{ field: 'age', operator: 'gt', value: 18 }]);
  });

  it('rejects an operator not whitelisted for the field', () => {
    assert.throws(
      () =>
        parseFilters(new URL('http://x/?filter[age][gt]=18'), {
          fields: { age: { type: 'integer' } },
        }),
      ValidationError,
    );
  });

  it('enforces the filter count bound across accumulated values', () => {
    const params = new URLSearchParams();
    for (let i = 0; i < 40; i += 1) params.append('filter[t][]', String(i));
    assert.throws(
      () =>
        parseFilters(params, {
          fields: { t: { type: 'string', operators: ['in'] } },
          maxFilters: 32,
        }),
      ValidationError,
    );
  });
});
