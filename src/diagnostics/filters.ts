/**
 * Record-time and read-time filter gates for the diagnostics recorder.
 * Filters are pure predicate/transform functions — no I/O, no state.
 */

import type { DiagnosticsEntry } from './recorder.js';

/** A record-time predicate that gates whether an entry is kept. */
export type DiagnosticsFilterFn = (entry: DiagnosticsEntry) => boolean;

/** Record-time and read-time filter callbacks. */
export interface DiagnosticsFilters {
  /**
   * Per-entry gate called at record time. Returning `false` drops the entry
   * before it reaches the buffer. A throwing filter is treated as fail-closed
   * (drop) so a broken filter never leaks entries.
   */
  readonly filter?: DiagnosticsFilterFn;
  /**
   * Read-time transform applied to the result of `entries()`, after the type
   * filter. The returned array becomes the final output. A throwing filter
   * propagates to the caller (entries() does not guard it).
   */
  readonly filterBatch?: (entries: readonly DiagnosticsEntry[]) => DiagnosticsEntry[];
}

/**
 * Record-time gate: apply a filter, returning `true` when the entry should be
 * kept. A throwing filter is treated as fail-closed (drop) so a broken filter
 * never leaks entries into the buffer.
 */
export function applyFilters(entry: DiagnosticsEntry, filters: DiagnosticsFilters): boolean {
  if (filters.filter === undefined) return true;
  try {
    return filters.filter(entry);
  } catch {
    // Fail-closed: a throwing filter drops the entry rather than leaking it.
    return false;
  }
}
