/**
 * Tests for T1.8 Slice 4: overlap policy on schedule definitions.
 *
 * Exercises `prepareSchedules` with the new `overlap` field, plus
 * `isOverlapDescriptor` structural guard unit tests.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';

import { createJobRegistry, defineJob } from '../../src/jobs/registry.js';
import {
  DEFAULT_OVERLAP_TTL_MS,
  MAX_OVERLAP_TTL_MS,
  isOverlapDescriptor,
  prepareSchedules,
} from '../../src/jobs/scheduler.js';

function stubRegistry() {
  const job = defineJob(z.object({}), async () => undefined);
  return createJobRegistry({ job });
}

describe('isOverlapDescriptor', () => {
  it('returns true for a valid descriptor', () => {
    assert.equal(isOverlapDescriptor({ key: 'schedule:my-job', ttlMs: 60_000 }), true);
    assert.equal(isOverlapDescriptor({ key: 'x', ttlMs: 1 }), true);
    assert.equal(isOverlapDescriptor({ key: 'schedule:a', ttlMs: 300_000 }), true);
  });

  it('returns false for null or non-object', () => {
    assert.equal(isOverlapDescriptor(null), false);
    assert.equal(isOverlapDescriptor(undefined), false);
    assert.equal(isOverlapDescriptor(42), false);
    assert.equal(isOverlapDescriptor('key'), false);
    assert.equal(isOverlapDescriptor(true), false);
    assert.equal(isOverlapDescriptor([]), false);
  });

  it('returns false when key is missing or empty', () => {
    assert.equal(isOverlapDescriptor({ ttlMs: 1000 }), false);
    assert.equal(isOverlapDescriptor({ key: '', ttlMs: 1000 }), false);
    assert.equal(isOverlapDescriptor({ key: '  ', ttlMs: 1000 }), false);
  });

  it('returns false when ttlMs is missing, zero, negative, or non-finite', () => {
    assert.equal(isOverlapDescriptor({ key: 'x' }), false);
    assert.equal(isOverlapDescriptor({ key: 'x', ttlMs: 0 }), false);
    assert.equal(isOverlapDescriptor({ key: 'x', ttlMs: -1 }), false);
    assert.equal(isOverlapDescriptor({ key: 'x', ttlMs: Infinity }), false);
    assert.equal(isOverlapDescriptor({ key: 'x', ttlMs: NaN }), false);
    assert.equal(isOverlapDescriptor({ key: 'x', ttlMs: '1000' }), false);
  });
});

describe('prepareSchedules overlap policy', () => {
  it('omits overlap when schedule has no overlap field', () => {
    const prepared = prepareSchedules(stubRegistry(), [{ id: 's1', job: 'job', everyMs: 5000 }]);
    assert.equal(prepared.length, 1);
    assert.equal('overlap' in prepared[0]!, false);
  });

  it('resolves overlap: true to the default key and ttl', () => {
    const prepared = prepareSchedules(stubRegistry(), [
      { id: 's1', job: 'job', everyMs: 5000, overlap: true },
    ]);
    assert.deepEqual(prepared[0]!.overlap, {
      key: 'schedule:s1',
      ttlMs: DEFAULT_OVERLAP_TTL_MS,
    });
  });

  it('resolves explicit key and ttlMs verbatim', () => {
    const prepared = prepareSchedules(stubRegistry(), [
      { id: 'my-id', job: 'job', everyMs: 5000, overlap: { key: 'custom:lock', ttlMs: 60_000 } },
    ]);
    assert.deepEqual(prepared[0]!.overlap, { key: 'custom:lock', ttlMs: 60_000 });
  });

  it('defaults the key when only ttlMs is explicit', () => {
    const prepared = prepareSchedules(stubRegistry(), [
      { id: 'id-a', job: 'job', everyMs: 5000, overlap: { ttlMs: 10_000 } },
    ]);
    assert.deepEqual(prepared[0]!.overlap, { key: 'schedule:id-a', ttlMs: 10_000 });
  });

  it('defaults the ttl when only key is explicit', () => {
    const prepared = prepareSchedules(stubRegistry(), [
      { id: 'id-b', job: 'job', everyMs: 5000, overlap: { key: 'my:key' } },
    ]);
    assert.deepEqual(prepared[0]!.overlap, { key: 'my:key', ttlMs: DEFAULT_OVERLAP_TTL_MS });
  });

  it('rejects an invalid ttl (0)', () => {
    assert.throws(
      () =>
        prepareSchedules(stubRegistry(), [
          { id: 's', job: 'job', everyMs: 5000, overlap: { ttlMs: 0 } },
        ]),
      /schedule "s"/,
    );
  });

  it('rejects an invalid ttl (negative)', () => {
    assert.throws(
      () =>
        prepareSchedules(stubRegistry(), [
          { id: 's', job: 'job', everyMs: 5000, overlap: { ttlMs: -1 } },
        ]),
      /schedule "s"/,
    );
  });

  it('rejects a non-integer ttl', () => {
    assert.throws(
      () =>
        prepareSchedules(stubRegistry(), [
          { id: 's', job: 'job', everyMs: 5000, overlap: { ttlMs: 1.5 } },
        ]),
      /schedule "s"/,
    );
  });

  it('rejects a ttl above MAX_OVERLAP_TTL_MS', () => {
    assert.throws(
      () =>
        prepareSchedules(stubRegistry(), [
          { id: 's', job: 'job', everyMs: 5000, overlap: { ttlMs: MAX_OVERLAP_TTL_MS + 1 } },
        ]),
      /schedule "s"/,
    );
  });

  it('rejects an empty key', () => {
    assert.throws(
      () =>
        prepareSchedules(stubRegistry(), [
          { id: 's', job: 'job', everyMs: 5000, overlap: { key: '' } },
        ]),
      /schedule "s"/,
    );
  });

  it('rejects a whitespace-only key', () => {
    assert.throws(
      () =>
        prepareSchedules(stubRegistry(), [
          { id: 's', job: 'job', everyMs: 5000, overlap: { key: '   ' } },
        ]),
      /schedule "s"/,
    );
  });

  it('rejects an invalid shape: number', () => {
    assert.throws(
      () =>
        prepareSchedules(stubRegistry(), [
          { id: 's', job: 'job', everyMs: 5000, overlap: 42 as unknown as true },
        ]),
      /schedule "s"/,
    );
  });

  it('rejects an invalid shape: array', () => {
    assert.throws(
      () =>
        prepareSchedules(stubRegistry(), [
          { id: 's', job: 'job', everyMs: 5000, overlap: [] as unknown as true },
        ]),
      /schedule "s"/,
    );
  });

  it('rejects an invalid shape: null', () => {
    assert.throws(
      () =>
        prepareSchedules(stubRegistry(), [
          { id: 's', job: 'job', everyMs: 5000, overlap: null as unknown as true },
        ]),
      /schedule "s"/,
    );
  });

  it('trims a key with surrounding whitespace', () => {
    const prepared = prepareSchedules(stubRegistry(), [
      { id: 'my', job: 'job', everyMs: 5000, overlap: { key: '  my:lock  ' } },
    ]);
    assert.deepEqual(prepared[0]!.overlap, { key: 'my:lock', ttlMs: DEFAULT_OVERLAP_TTL_MS });
  });
});
