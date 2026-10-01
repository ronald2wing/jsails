import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createInterceptorRegistry,
  createServiceToken,
  defineEvent,
  definePlugin,
  defineOperation,
  InterceptorError,
  runExtensions,
  type JsailsPlugin,
  type PluginContext,
} from '../../src/extensions/index.js';

/**
 * Tests for the plugin contract: the `definePlugin` surface, the plugin setup
 * context (`intercept` / `observe`), and the exact interceptor/observer
 * semantics the contract promises. No service, network, or HTTP is involved.
 */

describe('definePlugin and the plugin context', () => {
  it('returns its argument by identity without invoking setup', () => {
    let setupCalls = 0;
    const plugin: JsailsPlugin = {
      name: 'm',
      setup() {
        setupCalls += 1;
      },
    };

    assert.equal(definePlugin(plugin), plugin);
    assert.equal(setupCalls, 0);
  });

  it('hands setup a context carrying intercept and observe', async () => {
    const op = defineOperation<{ n: number }, number>('op');
    const event = defineEvent<string>('evt');
    let sawIntercept = false;
    let sawObserve = false;

    const runtime = await runExtensions([
      definePlugin({
        name: 'm',
        setup({ intercept, observe }) {
          assert.equal(typeof intercept, 'function');
          assert.equal(typeof observe, 'function');
          sawIntercept = true;
          sawObserve = true;
          intercept(op, () => {});
          observe(event, () => {});
        },
      }),
    ]);

    assert.equal(sawIntercept, true);
    assert.equal(sawObserve, true);
    await runtime.close();
  });
});

describe('before interceptors', () => {
  it('runs in ascending priority then declaration order and mutates args in place', async () => {
    const op = defineOperation<{ log: string[] }, unknown>('op');
    const runtime = await runExtensions([
      definePlugin({
        name: 'late',
        priority: 2,
        setup({ intercept }) {
          intercept(op, (args) => {
            args.log.push('late');
          });
        },
      }),
      definePlugin({
        name: 'early',
        priority: 0,
        setup({ intercept }) {
          intercept(op, (args) => {
            args.log.push('early');
          });
        },
      }),
      definePlugin({
        name: 'mid',
        priority: 1,
        setup({ intercept }) {
          intercept(op, (args) => {
            args.log.push('mid');
          });
        },
      }),
    ]);

    const args = { log: [] as string[] };
    await runtime.interceptors.runBefore(op, args);
    assert.deepEqual(args.log, ['early', 'mid', 'late']);
    await runtime.close();
  });

  it('awaits sequentially and a throw aborts the remaining hooks', async () => {
    const op = defineOperation<{ log: string[] }, unknown>('op');
    const runtime = await runExtensions([
      definePlugin({
        name: 'm',
        setup({ intercept }) {
          intercept(op, async (args) => {
            await new Promise((resolve) => setTimeout(resolve, 1));
            args.log.push('async');
          });
          intercept(op, (args) => {
            args.log.push('before-abort');
            throw new Error('abort');
          });
          intercept(op, (args) => {
            args.log.push('never');
          });
        },
      }),
    ]);

    const args = { log: [] as string[] };
    await assert.rejects(runtime.interceptors.runBefore(op, args), /abort/);
    assert.deepEqual(args.log, ['async', 'before-abort']);
    await runtime.close();
  });
});

describe('after interceptors', () => {
  it('runs in reverse order and threads the result through each hook', async () => {
    const op = defineOperation<{ n: number }, number>('op');
    const order: string[] = [];
    const runtime = await runExtensions([
      definePlugin({
        name: 'first',
        setup({ intercept }) {
          intercept(
            op,
            (result) => {
              order.push('first');
              return result + 1;
            },
            { phase: 'after' },
          );
        },
      }),
      definePlugin({
        name: 'second',
        setup({ intercept }) {
          intercept(
            op,
            (result) => {
              order.push('second');
              return result * 10;
            },
            { phase: 'after' },
          );
        },
      }),
    ]);

    const result = await runtime.interceptors.runAfter(op, { n: 1 }, 0);
    assert.deepEqual(order, ['second', 'first']);
    assert.equal(result, 1);
    await runtime.close();
  });

  it('propagates a thrown error', async () => {
    const op = defineOperation<unknown, number>('op');
    const runtime = await runExtensions([
      definePlugin({
        name: 'm',
        setup({ intercept }) {
          intercept(
            op,
            () => {
              throw new Error('after-boom');
            },
            { phase: 'after' },
          );
        },
      }),
    ]);

    await assert.rejects(runtime.interceptors.runAfter(op, undefined, 1), /after-boom/);
    await runtime.close();
  });
});

describe('observers', () => {
  it('runs in ascending order, collects errors, and cannot transform the payload', async () => {
    const event = defineEvent<{ log: string[] }>('evt');
    const seen: string[] = [];
    const runtime = await runExtensions([
      definePlugin({
        name: 'a',
        priority: 2,
        setup({ observe }) {
          observe(event, (payload) => {
            seen.push('a');
            payload.log.push('a');
          });
        },
      }),
      definePlugin({
        name: 'b',
        priority: 0,
        setup({ observe }) {
          observe(event, () => {
            throw new Error('b-boom');
          });
        },
      }),
      definePlugin({
        name: 'c',
        priority: 1,
        setup({ observe }) {
          observe(event, () => {
            seen.push('c');
          });
        },
      }),
    ]);

    const payload = { log: [] as string[] };
    const errors = await runtime.interceptors.emit(event, payload);

    assert.deepEqual(seen, ['c', 'a']);
    assert.deepEqual(payload.log, ['a']);
    assert.equal(errors.length, 1);
    assert.equal((errors[0] as Error).message, 'b-boom');
    await runtime.close();
  });
});

describe('plugin ordering and disabling', () => {
  it('runs setup in ascending priority then declaration order', async () => {
    const order: string[] = [];
    const runtime = await runExtensions([
      definePlugin({
        name: 'z',
        priority: 3,
        setup() {
          order.push('z');
        },
      }),
      definePlugin({
        name: 'a',
        priority: 0,
        setup() {
          order.push('a');
        },
      }),
      definePlugin({
        name: 'b',
        priority: 0,
        setup() {
          order.push('b');
        },
      }),
    ]);

    assert.deepEqual(order, ['a', 'b', 'z']);
    await runtime.close();
  });

  it('skips a disabled plugin entirely, including its requirements', async () => {
    const missing = createServiceToken<number>('missing');
    let ran = false;

    const runtime = await runExtensions([
      definePlugin({
        name: 'off',
        disabled: true,
        requires: [missing],
        setup() {
          ran = true;
        },
      }),
    ]);

    assert.equal(ran, false);
    await runtime.close();
  });

  it('inherits the plugin priority for its interceptors', async () => {
    const op = defineOperation<{ log: string[] }, unknown>('op');
    const runtime = await runExtensions([
      definePlugin({
        name: 'high',
        priority: 5,
        setup({ intercept }) {
          intercept(op, (args) => {
            args.log.push('high');
          });
        },
      }),
      definePlugin({
        name: 'low',
        priority: -5,
        setup({ intercept }) {
          intercept(op, (args) => {
            args.log.push('low');
          });
        },
      }),
    ]);

    const args = { log: [] as string[] };
    await runtime.interceptors.runBefore(op, args);
    assert.deepEqual(args.log, ['low', 'high']);
    await runtime.close();
  });
});

describe('interceptor registry invariants', () => {
  it('rejects unknown operation and event tokens', () => {
    const registry = createInterceptorRegistry();

    const unknownOperation = (): unknown => registry.runBefore({} as never, {});
    assert.throws(unknownOperation, (error: unknown) => {
      assert.ok(error instanceof InterceptorError);
      assert.equal(error.code, 'unknown_operation');
      return true;
    });

    const unknownEvent = (): unknown => registry.emit({} as never, {});
    assert.throws(unknownEvent, (error: unknown) => {
      assert.ok(error instanceof InterceptorError);
      assert.equal(error.code, 'unknown_event');
      return true;
    });
  });

  it('seals registration after setup while invocation keeps working', async () => {
    const op = defineOperation<{ log: string[] }, unknown>('op');
    let leaked: PluginContext['intercept'] | undefined;

    const runtime = await runExtensions([
      definePlugin({
        name: 'm',
        setup({ intercept }) {
          leaked = intercept;
          intercept(op, (args) => {
            args.log.push('registered');
          });
        },
      }),
    ]);

    const args = { log: [] as string[] };
    await runtime.interceptors.runBefore(op, args);
    assert.deepEqual(args.log, ['registered']);

    assert.throws(
      () => leaked?.(op, () => {}),
      (error: unknown) => {
        assert.ok(error instanceof InterceptorError);
        assert.equal(error.code, 'sealed');
        return true;
      },
    );

    await runtime.close();
  });
});

/** Compile-time guard: the plugin context exposes interception surfaces. */
const _context = {} as PluginContext;
void _context.intercept;
void _context.observe;
