// Job definitions: typed, schema-validated handler pairs.
export {
  createJobRegistry,
  defineJob,
  JobPayloadError,
  JobNotRegisteredError,
  validatePayload,
  type JobContext,
  type JobDefinition,
  type JobHandler,
  type JobRegistry,
} from './registry.js';

// Per-job middleware: cross-cutting worker-side behavior (logging, metrics,
// and — in a later slice — batching/chaining).
export {
  composeMiddleware,
  JobMiddlewareError,
  type JobMiddleware,
  type JobMiddlewareContext,
} from './middleware.js';

// Queue: bounded options and validation.
export {
  DEFAULT_ATTEMPTS,
  DEFAULT_BACKOFF_MS,
  JobOptionsError,
  MAX_ATTEMPTS,
  validateJobOptions,
  type JobQueue,
} from './queue.js';

// Scheduler: at-least-once cron/interval definitions and overlap control.
export {
  DEFAULT_OVERLAP_TTL_MS,
  DEFAULT_TIMEZONE,
  MAX_OVERLAP_TTL_MS,
  MAX_SCHEDULES,
  MIN_INTERVAL_MS,
  isOverlapDescriptor,
  ScheduleError,
  type JobWorker,
  type OverlapDescriptor,
  type OverlapPolicy,
  type PreparedSchedule,
  type ScheduleDefinition,
  type WorkerJob,
} from './scheduler.js';

// Runtime config: load, validate, and resolve the work/schedule config module.
export {
  DEFAULT_RUNTIME_CONFIG_PATH,
  RuntimeConfigError,
  assertRedisUrl,
  loadRuntimeConfigModule,
  resolveRuntimeValkeyUrl,
  validateRuntimeConfig,
  type ResolvedRuntimeConfig,
  type RuntimeConfig,
} from './runtime-config.js';

// Provider-neutral runtime: bind the registry to an adapter.
export {
  createJobsRuntime,
  validateJobsRuntimeAdapter,
  JobsRuntimeError,
  JobsRuntimeClosedError,
  type JobsRuntimeOptions,
  type JobAdapterContext,
  type JobDispatchOptions,
  type JobsRuntimeAdapter,
  type JobsRuntime,
  type ProcessJob,
  type QueueCounts,
  type RuntimeJob,
  type RuntimeProducer,
  type RuntimeWorker,
  type ScheduleInfo,
} from './runtime.js';

// Awaitable lives in shared internals; re-export it here so the public
// `jsails` and `jsails/jobs` barrels still resolve it at the same name.
export { type Awaitable } from '../internal/types.js';

// Built-in BullMQ adapter: the default transport for the neutral runtime.
export { createBullMQAdapter, type BullMQAdapterOptions } from './bullmq-adapter.js';

// First-party `jobs` plugin: a producer-only, lazily-built dispatch surface.
export { jobsPlugin, jobsToken, type JobsPluginOptions, type JobsService } from './plugin.js';

// The declarative loader calls `mod.default(options)`, so every first-party
// subpath barrel must default-export its factory alongside the named export.
export { jobsPlugin as default } from './plugin.js';

// In-memory job observers: per-job metrics aggregation and the bounded failed-job
// store with retry. These are pure in-process data structures with no external
// service dependency, suitable for diagnostics recorders and admin dashboards.
export {
  createJobMetrics,
  detectLongWaits,
  type JobMetrics,
  type JobMetricsOptions,
  type JobMetricsSnapshot,
  type LongWaitThreshold,
} from './metrics.js';

export {
  createJobMetricsHistory,
  type JobMetricsHistory,
  type JobMetricsHistoryEntry,
  type JobMetricsHistoryOptions,
} from './metrics-history.js';

// Job tags: caller-supplied monitoring labels carried in dispatch options and
// available as a filter on metrics/failed-store listing.
export {
  MAX_TAG_LENGTH,
  MAX_TAGS,
  normalizeTags,
  tagFilter,
  TAG_OPTION_KEY,
  TagError,
} from './tags.js';

// Job lifecycle events: value-free observability through the shared signals bus.
export { jobPushed, jobCompleted, jobFailed, jobRetried, type JobEventPayload } from './events.js';

export {
  createFailedJobStore,
  FailedJobNotFoundError,
  type FailedJobEntry,
  type FailedJobStore,
  type FailedJobStoreOptions,
} from './failed.js';

// Job chaining: sequential, on-success continuation via per-job middleware.
export {
  chainMiddleware,
  CHAIN_OPTION_KEY,
  createJobChain,
  JobChainError,
  type ChainStep,
  type JobChain,
} from './chain.js';

// Job batching: fan-out with in-process settlement observation via per-job middleware.
export {
  createBatchCoordinator,
  createBatchMiddleware,
  createJobBatch,
  isBatchDescriptor,
  BATCH_OPTION_KEY,
  JobBatchError,
  type BatchCallbacks,
  type BatchCoordinator,
  type BatchFailedSummary,
  type BatchFailure,
  type BatchItem,
  type BatchSummary,
  type JobBatch,
} from './batch.js';

// Shared-store batch coordinator: a `BatchCoordinator` backed by the `CacheStore`
// contract so producer and worker processes share batch progress (multi-process).
export {
  createSharedBatchCoordinator,
  SharedBatchCoordinatorError,
} from './shared-batch-coordinator.js';

// Durable schedule pause: an opt-in `PausedScheduleStore` (memory or cache-backed)
// so a paused schedule stays paused across a `work` restart.
export {
  createMemoryPausedScheduleStore,
  createCachePausedScheduleStore,
  PausedScheduleError,
  type PausedScheduleStore,
  type CachePausedScheduleStoreOptions,
} from './paused-schedules.js';

// Overlap control: mutex-backed middleware preventing concurrent scheduled runs.
export { createOverlapMiddleware, OVERLAP_OPTION_KEY } from './overlap.js';
