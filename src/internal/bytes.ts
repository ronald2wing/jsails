/**
 * Internal byte-array helpers.
 *
 * Browser-safe — no Node builtins, no DOM globals.
 * Nothing here is re-exported from the package entry (`src/index.ts`).
 */

/** Concatenate a list of byte chunks into a single Uint8Array. */
export function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}
