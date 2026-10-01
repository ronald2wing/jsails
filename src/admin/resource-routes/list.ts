/**
 * Admin resource list route: the sortable, filterable, searchable, paginated
 * list table (`GET <slug>`).
 *
 * The handler runs the shared default-deny auth gate first, then the resource's
 * own `authorize` (default-allow when absent; exact `true` when present), parses
 * the whitelisted list-table state, invokes the trusted `list` callback, and
 * renders the list page. Markup is server-rendered through Preact, which owns
 * all escaping.
 */

import type { Context } from 'hono';

import { adminHtmlResponse } from '../document.js';
import { assertAdminSession } from '../guards.js';
import { parseListState } from '../list-query.js';
import type { AdminPanel } from '../panel.js';
import { renderListPage } from '../resource/render.js';
import type { Resource, ResourceListContext } from '../resource.js';
import { forbiddenResponse, readNotice, resourceAllowed, serverErrorResponse } from '../routes.js';

/** GET <slug>: the sortable, filterable, searchable, paginated list table. */
export async function handleList(
  panel: AdminPanel,
  resource: Resource,
  c: Context,
): Promise<Response> {
  const session = await assertAdminSession(panel, c.req.raw);
  if (session === null) {
    return forbiddenResponse();
  }
  if (!(await resourceAllowed(resource, session, 'list'))) {
    return forbiddenResponse();
  }
  const state = parseListState(new URL(c.req.raw.url), resource);
  const context: ResourceListContext = {
    session,
    page: state.page,
    pageSize: state.pageSize,
    ...(state.sort !== undefined ? { sort: state.sort, direction: state.direction } : {}),
    ...(state.search !== undefined ? { search: state.search } : {}),
    ...(Object.keys(state.filters).length > 0 ? { filters: state.filters } : {}),
  };
  let result;
  try {
    result = await resource.list(context);
  } catch {
    return serverErrorResponse();
  }
  const notice = readNotice(new URL(c.req.raw.url), panel);
  return adminHtmlResponse(await renderListPage(panel, resource, result, state, notice), 200);
}
