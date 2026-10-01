/**
 * Internal value-selection helper.
 *
 * Browser-safe — no Node builtins, no DOM globals.
 * Nothing here is re-exported from the package entry (`src/index.ts`).
 */

/**
 * Return the first non-empty string in `values`, or `undefined` when none
 * qualifies. A value qualifies when it is a string whose `trim()` is non-empty;
 * non-string values (`undefined`, numbers) are skipped. Used to pick the first
 * configured environment variable / option across the mail, cache, and mutex
 * plugins without duplicating the fallback dance.
 */
export function firstConfigured(...values: readonly (string | undefined)[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') {
      return value;
    }
  }
  return undefined;
}
