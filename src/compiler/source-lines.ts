/**
 * Line-offset utilities for the component compiler.
 *
 * The region and SFC scanners are line-anchored, but diagnostics need absolute
 * character offsets and converted `line:column` positions. These helpers are the
 * single place that converts between an offset and a line/column, so the
 * scanners do not each reimplement newline accounting.
 *
 * The line model matches `regions.ts` and `sfc.ts`: a source is split on
 * `/\r?\n/`, so a `\r` is never part of a line and the separator width is
 * counted per line. `lineStartOffsets(source)[i]` is the absolute offset of the
 * first character of line `i` (0-based).
 */

import type { SourcePosition } from './errors.js';

/**
 * Compute the absolute start offset of every line in `source`.
 *
 * Line `0` starts at `0`; each following line starts after its `\r?\n`
 * separator, so callers can map a line index to a character offset with a single
 * lookup. The returned array is frozen.
 */
export function lineStartOffsets(source: string): readonly number[] {
  const starts: number[] = [0];
  for (let index = 0; index < source.length; index += 1) {
    const char = source.charCodeAt(index);
    if (char !== 10) {
      continue;
    }
    // A `\r\n` separator counts the `\r` as part of the previous line; the next
    // line begins after the `\n`.
    starts.push(index + 1);
  }
  return Object.freeze(starts);
}

/**
 * Convert an absolute character offset into a 1-based `line:column`.
 *
 * `offsets` must be the result of `lineStartOffsets(source)` for the same
 * source. Binary search finds the line whose start is the greatest offset
 * `<= offset`; the column is the distance from that start (1-based).
 */
export function offsetToPoint(offsets: readonly number[], offset: number): SourcePosition {
  if (offsets.length === 0) {
    return Object.freeze({ line: 1, column: 1 });
  }
  let low = 0;
  let high = offsets.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if ((offsets[mid] ?? 0) <= offset) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return Object.freeze({ line: low + 1, column: offset - (offsets[low] ?? 0) + 1 });
}
