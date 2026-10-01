/**
 * Time-based pruning for the diagnostics recorder. Pure functions — no I/O,
 * no state, no connection.
 */

import type { DiagnosticsEntry } from './recorder.js';

/** Options for {@link pruneEntries}. */
export interface PruneOptions {
  /** Drop entries whose `at` is older than this many hours before `now`. */
  readonly hours: number;
  /** Always keep at least this many newest 'exception' entries regardless of age. */
  readonly keepExceptions: number;
}

/**
 * Pure function: given entries, now, and options, return the retained subset
 * sorted by `at` ascending.
 *
 * Entries older than `hours` before `now` are dropped, except the newest
 * `keepExceptions` entries whose `type === 'exception'` are always retained.
 */
export function pruneEntries(
  entries: readonly DiagnosticsEntry[],
  options: PruneOptions,
  now: number,
): readonly DiagnosticsEntry[] {
  const cutoff = now - options.hours * 60 * 60 * 1000;

  const recent: DiagnosticsEntry[] = [];
  const aged: DiagnosticsEntry[] = [];

  for (const entry of entries) {
    if (entry.at >= cutoff) {
      recent.push(entry);
    } else {
      aged.push(entry);
    }
  }

  if (options.keepExceptions <= 0 || aged.length === 0) {
    return recent.sort((a, b) => a.at - b.at);
  }

  // From aged entries, keep the newest `keepExceptions` exception entries.
  const agedExceptions = aged
    .filter((e) => e.type === 'exception')
    .sort((a, b) => b.at - a.at)
    .slice(0, options.keepExceptions);

  return [...recent, ...agedExceptions].sort((a, b) => a.at - b.at);
}
