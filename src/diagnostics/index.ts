/**
 * Diagnostics: a Telescope-style, in-memory diagnostics recorder with typed
 * entries, filtering, aggregate statistics, a first-party plugin, and an
 * export-only neutral exporter seam.
 *
 * {@link InMemoryDiagnosticsRecorder} is the bounded ring-buffer recorder.
 * {@link diagnosticsPlugin} is the first-party extension that provides it
 * under a typed service token, with an opt-in disabled/no-op mode.
 * {@link consoleExporter} and {@link HttpExporter} drain entries to external
 * destinations without pulling in any new dependencies.
 */

export {
  InMemoryDiagnosticsRecorder,
  type DiagnosticsEntry,
  type DiagnosticsFilter,
  type DiagnosticsRecorder,
  type DiagnosticsRecorderOptions,
  type DiagnosticsStats,
} from './recorder.js';

// Export-only neutral exporter seam: console, HTTP, and one-shot drain.
export {
  consoleExporter,
  DiagnosticsExporterError,
  exportOnce,
  HttpExporter,
  type ConsoleExporterOptions,
  type DiagnosticsExporter,
  type DiagnosticsExporterErrorCode,
  type HttpExporterOptions,
} from './exporter.js';

// Watcher seam: register observer-style watchers (request / query / exception)
// that record through the recorder; the registry starts/stops them as a group.
export {
  createWatcherRegistry,
  WatcherError,
  type Watcher,
  type WatcherContext,
  type WatcherRegistry,
} from './watchers/index.js';

export { RequestWatcher, type RequestWatcherOptions } from './watchers/request.js';
export { QueryWatcher, type QueryWatcherOptions, type QueryEvent } from './watchers/query.js';
export {
  ExceptionWatcherImpl,
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
