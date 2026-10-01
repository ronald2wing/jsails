/**
 * Internal HTTP-shape helpers.
 *
 * Kept dependency-free (no Node runtime imports, no browser globals beyond the
 * standard `URL`) so the browser-safe `jsails/client` bundle and server modules
 * can both import it. Nothing here is re-exported from the package entry
 * (`src/index.ts`).
 */

/** True for `http(s)` origins only: no path, query, fragment, or credentials. */
export function isHttpOrigin(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.username === '' &&
      url.password === '' &&
      url.pathname === '/' &&
      url.search === '' &&
      url.hash === ''
    );
  } catch {
    return false;
  }
}

/**
 * True for a root-relative path of the form `/seg/seg`:
 * starts with `/`, is not protocol-relative (`//`), contains no backslash,
 * NUL, control character, or `..` segment.
 */
export function isValidRelativePath(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  if (value.length === 0 || value[0] !== '/') {
    return false;
  }
  // Reject protocol-relative paths that would escape the origin.
  if (value.startsWith('//')) {
    return false;
  }
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    // backslash, NUL, and control characters are filesystem/URL hazards
    if (code === 0x5c || code === 0x00 || code < 0x20) {
      return false;
    }
  }
  if (value.split('/').some((segment) => segment === '..')) {
    return false;
  }
  return true;
}
