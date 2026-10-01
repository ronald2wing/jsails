/**
 * The read surface a jobs dashboard renders: the worker-owned metrics collector and
 * failed-job store, plus an optional queue-counts reader.
 *
 * Metrics and the failed store are owned by the *worker* process (they accumulate
 * per-process as jobs run) — there is no process-global registry to read them from.
 * A jobs dashboard therefore renders whatever a source the application injects:
 * `jobsPlugin({ registry, dashboard })` accepts the same {@link JobsDashboardSource}
 * (validated eagerly at boot), and {@link import('./dashboard.js').jobsDashboard}
 * renders it read-only in the admin panel. The page never fabricates data when a
 * source (or a capability within it) is absent — it reports `unavailable` instead.
 *
 * This module is dependency-light on purpose: it imports only the metric, failed-store,
 * and queue-count contracts (all types) so both the producer plugin and the admin page
 * can share the source type and its validation without pulling the admin/Preact graph
 * into the producer path.
 */

import type { FailedJobStore } from './failed.js';
import type { JobMetrics } from './metrics.js';
import type { QueueCounts } from './runtime.js';

/**
 * The read-only data a jobs dashboard renders.
 *
 * `metrics` and `failed` are required: they are the per-job completion/failure
 * counts and the bounded recent-failures list, both worker-owned and injected by
 * the application. `readCounts` is optional — it exposes the live queue's
 * waiting/active/completed/failed/delayed totals through the transport's
 * `readCounts` capability; when absent (or when the transport has no countable
 * queue) the dashboard renders the queue section as `unavailable`.
 */
export interface JobsDashboardSource {
  /** Per-job completion/failure/wait metrics (worker-owned). */
  readonly metrics: JobMetrics;
  /** The bounded recent-failures store (worker-owned). */
  readonly failed: FailedJobStore;
  /** Optional live queue-counts reader (e.g. the runtime's `readCounts()`). */
  readonly readCounts?: () => Promise<QueueCounts>;
}

/** Raised for an invalid jobs dashboard source. Messages never embed values. */
export class JobsDashboardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JobsDashboardError';
  }
}

/**
 * Validate a jobs dashboard source structurally: a `metrics` object with a
 * `snapshot` function and a `failed` object with a `list` function, plus an
 * optional `readCounts` function. Throws a value-free {@link JobsDashboardError}
 * on any violation. This is the single validation shared by `jobsPlugin` (boot
 * time) and the admin page factory, so a miswired source fails as early as
 * possible rather than surfacing as a broken render.
 */
export function validateJobsDashboardSource(
  source: unknown,
): asserts source is JobsDashboardSource {
  if (source === null || typeof source !== 'object' || Array.isArray(source)) {
    throw new JobsDashboardError('jobs dashboard source must be an object');
  }
  const metrics = (source as { metrics?: unknown }).metrics;
  if (
    metrics === null ||
    typeof metrics !== 'object' ||
    typeof (metrics as { snapshot?: unknown }).snapshot !== 'function'
  ) {
    throw new JobsDashboardError('jobs dashboard source requires a job metrics collector');
  }
  const failed = (source as { failed?: unknown }).failed;
  if (
    failed === null ||
    typeof failed !== 'object' ||
    typeof (failed as { list?: unknown }).list !== 'function'
  ) {
    throw new JobsDashboardError('jobs dashboard source requires a failed-job store');
  }
  const readCounts = (source as { readCounts?: unknown }).readCounts;
  if (readCounts !== undefined && typeof readCounts !== 'function') {
    throw new JobsDashboardError('jobs dashboard readCounts must be a function when present');
  }
}
