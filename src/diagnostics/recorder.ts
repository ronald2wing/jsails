/**
 * Telescope-style diagnostics recorder: an in-memory bounded ring buffer of
 * typed, value-free {@link DiagnosticsEntry} instances.
 *
 * The recorder is deliberately simple: entries are held in-process, the buffer
 * is bounded so it never grows without limit, and entry data is a plain
 * {@link Record} — no secrets, no credentials, no raw request bodies or
 * environment values.
 *
 * `wrapAsync(type, fn)` is the primary integration seam: it wraps an async
 * call, records its duration, and rethrows the error so a watcher can observe
 * the failure without swallowing it.
 */

import { createHash } from 'node:crypto';

import { type DiagnosticsFilters, applyFilters } from './filters.js';
import { type PruneOptions, pruneEntries } from './prune.js';
import { type TagCallback, createTagRegistry } from './tags.js';

/** A single recorded diagnostic entry, immutable after recording. */
export interface DiagnosticsEntry {
  /** Entry type (e.g. "http", "query", "job", "broadcast"). */
  readonly type: string;
  /** Milliseconds since epoch when the entry was recorded. */
  readonly at: number;
  /**
   * Monotonic entry identifier derived by the recorder. Never caller-supplied;
   * rendered as the decimal string `"<n>"`.
   */
  readonly id?: string;
  /**
   * Stable 12-hex-char hash of `type` + {@link data}`.family`, derived by the
   * recorder when a `family` discriminator is present. Omitted otherwise.
   */
  readonly familyHash?: string;
  /** Wall-clock duration in milliseconds, when {@link wrapAsync} recorded it. */
  readonly durationMs?: number;
  /** Value-free metadata; never contains secrets, credentials, or raw bodies. */
  readonly data?: Readonly<Record<string, unknown>>;
  /**
   * Tags derived from {@link DiagnosticsRecorderOptions.tags} callbacks at
   * record time. Each tag is a `"name:value"` string; omitted when no
   * callbacks matched or no callbacks were configured.
   */
  readonly tags?: readonly string[];
}

/**
 * Filter for {@link DiagnosticsRecorder.entries}. An omitted filter returns
 * every entry; a single type matches that string; an array matches any listed
 * type.
 */
export interface DiagnosticsFilter {
  readonly type?: string | readonly string[];
}

/** Aggregate statistics over the recorded entries. */
export interface DiagnosticsStats {
  /** Total entries currently in the buffer. */
  readonly total: number;
  /** Count of entries per type, keyed by type string. */
  readonly byType: Readonly<Record<string, number>>;
  /** How many entries carry a duration (i.e. were recorded via wrapAsync). */
  readonly withDuration: number;
  /**
   * Counts of entries whose tags intersect the {@link DiagnosticsRecorderOptions.monitored}
   * set, keyed by monitored tag name. Present only when `monitored` is set.
   */
  readonly monitoredCounts?: Readonly<Record<string, number>>;
}

/** Options for {@link createDiagnosticsRecorder}. */
export interface DiagnosticsRecorderOptions {
  /**
   * Maximum entries the buffer holds before it wraps. When the buffer is full
   * the oldest entry is evicted. Defaults to 1000.
   */
  readonly maxEntries?: number;
  /**
   * Monotonic clock returning milliseconds since epoch. Defaults to
   * {@link Date.now}. Inject a fake clock in tests.
   */
  readonly clock?: () => number;
  /**
   * Tag callbacks that derive per-entry tags at record time. A callback that
   * throws is skipped for that entry — tags must never break recording.
   */
  readonly tags?: readonly TagCallback[];
  /** Tag names whose entries are counted in {@link DiagnosticsStats.monitoredCounts}. */
  readonly monitored?: readonly string[];
  /**
   * Filters to gate recording and transform `entries()` output.
   * `filter` drops an entry at record time (fail-closed). `filterBatch` is a
   * read-time transform applied after the type filter on `entries()`.
   */
  readonly filters?: DiagnosticsFilters;
  /**
   * Whether the recorder starts actively recording. When `false` the recorder
   * is constructed silent (record/wrapAsync are no-ops) but {@link isPaused}
   * returns `false`. Call {@link resume} to enable recording. Defaults to
   * `true`.
   */
  readonly enabled?: boolean;
}

/**
 * A bounded, in-memory recorder of diagnostic entries with typed filtering
 * and aggregate statistics. Every entry is value-free — no raw secrets,
 * credentials, or environment data is recorded.
 */
export interface DiagnosticsRecorder {
  /** Record a new entry (derives `at` from the clock). */
  record(entry: Omit<DiagnosticsEntry, 'at'>): void;
  /** Return recorded entries, filtered by type when `filter.type` is set. */
  entries(filter?: DiagnosticsFilter): DiagnosticsEntry[];
  /** Discard every recorded entry. */
  clear(): void;
  /** Aggregate counts: total, per-type, and how many carry a duration. */
  stats(): DiagnosticsStats;
  /**
   * Wrap an async call, recording its duration and outcome. The entry type is
   * prefixed with `"failed:"` when `fn` throws or rejects, and the error is
   * rethrown so the caller still sees it.
   */
  wrapAsync<T>(type: string, fn: () => Promise<T>): Promise<T>;
  /**
   * Pause recording: `record` and `wrapAsync` become no-ops for new entries.
   * Existing entries, `entries()`, `stats()`, and `clear()` still work.
   * Idempotent.
   */
  pause(): void;
  /**
   * Resume recording after a pause. Also re-enables the recorder when it was
   * constructed with `enabled: false`. Idempotent.
   */
  resume(): void;
  /** Whether the recorder is currently paused via {@link pause}. */
  isPaused(): boolean;
  /**
   * Prune entries in place, returning the count of removed entries.
   * `now` defaults to the recorder's clock.
   */
  prune(options: PruneOptions, now?: number): number;
}

/** Default maximum entries when none is supplied. */
const DEFAULT_MAX_ENTRIES = 1000;

/** Default clock — a thunk so Date.now is resolved at call time. */
const DEFAULT_CLOCK = (): number => Date.now();

/** Validate creation options eagerly; throws {@link TypeError} for malformed input. */
function validateOptions(options: DiagnosticsRecorderOptions): void {
  if (options.maxEntries !== undefined) {
    if (typeof options.maxEntries !== 'number' || !Number.isFinite(options.maxEntries)) {
      throw new TypeError('maxEntries must be a finite number');
    }
    if (options.maxEntries < 1 || !Number.isInteger(options.maxEntries)) {
      throw new TypeError('maxEntries must be a positive integer');
    }
  }
  if (options.clock !== undefined && typeof options.clock !== 'function') {
    throw new TypeError('clock must be a function');
  }
  if (options.enabled !== undefined && typeof options.enabled !== 'boolean') {
    throw new TypeError('enabled must be a boolean');
  }
}

/** True when the filter's type matches the entry's type. */
function typeMatches(entry: DiagnosticsEntry, filterType: DiagnosticsFilter['type']): boolean {
  if (filterType === undefined) return true;
  if (typeof filterType === 'string') return entry.type === filterType;
  return filterType.includes(entry.type);
}

/**
 * Create a bounded, in-memory diagnostics recorder. Construction is inert —
 * the buffer is allocated but no I/O, connection, or timer is opened.
 */
export function createDiagnosticsRecorder(
  options: DiagnosticsRecorderOptions = {},
): DiagnosticsRecorder {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('options must be an object');
  }
  validateOptions(options);

  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const clock = options.clock ?? DEFAULT_CLOCK;

  // Pre-allocated ring buffer; slots are filled with `undefined` between
  // `clear()` calls, so callers always get unique entries without stale
  // data.
  const buffer: (DiagnosticsEntry | undefined)[] = new Array(maxEntries);
  let head = 0; // next write index
  let count = 0; // number of entries currently stored
  let nextId = 1; // monotonic entry id

  // Construction-time enablement: when false the recorder starts silent but isPaused() is false.
  let _disabled = options.enabled === false;
  // Runtime pause toggle.
  let _paused = false;

  // Tag derivation: built once from callbacks, called on every record.
  const tagRegistry =
    options.tags !== undefined && options.tags.length > 0
      ? createTagRegistry(options.tags)
      : undefined;

  const monitoredTags = options.monitored;

  /** Derive a stable, truncated sha1 family hash from type + discriminator. */
  const deriveFamilyHash = (type: string, family: unknown): string | undefined => {
    if (typeof family !== 'string' || family.length === 0) return undefined;
    return createHash('sha1').update(type).update(family).digest('hex').slice(0, 12);
  };

  const record = (entry: Omit<DiagnosticsEntry, 'at'>): void => {
    if (_disabled || _paused) return;

    const id = String(nextId++);
    const familyHash = deriveFamilyHash(entry.type, entry.data?.family);
    const at = clock();

    // Build the entry without tags first, since tag callbacks inspect the
    // complete entry.
    const preliminary: DiagnosticsEntry = {
      type: entry.type,
      at,
      id,
      ...(familyHash !== undefined ? { familyHash } : {}),
      ...(entry.durationMs !== undefined ? { durationMs: entry.durationMs } : {}),
      ...(entry.data !== undefined ? { data: entry.data } : {}),
    };

    // Derive tags; a throwing callback is skipped so recording is never broken.
    const derivedTags = tagRegistry !== undefined ? tagRegistry.tag(preliminary) : undefined;

    // Apply record-time filter gate (fail-closed); skip ids already consumed.
    if (options.filters !== undefined) {
      const entryForFilter: DiagnosticsEntry =
        derivedTags !== undefined && derivedTags.length > 0
          ? { ...preliminary, tags: derivedTags }
          : preliminary;
      if (!applyFilters(entryForFilter, options.filters)) return;
    }

    const complete: DiagnosticsEntry =
      derivedTags !== undefined && derivedTags.length > 0
        ? { ...preliminary, tags: derivedTags }
        : preliminary;

    buffer[head] = complete;
    head = (head + 1) % maxEntries;
    if (count < maxEntries) count += 1;
  };

  const entries = (filter: DiagnosticsFilter = {}): DiagnosticsEntry[] => {
    const filterType = filter.type;
    const result: DiagnosticsEntry[] = [];

    if (count === 0) return result;

    // Buffer wrapped, so the oldest valid entry is at `head` (the next
    // write slot) when `count === maxEntries`, or at index 0 when the
    // buffer hasn't wrapped yet.
    const start = count === maxEntries ? head : 0;

    for (let i = 0; i < count; i++) {
      const idx = (start + i) % maxEntries;
      const entry = buffer[idx];
      if (entry !== undefined && typeMatches(entry, filterType)) {
        result.push(entry);
      }
    }

    // Apply filterBatch after type filtering.
    if (options.filters?.filterBatch !== undefined) {
      return options.filters.filterBatch(result);
    }

    return result;
  };

  const clear = (): void => {
    for (let i = 0; i < maxEntries; i++) {
      buffer[i] = undefined;
    }
    head = 0;
    count = 0;
  };

  const stats = (): DiagnosticsStats => {
    const byType: Record<string, number> = {};
    let withDuration = 0;
    const monitoredCounts: Record<string, number> | undefined =
      monitoredTags !== undefined ? {} : undefined;

    const all = entries();
    for (const entry of all) {
      const prev = byType[entry.type] ?? 0;
      byType[entry.type] = prev + 1;
      if (entry.durationMs !== undefined) withDuration += 1;

      // Count entries whose tags intersect the monitored set.
      if (monitoredCounts !== undefined && entry.tags !== undefined) {
        for (const tagName of monitoredTags!) {
          const hasMatch = entry.tags.some((t) => {
            const colonIdx = t.indexOf(':');
            return (colonIdx !== -1 ? t.slice(0, colonIdx) : t) === tagName;
          });
          if (hasMatch) {
            monitoredCounts[tagName] = (monitoredCounts[tagName] ?? 0) + 1;
          }
        }
      }
    }

    const result: DiagnosticsStats =
      monitoredCounts !== undefined
        ? { total: all.length, byType, withDuration, monitoredCounts }
        : { total: all.length, byType, withDuration };
    return result;
  };

  const wrapAsync = async <T>(type: string, fn: () => Promise<T>): Promise<T> => {
    const startedAt = clock();
    try {
      const result = await fn();
      if (!_disabled && !_paused) {
        record({
          type,
          durationMs: clock() - startedAt,
          data: { status: 'success' },
        });
      }
      return result;
    } catch (error) {
      if (!_disabled && !_paused) {
        record({
          type: `failed:${type}`,
          durationMs: clock() - startedAt,
          data: { status: 'failure' },
        });
      }
      throw error;
    }
  };

  const pause = (): void => {
    _paused = true;
  };

  const resume = (): void => {
    _paused = false;
    _disabled = false;
  };

  const isPaused = (): boolean => _paused;

  const prune = (pruneOpts: PruneOptions, now?: number): number => {
    // Collect all entries from the buffer directly, bypassing read-time
    // filters so prune operates on the raw buffer contents.
    const allEntries: DiagnosticsEntry[] = [];
    const start = count === maxEntries ? head : 0;
    for (let i = 0; i < count; i++) {
      const idx = (start + i) % maxEntries;
      const entry = buffer[idx];
      if (entry !== undefined) {
        allEntries.push(entry);
      }
    }

    const retained = pruneEntries(allEntries, pruneOpts, now ?? clock());
    const removed = allEntries.length - retained.length;

    if (removed === 0) return 0;

    // Clear and rebuild the buffer with retained entries only.
    for (let i = 0; i < maxEntries; i++) {
      buffer[i] = undefined;
    }
    head = 0;
    count = 0;

    for (const entry of retained) {
      buffer[head] = entry;
      head = (head + 1) % maxEntries;
      count += 1;
    }

    return removed;
  };

  return { record, entries, clear, stats, wrapAsync, pause, resume, isPaused, prune };
}
