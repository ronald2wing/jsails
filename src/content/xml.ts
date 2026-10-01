/**
 * XML escaping for the content feeds and sitemap.
 *
 * Both are server-only; nothing here is re-exported from a public barrel.
 */

/** Escape XML text content: `&`, `<`, `>`. */
export function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Escape XML attribute content: `&`, `<`, `>`, `"`. */
export function escapeAttr(value: string): string {
  return escapeText(value).replace(/"/g, '&quot;');
}
