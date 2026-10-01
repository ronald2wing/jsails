/**
 * First-party `jobs` plugin: a producer-only, lazily-built dispatch surface
 * exposed as a {@link JsailsPlugin} named `jobs`.
 *
 * `jobsPlugin({ registry, adapter?, queueName?, prefix?, concurrency? })` builds
 * a plugin whose `setup` registers a {@link JobsService} under {@link jobsToken}.
 * The service carries a single `dispatch(name, payload, opts?)` method that is
 * resolved against the provided {@link JobRegistry} and, on first use, the
 * underlying {@link JobsRuntime} over the selected transport:
 *
 * - with an explicit `adapter`, that neutral {@link JobsRuntimeAdapter} is used
 *   verbatim (identity preserved) and no Valkey/Redis URL is read or validated;
 * - without an `adapter`, the built-in BullMQ adapter is used, resolving the
 *   connection URL lazily from `VALKEY_URL` (a missing URL fails
 *   the first dispatch with a value-free {@link RuntimeConfigError}).
 *
 * Construction is fully lazy: nothing connects and no handle is created at
 * import, plugin construction, or `setup` — the runtime (and, in the built-in
 * path, the adapter) is created on the first `dispatch` and reused thereafter.
 * The cleanup closes the runtime (which closes the worker then producer,
 * idempotently) and is a no-op when dispatch was never called.
 *
 * This is the dispatch side only: it never starts a worker. A worker is started
 * separately (e.g. via the `jsails work` CLI), so this plugin is safe to mount
 * in a web process that only enqueues jobs.
 */

import { definePlugin, type JsailsPlugin } from '../extensions/plugin-contract.js';
import { createServiceToken, type ServiceToken } from '../extensions/services.js';
import { signalsToken } from '../signals/plugin.js';
import { createBullMQAdapter } from './bullmq-adapter.js';
import type { JobRegistry } from './registry.js';
import { createJobsRuntime, type JobsRuntimeAdapter, type JobsRuntime } from './runtime.js';
import { resolveRuntimeValkeyUrl } from './runtime-config.js';

/** The service the `jobs` plugin provides: a producer-only dispatch surface. */
export interface JobsService {
  /** Validate and enqueue a job named in the registry. */
  dispatch(name: string, payload: unknown, opts?: unknown): Promise<unknown>;
}

/**
 * Opaque token for the {@link JobsService}. Defined once here and shared by the
 * provider (`jobsPlugin`) and any consumer (e.g. an extension's `requires`).
 */
export const jobsToken: ServiceToken<JobsService> = createServiceToken<JobsService>('jobs');

/** Options accepted by {@link jobsPlugin}. */
export interface JobsPluginOptions {
  /** The registry naming the jobs this plugin may dispatch. */
  readonly registry: JobRegistry;
  /**
   * Optional neutral transport adapter. When present it is used as-is and no
   * Valkey/Redis URL is read or validated. When absent, the built-in BullMQ
   * adapter is used, resolving `VALKEY_URL` lazily on first use.
   */
  readonly adapter?: JobsRuntimeAdapter;
  /** Queue name. Defaults to `"default"`. */
  readonly queueName?: string;
  /** Key prefix. Defaults to `"bull"`. */
  readonly prefix?: string;
  /** Worker concurrency. Defaults to 1 (unused by the dispatch-only service). */
  readonly concurrency?: number;
}

/**
 * Build the first-party `jobs` plugin. The returned plugin is inert: nothing is
 * constructed or connected until the first `dispatch` through the service.
 */
export function jobsPlugin(options: JobsPluginOptions): JsailsPlugin {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('jobsPlugin requires an options object');
  }
  const registry = options.registry;
  if (registry === null || typeof registry !== 'object') {
    throw new TypeError('jobsPlugin requires a job registry');
  }

  const resolveAdapter = (): JobsRuntimeAdapter =>
    options.adapter ?? createBullMQAdapter({ redisUrl: resolveRuntimeValkeyUrl({}) });

  return definePlugin({
    name: 'jobs',
    setup({ services }) {
      let runtime: JobsRuntime | undefined;

      function ensureRuntime(): JobsRuntime {
        if (runtime === undefined) {
          runtime = createJobsRuntime({
            registry,
            adapter: resolveAdapter(),
            queueName: options.queueName,
            prefix: options.prefix,
            concurrency: options.concurrency,
            // Emit the job lifecycle events (pushed/completed/failed/retried) on
            // the shared signals bus when the `signals` plugin is present — a
            // web process that only dispatches still publishes `jobPushed`.
            signals: services.tryGet(signalsToken),
          });
        }
        return runtime;
      }

      services.provide(jobsToken, {
        dispatch: (name, payload, opts) => ensureRuntime().dispatch(name, payload, opts),
      });

      return () => (runtime === undefined ? Promise.resolve() : runtime.close());
    },
  });
}
