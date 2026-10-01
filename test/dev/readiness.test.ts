import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DevUrlTracker, DevUrlTrackerError } from '../../src/dev/readiness.js';

/**
 * Tests drive the tracker through an injected monotonic clock, an injected
 * liveness probe, and an injected `sleep` that advances the clock — so no real
 * timer, fetch, or server is involved and the test is deterministic.
 */
describe('DevUrlTracker', () => {
  const POLL = 1;
  const QUIESCE = 10;

  function makeTracker(liveUrls: readonly string[], quiescenceMs = QUIESCE): DevUrlTracker {
    let now = 0;
    const live = new Set(liveUrls);
    return new DevUrlTracker(
      { quiescenceMs, pollIntervalMs: POLL },
      () => now,
      async (url) => live.has(url),
      async (ms) => {
        now += ms;
      },
    );
  }

  it('resolves the latest quiescent live URL, skipping an earlier dead port', async () => {
    let now = 0;
    const live = new Map<string, boolean>([
      ['http://x:1/', false],
      ['http://x:2/', true],
    ]);
    const tracker = new DevUrlTracker(
      { quiescenceMs: QUIESCE, pollIntervalMs: POLL },
      () => now,
      async (url) => live.get(url) ?? false,
      async (ms) => {
        now += ms;
      },
    );
    tracker.noteUrl('http://x:1/'); // dead — the benign restart's old port.
    tracker.noteUrl('http://x:2/'); // the settled, live port.

    const result = await tracker.waitForLive({ timeoutMs: 1000, aborted: () => false });
    assert.equal(result.url, 'http://x:2/');
  });

  it('waits out the quiescence window before probing the latest URL', async () => {
    let now = 0;
    let probedAt = -1;
    const tracker = new DevUrlTracker(
      { quiescenceMs: QUIESCE, pollIntervalMs: POLL },
      () => now,
      async (url) => {
        probedAt = now;
        return url === 'http://x:1/';
      },
      async (ms) => {
        now += ms;
      },
    );
    tracker.noteUrl('http://x:1/'); // noted at now=0

    const result = await tracker.waitForLive({ timeoutMs: 1000, aborted: () => false });
    assert.equal(result.url, 'http://x:1/');
    // The first probe ran only after the quiescence window elapsed.
    assert.ok(probedAt >= QUIESCE, `first probe at ${probedAt}, expected >= ${QUIESCE}`);
  });

  it('re-anchors to a newer URL noted mid-wait', async () => {
    let now = 0;
    const tracker = new DevUrlTracker(
      { quiescenceMs: QUIESCE, pollIntervalMs: POLL },
      () => now,
      async (url) => url === 'http://x:2/',
      async (ms) => {
        now += ms;
        // After the first few polls, a restart prints a fresh port.
        if (now === 3) {
          tracker.noteUrl('http://x:2/');
        }
      },
    );
    tracker.noteUrl('http://x:1/'); // dead; never live.

    const result = await tracker.waitForLive({ timeoutMs: 1000, aborted: () => false });
    assert.equal(result.url, 'http://x:2/');
  });

  it('rejects with a timeout when no URL settles and goes live', async () => {
    const tracker = makeTracker([]);
    tracker.noteUrl('http://x:1/'); // never live.

    await assert.rejects(
      () => tracker.waitForLive({ timeoutMs: 30, aborted: () => false }),
      (err: unknown) => {
        assert.ok(err instanceof DevUrlTrackerError);
        assert.equal(err.code, 'timeout');
        return true;
      },
    );
  });

  it('rejects with aborted when the predicate flips true', async () => {
    const tracker = makeTracker([]);
    tracker.noteUrl('http://x:1/');

    await assert.rejects(
      () => tracker.waitForLive({ timeoutMs: 1000, aborted: () => true }),
      (err: unknown) => {
        assert.ok(err instanceof DevUrlTrackerError);
        assert.equal(err.code, 'aborted');
        return true;
      },
    );
  });

  it('consumes one URL per call, waiting for a newer URL on the next', async () => {
    let now = 0;
    const live = new Map<string, boolean>([
      ['http://x:1/', true],
      ['http://x:2/', true],
    ]);
    const tracker = new DevUrlTracker(
      { quiescenceMs: QUIESCE, pollIntervalMs: POLL },
      () => now,
      async (url) => live.get(url) ?? false,
      async (ms) => {
        now += ms;
      },
    );
    tracker.noteUrl('http://x:1/'); // first live URL.
    const first = await tracker.waitForLive({ timeoutMs: 1000, aborted: () => false });
    assert.equal(first.url, 'http://x:1/');

    // A restart prints a fresh port while the old URL is still live. The next
    // wait must NOT re-resolve the old URL — it awaits the newer one.
    tracker.noteUrl('http://x:2/');
    const second = await tracker.waitForLive({ timeoutMs: 1000, aborted: () => false });
    assert.equal(second.url, 'http://x:2/');
  });
});
