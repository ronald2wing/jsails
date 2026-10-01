/**
 * Task note helpers, shared between the browser island and the server.
 *
 * This module demonstrates the function-level server seam: `summarizeNote` is
 * browser-safe and imported by the counter island, while `persistNote` is
 * marked `'use server'` so a build into a client chunk replaces its body with a
 * throwing stub — the persistence code never reaches the browser, yet the two
 * still live in one file. The runtime never calls `persistNote` from the
 * client; server components call it directly on the server.
 *
 * `summarizeNote` is intentionally pure so SSR and hydration agree.
 */

/** Collapse whitespace and bound a note to a single short display line. */
export function summarizeNote(note: string, maxLength = 40): string {
  const collapsed = note.replace(/\s+/g, ' ').trim();
  return collapsed.length > maxLength ? `${collapsed.slice(0, maxLength - 1)}…` : collapsed;
}

/**
 * Persist a note server-side. Marked `'use server'`: the body is stripped from
 * the client bundle, where the call site becomes a throwing stub. A real app
 * would replace this with its own store call; the starter keeps it dependency-
 * free and unused at runtime so the seam is visible without adding a database.
 */
export async function persistNote(note: string): Promise<void> {
  'use server';
  await Promise.resolve(note);
}
