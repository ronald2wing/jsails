/**
 * Admin relation manager routes: the HTTP surface for inline related-record
 * CRUD mounted under each resource's route prefix.
 *
 * `registerRelationManagerRoutes(app, panel, resource, manager)` mounts:
 *
 * - `GET  <resourceRoot>/<name>?parent=<parentId>` — the list table;
 * - `POST <resourceRoot>/<name>` — create (only when `manager.create` is set);
 * - `POST <resourceRoot>/<name>/<relatedId>/delete` — delete (only when
 *   `manager.delete` is set).
 *
 * Every route runs the shared default-deny auth gate (`assertAdminSession`),
 * and every POST enforces same-origin + constant-time CSRF (`_csrf` field).
 * A missing or denying session returns 403; a missing callback returns 405
 * ("read-only" in the message); a callback that throws returns 500.
 */

import type { Context } from 'hono';
import { h } from 'preact';

import { adminHtmlResponse, adminRedirectResponse, renderAdminDocument } from './document.js';
import { assertAdminMutation, assertAdminSession, readFormBody } from './guards.js';
import type { AdminPanel } from './panel.js';
import type { RelationManager } from './relation-manager.js';
import { renderRelationManager, type RenderRelationManagerOptions } from './relation-manager.js';
import type { Resource } from './resource.js';
import { forbiddenResponse, resourceAllowed, serverErrorResponse } from './routes.js';

/** A value-free 405 for a mutation on a relation manager with no corresponding callback. */
function readOnlyResponse(message: string): Response {
  return adminHtmlResponse(
    renderAdminDocument(
      'Method Not Allowed',
      undefined,
      h('h1', null, 'Method Not Allowed'),
      h('p', null, message),
    ),
    405,
  );
}

/** Strip internal hidden form fields so only field values reach the callback. */
function valuesWithoutMarkers(body: Record<string, string>): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(body)) {
    if (key !== '_csrf' && key !== '_parent') {
      values[key] = value;
    }
  }
  return values;
}

/** Validate a non-empty id parameter; returns the id or a 400 Response. */
function requireNonEmpty(value: string | undefined, label: string): string | Response {
  if (value === undefined || value.trim() === '') {
    return adminHtmlResponse(
      renderAdminDocument(
        'Bad Request',
        undefined,
        h('h1', null, 'Bad Request'),
        h('p', null, `${label} is required.`),
      ),
      400,
    );
  }
  return value;
}

/**
 * Register the relation manager's list, create, and delete routes under the
 * parent resource's route prefix.
 */
export function registerRelationManagerRoutes(
  app: import('hono').Hono,
  panel: AdminPanel,
  resource: Resource,
  manager: RelationManager,
): void {
  const root = `${panel.path}/${resource.slug}/${manager.name}`;

  app.get(root, async (c) => handleList(panel, resource, manager, c));

  if (manager.create !== undefined) {
    app.post(root, async (c) => handleCreate(panel, resource, manager, c));
  }

  if (manager.delete !== undefined) {
    app.post(`${root}/:relatedId/delete`, async (c) => handleDelete(panel, resource, manager, c));
  }
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

async function handleList(
  panel: AdminPanel,
  resource: Resource,
  manager: RelationManager,
  c: Context,
): Promise<Response> {
  const session = await assertAdminSession(panel, c.req.raw);
  if (session === null) {
    return forbiddenResponse();
  }
  if (!(await resourceAllowed(resource, session, 'list'))) {
    return forbiddenResponse();
  }

  const url = new URL(c.req.raw.url);
  const parentId = requireNonEmpty(url.searchParams.get('parent') ?? undefined, 'parent');
  if (typeof parentId !== 'string') {
    return parentId;
  }

  const page = clampInt(url.searchParams.get('page'), 1, 1);
  const pageSize = clampInt(url.searchParams.get('pageSize'), 20, 1, 100);

  let result;
  try {
    result = await manager.list({ session, parentId, page, pageSize });
  } catch {
    return serverErrorResponse();
  }

  const options: RenderRelationManagerOptions = {
    panelPath: panel.path,
    resourceSlug: resource.slug,
    csrfToken: session.csrfToken,
  };
  const html = renderRelationManager(manager, result.rows, parentId, options);
  return adminHtmlResponse(html, 200);
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

async function handleCreate(
  panel: AdminPanel,
  resource: Resource,
  manager: RelationManager,
  c: Context,
): Promise<Response> {
  const session = await assertAdminSession(panel, c.req.raw);
  if (session === null) {
    return forbiddenResponse();
  }
  if (!(await resourceAllowed(resource, session, 'update'))) {
    return forbiddenResponse();
  }

  const body = await readFormBody(c.req.raw);
  if (!assertAdminMutation(c.req.raw, session, body)) {
    return forbiddenResponse();
  }

  const parentId = requireNonEmpty(body['_parent'], 'parent');
  if (typeof parentId !== 'string') {
    return parentId;
  }

  const create = manager.create;
  if (create === undefined) {
    return readOnlyResponse('This relation manager does not accept creates.');
  }

  const values = valuesWithoutMarkers(body);
  try {
    await create({ session, parentId, values });
  } catch {
    return serverErrorResponse();
  }

  return adminRedirectResponse(
    `${panel.path}/${resource.slug}/${manager.name}?parent=${encodeURIComponent(parentId)}`,
  );
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

async function handleDelete(
  panel: AdminPanel,
  resource: Resource,
  manager: RelationManager,
  c: Context,
): Promise<Response> {
  const session = await assertAdminSession(panel, c.req.raw);
  if (session === null) {
    return forbiddenResponse();
  }
  if (!(await resourceAllowed(resource, session, 'update'))) {
    return forbiddenResponse();
  }

  const relatedId = requireNonEmpty(c.req.param('relatedId'), 'relatedId');
  if (typeof relatedId !== 'string') {
    return relatedId;
  }

  const body = await readFormBody(c.req.raw);
  if (!assertAdminMutation(c.req.raw, session, body)) {
    return forbiddenResponse();
  }

  const parentId = requireNonEmpty(body['_parent'], 'parent');
  if (typeof parentId !== 'string') {
    return parentId;
  }

  const del = manager.delete;
  if (del === undefined) {
    return readOnlyResponse('This relation manager does not accept deletes.');
  }

  try {
    await del({ session, parentId, relatedId });
  } catch {
    return serverErrorResponse();
  }

  return adminRedirectResponse(
    `${panel.path}/${resource.slug}/${manager.name}?parent=${encodeURIComponent(parentId)}`,
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse a positive integer from a query string, clamped to a range. */
function clampInt(
  raw: string | null,
  fallback: number,
  min = 1,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (raw === null || raw === '') {
    return fallback;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) {
    return fallback;
  }
  return Math.min(Math.floor(n), max);
}
