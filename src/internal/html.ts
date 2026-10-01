/**
 * Internal HTML-escaping helpers.
 *
 * Browser-safe — no Node builtins, no DOM globals.
 * Nothing here is re-exported from the package entry (`src/index.ts`).
 */

const HTML_ESCAPE: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
};

/**
 * HTML-entity-escape a string for safe embedding in an attribute value.
 * Escapes exactly four characters: `&`, `<`, `>`, `"`.
 */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (c) => HTML_ESCAPE[c] ?? c);
}
