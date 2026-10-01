import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DevReadinessError,
  DevUrlTracker,
  type ReadinessOptions,
} from '../../src/dev/readiness.js';

/**
 * Tests for the bounded dev readiness waiter (`DevUrlTracker`).
 *
 * These drive the quiescence + liveness logic with a fake probe and small real
 * timers: no HTTP request, child process, or dev toolchain is involved. Each
 * scenario is bounded by the `timeoutMs` it passes, so a regression that turns
 * a wait into an unbounded retry loop fails the test rather than hanging it.
 */

const fast = (overrides: Partial<ReadinessOptions> = {}): ReadinessOptions => ({
  quiescenceMs: 40,
  pollIntervalMs: 5,
  ...overrides,
});

const alwaysLive = () => async () => true;

describe('DevUrlTracker', () => {
  it('resolves the single observed URL and consumes it', async () => {
    const tracker = new DevUrlTracker({ ...fast(), probe: alwaysLive() });
    tracker.noteUrl('http://127.0.0.1:4000/');

    const live = await tracker.waitForLive({ timeoutMs: 1000 });

    assert.equal(live.url, 'http://127.0.0.1:4000/');
    assert.equal(live.delivered, 1, 'the single URL is consumed');
  });

  it('absorbs a startup burst, settles on the latest live URL, then waits for the edit URL', async () => {
    // The first burst URL is already dead (the benign tsc-watch restart).
    const probe = async (url: string) => url !== 'http://127.0.0.1:4001/';
    const tracker = new DevUrlTracker({ ...fast(), probe });
    tracker.noteUrl('http://127.0.0.1:4001/');
    tracker.noteUrl('http://127.0.0.1:4002/');

    const boot = await tracker.waitForLive({ timeoutMs: 1000 });
    assert.equal(boot.url, 'http://127.0.0.1:4002/', 'the dead first URL is skipped');
    assert.equal(boot.delivered, 2, 'boot consumes the whole burst');

    // An edit triggers a third URL; the next wait must not be shifted by the burst.
    tracker.noteUrl('http://127.0.0.1:4003/');
    const edit = await tracker.waitForLive({ timeoutMs: 1000 });
    assert.equal(edit.url, 'http://127.0.0.1:4003/');
    assert.equal(edit.delivered, 3);
  });

  it('re-waits quiescence when a new URL arrives mid-quiescence', async () => {
    const tracker = new DevUrlTracker({ ...fast(), probe: alwaysLive() });
    tracker.noteUrl('http://127.0.0.1:4001/');

    const pending = tracker.waitForLive({ timeoutMs: 1000 });
    // Lands before the quiescence window elapses, so the tracker must restart it.
    setTimeout(() => tracker.noteUrl('http://127.0.0.1:4002/'), 10);

    const live = await pending;
    assert.equal(live.url, 'http://127.0.0.1:4002/');
    assert.equal(live.delivered, 2);
  });

  it('fails bounded when a URL never becomes live (dead port / crash loop)', async () => {
    const tracker = new DevUrlTracker({ ...fast(), probe: async () => false });
    tracker.noteUrl('http://127.0.0.1:4000/');

    await assert.rejects(
      () => tracker.waitForLive({ timeoutMs: 120 }),
      (error) => error instanceof DevReadinessError && /timed out/.test(error.message),
    );
  });

  it('rejects immediately when aborted before any URL becomes live', async () => {
    const tracker = new DevUrlTracker({ ...fast(), probe: async () => false });
    tracker.noteUrl('http://127.0.0.1:4000/');

    await assert.rejects(
      () => tracker.waitForLive({ timeoutMs: 60_000, aborted: () => true }),
      (error) => error instanceof DevReadinessError && /exited/.test(error.message),
    );
  });
});
