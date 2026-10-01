/**
 * Tag callbacks for the diagnostics recorder: attach typed labels to entries
 * without slowing the recording hot path. Tags are derived by the recorder at
 * record time; the registry is pure and opens no connection.
 */

import type { DiagnosticsEntry } from './recorder.js';

/** A named tag callback that labels an entry when its `when` predicate matches. */
export interface TagCallback {
  readonly name: string;
  readonly when: (entry: DiagnosticsEntry) => boolean;
  readonly value: (entry: DiagnosticsEntry) => string;
}

/** Maximum length of a single tag value (character count). */
const MAX_TAG_LENGTH = 64;

/** Maximum number of tags attached to a single entry. */
const MAX_TAGS = 10;

/** Tag derivation handle returned by {@link createTagRegistry}. */
export interface TagRegistry {
  tag(entry: DiagnosticsEntry): readonly string[];
}

/**
 * Build a tag derivation registry from a list of callbacks. The returned
 * `tag()` function is called on every recorded entry and returns the active
 * tags as `"name:value"` strings.
 *
 * A callback that throws is skipped for that entry — tag callbacks must never
 * break recording. Values are bounded by {@link MAX_TAG_LENGTH} and the total
 * count by {@link MAX_TAGS}.
 */
export function createTagRegistry(callbacks: readonly TagCallback[]): TagRegistry {
  const tag = (entry: DiagnosticsEntry): readonly string[] => {
    const result: string[] = [];

    for (const cb of callbacks) {
      try {
        if (!cb.when(entry)) continue;

        const raw = cb.value(entry);
        const bounded = raw.length > MAX_TAG_LENGTH ? raw.slice(0, MAX_TAG_LENGTH) : raw;
        result.push(`${cb.name}:${bounded}`);

        if (result.length >= MAX_TAGS) break;
      } catch {
        // A throwing callback is skipped for this entry — tag callbacks must
        // never break recording.
      }
    }

    return result;
  };

  return { tag };
}
