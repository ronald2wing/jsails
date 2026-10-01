/**
 * Schedule definitions and validation.
 *
 * `prepareSchedules` validates a whole schedule list once — count bound,
 * duplicate ids, known jobs, interval/cron exclusivity, timezone, and payload —
 * before any registration call, and returns provider-neutral
 * {@link PreparedSchedule}s. The neutral job runtime (`./runtime.js`) uses it,
 * and the built-in BullMQ adapter maps the result onto
 * `Queue.upsertJobScheduler`. Cron *patterns* are not parsed here: the provider
 * validates them per call, and an engine/network failure can surface mid-loop,
 * so registration is not transactional — a failure may leave earlier schedules
 * registered and they are not rolled back. Ids are stable, so re-running the
 * same list is a safe idempotent retry. Timezones are validated locally with
 * `Intl`.
 *
 * Scheduling is **at-least-once**, not exactly-once: the provider deduplicates
 * scheduler registration, not execution. It does not guarantee non-overlap of
 * runs or catch-up of missed runs, so handlers must be idempotent.
 */

import type { ConnectionOptions, WorkerOptions } from 'bullmq';

import { validatePayload, type JobRegistry } from './registry.js';

/** Default IANA timezone for cron schedules. */
export const DEFAULT_TIMEZONE = 'UTC';

/** Upper bound on the number of schedules accepted in one call. */
export const MAX_SCHEDULES = 100;

/** Minimum interval (ms) for `everyMs` schedules; prevents pathological loops. */
export const MIN_INTERVAL_MS = 1000;

/** Default lock TTL for overlap control (5 minutes). */
export const DEFAULT_OVERLAP_TTL_MS = 300_000;
/** Upper bound on an overlap lock TTL (1 hour). */
export const MAX_OVERLAP_TTL_MS = 3_600_000;

/** Per-schedule overlap policy. `true` means "use the default policy". */
export interface OverlapPolicy {
  /** Custom mutex key. Defaults to `schedule:<id>`. */
  readonly key?: string;
  /** Lock TTL in ms. Defaults to {@link DEFAULT_OVERLAP_TTL_MS}. */
  readonly ttlMs?: number;
}

/** The resolved overlap descriptor carried to the worker. */
export interface OverlapDescriptor {
  readonly key: string;
  readonly ttlMs: number;
}

/** A single schedule to register. Exactly one of `everyMs` or `cron` is required. */
export interface ScheduleDefinition {
  /** Stable, unique schedule id (reused across restarts; idempotent upsert). */
  id: string;
  /** Job name; must exist in the registry. */
  job: string;
  /** Run every N milliseconds (exclusive with `cron`). */
  everyMs?: number;
  /** Cron pattern, e.g. `"0 * * * *"` (exclusive with `everyMs`). Validated by BullMQ. */
  cron?: string;
  /** IANA timezone for cron schedules. Defaults to UTC. Ignored for intervals. */
  timezone?: string;
  /** Payload passed to the job; validated against the registry schema. */
  data?: unknown;
  /** Overlap control: `true` for the default policy, or an explicit policy. */
  readonly overlap?: OverlapPolicy | true;
}

/** Raised for invalid schedule input this module rejects locally, before any registration call. */
export class ScheduleError extends Error {
  readonly scheduleId: string | undefined;

  constructor(message: string, scheduleId?: string) {
    super(message);
    this.name = 'ScheduleError';
    this.scheduleId = scheduleId;
  }
}

/** The minimal job surface the worker processor consumes. */
export interface WorkerJob {
  readonly name: string;
  readonly id?: string;
  readonly data: unknown;
  readonly attemptsMade: number;
  readonly attemptsStarted: number;
  log(message: string): Promise<unknown>;
  updateProgress(progress: number | Record<string, unknown>): Promise<void>;
}

/** The worker surface the handle needs. A BullMQ `Worker` satisfies it. */
export interface JobWorker {
  close(force?: boolean): Promise<void>;
  on(eventName: 'error', listener: (error: Error) => void): unknown;
}

/** Dependency-injection seam: builds the underlying worker. Tests pass a mock. */
export type WorkerFactory = (
  queueName: string,
  processor: (job: WorkerJob) => Promise<unknown>,
  opts: WorkerOptions<ConnectionOptions>,
) => JobWorker;

/**
 * Structural guard for a resolved overlap descriptor. Returns `true` only
 * when `value` is a non-null object with a non-empty string `key` and a
 * positive finite number `ttlMs`.
 */
export function isOverlapDescriptor(value: unknown): value is OverlapDescriptor {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.key === 'string' &&
    obj.key.trim().length > 0 &&
    typeof obj.ttlMs === 'number' &&
    Number.isFinite(obj.ttlMs) &&
    obj.ttlMs > 0
  );
}

/**
 * A schedule after local validation: provider-neutral fields plus a resolved
 * repeat. A queue provider (or the neutral job runtime) converts `repeat` to
 * its own protocol; no provider types leak out of this module.
 */
export interface PreparedSchedule {
  readonly id: string;
  readonly job: string;
  readonly repeat: { readonly every: number } | { readonly pattern: string; readonly tz: string };
  readonly data: unknown;
  /** Resolved overlap descriptor, when the schedule opts into overlap control. */
  readonly overlap?: OverlapDescriptor;
}

/**
 * Validate a whole schedule list once, before any registration call. Every
 * locally checkable property — count bound, duplicate ids, known jobs,
 * interval/cron exclusivity, timezone, payload, and overlap policy — is
 * checked here. Cron pattern validity is delegated to the provider and is
 * checked per call.
 */
export function prepareSchedules(
  registry: JobRegistry,
  schedules: readonly ScheduleDefinition[],
): PreparedSchedule[] {
  if (schedules.length > MAX_SCHEDULES) {
    throw new ScheduleError(
      `at most ${MAX_SCHEDULES} schedules are supported, got ${schedules.length}`,
    );
  }

  const prepared: PreparedSchedule[] = [];
  const seen = new Set<string>();

  for (const schedule of schedules) {
    if (typeof schedule.id !== 'string' || schedule.id.trim() === '') {
      throw new ScheduleError('schedule id must be a non-empty string');
    }
    if (seen.has(schedule.id)) {
      throw new ScheduleError(`duplicate schedule id "${schedule.id}"`, schedule.id);
    }
    seen.add(schedule.id);

    const definition = registry[schedule.job];
    if (definition === undefined) {
      throw new ScheduleError(
        `schedule "${schedule.id}" references unknown job "${schedule.job}"`,
        schedule.id,
      );
    }

    const hasEvery = schedule.everyMs !== undefined;
    const hasCron = schedule.cron !== undefined;
    if (hasEvery === hasCron) {
      throw new ScheduleError(
        `schedule "${schedule.id}" must specify exactly one of everyMs or cron`,
        schedule.id,
      );
    }

    let repeat: PreparedSchedule['repeat'];
    if (hasEvery) {
      if (schedule.timezone !== undefined) {
        throw new ScheduleError(
          `schedule "${schedule.id}" timezone is only valid with cron schedules`,
          schedule.id,
        );
      }
      const everyMs = schedule.everyMs;
      if (typeof everyMs !== 'number' || !Number.isInteger(everyMs) || everyMs < MIN_INTERVAL_MS) {
        throw new ScheduleError(
          `schedule "${schedule.id}" everyMs must be an integer >= ${MIN_INTERVAL_MS}`,
          schedule.id,
        );
      }
      repeat = { every: everyMs };
    } else {
      const cron = schedule.cron;
      if (typeof cron !== 'string' || cron.trim() === '') {
        throw new ScheduleError(
          `schedule "${schedule.id}" cron must be a non-empty string`,
          schedule.id,
        );
      }
      repeat = { pattern: cron, tz: validateTimezone(schedule.timezone, schedule.id) };
    }

    const data =
      schedule.data === undefined
        ? undefined
        : validatePayload(definition.schema, schedule.job, schedule.data);

    const overlap = resolveOverlap(schedule.overlap, schedule.id);

    // Only include `overlap` when defined so `in` checks report it absent.
    prepared.push(
      overlap !== undefined
        ? { id: schedule.id, job: schedule.job, repeat, data, overlap }
        : { id: schedule.id, job: schedule.job, repeat, data },
    );
  }

  return prepared;
}

/**
 * Resolve a schedule's overlap policy to an {@link OverlapDescriptor}.
 * Returns `undefined` when `overlap` is absent (no overlap control).
 * Rejects invalid shapes with {@link ScheduleError} — the error message
 * includes the schedule id but never echoes the offending value.
 */
function resolveOverlap(
  overlap: OverlapPolicy | true | undefined,
  scheduleId: string,
): OverlapDescriptor | undefined {
  if (overlap === undefined) {
    return undefined;
  }

  if (overlap === true) {
    return { key: `schedule:${scheduleId}`, ttlMs: DEFAULT_OVERLAP_TTL_MS };
  }

  if (overlap === null || typeof overlap !== 'object' || Array.isArray(overlap)) {
    throw new ScheduleError(
      `schedule "${scheduleId}" overlap must be true or an object`,
      scheduleId,
    );
  }

  const key = resolveOverlapKey(overlap.key, scheduleId);
  const ttlMs = resolveOverlapTtl(overlap.ttlMs, scheduleId);

  return { key, ttlMs };
}

/** Resolve the overlap key: trim and validate, defaulting to `schedule:<id>`. */
function resolveOverlapKey(raw: string | undefined, scheduleId: string): string {
  if (raw === undefined) {
    return `schedule:${scheduleId}`;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new ScheduleError(
      `schedule "${scheduleId}" overlap key must be a non-empty string`,
      scheduleId,
    );
  }
  return trimmed;
}

/** Resolve the overlap ttl: validate bounds and integer, defaulting to {@link DEFAULT_OVERLAP_TTL_MS}. */
function resolveOverlapTtl(raw: number | undefined, scheduleId: string): number {
  if (raw === undefined) {
    return DEFAULT_OVERLAP_TTL_MS;
  }
  if (
    typeof raw !== 'number' ||
    !Number.isInteger(raw) ||
    raw < MIN_INTERVAL_MS ||
    raw > MAX_OVERLAP_TTL_MS
  ) {
    throw new ScheduleError(
      `schedule "${scheduleId}" overlap ttlMs must be an integer between ${MIN_INTERVAL_MS} and ${MAX_OVERLAP_TTL_MS}`,
      scheduleId,
    );
  }
  return raw;
}

/** Validate an IANA timezone with `Intl`, defaulting to UTC. */
function validateTimezone(timezone: string | undefined, scheduleId: string): string {
  const tz = timezone ?? DEFAULT_TIMEZONE;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    throw new ScheduleError(`schedule "${scheduleId}" has invalid timezone "${tz}"`, scheduleId);
  }
  return tz;
}
