import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createCleanup } from '../../src/extensions/index.js';

/**
 * Tests for the `createCleanup` idempotent teardown wrapper. No service or I/O
 * is involved — every teardown is a simple counter so we assert call counts
 * without forcing real asynchronous teardown work.
 */

describe('createCleanup', () => {
  it('runs teardown once across sequential calls', async () => {
    let calls = 0;
    const cleanup = createCleanup(() => {
      calls += 1;
    });

    await cleanup();
    await cleanup();
    await cleanup();

    assert.equal(calls, 1);
  });

  it('shares one invocation across concurrent callers', async () => {
    let calls = 0;
    const cleanup = createCleanup(() => {
      calls += 1;
    });

    const [a, b] = await Promise.all([cleanup(), cleanup()]);

    assert.equal(calls, 1);
    assert.strictEqual(a, undefined);
    assert.strictEqual(b, undefined);
  });

  it('memoizes rejection and never retries', async () => {
    let calls = 0;
    const cleanup = createCleanup(() => {
      calls += 1;
      return Promise.reject(new Error('teardown failed'));
    });

    await assert.rejects(cleanup, /teardown failed/);
    await assert.rejects(cleanup, /teardown failed/);

    assert.equal(calls, 1);
  });

  it('captures synchronous throw as a rejected promise', async () => {
    const cleanup = createCleanup(() => {
      throw new Error('sync throw');
    });

    // The wrapper must never throw synchronously — the error is surfaced only
    // through the returned promise.
    const promise = cleanup();
    assert.ok(promise instanceof Promise);

    await assert.rejects(promise, /sync throw/);
  });

  it('works when teardown returns void and when it returns a promise', async () => {
    let voidCalls = 0;
    const voidCleanup = createCleanup(() => {
      voidCalls += 1;
    });

    let promiseCalls = 0;
    const promiseCleanup = createCleanup(() => {
      promiseCalls += 1;
      return Promise.resolve();
    });

    await voidCleanup();
    await promiseCleanup();

    assert.equal(voidCalls, 1);
    assert.equal(promiseCalls, 1);
  });
});
