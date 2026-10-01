import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { CompilerErrorCode } from '../../src/compiler/errors.js';
import { lowerDirective, type DirectiveReporter } from '../../src/compiler/directives.js';

/**
 * Create a directive reporter that captures the last reported error. Success
 * tests pass a no-op reporter so they don't accidentally wait for a throw.
 */
function captureReporter(): {
  reported: { code: CompilerErrorCode; message: string; subject: string }[];
  report: DirectiveReporter;
} {
  const captured: { code: CompilerErrorCode; message: string; subject: string }[] = [];
  const report: DirectiveReporter = (code, message, subject) => {
    captured.push({ code, message, subject });
  };
  return { reported: captured, report };
}

/**
 * Assert that a call to `lowerDirective` with a capturing reporter fires the
 * expected code/message/subject combination and returns `null`.
 */
function assertReported(
  name: string,
  value: string | null,
  expectedCode: CompilerErrorCode,
  expectedSubject: string,
): void {
  const { reported, report } = captureReporter();
  const result = lowerDirective(name, value, report);
  assert.equal(result, null, `expected null for '${name}'`);
  assert.equal(reported.length, 1, `expected exactly one report for '${name}'`);
  assert.equal(reported[0]!.code, expectedCode, `code for '${name}'`);
  assert.equal(reported[0]!.subject, expectedSubject, `subject for '${name}'`);
}

/** A no-op reporter for success cases. */
const NOOP: DirectiveReporter = () => {};

// Mirror of the production table: the builder each token lowers to.
const TOKENS: ReadonlyArray<[string, string]> = [
  ['js-confirm', 'confirm'],
  ['js-loading', 'loadingTarget'],
  ['js-show', 'show'],
  ['js-text', 'text'],
  ['js-sort', 'sort'],
  ['js-intersect', 'intersect'],
  ['js-ref', 'ref'],
  ['js-ignore', 'ignore'],
  ['js-call', 'call'],
  ['js-submit', 'submit'],
  ['js-model', 'bind'],
  ['js-poll', 'poll'],
];

describe('lowerDirective', () => {
  it('lowers every token to the right builder and args', () => {
    for (const [token, builder] of TOKENS) {
      const value = token === 'js-ignore' ? null : `v-for-${token}`;
      const lowered = lowerDirective(token, value, NOOP);
      assert.ok(lowered !== null, `lowered should not be null for ${token}`);
      assert.equal(lowered.builder, builder, token);
      if (token === 'js-ignore') {
        assert.deepEqual(lowered.args, [], token);
      } else {
        assert.deepEqual(lowered.args, [`v-for-${token}`], token);
      }
    }
  });

  it('lowers js-ignore with null to ignore and no args', () => {
    const lowered = lowerDirective('js-ignore', null, NOOP);
    assert.ok(lowered !== null);
    assert.deepEqual(lowered, { builder: 'ignore', args: [] });
  });

  it('reports unsupported_position when js-ignore carries a value', () => {
    assertReported('js-ignore', 'x', 'unsupported_position', 'js-ignore');
  });

  it('reports unsupported_position when a value-taking directive has no value', () => {
    assertReported('js-submit', null, 'unsupported_position', 'js-submit');
  });

  it('reports unknown_directive for an unknown js- token', () => {
    assertReported('js-frobnicate', 'x', 'unknown_directive', 'js-frobnicate');
  });

  it('reports unknown_directive for a non-js- name', () => {
    assertReported('class', 'x', 'unknown_directive', 'class');
  });

  it('reports unknown_directive for a prototype key', () => {
    // `constructor`/`__proto__`/`toString` must not resolve to inherited members.
    for (const name of ['constructor', '__proto__', 'toString']) {
      assertReported(name, null, 'unknown_directive', name);
    }
  });

  it('keeps the error message free of the value text', () => {
    const { reported, report } = captureReporter();
    lowerDirective('js-ignore', 'do-not-leak', report);
    assert.equal(reported.length, 1);
    assert.ok(!reported[0]!.message.includes('do-not-leak'));
  });

  it('returns a frozen object', () => {
    const lowered = lowerDirective('js-submit', "'add'", NOOP);
    assert.ok(lowered !== null);
    assert.ok(Object.isFrozen(lowered));
    assert.ok(Object.isFrozen(lowered.args));
  });
});
