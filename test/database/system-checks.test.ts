import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createSystemCheckRegistry,
  defineSystemCheck,
  SystemCheckError,
} from '../../src/database/system-checks.js';

// ---------------------------------------------------------------------------
// createSystemCheckRegistry
// ---------------------------------------------------------------------------

describe(createSystemCheckRegistry.name, () => {
  it('returns a frozen registry', () => {
    const registry = createSystemCheckRegistry();
    assert.ok(Object.isFrozen(registry));
  });

  it('register throws for a non-function fn', () => {
    const registry = createSystemCheckRegistry();
    assert.throws(() => {
      registry.register('test', undefined as unknown as () => []);
    }, SystemCheckError);
  });

  it('register throws for an empty id', () => {
    const registry = createSystemCheckRegistry();
    assert.throws(() => registry.register('', () => []), SystemCheckError);
  });

  it('register throws on duplicate id', () => {
    const registry = createSystemCheckRegistry();
    const fn = () => [];
    registry.register('duplicate', fn);
    assert.throws(() => registry.register('duplicate', fn), SystemCheckError);
  });

  it('duplicate rejection message does not echo caller data', () => {
    const registry = createSystemCheckRegistry();
    registry.register('db', () => []);
    try {
      registry.register('db', () => []);
      assert.fail('expected throw');
    } catch (e) {
      assert.ok(e instanceof SystemCheckError);
      assert.ok(!e.message.includes('db'));
    }
  });

  it('run on an empty registry returns an empty frozen array', () => {
    const registry = createSystemCheckRegistry();
    const results = registry.run();
    assert.ok(Object.isFrozen(results));
    assert.equal(results.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Registration order + return shape
// ---------------------------------------------------------------------------

describe('registration order', () => {
  it('run yields results in registration order', () => {
    const registry = createSystemCheckRegistry();

    registry.register('alpha', () => [{ id: 'alpha', severity: 'info', message: 'first' }]);
    registry.register('beta', () => [{ id: 'beta', severity: 'info', message: 'second' }]);
    registry.register('gamma', () => [{ id: 'gamma', severity: 'info', message: 'third' }]);

    const results = registry.run();

    assert.equal(results.length, 3);
    const [first, second, third] = results;
    assert.equal(first!.id, 'alpha');
    assert.equal(second!.id, 'beta');
    assert.equal(third!.id, 'gamma');
  });

  it('a check may return multiple results in order', () => {
    const registry = createSystemCheckRegistry();

    registry.register('multi', () => [
      { id: 'multi', severity: 'info', message: 'a' },
      { id: 'multi', severity: 'warning', message: 'b' },
    ]);

    const results = registry.run();
    assert.equal(results.length, 2);
    const [multiA, multiB] = results;
    assert.deepStrictEqual(multiA!, {
      id: 'multi',
      severity: 'info',
      message: 'a',
    });
    assert.deepStrictEqual(multiB!, {
      id: 'multi',
      severity: 'warning',
      message: 'b',
    });
  });
});

// ---------------------------------------------------------------------------
// Throwing check isolation
// ---------------------------------------------------------------------------

describe('throwing check isolation', () => {
  it('a throwing check becomes an error check without halting the run', () => {
    const registry = createSystemCheckRegistry();

    registry.register('before', () => [{ id: 'before', severity: 'info', message: 'ok' }]);
    registry.register('bad', () => {
      throw new Error('boom');
    });
    registry.register('after', () => [{ id: 'after', severity: 'info', message: 'still runs' }]);

    const results = registry.run();

    assert.equal(results.length, 3);
    const [beforeResult, badResult, afterResult] = results;

    // first check passes normally
    assert.equal(beforeResult!.id, 'before');
    assert.equal(beforeResult!.severity, 'info');

    // throwing check becomes a single error result
    assert.equal(badResult!.id, 'bad');
    assert.equal(badResult!.severity, 'error');
    assert.equal(typeof badResult!.message, 'string');
    assert.ok(badResult!.message.length > 0);

    // third check still runs
    assert.equal(afterResult!.id, 'after');
    assert.equal(afterResult!.severity, 'info');
  });

  it('error message for a throwing check is value-free', () => {
    const registry = createSystemCheckRegistry();

    const secret = 'private-password-123';
    registry.register('leaky', () => {
      throw new Error(secret);
    });

    const results = registry.run();
    assert.equal(results.length, 1);
    const [leakyResult] = results;
    assert.equal(leakyResult!.severity, 'error');
    assert.ok(!leakyResult!.message.includes('private'));
    assert.ok(!leakyResult!.message.includes('password'));
    assert.ok(!leakyResult!.message.includes('leaky'));
  });
});

// ---------------------------------------------------------------------------
// defineSystemCheck
// ---------------------------------------------------------------------------

describe(defineSystemCheck.name, () => {
  it('returns { id, fn } for a given check', () => {
    const fn = () => [];
    const defined = defineSystemCheck('my-check', fn);

    assert.equal(defined.id, 'my-check');
    assert.equal(defined.fn, fn);
  });

  it('composes with the registry', () => {
    const registry = createSystemCheckRegistry();
    const a = defineSystemCheck('a', () => [{ id: 'a', severity: 'info', message: 'ok' }]);
    const b = defineSystemCheck('b', () => [{ id: 'b', severity: 'warning', message: 'warn' }]);

    registry.register(a.id, a.fn);
    registry.register(b.id, b.fn);

    const results = registry.run();
    assert.equal(results.length, 2);
    const [aResult, bResult] = results;
    assert.equal(aResult!.id, 'a');
    assert.equal(bResult!.id, 'b');
  });
});

// ---------------------------------------------------------------------------
// Context forwarding
// ---------------------------------------------------------------------------

describe('context forwarding', () => {
  it('passes empty context when none is given', () => {
    const registry = createSystemCheckRegistry();
    let ctx: unknown;

    registry.register('ctx', (c) => {
      ctx = c;
      return [];
    });

    registry.run();
    assert.ok(typeof ctx === 'object');
    assert.equal((ctx as Record<string, unknown>).schema, undefined);
  });

  it('forwards schema and config to every check', () => {
    const registry = createSystemCheckRegistry();
    const schema = { tables: [] };
    const config = { timeout: 5000 };
    const seenSchema: unknown[] = [];
    const seenConfig: unknown[] = [];

    registry.register('a', (ctx) => {
      seenSchema.push(ctx.schema);
      seenConfig.push(ctx.config);
      return [];
    });
    registry.register('b', (ctx) => {
      seenSchema.push(ctx.schema);
      seenConfig.push(ctx.config);
      return [];
    });

    registry.run({ schema, config });

    assert.equal(seenSchema.length, 2);
    assert.strictEqual(seenSchema[0], schema);
    assert.strictEqual(seenSchema[1], schema);
    assert.strictEqual(seenConfig[0], config);
    assert.strictEqual(seenConfig[1], config);
  });
});

// ---------------------------------------------------------------------------
// result immutability
// ---------------------------------------------------------------------------

describe('result immutability', () => {
  it('run returns a frozen array', () => {
    const registry = createSystemCheckRegistry();
    registry.register('a', () => [{ id: 'a', severity: 'info', message: 'ok' }]);

    const results = registry.run();
    assert.ok(Object.isFrozen(results));
  });
});

// ---------------------------------------------------------------------------
// Value-free Error
// ---------------------------------------------------------------------------

describe(SystemCheckError.name, () => {
  it('is an Error subclass with name SystemCheckError', () => {
    const err = new SystemCheckError('something');
    assert.ok(err instanceof Error);
    assert.equal(err.name, 'SystemCheckError');
  });
});
