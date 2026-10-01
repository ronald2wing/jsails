/**
 * Job lifecycle event tokens and payload.
 *
 * Four signals — `jobPushed`, `jobCompleted`, `jobFailed`, `jobRetried` —
 * are emitted at well-defined boundaries by the provider-neutral job runtime.
 * Every payload is value-free: name, jobId, attemptsMade only, never data/opts.
 */
import { defineEvent } from '../extensions/interceptors.js';

/** Value-free snapshot of a job lifecycle event. */
export interface JobEventPayload {
  /** The registered job name. */
  readonly name: string;
  /** The provider's job id, undefined at dispatch time. */
  readonly jobId: string | undefined;
  /** Attempts made so far (failed/retried events only). */
  readonly attemptsMade?: number;
}

/** Emitted after a successful `producer.dispatch` inside the runtime. */
export const jobPushed = defineEvent<JobEventPayload>('job.pushed');

/** Emitted after the handler resolves successfully. */
export const jobCompleted = defineEvent<JobEventPayload>('job.completed');

/** Emitted when the handler throws, before re-throwing. */
export const jobFailed = defineEvent<JobEventPayload>('job.failed');

/**
 * Emitted together with `jobFailed` when `attemptsMade > 0` — a retry is
 * pending at the transport level. The runtime does not own retry policy.
 */
export const jobRetried = defineEvent<JobEventPayload>('job.retried');
