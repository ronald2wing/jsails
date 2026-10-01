/**
 * In-memory job metrics collector.
 *
 * `createJobMetrics` builds a lightweight aggregator that measures completed
 * and failed jobs by name. It is a pure in-process counter — no external
 * service, no connection, no snapshot history — meant for a diagnostics
 * dashboard or a polling consumer that reads `snapshot()` and then `reset()`s
 * on its own cadence. Inspired by Horizon's per-job throughput + runtime
 * tracking.
 *
 * Every public method is synchronous. Errors from `recordFailed` carry only
 * the error message (value-free), never a payload or stack trace.
 */

export interface JobMetricsSnapshot {
  /** Number of times this job completed since the last reset. */
  readonly completed: number;
  /** Number of times this job failed since the last reset. */
  readonly failed: number;
  /** Mean duration in milliseconds (0 when no completed runs). */
  readonly avgDurationMs: number;
  /** Error message of the most recent failure, or undefined. */
  readonly lastError?: string;
  /** Mean wait time in milliseconds since the last reset (0 when no samples). */
  readonly avgWaitMs: number;
  /** Maximum wait time in milliseconds since the last reset (0 when no samples). */
  readonly maxWaitMs: number;
  /**
   * Per-tag completion/failure breakdown. Present only when at least one
   * tagged record was recorded for this job since the last reset; absent
   * (and byte-identical to the pre-tagging snapshot) otherwise.
   */
  readonly byTag?: Readonly<Record<string, { completed: number; failed: number }>>;
}

/** Options accepted by {@link createJobMetrics}. */
export interface JobMetricsOptions {
  /**
   * A clock returning the current time in milliseconds. Defaults to
   * `Date.now`. Inject a fake clock in tests.
   */
  readonly clock?: () => number;
}

/**
 * A bounded, in-memory collector of per-job completion and failure counts
 * plus average execution duration. Every public method is synchronous.
 */
export interface JobMetrics {
  /**
   * Record a successful job execution. `durationMs` must be non-negative;
   * negative values are clamped to 0. Optional `tags` are normalized
   * monitoring labels for a per-tag breakdown.
   */
  recordCompleted(name: string, durationMs: number, tags?: readonly string[]): void;

  /**
   * Record a job failure, capturing only the error message. Optional `tags`
   * are normalized monitoring labels for a per-tag breakdown.
   */
  recordFailed(name: string, error: Error, tags?: readonly string[]): void;

  /**
   * Record a wait-time sample. `waitMs` must be non-negative; negative values
   * are clamped to 0.
   */
  recordWait(name: string, waitMs: number): void;

  /** Return a frozen per-job summary and then clear internal counters. */
  snapshot(): Readonly<Record<string, JobMetricsSnapshot>>;

  /** Clear all accumulated metrics without returning a snapshot. */
  reset(): void;
}

/** Internal state for one job. */
interface JobMetricsState {
  completed: number;
  failed: number;
  durations: number[];
  lastError?: string;
  waitTotalMs: number;
  waitSamples: number;
  maxWaitMs: number;
  /** Per-tag completion/failure counters. Absent when no tagged records. */
  byTag?: Map<string, { completed: number; failed: number }>;
}

/**
 * Create the collector. Nothing is accumulated until `recordCompleted` or
 * `recordFailed` is called; construction is inert.
 */
export function createJobMetrics(options: JobMetricsOptions = {}): JobMetrics {
  // clock is part of the stable public API; pure-counting mode does not
  // consume it yet but caller-supplied clocks are accepted for future use.
  const _clock = options.clock;

  const jobs = new Map<string, JobMetricsState>();

  function ensure(name: string): JobMetricsState {
    let state = jobs.get(name);
    if (state === undefined) {
      state = {
        completed: 0,
        failed: 0,
        durations: [],
        waitTotalMs: 0,
        waitSamples: 0,
        maxWaitMs: 0,
      };
      jobs.set(name, state);
    }
    return state;
  }

  function recordCompleted(name: string, durationMs: number, tags?: readonly string[]): void {
    const state = ensure(name);
    state.completed++;
    state.durations.push(Math.max(0, durationMs));
    recordTags(state, tags, 'completed');
  }

  function recordFailed(name: string, error: Error, tags?: readonly string[]): void {
    const state = ensure(name);
    state.failed++;
    state.lastError = error.message;
    recordTags(state, tags, 'failed');
  }

  function recordTags(
    state: JobMetricsState,
    tags: readonly string[] | undefined,
    kind: 'completed' | 'failed',
  ): void {
    if (tags === undefined || tags.length === 0) {
      return;
    }
    if (state.byTag === undefined) {
      state.byTag = new Map();
    }
    for (const tag of tags) {
      let entry = state.byTag.get(tag);
      if (entry === undefined) {
        entry = { completed: 0, failed: 0 };
        state.byTag.set(tag, entry);
      }
      entry[kind]++;
    }
  }

  function recordWait(name: string, waitMs: number): void {
    const state = ensure(name);
    const clamped = Math.max(0, waitMs);
    state.waitTotalMs += clamped;
    state.waitSamples++;
    if (clamped > state.maxWaitMs) {
      state.maxWaitMs = clamped;
    }
  }

  function snapshot(): Readonly<Record<string, JobMetricsSnapshot>> {
    const result: Record<string, JobMetricsSnapshot> = {};

    for (const [name, state] of jobs) {
      const byTag =
        state.byTag !== undefined && state.byTag.size > 0 ? buildByTag(state.byTag) : undefined;

      const entry: JobMetricsSnapshot = {
        completed: state.completed,
        failed: state.failed,
        avgDurationMs: avgDuration(state.durations),
        lastError: state.lastError,
        avgWaitMs: avgWait(state.waitTotalMs, state.waitSamples),
        maxWaitMs: state.maxWaitMs,
        byTag,
      };

      result[name] = entry;
    }

    jobs.clear();

    return Object.freeze(result);
  }

  function reset(): void {
    jobs.clear();
  }

  return { recordCompleted, recordFailed, recordWait, snapshot, reset };
}

function avgDuration(durations: readonly number[]): number {
  if (durations.length === 0) {
    return 0;
  }
  const sum = durations.reduce((a, b) => a + b, 0);
  return Number((sum / durations.length).toFixed(2));
}

function buildByTag(
  byTag: Map<string, { completed: number; failed: number }>,
): Readonly<Record<string, { completed: number; failed: number }>> {
  const result: Record<string, { completed: number; failed: number }> = {};
  for (const [tag, counters] of byTag) {
    result[tag] = { completed: counters.completed, failed: counters.failed };
  }
  return Object.freeze(result);
}

function avgWait(totalMs: number, samples: number): number {
  if (samples === 0) {
    return 0;
  }
  return Number((totalMs / samples).toFixed(2));
}

/** A named threshold for long-wait detection. */
export interface LongWaitThreshold {
  /** Job name to check. */
  readonly name: string;
  /** Minimum max-wait in milliseconds to be considered a long wait. */
  readonly thresholdMs: number;
}

/**
 * Detect job names whose `maxWaitMs` is at or above the configured threshold.
 *
 * Returns names in threshold-declaration order. A threshold whose `name` is
 * absent from the snapshot is skipped (no entry → no violation). The result is
 * a flat list of names, each appearing at most once.
 */
export function detectLongWaits(
  snapshot: Readonly<Record<string, JobMetricsSnapshot>>,
  thresholds: readonly LongWaitThreshold[],
): readonly string[] {
  const result: string[] = [];
  for (const threshold of thresholds) {
    const entry = snapshot[threshold.name];
    if (entry !== undefined && entry.maxWaitMs >= threshold.thresholdMs) {
      result.push(threshold.name);
    }
  }
  return result;
}
