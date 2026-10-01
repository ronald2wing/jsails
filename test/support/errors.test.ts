import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SupportError } from '../../src/support/errors.js';

class DemoError extends SupportError {
  readonly code = 'demo_code';
}

describe('SupportError', () => {
  it("sets name to the subclass's own class name", () => {
    const err = new DemoError('boom');
    assert.equal(err.name, 'DemoError');
  });

  it('is an instance of SupportError and Error', () => {
    const err = new DemoError('boom');
    assert.ok(err instanceof SupportError);
    assert.ok(err instanceof Error);
  });

  it('has the stable code from the subclass', () => {
    const err = new DemoError('boom');
    assert.equal(err.code, 'demo_code');
    assert.ok(typeof err.code === 'string' && err.code.length > 0);
  });

  it('round-trips cause when passed', () => {
    const original = new Error('inner');
    const err = new DemoError('boom', { cause: original });
    assert.equal(err.cause, original);
  });

  it('preserves the exact message (value-free — no input interpolation)', () => {
    const err = new DemoError('operation_failed');
    assert.equal(err.message, 'operation_failed');
    assert.ok(!err.message.includes('secret'));
  });

  it('has correct prototype chain', () => {
    assert.ok(Object.getPrototypeOf(DemoError.prototype) === SupportError.prototype);
  });
});
