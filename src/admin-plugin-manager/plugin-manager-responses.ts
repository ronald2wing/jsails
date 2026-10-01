/**
 * Value-free HTTP responses for the plugin manager POST handlers.
 *
 * Failures shared with the core admin routes (`notFoundResponse`,
 * `serverErrorResponse`, `badRequestResponse`) are imported from
 * `../admin/responses.js` so the two surfaces stay in lockstep. The responses
 * below are specific to the plugin manager: raw error text is never emitted —
 * {@link forbiddenWithReasonResponse} surfaces a capability reason the plugin
 * manager itself produced, never a caught exception.
 */

import { h } from 'preact';

import { adminHtmlResponse, renderAdminDocument } from '../admin/document.js';

export { badRequestResponse, notFoundResponse, serverErrorResponse } from '../admin/responses.js';

/** A 403 carrying a stable, value-free reason (never raw error text). */
export function forbiddenWithReasonResponse(reason: string): Response {
  return adminHtmlResponse(
    renderAdminDocument('Forbidden', undefined, h('h1', null, 'Forbidden'), h('p', null, reason)),
    403,
  );
}

/** A 409 for an install targeting a code-managed plugin id. */
export function conflictResponse(): Response {
  return adminHtmlResponse(
    renderAdminDocument(
      'Conflict',
      undefined,
      h('h1', null, 'Conflict'),
      h('p', null, 'This plugin is managed by the application configuration.'),
    ),
    409,
  );
}

/** A value-free 400 for a failed install; the cause is never emitted. */
export function installFailureResponse(): Response {
  return adminHtmlResponse(
    renderAdminDocument(
      'Install Failed',
      undefined,
      h('h1', null, 'Install Failed'),
      h('p', null, 'The plugin could not be installed.'),
    ),
    400,
  );
}
