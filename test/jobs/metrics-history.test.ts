import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createJobMetricsHistory } from '../../src/jobs/metrics-history.js';
import { createJobMetrics } from '../../src/jobs/metrics.js';

describe('createJobMetricsHistory', () => {
  it('inert construction does not capture anything', () => {
    const metrics = createJobMetrics();
    const history = createJobMetricsHistory(metrics, { maxSnapshots: 10 });

    assert.deepEqual(history.list(), []);
  });

  it('capture() records an entry with the injected clock time and the snapshot', () => {
    let now = 1000;
    const metrics = createJobMetrics();
    const history = createJobMetricsHistory(metrics, {
      maxSnapshots: 10,
      clock: () => now++,
    });

    metrics.recordCompleted('sendEmail', 42);
    metrics.recordFailed('report', new Error('timeout'));

    history.capture();

    const entries = history.list();
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.at, 1000);
    assert.equal(entries[0]!.metrics.sendEmail?.completed, 1);
    assert.equal(entries[0]!.metrics.sendEmail?.avgDurationMs, 42);
    assert.equal(entries[0]!.metrics.sendEmail?.failed, 0);
    assert.equal(entries[0]!.metrics.report?.completed, 0);
    assert.equal(entries[0]!.metrics.report?.failed, 1);
    assert.equal(entries[0]!.metrics.report?.lastError, 'timeout');
  });

  it('capture() reads and resets the underlying metrics, so successive captures are disjoint', () => {
    let now = 2000;
    const metrics = createJobMetrics();
    const history = createJobMetricsHistory(metrics, {
      maxSnapshots: 10,
      clock: () => now++,
    });

    metrics.recordCompleted('task', 10);
    history.capture();

    // Next capture window -- only events recorded after the first capture appear.
    metrics.recordCompleted('task', 50);
    metrics.recordFailed('task', new Error('late'));
    history.capture();

    const entries = history.list();
    assert.equal(entries.length, 2);
    assert.equal(entries[0]!.at, 2000);
    assert.equal(entries[0]!.metrics.task?.completed, 1);
    assert.equal(entries[0]!.metrics.task?.avgDurationMs, 10);
    assert.equal(entries[0]!.metrics.task?.failed, 0);
    assert.equal(entries[0]!.metrics.task?.lastError, undefined);

    assert.equal(entries[1]!.at, 2001);
    assert.equal(entries[1]!.metrics.task?.completed, 1);
    assert.equal(entries[1]!.metrics.task?.avgDurationMs, 50);
    assert.equal(entries[1]!.metrics.task?.failed, 1);
    assert.equal(entries[1]!.metrics.task?.lastError, 'late');
  });

  it('capture() records empty snapshot when nothing happened', () => {
    let now = 3000;
    const metrics = createJobMetrics();
    const history = createJobMetricsHistory(metrics, {
      maxSnapshots: 10,
      clock: () => now++,
    });

    history.capture();

    const entries = history.list();
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.at, 3000);
    assert.deepEqual(entries[0]!.metrics, {});
  });

  it('exceeding maxSnapshots evicts the oldest entries', () => {
    let now = 4000;
    const metrics = createJobMetrics();
    const history = createJobMetricsHistory(metrics, {
      maxSnapshots: 3,
      clock: () => now++,
    });

    for (let i = 0; i < 5; i++) {
      metrics.recordCompleted(`job${i}`, 1);
      history.capture();
    }

    const entries = history.list();
    assert.equal(entries.length, 3);
    // Oldest kept are job2 (at 4002), job3 (at 4003), job4 (at 4004).
    assert.equal(entries[0]!.at, 4002);
    assert.equal(entries[1]!.at, 4003);
    assert.equal(entries[2]!.at, 4004);
    assert.ok(entries[0]!.metrics.job2);
    assert.ok(entries[1]!.metrics.job3);
    assert.ok(entries[2]!.metrics.job4);
  });

  it('list() returns oldest-first', () => {
    let now = 5000;
    const metrics = createJobMetrics();
    const history = createJobMetricsHistory(metrics, {
      maxSnapshots: 10,
      clock: () => now++,
    });

    metrics.recordCompleted('alpha', 1);
    history.capture();
    metrics.recordCompleted('beta', 2);
    history.capture();
    metrics.recordCompleted('gamma', 3);
    history.capture();

    const entries = history.list();
    assert.equal(entries.length, 3);
    assert.equal(entries[0]!.at, 5000);
    assert.equal(entries[1]!.at, 5001);
    assert.equal(entries[2]!.at, 5002);
  });

  it('list() returns a copy that does not affect internal state', () => {
    const metrics = createJobMetrics();
    const history = createJobMetricsHistory(metrics, { maxSnapshots: 10 });

    metrics.recordCompleted('job', 1);
    history.capture();

    const copy = history.list();
    // Mutating the returned array must not affect the internal ring.
    (copy as unknown[]).push({ at: 9999, metrics: {} });

    const fresh = history.list();
    assert.equal(fresh.length, 1);
  });

  it('clear() empties all entries', () => {
    const metrics = createJobMetrics();
    const history = createJobMetricsHistory(metrics, { maxSnapshots: 10 });

    metrics.recordCompleted('job', 1);
    history.capture();
    assert.equal(history.list().length, 1);

    history.clear();
    assert.deepEqual(history.list(), []);
  });

  it('clear() is idempotent on empty history', () => {
    const metrics = createJobMetrics();
    const history = createJobMetricsHistory(metrics, { maxSnapshots: 10 });

    assert.doesNotThrow(() => history.clear());
    assert.deepEqual(history.list(), []);
  });

  it('maxSnapshots < 1 throws TypeError', () => {
    const metrics = createJobMetrics();

    assert.throws(() => createJobMetricsHistory(metrics, { maxSnapshots: 0 }), {
      name: 'TypeError',
    });

    assert.throws(() => createJobMetricsHistory(metrics, { maxSnapshots: -1 }), {
      name: 'TypeError',
    });
  });

  it('defaults maxSnapshots to 60', () => {
    const metrics = createJobMetrics();
    const history = createJobMetricsHistory(metrics);

    // Capture 61 entries -- only the most recent 60 should remain.
    for (let i = 0; i < 61; i++) {
      metrics.recordCompleted('job', 1);
      history.capture();
    }

    const entries = history.list();
    assert.equal(entries.length, 60);
    // The oldest entry should be from the second capture (index 1).
    assert.ok(entries[0]!.metrics.job);
  });
});
