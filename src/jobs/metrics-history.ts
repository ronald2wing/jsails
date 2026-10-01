/**
 * Bounded, time-stamped history of JobMetrics snapshots.
 *
 * `createJobMetricsHistory` wraps a `JobMetrics` collector and records
 * snapshots on demand. It is a pure in-memory ring — no external service,
 * no timer, no connection — meant for a diagnostics dashboard that polls
 * `capture()` on its own cadence. Eviction is oldest-first (the Horizon
 * trim model).
 *
 * Construction is inert; `capture()` calls `metrics.snapshot()` which also
 * resets the underlying collector, so every captured entry represents the
 * metrics accumulated since the previous capture.
 */

import type { JobMetrics, JobMetricsSnapshot } from './metrics.js';

export interface JobMetricsHistoryOptions {
  /** Maximum number of snapshots to retain. Default 60. Must be >= 1. */
  readonly maxSnapshots?: number;
  /** Clock returning a monotonic/epoch timestamp in milliseconds. Defaults to `Date.now`. */
  readonly clock?: () => number;
}

export interface JobMetricsHistoryEntry {
  /** Clock timestamp (ms) at the moment of capture. */
  readonly at: number;
  /** Frozen per-job snapshot taken at this capture point. */
  readonly metrics: Readonly<Record<string, JobMetricsSnapshot>>;
}

export interface JobMetricsHistory {
  /** Snapshot the underlying metrics, stamp it, and push the entry. Evicts oldest when full. */
  capture(): void;
  /** Return all entries oldest-first. The returned array is a snapshot — mutating it does not affect history. */
  list(): readonly JobMetricsHistoryEntry[];
  /** Remove all recorded entries. */
  clear(): void;
}

export function createJobMetricsHistory(
  metrics: JobMetrics,
  options: JobMetricsHistoryOptions = {},
): JobMetricsHistory {
  const maxSnapshots = options.maxSnapshots ?? 60;
  const clock = options.clock ?? Date.now;

  if (typeof maxSnapshots !== 'number' || maxSnapshots < 1) {
    throw new TypeError('maxSnapshots must be a positive integer');
  }

  const entries: JobMetricsHistoryEntry[] = [];

  function capture(): void {
    entries.push({ at: clock(), metrics: metrics.snapshot() });

    // Evict oldest entries when over the bound.
    while (entries.length > maxSnapshots) {
      entries.shift();
    }
  }

  function list(): readonly JobMetricsHistoryEntry[] {
    return [...entries];
  }

  function clear(): void {
    entries.length = 0;
  }

  return { capture, list, clear };
}
