/**
 * Server-component directive marker builder tests.
 *
 * Covers `src/server-components/directives.ts` in isolation: each builder returns
 * the correct attribute map; each rejects invalid input with a value-free
 * `ServerComponentRuntimeError`; `refAttrs` additionally rejects whitespace,
 * quotes, and angle brackets.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  confirmAttrs,
  ignoreAttrs,
  intersectAttrs,
  loadingTargetAttrs,
  refAttrs,
  showAttrs,
  sortAttrs,
  textAttrs,
} from '../../src/server-components/directives.js';

import {
  CONFIRM_ATTRIBUTE,
  IGNORE_ATTRIBUTE,
  INTERSECT_ATTRIBUTE,
  LOADING_TARGET_ATTRIBUTE,
  REF_ATTRIBUTE,
  SHOW_ATTRIBUTE,
  SORT_ATTRIBUTE,
  TEXT_ATTRIBUTE,
} from '../../src/server-components/protocol.js';

import { ServerComponentRuntimeError } from '../../src/server-components/runtime/value-errors.js';

/** Assert that `fn` throws a `ServerComponentRuntimeError` whose message does NOT
 *  contain `badValue`. When `badValue` is empty the `includes` check is skipped
 *  (every string includes the empty string). */
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

describe('confirmAttrs', () => {
  it('returns confirm attribute with value', () => {
    const attrs = confirmAttrs('Are you sure?');
    assert.deepStrictEqual(attrs, { [CONFIRM_ATTRIBUTE]: 'Are you sure?' });
  });

  it('rejects empty string', () => {
    assertRejectsValueFree(() => confirmAttrs(''), '');
  });

  it('rejects whitespace-only string', () => {
    assertRejectsValueFree(() => confirmAttrs('   '), '   ');
  });
});

describe('loadingTargetAttrs', () => {
  it('returns loading target attribute with value', () => {
    const attrs = loadingTargetAttrs('spinner');
    assert.deepStrictEqual(attrs, { [LOADING_TARGET_ATTRIBUTE]: 'spinner' });
  });

  it('rejects empty string', () => {
    assertRejectsValueFree(() => loadingTargetAttrs(''), '');
  });
});

describe('showAttrs', () => {
  it('returns show attribute with field name', () => {
    const attrs = showAttrs('isVisible');
    assert.deepStrictEqual(attrs, { [SHOW_ATTRIBUTE]: 'isVisible' });
  });

  it('rejects empty string', () => {
    assertRejectsValueFree(() => showAttrs(''), '');
  });
});

describe('textAttrs', () => {
  it('returns text attribute with field name', () => {
    const attrs = textAttrs('message');
    assert.deepStrictEqual(attrs, { [TEXT_ATTRIBUTE]: 'message' });
  });

  it('rejects empty string', () => {
    assertRejectsValueFree(() => textAttrs(''), '');
  });
});

describe('sortAttrs', () => {
  it('returns sort attribute with field name', () => {
    const attrs = sortAttrs('title');
    assert.deepStrictEqual(attrs, { [SORT_ATTRIBUTE]: 'title' });
  });

  it('rejects empty string', () => {
    assertRejectsValueFree(() => sortAttrs(''), '');
  });
});

describe('intersectAttrs', () => {
  it('returns intersect attribute with action name', () => {
    const attrs = intersectAttrs('lazyLoad');
    assert.deepStrictEqual(attrs, { [INTERSECT_ATTRIBUTE]: 'lazyLoad' });
  });

  it('rejects empty string', () => {
    assertRejectsValueFree(() => intersectAttrs(''), '');
  });
});

describe('refAttrs', () => {
  it('returns ref attribute with element id', () => {
    const attrs = refAttrs('my-element');
    assert.deepStrictEqual(attrs, { [REF_ATTRIBUTE]: 'my-element' });
  });

  it('rejects empty string', () => {
    assertRejectsValueFree(() => refAttrs(''), '');
  });

  it('rejects whitespace-only string', () => {
    assertRejectsValueFree(() => refAttrs('  '), '  ');
  });

  it('rejects string containing whitespace', () => {
    assertRejectsValueFree(() => refAttrs('my element'), 'my element');
  });

  it('rejects string containing double quote', () => {
    assertRejectsValueFree(() => refAttrs('my"element'), 'my"element');
  });

  it('rejects string containing angle bracket', () => {
    assertRejectsValueFree(() => refAttrs('my<element'), 'my<element');
  });

  it('rejects string containing control character', () => {
    assertRejectsValueFree(() => refAttrs('my\nelement'), 'my\nelement');
  });
});

describe('ignoreAttrs', () => {
  it('returns ignore attribute with empty value', () => {
    const attrs = ignoreAttrs();
    assert.deepStrictEqual(attrs, { [IGNORE_ATTRIBUTE]: '' });
  });
});
