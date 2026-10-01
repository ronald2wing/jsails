/**
 * Internal value-free response factories.
 *
 * Every response body here is a stable, hardcoded string — no submitted value,
 * token, error detail, or session id is ever interpolated. These are pure
 * `Response` constructors with no Node imports; they may be re-exported from
 * `jsails/extensions` later.
 */

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

/** Build a plain-text response with a fixed body and status. */
function textResponse(
  body: string,
  status: number,
  extraHeaders?: Record<string, string>,
): Response {
  const headers = new Headers({ 'content-type': 'text/plain; charset=utf-8' });
  if (extraHeaders !== undefined) {
    for (const [name, value] of Object.entries(extraHeaders)) {
      headers.set(name, value);
    }
  }
  return new Response(body, { status, headers });
}

// ---------------------------------------------------------------------------
// Status-specific factories
// ---------------------------------------------------------------------------

/**
 * A value-free 403 Forbidden response. The body is the single word "Forbidden"
 * with no request or user detail echoed.
 */
export function forbiddenResponse(): Response {
  return textResponse('Forbidden', 403);
}

/**
 * A value-free 400 Bad Request response. The body is "Bad Request" with no
 * request detail echoed.
 */
export function badRequestResponse(): Response {
  return textResponse('Bad Request', 400);
}

/**
 * A value-free 404 Not Found response. The body is "Not Found" with no path
 * or resource detail echoed.
 */
export function notFoundResponse(): Response {
  return textResponse('Not Found', 404);
}

// ---------------------------------------------------------------------------
// Cache-control helper
// ---------------------------------------------------------------------------

/**
 * Attach a `Cache-Control: no-store` header to an existing response, preserving
 * every other header, status, and the original body. The caller's response is
 * never modified — a new `Response` is returned.
 */
export function attachNoStore(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('cache-control', 'no-store');
  return new Response(response.body, {
    status: response.status,
    headers,
  });
}
