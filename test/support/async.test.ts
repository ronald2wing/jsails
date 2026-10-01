import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  Async,
  AsyncError,
  debounce,
  delay,
  limit,
  mapConcurrent,
  memoize,
  once,
  retry,
  sleep,
  throttle,
  timeout,
} from '../../src/support/async.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assertValueFreeError(fn: () => unknown, offendingValue: string) {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof AsyncError);
    assert.equal(err.code, 'invalid_argument');
    const message = err.message;
    assert.ok(!message.includes(offendingValue), `message should not echo input: ${message}`);
    return true;
  });
}

/**
 * Slight tolerance (ms) for timing assertions — generous enough to absorb CI jitter
 * but tight enough to catch a real miss.
 */
const TIMING_TOLERANCE_MS = 80;

// ---------------------------------------------------------------------------
// sleep / delay
// ---------------------------------------------------------------------------

describe('sleep', () => {
  it('resolves after roughly the requested ms', async () => {
    const start = Date.now();
    await sleep(50);
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 40, `sleep should be >= ~40ms, was ${elapsed}ms`);
    assert.ok(elapsed <= 50 + TIMING_TOLERANCE_MS, `sleep should be <= ~130ms, was ${elapsed}ms`);
  });

  it('resolves immediately for 0', async () => {
    const start = Date.now();
    await sleep(0);
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 30, `sleep(0) should resolve quickly, was ${elapsed}ms`);
  });

  it('throws value-free on negative ms', () => {
    assertValueFreeError(() => sleep(-1), '-1');
  });

  it('throws value-free on NaN', () => {
    assertValueFreeError(() => sleep(NaN), 'NaN');
  });
});

describe('delay', () => {
  it('is an alias of sleep', async () => {
    const start = Date.now();
    await delay(30);
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 20 && elapsed <= 30 + TIMING_TOLERANCE_MS);
  });
});

// ---------------------------------------------------------------------------
// once
// ---------------------------------------------------------------------------

describe('once', () => {
  it('runs the function exactly once', () => {
    let calls = 0;
    const fn = once(() => {
      calls++;
      return calls;
    });
    assert.equal(fn(), 1);
    assert.equal(fn(), 1);
    assert.equal(fn(), 1);
    assert.equal(calls, 1);
  });

  it('returns the first result on repeated calls', () => {
    const fn = once((x: number) => x * 2);
    assert.equal(fn(5), 10);
    assert.equal(fn(100), 10); // still returns first result
  });

  it('throws value-free on non-function', () => {
    assertValueFreeError(() => once(42 as unknown as (...args: never[]) => unknown), '42');
  });
});

// ---------------------------------------------------------------------------
// debounce
// ---------------------------------------------------------------------------

describe('debounce', () => {
  it('coalesces rapid calls', async () => {
    let calls = 0;
    const fn = debounce(() => {
      calls++;
    }, 50);

    fn();
    fn();
    fn();

    assert.equal(calls, 0); // not yet

    await sleep(120);
    assert.equal(calls, 1);
  });

  it('cancels pending invocation', async () => {
    let calls = 0;
    const fn = debounce(() => {
      calls++;
    }, 50);

    fn();
    fn.cancel();
    await sleep(100);
    assert.equal(calls, 0);
  });

  it('invokes immediately with leading: true', async () => {
    let calls = 0;
    const fn = debounce(
      () => {
        calls++;
      },
      50,
      { leading: true, trailing: false },
    );

    fn();
    assert.equal(calls, 1);

    fn();
    fn();
    assert.equal(calls, 1); // still leading only once in window

    await sleep(120);
    assert.equal(calls, 1);
  });

  it('throws value-free on non-function', () => {
    assertValueFreeError(() => debounce(42 as unknown as (...args: never[]) => void, 50), '42');
  });

  it('throws value-free on negative ms', () => {
    assertValueFreeError(() => debounce(() => {}, -1), '-1');
  });
});

// ---------------------------------------------------------------------------
// throttle
// ---------------------------------------------------------------------------

describe('throttle', () => {
  it('limits call frequency', async () => {
    let calls = 0;
    const fn = throttle(
      () => {
        calls++;
      },
      50,
      { leading: true, trailing: false },
    );

    fn(); // immediate
    fn(); // throttled
    fn(); // throttled

    assert.equal(calls, 1);

    await sleep(120);
    assert.equal(calls, 1); // no trailing
  });

  it('fires trailing when configured', async () => {
    let calls = 0;
    const fn = throttle(
      () => {
        calls++;
      },
      50,
      { leading: false, trailing: true },
    );

    fn(); // queued
    fn(); // still in window

    assert.equal(calls, 0);

    await sleep(120);
    assert.equal(calls, 1); // trailing fired
  });

  it('throws value-free on non-function', () => {
    assertValueFreeError(() => throttle(42 as unknown as (...args: never[]) => void, 50), '42');
  });

  it('throws value-free on negative ms', () => {
    assertValueFreeError(() => throttle(() => {}, -1), '-1');
  });
});

// ---------------------------------------------------------------------------
// memoize
// ---------------------------------------------------------------------------

describe('memoize', () => {
  it('caches results by first argument', () => {
    let calls = 0;
    const fn = memoize((x: number) => {
      calls++;
      return x * 2;
    });

    assert.equal(fn(5), 10);
    assert.equal(fn(5), 10);
    assert.equal(fn(10), 20);
    assert.equal(calls, 2);
  });

  it('exposes a cache', () => {
    const fn = memoize((x: number) => x + 1);
    fn(1);
    fn(2);
    assert.ok(fn.cache instanceof Map);
    assert.equal(fn.cache.size, 2);
  });

  it('throws value-free on non-function', () => {
    assertValueFreeError(() => memoize(42 as unknown as (...args: never[]) => unknown), '42');
  });
});

// ---------------------------------------------------------------------------
// retry
// ---------------------------------------------------------------------------

describe('retry', () => {
  it('succeeds on first attempt', async () => {
    const result = await retry(async () => 42);
    assert.equal(result, 42);
  });

  it('succeeds after failures', async () => {
    let attempts = 0;
    const result = await retry(
      async () => {
        attempts++;
        if (attempts < 3) throw new Error('fail');
        return attempts;
      },
      { retries: 3, minTimeout: 1, maxTimeout: 5 },
    );
    assert.equal(result, 3);
    assert.equal(attempts, 3);
  });

  it('honours the retry count', async () => {
    let attempts = 0;
    await assert.rejects(
      retry(
        async () => {
          attempts++;
          throw new Error('fail');
        },
        { retries: 2, minTimeout: 1, maxTimeout: 5 },
      ),
    );
    // initial call + 2 retries = 3 total attempts
    assert.equal(attempts, 3);
  });

  it('throws value-free on non-function', () => {
    assertValueFreeError(() => retry(42 as unknown as () => Promise<unknown>), '42');
  });

  it('throws value-free on negative retries', () => {
    assertValueFreeError(() => retry(async () => {}, { retries: -1 }), '-1');
  });

  it('throws value-free on non-integer retries', () => {
    assertValueFreeError(() => retry(async () => {}, { retries: 1.5 }), '1.5');
  });
});

// ---------------------------------------------------------------------------
// limit
// ---------------------------------------------------------------------------

describe('limit', () => {
  it('enforces the concurrency bound', async () => {
    const run = limit(2);
    let inFlight = 0;
    let maxInFlight = 0;

    const tasks = Array.from({ length: 6 }, (_, i) =>
      run(async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await sleep(10);
        inFlight--;
        return i;
      }),
    );

    const results = await Promise.all(tasks);
    assert.deepEqual(results, [0, 1, 2, 3, 4, 5]);
    assert.ok(maxInFlight <= 2, `max in-flight was ${maxInFlight}, expected <= 2`);
    assert.equal(maxInFlight, 2);
  });

  it('throws value-free on non-positive concurrency', () => {
    assertValueFreeError(() => limit(0), '0');
    assertValueFreeError(() => limit(-1), '-1');
  });

  it('throws value-free on non-integer concurrency', () => {
    assertValueFreeError(() => limit(1.5), '1.5');
  });

  it('throws when the run function is not callable', async () => {
    const run = limit(1);
    await assert.rejects(run(42 as unknown as () => Promise<unknown>));
  });
});

// ---------------------------------------------------------------------------
// mapConcurrent
// ---------------------------------------------------------------------------

describe('mapConcurrent', () => {
  it('preserves order', async () => {
    const results = await mapConcurrent([3, 1, 2], async (n) => n * 10);
    assert.deepEqual(results, [30, 10, 20]);
  });

  it('respects concurrency', async () => {
    let inFlight = 0;
    let maxInFlight = 0;

    const results = await mapConcurrent(
      [1, 2, 3, 4, 5, 6],
      async (n) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await sleep(10);
        inFlight--;
        return n * 10;
      },
      { concurrency: 2 },
    );

    assert.deepEqual(results, [10, 20, 30, 40, 50, 60]);
    assert.ok(maxInFlight <= 2, `max in-flight was ${maxInFlight}, expected <= 2`);
  });

  it('throws value-free on non-array items', () => {
    assertValueFreeError(() => mapConcurrent(42 as unknown as unknown[], async (n) => n), '42');
  });

  it('throws value-free on non-function mapper', () => {
    assertValueFreeError(
      () => mapConcurrent([1], 42 as unknown as (item: number) => Promise<number>),
      '42',
    );
  });

  it('throws value-free on non-integer concurrency', () => {
    assertValueFreeError(() => mapConcurrent([1], async (n) => n, { concurrency: 1.5 }), '1.5');
  });
});

// ---------------------------------------------------------------------------
// timeout
// ---------------------------------------------------------------------------

describe('timeout', () => {
  it('returns an AbortSignal that aborts after the given ms', async () => {
    const signal = timeout(50);
    assert.ok(signal instanceof AbortSignal);
    assert.equal(signal.aborted, false);

    // Poll with a safety margin rather than relying on the 'abort' event,
    // which can race with the test runner's event loop heuristics.
    await sleep(80);
    assert.equal(signal.aborted, true);
    assert.ok(signal.reason instanceof DOMException);
    assert.equal(signal.reason.name, 'TimeoutError');
  });

  it('timeout(0) aborts immediately', async () => {
    const signal = timeout(0);
    // Allow the microtask to settle.
    await sleep(5);
    assert.equal(signal.aborted, true);
  });

  it('throws value-free on negative ms', () => {
    assertValueFreeError(() => timeout(-1), '-1');
  });

  it('throws value-free on NaN', () => {
    assertValueFreeError(() => timeout(NaN), 'NaN');
  });
});

// ---------------------------------------------------------------------------
// Async frozen namespace
// ---------------------------------------------------------------------------

describe('Async', () => {
  it('is frozen', () => {
    assert.throws(() => {
      (Async as Record<string, unknown>).newProp = true;
    }, TypeError);
  });

  it('contains all expected helpers', () => {
    assert.equal(typeof Async.sleep, 'function');
    assert.equal(typeof Async.delay, 'function');
    assert.equal(typeof Async.once, 'function');
    assert.equal(typeof Async.debounce, 'function');
    assert.equal(typeof Async.throttle, 'function');
    assert.equal(typeof Async.memoize, 'function');
    assert.equal(typeof Async.retry, 'function');
    assert.equal(typeof Async.limit, 'function');
    assert.equal(typeof Async.mapConcurrent, 'function');
    assert.equal(typeof Async.timeout, 'function');
  });

  it('does not accept new properties', () => {
    assert.throws(() => {
      Object.assign(Async, { extra: 1 });
    }, TypeError);
  });
});
