/**
 * API Explorer route handler (`createApiExplorerHandler`).
 *
 * Wraps the pure `renderApiExplorer` function into a handler that returns a
 * web-standard `Response` with `text/html; charset=utf-8`. The handler accepts
 * a plain `Request` and ignores its method/path/body — it always returns the
 * explorer page. This is the minimal serving surface; mount it on a Hono app
 * or any request handler that accepts a `(request) => Response` function.
 */

import { renderApiExplorer } from './explorer.js';
import type { OpenApiDocument } from './openapi.js';

/** Options for {@link createApiExplorerHandler}. */
export interface ApiExplorerHandlerOptions {
  /** The OpenAPI document to render. */
  readonly spec: OpenApiDocument;
}

/**
 * Create a request handler that serves the API explorer page.
 *
 * @returns a handler `(request: Request) => Response` returning `text/html`.
 */
export function createApiExplorerHandler(
  options: ApiExplorerHandlerOptions,
): (request: Request) => Response {
  const html = renderApiExplorer(options.spec);

  return (_request: Request): Response => {
    return new Response(html, {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  };
}
