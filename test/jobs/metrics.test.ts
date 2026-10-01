import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createJobMetrics, detectLongWaits } from '../../src/jobs/metrics.js';
import type { LongWaitThreshold } from '../../src/jobs/metrics.js';

/**
 * Unit tests for the in-memory per-job metrics collector:
 * completed/failed counting, average duration, reset, value-free errors,
 * and idempotent snapshot behaviour.
 */

describe('createJobMetrics', () => {
  it('starts with an empty snapshot', () => {
    const metrics = createJobMetrics();
    const snap = metrics.snapshot();
    assert.deepEqual(snap, {});
  });

  it('counts completed and computes average duration', () => {
    const metrics = createJobMetrics();

    metrics.recordCompleted('sendEmail', 50);
    metrics.recordCompleted('sendEmail', 70);

    const snap = metrics.snapshot();
    assert.equal(snap.sendEmail?.completed, 2);
    assert.equal(snap.sendEmail?.failed, 0);
    assert.equal(snap.sendEmail?.avgDurationMs, 60);
    assert.equal(snap.sendEmail?.lastError, undefined);
  });

  it('counts failed and captures only the error message', () => {
    const metrics = createJobMetrics();

    metrics.recordFailed('sendEmail', new Error('connection refused'));
    metrics.recordFailed('sendEmail', new Error('timeout'));

    const snap = metrics.snapshot();
    assert.equal(snap.sendEmail?.completed, 0);
    assert.equal(snap.sendEmail?.failed, 2);
    assert.equal(snap.sendEmail?.lastError, 'timeout');
  });

  it('never exposes payload or stack in lastError', () => {
    const metrics = createJobMetrics();
    const err = new Error('bad things');
    err.stack = undefined; // remove stack so we can test value-free guarantees

    metrics.recordFailed('secretJob', err);

    const snap = metrics.snapshot();
    assert.equal(snap.secretJob?.lastError, 'bad things');
    // The error message is the only property captured.
    assert.ok(typeof snap.secretJob?.lastError === 'string');
  });

  it('separates metrics per job name', () => {
    const metrics = createJobMetrics();

    metrics.recordCompleted('email', 10);
    metrics.recordCompleted('email', 20);
    metrics.recordFailed('email', new Error('fail1'));
    metrics.recordCompleted('cleanup', 100);
    metrics.recordFailed('cleanup', new Error('fail2'));
    metrics.recordFailed('cleanup', new Error('fail3'));

    const snap = metrics.snapshot();
    assert.equal(snap.email?.completed, 2);
    assert.equal(snap.email?.failed, 1);
    assert.equal(snap.email?.avgDurationMs, 15);
    assert.equal(snap.email?.lastError, 'fail1');
    assert.equal(snap.cleanup?.completed, 1);
    assert.equal(snap.cleanup?.failed, 2);
    assert.equal(snap.cleanup?.avgDurationMs, 100);
    assert.equal(snap.cleanup?.lastError, 'fail3');
  });

  it('clamps negative durations to 0', () => {
    const metrics = createJobMetrics();

    metrics.recordCompleted('job', -500);
    metrics.recordCompleted('job', 100);

    const snap = metrics.snapshot();
    assert.equal(snap.job?.avgDurationMs, 50);
  });

  it('snapshot clears after read', () => {
    const metrics = createJobMetrics();

    metrics.recordCompleted('job', 42);
    const snap1 = metrics.snapshot();
    assert.equal(snap1.job?.completed, 1);

    const snap2 = metrics.snapshot();
    assert.deepEqual(snap2, {});
  });

  it('reset clears without returning a snapshot', () => {
    const metrics = createJobMetrics();

    metrics.recordCompleted('job', 42);
    metrics.recordFailed('job', new Error('e'));

    metrics.reset();

    const snap = metrics.snapshot();
    assert.deepEqual(snap, {});
  });

  it('frozen snapshot cannot be mutated', () => {
    const metrics = createJobMetrics();
    metrics.recordCompleted('job', 10);

    const snap = metrics.snapshot();

    assert.throws(() => {
      (snap as Record<string, unknown>).job = undefined;
    }, TypeError);
  });

  it('tolerates missing job names gracefully', () => {
    const metrics = createJobMetrics();
    // snapshot of an empty collector is fine
    assert.doesNotThrow(() => metrics.snapshot());
  });

  it('computes avgDurationMs correctly with a single duration', () => {
    const metrics = createJobMetrics();

    metrics.recordCompleted('job', 17);

    const snap = metrics.snapshot();
    assert.equal(snap.job?.avgDurationMs, 17);
  });

  it('collects multiple rounds across snapshots', () => {
    const metrics = createJobMetrics();

    metrics.recordCompleted('task', 10);
    metrics.recordCompleted('task', 20);

    const snap1 = metrics.snapshot();
    assert.equal(snap1.task?.completed, 2);
    assert.equal(snap1.task?.avgDurationMs, 15);

    metrics.recordCompleted('task', 100);
    metrics.recordFailed('task', new Error('late'));

    const snap2 = metrics.snapshot();
    assert.equal(snap2.task?.completed, 1);
    assert.equal(snap2.task?.failed, 1);
    assert.equal(snap2.task?.avgDurationMs, 100);
    assert.equal(snap2.task?.lastError, 'late');
  });
});

describe('wait time', () => {
  it('recordWait accumulates and snapshot reports avgWaitMs / maxWaitMs', () => {
    const metrics = createJobMetrics();

    metrics.recordWait('sendEmail', 300);
    metrics.recordWait('sendEmail', 500);

    const snap = metrics.snapshot();
    assert.equal(snap.sendEmail?.avgWaitMs, 400);
    assert.equal(snap.sendEmail?.maxWaitMs, 500);
  });

  it('clamps negative waits to 0', () => {
    const metrics = createJobMetrics();

    metrics.recordWait('sendEmail', -100);
    metrics.recordWait('sendEmail', 200);

    const snap = metrics.snapshot();
    assert.equal(snap.sendEmail?.avgWaitMs, 100);
    assert.equal(snap.sendEmail?.maxWaitMs, 200);
  });

  it('snapshot clears wait state (second call reports 0)', () => {
    const metrics = createJobMetrics();

    metrics.recordWait('sendEmail', 300);
    const snap1 = metrics.snapshot();
    assert.equal(snap1.sendEmail?.avgWaitMs, 300);
    assert.equal(snap1.sendEmail?.maxWaitMs, 300);

    const snap2 = metrics.snapshot();
    assert.equal(snap2.sendEmail, undefined);
  });

  it('detectLongWaits returns names at or over threshold in threshold order', () => {
    const metrics = createJobMetrics();
    metrics.recordWait('email', 6000);
    metrics.recordWait('cleanup', 2000);
    metrics.recordWait('digest', 100);
    const snap = metrics.snapshot();

    const thresholds: readonly LongWaitThreshold[] = [
      { name: 'digest', thresholdMs: 5000 },
      { name: 'email', thresholdMs: 5000 },
      { name: 'cleanup', thresholdMs: 1000 },
    ];
    const result = detectLongWaits(snap, thresholds);
    assert.deepEqual(result, ['email', 'cleanup']);
  });

  it('detectLongWaits returns empty when no threshold is exceeded', () => {
    const metrics = createJobMetrics();
    metrics.recordWait('email', 100);
    const snap = metrics.snapshot();

    const thresholds: readonly LongWaitThreshold[] = [{ name: 'email', thresholdMs: 5000 }];
    const result = detectLongWaits(snap, thresholds);
    assert.deepEqual(result, []);
  });

  it('detectLongWaits skips names absent from snapshot', () => {
    const metrics = createJobMetrics();
    metrics.recordWait('email', 100);
    const snap = metrics.snapshot();

    const thresholds: readonly LongWaitThreshold[] = [{ name: 'missing', thresholdMs: 0 }];
    const result = detectLongWaits(snap, thresholds);
    assert.deepEqual(result, []);
  });

  it('detectLongWaits exact threshold match is included', () => {
    const metrics = createJobMetrics();
    metrics.recordWait('job', 5000);
    const snap = metrics.snapshot();

    const thresholds: readonly LongWaitThreshold[] = [{ name: 'job', thresholdMs: 5000 }];
    const result = detectLongWaits(snap, thresholds);
    assert.deepEqual(result, ['job']);
  });

  it('detectLongWaits returns empty for empty thresholds', () => {
    const metrics = createJobMetrics();
    metrics.recordWait('email', 9999);
    const snap = metrics.snapshot();

    const result = detectLongWaits(snap, []);
    assert.deepEqual(result, []);
  });

  it('avgWaitMs is 0 when no wait samples have been recorded', () => {
    const metrics = createJobMetrics();
    metrics.recordCompleted('email', 100);
    const snap = metrics.snapshot();
    assert.equal(snap.email?.avgWaitMs, 0);
    assert.equal(snap.email?.maxWaitMs, 0);
  });
});

describe('tagged metrics', () => {
  it('tagged completions appear under byTag', () => {
    const metrics = createJobMetrics();

    metrics.recordCompleted('sendEmail', 50, ['a', 'b']);
    metrics.recordCompleted('sendEmail', 30, ['a']);

    const snap = metrics.snapshot();
    const job = snap.sendEmail;
    assert.ok(job !== undefined);
    const byTag = job.byTag;
    assert.ok(byTag !== undefined);
    assert.equal(byTag['a']?.completed, 2);
    assert.equal(byTag['a']?.failed, 0);
    assert.equal(byTag['b']?.completed, 1);
    assert.equal(byTag['b']?.failed, 0);
  });

  it('tagged failures appear under byTag', () => {
    const metrics = createJobMetrics();

    metrics.recordFailed('sendEmail', new Error('err'), ['a']);
    metrics.recordFailed('sendEmail', new Error('err'), ['b']);

    const snap = metrics.snapshot();
    const job = snap.sendEmail;
    assert.ok(job !== undefined);
    const byTag = job.byTag;
    assert.ok(byTag !== undefined);
    assert.equal(byTag['a']?.completed, 0);
    assert.equal(byTag['a']?.failed, 1);
    assert.equal(byTag['b']?.completed, 0);
    assert.equal(byTag['b']?.failed, 1);
  });

  it('untagged records leave byTag absent', () => {
    const metrics = createJobMetrics();

    metrics.recordCompleted('sendEmail', 50);
    metrics.recordFailed('sendEmail', new Error('e'));

    const snap = metrics.snapshot();
    const job = snap.sendEmail;
    assert.ok(job !== undefined);
    assert.equal(job.completed, 1);
    assert.equal(job.failed, 1);
    assert.equal(job.byTag, undefined);
  });

  it('mixed tagged and untagged records still report byTag only for tagged ones', () => {
    const metrics = createJobMetrics();

    metrics.recordCompleted('sendEmail', 50, ['a']);
    metrics.recordCompleted('sendEmail', 30);
    metrics.recordFailed('sendEmail', new Error('e'));

    const snap = metrics.snapshot();
    const job = snap.sendEmail;
    assert.ok(job !== undefined);
    assert.equal(job.completed, 2);
    assert.equal(job.failed, 1);
    // byTag present because at least one tagged record occurred
    const byTag = job.byTag;
    assert.ok(byTag !== undefined);
    assert.equal(byTag['a']?.completed, 1);
    assert.equal(byTag['a']?.failed, 0);
  });

  it('snapshot clears byTag state (second snapshot omits it)', () => {
    const metrics = createJobMetrics();

    metrics.recordCompleted('sendEmail', 50, ['a']);
    const snap1 = metrics.snapshot();
    assert.ok(snap1.sendEmail?.byTag !== undefined);

    // No new records – second snapshot should be empty and omit byTag.
    const snap2 = metrics.snapshot();
    assert.deepEqual(snap2, {});
  });

  it('byTag is frozen', () => {
    const metrics = createJobMetrics();
    metrics.recordCompleted('sendEmail', 50, ['a']);
    const snap = metrics.snapshot();

    const job = snap.sendEmail;
    assert.ok(job !== undefined);
    const byTag = job.byTag;
    assert.ok(byTag !== undefined);
    assert.ok(Object.isFrozen(byTag));

    assert.throws(() => {
      (byTag as Record<string, unknown>)['new'] = { completed: 0, failed: 0 };
    }, TypeError);
  });

  it('tags do not leak between job names', () => {
    const metrics = createJobMetrics();

    metrics.recordCompleted('email', 10, ['a']);
    metrics.recordFailed('cleanup', new Error('err'), ['b']);

    const snap = metrics.snapshot();
    assert.equal(snap.email?.byTag?.['a']?.completed, 1);
    assert.equal(snap.email?.byTag?.['b'], undefined);
    assert.equal(snap.cleanup?.byTag?.['b']?.failed, 1);
    assert.equal(snap.cleanup?.byTag?.['a'], undefined);
  });
});
