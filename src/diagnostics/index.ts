/**
 * Diagnostics: a Telescope-style, in-memory diagnostics recorder with typed
 * entries, filtering, aggregate statistics, and a first-party plugin.
 *
 * The {@link createDiagnosticsRecorder} factory builds the bounded ring-buffer
 * recorder. {@link diagnosticsPlugin} is the first-party extension that
 * provides it under a typed service token, with an opt-in disabled/no-op mode.
 */

export {
  createDiagnosticsRecorder,
  type DiagnosticsEntry,
  type DiagnosticsFilter,
  type DiagnosticsRecorder,
  type DiagnosticsRecorderOptions,
  type DiagnosticsStats,
} from './recorder.js';

// Watcher seam: register observer-style watchers (request / query / exception)
// that record through the recorder; the registry starts/stops them as a group.
export {
  createWatcherRegistry,
  WatcherError,
  type Watcher,
  type WatcherContext,
  type WatcherRegistry,
} from './watchers.js';

export { createRequestWatcher, type RequestWatcherOptions } from './watchers/request.js';
export { createQueryWatcher, type QueryWatcherOptions, type QueryEvent } from './watchers/query.js';
export {
  createExceptionWatcher,
  type ExceptionWatcherOptions,
  type CapturedError,
} from './watchers/exception.js';

// Tag callbacks + monitored tags.
export { createTagRegistry, type TagCallback } from './tags.js';

// Filtering callbacks + pruning.
export { applyFilters, type DiagnosticsFilterFn, type DiagnosticsFilters } from './filters.js';
export { pruneEntries, type PruneOptions } from './prune.js';

export {
  diagnosticsPlugin,
  diagnosticsToken,
  type Diagnostics,
  type DiagnosticsPluginOptions,
} from './plugin.js';

// The `diagnostics` factory is the subpath's default export, matching every
// other first-party plugin subpath: `plugins.use` resolves a specifier by
// importing the default export and calling it with the options tuple.
export { diagnosticsPlugin as default } from './plugin.js';
