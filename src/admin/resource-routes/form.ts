/**
 * Admin resource form routes: the empty create form and the populated edit form
 * (`GET <slug>/new` and `GET <slug>/:id`).
 *
 * Both handlers run the shared default-deny auth gate first, then the resource's
 * own `authorize` (`create`/`view`), preserve the whitelisted table state, and
 * render the shared form page. The edit form resolves the record through the
 * trusted `get` callback (a throw is a 500, `null`/absent `get` is a 404).
 * Markup is server-rendered through Preact, which owns all escaping.
 */

import type { Context } from 'hono';

import { adminHtmlResponse } from '../document.js';
import { assertAdminSession } from '../guards.js';
import { listQuery, parseListState } from '../list-query.js';
import type { AdminPanel } from '../panel.js';
import { renderRelationManager } from '../relation-manager.js';
import { renderFormPage } from '../resource/render.js';
import type { Resource } from '../resource.js';
import {
  forbiddenResponse,
  notFoundResponse,
  resourceAllowed,
  serverErrorResponse,
} from '../routes.js';

/**
 * Render each inline relation manager for a record id into an HTML string
 * safe to embed. `renderRelationManager` server-renders the table through
 * Preact (escaping every cell), so its output — and only its output — is the
 * trusted source the form page injects. A manager whose `list` throws is
 * omitted from the page (a related-row failure must not 500 the parent form).
 */
async function renderInlineManagers(
  panel: AdminPanel,
  resource: Resource,
  session: NonNullable<Awaited<ReturnType<typeof assertAdminSession>>>,
  parentId: string,
): Promise<readonly string[]> {
  const managers = resource.relationManagers ?? [];
  if (managers.length === 0) {
    return [];
  }
  const rendered: string[] = [];
  for (const manager of managers) {
    try {
      const result = await manager.list({ session, parentId, page: 1, pageSize: 25 });
      rendered.push(
        renderRelationManager(manager, result.rows, parentId, {
          panelPath: panel.path,
          resourceSlug: resource.slug,
          csrfToken: session.csrfToken,
        }),
      );
    } catch {
      // A single manager's list failure is isolated: the parent form still
      // renders, and the offending manager is dropped rather than surfacing a
      // raw callback error to the admin.
    }
  }
  return rendered;
}

/** GET <slug>/new: the empty create form, preserving any table state. */
export async function handleCreateForm(
  panel: AdminPanel,
  resource: Resource,
  c: Context,
): Promise<Response> {
  const session = await assertAdminSession(panel, c.req.raw);
  if (session === null) {
    return forbiddenResponse();
  }
  if (!(await resourceAllowed(resource, session, 'create'))) {
    return forbiddenResponse();
  }
  const state = parseListState(new URL(c.req.raw.url), resource);
  return adminHtmlResponse(
    renderFormPage(panel, resource, {
      id: null,
      values: {},
      errors: {},
      csrf: session.csrfToken,
      action: `${panel.path}/${resource.slug}`,
      back: listQuery(state),
    }),
    200,
  );
}

/** GET <slug>/:id: the edit form populated from `get`, preserving table state. */
export async function handleEditForm(
  panel: AdminPanel,
  resource: Resource,
  c: Context,
): Promise<Response> {
  const session = await assertAdminSession(panel, c.req.raw);
  if (session === null) {
    return forbiddenResponse();
  }
  const id = c.req.param('id');
  if (id === undefined) {
    return notFoundResponse();
  }
  if (!(await resourceAllowed(resource, session, 'view', id))) {
    return forbiddenResponse();
  }
  const get = resource.get;
  if (get === undefined) {
    return notFoundResponse();
  }
  let record;
  try {
    record = await get({ session, id });
  } catch {
    return serverErrorResponse();
  }
  if (record === null) {
    return notFoundResponse();
  }
  const state = parseListState(new URL(c.req.raw.url), resource);
  const relationManagerHtml = await renderInlineManagers(panel, resource, session, id);
  return adminHtmlResponse(
    renderFormPage(panel, resource, {
      id,
      record,
      values: {},
      errors: {},
      csrf: session.csrfToken,
      action: `${panel.path}/${resource.slug}/${id}`,
      back: listQuery(state),
      relationManagerHtml,
    }),
    200,
  );
}
