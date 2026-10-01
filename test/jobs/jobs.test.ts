import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';

import {
  buildConnectionOptions,
  PRODUCER_MAX_RETRIES_PER_REQUEST,
} from '../../src/jobs/connection.js';
import {
  createJobRegistry,
  defineJob,
  JobPayloadError,
  validatePayload,
  type JobDefinition,
} from '../../src/jobs/registry.js';
import { JobOptionsError, validateJobOptions } from '../../src/jobs/queue.js';

/**
 * Shared job-policy unit tests that never touch Redis: connection role options,
 * registry validation, and the bounded dispatch-option allowlist. The neutral
 * runtime and the built-in BullMQ adapter are exercised separately in
 * `runtime.test.ts` and `bullmq-adapter.test.ts`.
 */

// ---------------------------------------------------------------------------
// connection options
// ---------------------------------------------------------------------------

describe('connection options', () => {
  it('gives producers finite retries and no offline queue (fast-fail)', () => {
    const opts = buildConnectionOptions('redis://host:6379', 'producer');
    assert.equal(opts.url, 'redis://host:6379');
    assert.equal(opts.maxRetriesPerRequest, PRODUCER_MAX_RETRIES_PER_REQUEST);
    assert.equal(opts.enableOfflineQueue, false);
  });

  it('gives workers null retries so blocking pops never give up', () => {
    const opts = buildConnectionOptions('redis://host:6379', 'worker');
    assert.equal(opts.url, 'redis://host:6379');
    assert.equal(opts.maxRetriesPerRequest, null);
  });
});

// ---------------------------------------------------------------------------
// registry
// ---------------------------------------------------------------------------

describe('registry', () => {
  it('defineJob infers the handler payload type from the schema', () => {
    const job = defineJob(z.object({ n: z.number() }), async (data) => {
      // Compile-time check: data is typed; asserted at runtime for safety.
      assert.equal(typeof data.n, 'number');
    });
    assert.equal(typeof job.handler, 'function');
  });

  it('createJobRegistry rejects a missing handler', () => {
    const broken = {
      broken: { schema: z.object({}), handler: undefined },
    } as unknown as Record<string, JobDefinition>;
    assert.throws(() => createJobRegistry(broken), /must define a schema and a handler/);
  });

  it('redacts unrecognized payload field names from validation errors', () => {
    const schema = z.object({ to: z.string() }).strict();
    const sensitiveKey = 'super-secret-api-key';

    assert.throws(
      () => validatePayload(schema, 'sendEmail', { to: 'a@b.co', [sensitiveKey]: 'leak' }),
      (error: unknown) => {
        assert.ok(error instanceof JobPayloadError);
        assert.ok(
          !error.message.includes(sensitiveKey),
          'error must not echo the payload-provided field name',
        );
        assert.match(error.message, /unknown field/);
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// dispatch option allowlist
// ---------------------------------------------------------------------------

describe('validateJobOptions', () => {
  it('rejects unbounded attempts', () => {
    assert.throws(() => validateJobOptions({ attempts: 1000000 }), JobOptionsError);
    assert.throws(() => validateJobOptions({ attempts: 0 }), JobOptionsError);
    assert.throws(() => validateJobOptions({ attempts: 1.5 }), JobOptionsError);
  });

  it('rejects dangerous backoff shapes', () => {
    assert.throws(() => validateJobOptions({ backoff: { type: 'custom' } }), JobOptionsError);
    assert.throws(
      () => validateJobOptions({ backoff: { type: 'fixed', delay: -1 } }),
      JobOptionsError,
    );
  });

  it('passes allowlisted options through', () => {
    const result = validateJobOptions({
      attempts: 3,
      backoff: { type: 'fixed', delay: 100 },
      delay: 10,
    });
    assert.equal(result.attempts, 3);
    assert.deepEqual(result.backoff, { type: 'fixed', delay: 100 });
    assert.equal(result.delay, 10);
  });
});
