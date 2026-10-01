/**
 * Shared value-free HTTP responses for the admin surfaces.
 *
 * The route modules (`admin/routes.ts`, `resource-routes.ts`) and the plugin
 * manager both answer failures with an admin document carrying a stable status
 * and a fixed message; raw error text is never emitted. The generic responses
 * live here so the two surfaces share one definition instead of drifting.
 */

import { h } from 'preact';

import { adminHtmlResponse, renderAdminDocument } from './document.js';

/** A value-free 400 for a malformed request. */
export function badRequestResponse(): Response {
  return adminHtmlResponse(
    renderAdminDocument('Bad Request', undefined, h('h1', null, 'Bad Request')),
    400,
  );
}

/** A value-free 404 document. */
export function notFoundResponse(): Response {
  return adminHtmlResponse(
    renderAdminDocument('Not Found', undefined, h('h1', null, 'Not Found')),
    404,
  );
}

/** A value-free 500 document; internal details are never emitted. */
export function serverErrorResponse(): Response {
  return adminHtmlResponse(
    renderAdminDocument('Internal Server Error', undefined, h('h1', null, 'Internal Server Error')),
    500,
  );
}
