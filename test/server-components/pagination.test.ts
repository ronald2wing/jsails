/**
 * Pagination helper tests for server components.
 *
 * Covers `src/server-components/pagination.ts` in isolation: boundaries,
 * correct call-attrs construction, max-page-size clamping, custom options,
 * and value-free error rejection for invalid options.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFAULT_MAX_PAGE_SIZE } from '../../src/api/pagination.js';
import type { Page } from '../../src/api/pagination.js';
import type { ServerComponentCallAttrs } from '../../src/server-components/component.js';
import { pagerAttrs } from '../../src/server-components/pagination.js';
import { ARGS_ATTRIBUTE, CALL_ATTRIBUTE } from '../../src/server-components/protocol.js';
import { ServerComponentRuntimeError } from '../../src/server-components/runtime/value-errors.js';

/** Build a mid-page fixture. */
function makePage(overrides: Partial<Page<unknown>> = {}): Page<unknown> {
  return {
    count: 50,
    results: [],
    page: 2,
    pageSize: 20,
    next: 3,
    previous: 1,
    ...overrides,
  };
}

/**
 * Assert that `fn` throws a `ServerComponentRuntimeError` whose message does
 * NOT contain `badValue`. When `badValue` is empty the leak check is skipped
 * (every string includes the empty string).
 */
function assertRejectsValueFree(fn: () => unknown, badValue: string): void {
  assert.throws(fn, (error: unknown) => {
    if (!(error instanceof ServerComponentRuntimeError)) {
      return false;
    }
    const { message } = error;
    if (badValue !== '' && message.includes(badValue)) {
      throw new Error(`error message leaked value: ${JSON.stringify(message)}`);
    }
    return true;
  });
}

describe('pagerAttrs', () => {
  it('returns null for both directions at the only-page boundary', () => {
    const page: Page<unknown> = {
      count: 5,
      results: [],
      page: 1,
      pageSize: 20,
      next: null,
      previous: null,
    };
    const { previous, next } = pagerAttrs(page);
    assert.strictEqual(previous, null);
    assert.strictEqual(next, null);
  });

  it('returns null for previous on the first page', () => {
    const page = makePage({ page: 1, previous: null, next: 2 });
    const { previous, next } = pagerAttrs(page);
    assert.strictEqual(previous, null);
    assert.notStrictEqual(next, null);
  });

  it('returns null for next on the last page', () => {
    const page = makePage({ page: 3, previous: 2, next: null });
    const { previous, next } = pagerAttrs(page);
    assert.notStrictEqual(previous, null);
    assert.strictEqual(next, null);
  });

  it('yields call attrs with the correct target page and pageSize', () => {
    const page = makePage({ page: 2, pageSize: 20, previous: 1, next: 3 });
    const { previous, next } = pagerAttrs(page) as {
      previous: ServerComponentCallAttrs;
      next: ServerComponentCallAttrs;
    };

    assert.strictEqual(previous[CALL_ATTRIBUTE], 'page');
    const prevArgs = JSON.parse(previous[ARGS_ATTRIBUTE]!);
    assert.deepStrictEqual(prevArgs, { page: 1, pageSize: 20 });

    assert.strictEqual(next[CALL_ATTRIBUTE], 'page');
    const nextArgs = JSON.parse(next[ARGS_ATTRIBUTE]!);
    assert.deepStrictEqual(nextArgs, { page: 3, pageSize: 20 });
  });

  it('clamps pageSize to the default maxPageSize when pageSize exceeds it', () => {
    const page = makePage({ pageSize: 200, previous: 1, next: 3 });
    const { previous, next } = pagerAttrs(page) as {
      previous: ServerComponentCallAttrs;
      next: ServerComponentCallAttrs;
    };

    const prevArgs = JSON.parse(previous[ARGS_ATTRIBUTE]!);
    assert.strictEqual(prevArgs.pageSize, DEFAULT_MAX_PAGE_SIZE);

    const nextArgs = JSON.parse(next[ARGS_ATTRIBUTE]!);
    assert.strictEqual(nextArgs.pageSize, DEFAULT_MAX_PAGE_SIZE);
  });

  it('clamps pageSize to a custom maxPageSize', () => {
    const page = makePage({ pageSize: 200, previous: 1, next: 3 });
    const { previous, next } = pagerAttrs(page, { maxPageSize: 50 }) as {
      previous: ServerComponentCallAttrs;
      next: ServerComponentCallAttrs;
    };

    const prevArgs = JSON.parse(previous[ARGS_ATTRIBUTE]!);
    assert.strictEqual(prevArgs.pageSize, 50);

    const nextArgs = JSON.parse(next[ARGS_ATTRIBUTE]!);
    assert.strictEqual(nextArgs.pageSize, 50);
  });

  it('uses custom action, pageField, and pageSizeField', () => {
    const page = makePage({ previous: 1, next: 3 });
    const { previous, next } = pagerAttrs(page, {
      action: 'navigate',
      pageField: 'p',
      pageSizeField: 'ps',
    }) as {
      previous: ServerComponentCallAttrs;
      next: ServerComponentCallAttrs;
    };

    assert.strictEqual(previous[CALL_ATTRIBUTE], 'navigate');
    const prevArgs = JSON.parse(previous[ARGS_ATTRIBUTE]!);
    assert.deepStrictEqual(prevArgs, { p: 1, ps: 20 });

    assert.strictEqual(next[CALL_ATTRIBUTE], 'navigate');
    const nextArgs = JSON.parse(next[ARGS_ATTRIBUTE]!);
    assert.deepStrictEqual(nextArgs, { p: 3, ps: 20 });
  });

  it('rejects an empty action', () => {
    assertRejectsValueFree(() => pagerAttrs(makePage(), { action: '' }), '');
  });

  it('rejects a whitespace-only action', () => {
    assertRejectsValueFree(() => pagerAttrs(makePage(), { action: '  ' }), '  ');
  });

  it('rejects an empty pageField', () => {
    assertRejectsValueFree(() => pagerAttrs(makePage(), { pageField: '' }), '');
  });

  it('rejects an empty pageSizeField', () => {
    assertRejectsValueFree(() => pagerAttrs(makePage(), { pageSizeField: '' }), '');
  });

  it('rejects a non-integer maxPageSize', () => {
    assertRejectsValueFree(() => pagerAttrs(makePage(), { maxPageSize: 1.5 }), '1.5');
  });

  it('rejects a zero maxPageSize', () => {
    assertRejectsValueFree(() => pagerAttrs(makePage(), { maxPageSize: 0 }), '0');
  });

  it('rejects a negative maxPageSize', () => {
    assertRejectsValueFree(() => pagerAttrs(makePage(), { maxPageSize: -1 }), '-1');
  });

  it('does not leak invalid maxPageSize in the error message', () => {
    assertRejectsValueFree(() => pagerAttrs(makePage(), { maxPageSize: NaN }), 'NaN');
  });
});
