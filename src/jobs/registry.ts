/**
 * Job registry: the single source of truth for what jobs exist.
 *
 * A registry maps a job name to a Zod schema (validating the payload) and a
 * handler (processing it). `defineJob` infers the handler's payload type from
 * the schema, so handlers are written against a typed `data` while the
 * registry itself stays dynamically keyed — the runtime boundary that makes a
 * queue heterogeneous. Payload validation runs on both the dispatch side and
 * the worker side; errors are `JobPayloadError`s whose messages never echo the
 * offending payload.
 */

import type { z } from 'zod';

import { mapZodIssues } from '../internal/zod.js';

/** Runtime context handed to a job handler by the worker. */
export interface JobContext {
  /** BullMQ job id, when one was assigned. */
  readonly jobId: string | undefined;
  /** Job name, matching the registry key. */
  readonly name: string;
  /** Number of failed attempts so far (0 on the first run). */
  readonly attemptsMade: number;
  /** Number of times this job has started processing. */
  readonly attemptsStarted: number;
  /** Append a log row to the job (bounded by the job's `keepLogs` option). */
  log(message: string): Promise<void>;
  /** Report progress; a number (0-100) or a JSON-serializable object. */
  updateProgress(progress: number | Record<string, unknown>): Promise<void>;
}

/** A job handler: receives the validated payload and a runtime context. */
export type JobHandler<TPayload = unknown> = (
  data: TPayload,
  context: JobContext,
) => void | Promise<void>;

/**
 * A registered job. The schema is unparameterized here on purpose: a registry
 * holds jobs of many different payload shapes, so the concrete type lives at
 * each `defineJob` call site rather than in the registry container.
 */
export interface JobDefinition {
  readonly schema: z.ZodType;
  readonly handler: JobHandler<any>;
}

/** A name -> definition mapping. Keys are job names. */
export type JobRegistry = Readonly<Record<string, JobDefinition>>;

/**
 * Define a single job, inferring the handler's payload type from `schema`.
 * No decorators, no class metadata: a plain value pairing schema and handler.
 */
export function defineJob<const S extends z.ZodType>(
  schema: S,
  handler: JobHandler<z.infer<S>>,
): JobDefinition {
  return { schema, handler };
}

/**
 * Build a registry from job definitions, validating structural invariants.
 * Returns the same (already read-only-typed) object; it exists so malformed
 * registries fail loudly at construction rather than at first dispatch.
 */
export function createJobRegistry<const R extends Readonly<Record<string, JobDefinition>>>(
  jobs: R,
): Readonly<R> {
  for (const [name, definition] of Object.entries(jobs)) {
    if (name.trim() === '') {
      throw new Error('job name must be a non-empty string');
    }
    if (
      definition === undefined ||
      definition.schema === undefined ||
      typeof definition.handler !== 'function'
    ) {
      throw new Error(`job "${name}" must define a schema and a handler`);
    }
  }
  return jobs;
}

/** Raised when a dispatch or received payload fails schema validation. */
export class JobPayloadError extends Error {
  readonly jobName: string;

  constructor(jobName: string, message: string) {
    super(`invalid payload for job "${jobName}": ${message}`);
    this.name = 'JobPayloadError';
    this.jobName = jobName;
  }
}

/** Raised when a name is not present in the registry. */
export class JobNotRegisteredError extends Error {
  readonly jobName: string;

  constructor(jobName: string) {
    super(`unknown job "${jobName}"`);
    this.name = 'JobNotRegisteredError';
    this.jobName = jobName;
  }
}

/**
 * Validate a payload against a schema, throwing a payload-free
 * `JobPayloadError` on failure. Used on both sides of the queue so a bad
 * payload never reaches a handler unvalidated.
 */
export function validatePayload<S extends z.ZodType>(
  schema: S,
  jobName: string,
  payload: unknown,
): z.infer<S> {
  const result = schema.safeParse(payload);
  if (result.success) {
    return result.data;
  }
  throw new JobPayloadError(jobName, formatIssues(result.error));
}

/**
 * Join value-free issue descriptions into a single message. The canonical
 * mapper owns the per-issue wording; this only renders the `path: message`
 * shape the job error has always used.
 *
 * `unrecognized_keys` is handled here rather than through the mapper: the
 * mapper puts the (input-provided) key name in the path, but a job payload
 * error must never echo a payload-provided field name. Unknown keys are
 * collapsed to a single redacted `unknown field` entry.
 */
function formatIssues(error: z.ZodError): string {
  const parts: string[] = [];
  const known = error.issues.filter((issue) => issue.code !== 'unrecognized_keys');
  for (const entry of mapZodIssues(known)) {
    parts.push(`${entry.path === '_root' ? '(root)' : entry.path}: ${entry.message}`);
  }
  if (error.issues.some((issue) => issue.code === 'unrecognized_keys')) {
    parts.push('unknown field');
  }
  return parts.join('; ');
}
