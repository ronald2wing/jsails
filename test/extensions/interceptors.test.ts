import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createInterceptorRegistry,
  defineEvent,
  defineOperation,
  InterceptorError,
  lookupEvent,
  lookupOperation,
  resolveEvent,
  resolveOperation,
} from '../../src/extensions/interceptors.js';

/**
 * Tests for the name→token registry (Wave 1 of the unified name-resolution
 * design). Verifies that:
 *
 * - defineOperation / defineEvent register tokens under their name.
 * - resolveOperation / resolveEvent return the first-registered token.
 * - lookup variants return undefined on miss instead of throwing.
 * - Duplicate names keep the first token for bare lookup and store all tokens.
 * - Unknown names produce loud, value-free InterceptorErrors.
 * - intercept / observe accept strings and resolve them at registration.
 * - Token-object call sites are unchanged.
 *
 * Every test uses unique operation/event names (prefix `test.w1.`) to avoid
 * collisions with the shared module-level registry across test runs.
 *
 * Callback parameter types are explicit because TypeScript cannot infer TArgs
 * through the {@code OperationToken<TArgs, TResult> | string} union the
 * registry interface now accepts.
 */

describe('name → token registry (operations)', () => {
  it('resolveOperation returns the same token object defined under that name', () => {
    const op = defineOperation<{ n: number }, string>('test.w1.identityOp');
    const resolved = resolveOperation('test.w1.identityOp');
    assert.strictEqual(resolved, op);
    // The token object is identity — resolving by name returns the same object.
    assert.equal(resolved, op);
  });

  it('lookupOperation returns the first token or undefined on miss', () => {
    const op = defineOperation('test.w1.lookupOp');
    assert.strictEqual(lookupOperation('test.w1.lookupOp'), op);
    assert.strictEqual(lookupOperation('test.w1.nonexistentOp'), undefined);
  });

  it('duplicate name: first wins for bare lookup, second is not lost', () => {
    const first = defineOperation<{ log: string[] }, void>('test.w1.dupOp');
    const second = defineOperation<{ log: string[] }, void>('test.w1.dupOp');

    // Bare resolution returns the FIRST.
    assert.strictEqual(resolveOperation('test.w1.dupOp'), first);
    assert.notStrictEqual(resolveOperation('test.w1.dupOp'), second);

    // Identity: they are distinct objects.
    assert.notStrictEqual(first, second);
  });

  it('resolveOperation throws InterceptorError with unknown_operation on miss', () => {
    assert.throws(
      () => resolveOperation('test.w1.missingOp'),
      (err: unknown) => {
        assert.ok(err instanceof InterceptorError, `expected InterceptorError, got ${String(err)}`);
        assert.equal(err.code, 'unknown_operation');
        // Value-free: the input name never appears in the message.
        assert.ok(!err.message.includes('test.w1.missingOp'));
        return true;
      },
    );
  });

  it('resolveOperation does not echo the input name in the error message', () => {
    try {
      resolveOperation('test.w1.secretOpId');
      assert.fail('expected InterceptorError');
    } catch (err) {
      assert.ok(err instanceof InterceptorError);
      const message = err.message;
      assert.ok(!message.includes('test.w1'), `message should not echo input: ${message}`);
    }
  });
});

describe('name → token registry (events)', () => {
  it('resolveEvent returns the same token object defined under that name', () => {
    const ev = defineEvent<{ x: number }>('test.w1.identityEv');
    const resolved = resolveEvent('test.w1.identityEv');
    assert.strictEqual(resolved, ev);
  });

  it('lookupEvent returns the first token or undefined on miss', () => {
    const ev = defineEvent<string>('test.w1.lookupEv');
    assert.strictEqual(lookupEvent('test.w1.lookupEv'), ev);
    assert.strictEqual(lookupEvent('test.w1.nonexistentEv'), undefined);
  });

  it('duplicate name: first wins for bare lookup, second is not lost', () => {
    const first = defineEvent<{ a: number }>('test.w1.dupEv');
    const second = defineEvent<{ a: number }>('test.w1.dupEv');

    assert.strictEqual(resolveEvent('test.w1.dupEv'), first);
    assert.notStrictEqual(resolveEvent('test.w1.dupEv'), second);
    assert.notStrictEqual(first, second);
  });

  it('resolveEvent throws InterceptorError with unknown_event on miss', () => {
    assert.throws(
      () => resolveEvent('test.w1.missingEv'),
      (err: unknown) => {
        assert.ok(err instanceof InterceptorError, `expected InterceptorError, got ${String(err)}`);
        assert.equal(err.code, 'unknown_event');
        assert.ok(!err.message.includes('test.w1.missingEv'));
        return true;
      },
    );
  });
});

describe('string-based intercept / observe', () => {
  it('intercept by string resolves the token at registration and hooks fire', async () => {
    defineOperation<{ log: string[] }, void>('test.w1.stringIntercept');
    const registry = createInterceptorRegistry();
    const log: string[] = [];

    registry.intercept('test.w1.stringIntercept', (args: { log: string[] }) => {
      args.log.push('hooked');
    });

    const args = { log };
    await registry.runBefore(resolveOperation('test.w1.stringIntercept'), args);
    assert.deepEqual(args.log, ['hooked']);
  });

  it('intercept by unknown string throws at registration', () => {
    const registry = createInterceptorRegistry();

    assert.throws(
      () => registry.intercept('test.w1.noSuchOp', () => {}),
      (err: unknown) => {
        assert.ok(err instanceof InterceptorError, `expected InterceptorError, got ${String(err)}`);
        assert.equal(err.code, 'unknown_operation');
        assert.ok(!err.message.includes('test.w1.noSuchOp'));
        return true;
      },
    );
  });

  it('observe by string resolves the token at registration and observer fires', async () => {
    defineEvent<{ origin: string }>('test.w1.stringObserve');
    const registry = createInterceptorRegistry();
    let seen: string | undefined;

    registry.observe('test.w1.stringObserve', (payload: { origin: string }) => {
      seen = payload.origin;
    });

    await registry.emit(resolveEvent('test.w1.stringObserve'), { origin: 'test' });
    assert.equal(seen, 'test');
  });

  it('observe by unknown string throws at registration', () => {
    const registry = createInterceptorRegistry();

    assert.throws(
      () => registry.observe('test.w1.noSuchEv', () => {}),
      (err: unknown) => {
        assert.ok(err instanceof InterceptorError, `expected InterceptorError, got ${String(err)}`);
        assert.equal(err.code, 'unknown_event');
        assert.ok(!err.message.includes('test.w1.noSuchEv'));
        return true;
      },
    );
  });
});

describe('token-object call sites are unchanged', () => {
  it('intercept with a token object still validates and registers', async () => {
    const op = defineOperation<{ n: number }, number>('test.w1.tokenObjectOp');
    const registry = createInterceptorRegistry();

    registry.intercept<{ n: number }, number>(op, (args: { n: number }) => {
      args.n *= 2;
    });

    const args = { n: 21 };
    await registry.runBefore(op, args);
    assert.equal(args.n, 42);
  });

  it('intercept with an arbitrary object still throws', () => {
    const registry = createInterceptorRegistry();

    assert.throws(
      () => registry.intercept({ notAToken: true } as never, () => {}),
      (err: unknown) => {
        assert.ok(err instanceof InterceptorError, `expected InterceptorError, got ${String(err)}`);
        assert.equal(err.code, 'unknown_operation');
        return true;
      },
    );
  });

  it('observe with a token object still validates and registers', async () => {
    const ev = defineEvent<{ text: string }>('test.w1.tokenObjectEv');
    const registry = createInterceptorRegistry();
    let captured: string | undefined;

    registry.observe(ev, (payload: { text: string }) => {
      captured = payload.text;
    });

    await registry.emit(ev, { text: 'hello' });
    assert.equal(captured, 'hello');
  });

  it('before/after interceptors run in the correct order with string and token mixed', async () => {
    const op = defineOperation<{ log: string[] }, string>('test.w1.mixedOrder');
    const registry = createInterceptorRegistry();
    const log: string[] = [];

    // Mix token-object and string-based registration.
    registry.intercept<{ log: string[] }, string>(op, (args: { log: string[] }) => {
      args.log.push('token-before');
    });
    registry.intercept('test.w1.mixedOrder', (args: { log: string[] }) => {
      args.log.push('string-before');
    });
    registry.intercept(
      'test.w1.mixedOrder',
      (result: string, args: { log: string[] }) => {
        args.log.push(`string-after:${result}`);
        return `${result}-transformed`;
      },
      { phase: 'after' },
    );

    const args = { log };
    await registry.runBefore(op, args);
    const result = await registry.runAfter(op, args, 'value');
    assert.deepEqual(args.log, ['token-before', 'string-before', 'string-after:value']);
    assert.equal(result, 'value-transformed');
  });

  it('sealed registry rejects string-based intercept', () => {
    defineOperation('test.w1.sealedStringOp');
    const registry = createInterceptorRegistry();
    registry.seal();

    assert.throws(
      () => registry.intercept('test.w1.sealedStringOp', () => {}),
      (err: unknown) => {
        assert.ok(err instanceof InterceptorError, `expected InterceptorError, got ${String(err)}`);
        assert.equal(err.code, 'sealed');
        return true;
      },
    );
  });
});
