/**
 * Admin action routes: the confirm-then-run HTTP surface for a resource's
 * header, row, and bulk actions.
 *
 * `registerActionRoutes(app, panel, resource)` mounts, under the resource root:
 *
 * - `GET/POST <slug>/actions/:actionName` — a collection-level (header/bulk)
 *   action's server-rendered confirm page and its CSRF/origin-checked run;
 * - `GET/POST <slug>/:id/actions/:actionName` — a row action's confirm page and
 *   run.
 *
 * A confirm page resolves the target records (a bulk action de-duplicates and
 * drops unknown ids through `get`; a row action fetches the single record),
 * filters them through the action's per-record `authorize` (default-allow), and
 * renders a summary plus a POST form carrying a hidden CSRF token, the resolved
 * record ids, and the canonicalized `_back` table state. On success the run
 * redirects (303) to the list with a `?_notice=<code>` flash mapped through the
 * notice registry (unknown codes are dropped). Actions run the shared
 * default-deny auth gate first, exactly like every other admin route.
 */

import type { Context, Hono } from 'hono';
import { h, type ComponentChild } from 'preact';

import type { Session } from '../contracts/http.js';
import {
  adminHtmlResponse,
  adminRedirectResponse,
  renderAdminDocumentWithTheme,
} from './document.js';
import { assertAdminMutation, assertAdminSession, readFormBody } from './guards.js';
import { ADMIN_ACTION_SUCCESS_CODE } from './notices.js';
import type { AdminAction } from './actions.js';
import type { AdminPanel } from './panel.js';
import type { Resource } from './resource.js';
import {
  buildQuery,
  canonicalizeBack,
  listQuery,
  parseListState,
  readBulkIds,
  type ListState,
} from './list-query.js';
import {
  forbiddenResponse,
  notFoundResponse,
  recordId,
  resourceAllowed,
  serverErrorResponse,
} from './routes.js';

/** Maximum records a bulk action may target in one request. */
const MAX_BULK_IDS = 100;

/** The kind of a resource action, resolved from its `actions` object. */
type ActionKind = 'header' | 'row' | 'bulk';

/** A resolved action plus the kind it was declared under. */
interface LocatedAction {
  readonly kind: ActionKind;
  readonly action: AdminAction;
}

/** Register the header/bulk (collection) and row action routes for a resource. */
export function registerActionRoutes(app: Hono, panel: AdminPanel, resource: Resource): void {
  const root = `${panel.path}/${resource.slug}`;
  app.get(`${root}/actions/:actionName`, (c) => handleCollectionActionConfirm(panel, resource, c));
  app.post(`${root}/actions/:actionName`, (c) => handleCollectionActionRun(panel, resource, c));
  app.get(`${root}/:id/actions/:actionName`, (c) => handleRowActionConfirm(panel, resource, c));
  app.post(`${root}/:id/actions/:actionName`, (c) => handleRowActionRun(panel, resource, c));
}

// ---------------------------------------------------------------------------
// Action route handlers (header/bulk and row)
// ---------------------------------------------------------------------------

/** GET <slug>/actions/:name: confirm a header or bulk action. */
async function handleCollectionActionConfirm(
  panel: AdminPanel,
  resource: Resource,
  c: Context,
): Promise<Response> {
  const session = await assertAdminSession(panel, c.req.raw);
  if (session === null) return forbiddenResponse();
  if (!(await resourceAllowed(resource, session, 'list'))) return forbiddenResponse();

  const name = c.req.param('actionName');
  if (name === undefined) return notFoundResponse();
  const located = locateAction(resource, name);
  if (located === undefined || located.kind === 'row') return notFoundResponse();

  const url = new URL(c.req.raw.url);
  const state = parseListState(url, resource);

  if (located.kind === 'header') {
    return adminHtmlResponse(
      renderActionConfirmPage(panel, resource, located.action, session, state, []),
      200,
    );
  }

  // Bulk: resolve the selected ids through `get`, dropping unknown records.
  const get = resource.get;
  if (get === undefined) return notFoundResponse();
  const records = await resolveRecords(resource, get, session, readBulkIds(url), located.action);
  return adminHtmlResponse(
    renderActionConfirmPage(panel, resource, located.action, session, state, records),
    200,
  );
}

/** POST <slug>/actions/:name: run a header or bulk action. */
async function handleCollectionActionRun(
  panel: AdminPanel,
  resource: Resource,
  c: Context,
): Promise<Response> {
  const session = await assertAdminSession(panel, c.req.raw);
  if (session === null) return forbiddenResponse();
  if (!(await resourceAllowed(resource, session, 'list'))) return forbiddenResponse();

  const name = c.req.param('actionName');
  if (name === undefined) return notFoundResponse();
  const located = locateAction(resource, name);
  if (located === undefined || located.kind === 'row') return notFoundResponse();

  const body = await readFormBody(c.req.raw);
  if (!assertAdminMutation(c.req.raw, session, body)) return forbiddenResponse();

  let records: readonly Record<string, unknown>[] = [];
  if (located.kind === 'bulk') {
    const get = resource.get;
    if (get === undefined) return notFoundResponse();
    const ids = body['ids'] === undefined ? [] : body['ids'].split(',');
    records = await resolveRecords(resource, get, session, ids, located.action);
  }
  return runAction(panel, resource, located.action, session, records, body['_back']);
}

/** GET <slug>/:id/actions/:name: confirm a row action. */
async function handleRowActionConfirm(
  panel: AdminPanel,
  resource: Resource,
  c: Context,
): Promise<Response> {
  const session = await assertAdminSession(panel, c.req.raw);
  if (session === null) return forbiddenResponse();
  if (!(await resourceAllowed(resource, session, 'list'))) return forbiddenResponse();

  const name = c.req.param('actionName');
  if (name === undefined) return notFoundResponse();
  const located = locateAction(resource, name);
  if (located === undefined || located.kind !== 'row') return notFoundResponse();

  const id = c.req.param('id');
  if (id === undefined) return notFoundResponse();
  const get = resource.get;
  if (get === undefined) return notFoundResponse();

  let record;
  try {
    record = await get({ session, id });
  } catch {
    return serverErrorResponse();
  }
  if (record === null) return notFoundResponse();

  const state = parseListState(new URL(c.req.raw.url), resource);
  const records = await authorizeRecords(resource, located.action, session, [record]);
  return adminHtmlResponse(
    renderActionConfirmPage(panel, resource, located.action, session, state, records),
    200,
  );
}

/** POST <slug>/:id/actions/:name: run a row action. */
async function handleRowActionRun(
  panel: AdminPanel,
  resource: Resource,
  c: Context,
): Promise<Response> {
  const session = await assertAdminSession(panel, c.req.raw);
  if (session === null) return forbiddenResponse();
  if (!(await resourceAllowed(resource, session, 'list'))) return forbiddenResponse();

  const name = c.req.param('actionName');
  if (name === undefined) return notFoundResponse();
  const located = locateAction(resource, name);
  if (located === undefined || located.kind !== 'row') return notFoundResponse();

  const id = c.req.param('id');
  if (id === undefined) return notFoundResponse();
  const get = resource.get;
  if (get === undefined) return notFoundResponse();

  const body = await readFormBody(c.req.raw);
  if (!assertAdminMutation(c.req.raw, session, body)) return forbiddenResponse();

  let record;
  try {
    record = await get({ session, id });
  } catch {
    return serverErrorResponse();
  }
  if (record === null) return notFoundResponse();

  const records = await authorizeRecords(resource, located.action, session, [record]);
  return runAction(panel, resource, located.action, session, records, body['_back']);
}

/** Resolve + authorize a set of record ids for a bulk action. */
async function resolveRecords(
  resource: Resource,
  get: (context: { session: Session; id: string }) => Promise<Record<string, unknown> | null>,
  session: Session,
  ids: readonly string[],
  action: AdminAction,
): Promise<Record<string, unknown>[]> {
  const records: Record<string, unknown>[] = [];
  for (const id of ids.slice(0, MAX_BULK_IDS)) {
    let record;
    try {
      record = await get({ session, id });
    } catch {
      continue;
    }
    if (record !== null) records.push(record);
  }
  return authorizeRecords(resource, action, session, records);
}

/** Filter records through the action's per-record `authorize` (default-allow). */
async function authorizeRecords(
  _resource: Resource,
  action: AdminAction,
  session: Session,
  records: readonly Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
  if (action.authorize === undefined) return [...records];
  const authorized: Record<string, unknown>[] = [];
  for (const record of records) {
    try {
      if ((await action.authorize({ session, record })) === true) authorized.push(record);
    } catch {
      // Deny on throw, exactly like every other default-deny gate.
    }
  }
  return authorized;
}

/** Run a resolved action and 303-redirect to the list with a success notice. */
async function runAction(
  panel: AdminPanel,
  resource: Resource,
  action: AdminAction,
  session: Session,
  records: readonly Record<string, unknown>[],
  back: string | undefined,
): Promise<Response> {
  try {
    await action.run({ session, path: panel.path }, records);
  } catch {
    return serverErrorResponse();
  }
  const query = canonicalizeBack(back, resource);
  const notice = action.notice ?? ADMIN_ACTION_SUCCESS_CODE;
  const separator = query === '' ? '' : `&`;
  const suffix = `_notice=${encodeURIComponent(notice)}`;
  return adminRedirectResponse(
    `${panel.path}/${resource.slug}${query === '' ? `?${suffix}` : `?${query}${separator}${suffix}`}`,
  );
}

/** Locate an action by name across header/row/bulk (names are unique). */
function locateAction(resource: Resource, name: string): LocatedAction | undefined {
  for (const kind of ['header', 'row', 'bulk'] as const) {
    const found = (resource.actions?.[kind] ?? []).find((action) => action.name === name);
    if (found !== undefined) {
      return { kind, action: found };
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Action confirm page rendering
// ---------------------------------------------------------------------------

/** The action confirm page: a summary plus a POST form (CSRF + hidden records). */
function renderActionConfirmPage(
  panel: AdminPanel,
  resource: Resource,
  action: AdminAction,
  session: Session,
  state: ListState,
  records: readonly Record<string, unknown>[],
): string {
  const root = `${panel.path}/${resource.slug}`;
  const summary =
    records.length === 0
      ? null
      : h(
          'p',
          null,
          `This will affect ${records.length} record${records.length === 1 ? '' : 's'}.`,
        );
  const children: ComponentChild[] = [h('h1', null, action.label)];
  if (action.confirm !== undefined) {
    children.push(h('p', null, action.confirm));
  }
  if (summary !== null) {
    children.push(summary);
  }
  children.push(
    h(
      'form',
      {
        method: 'post',
        action: `${root}/actions/${action.name}`,
      },
      h('input', { type: 'hidden', name: '_csrf', value: session.csrfToken }),
      ...(records.length === 0
        ? []
        : [
            h('input', {
              type: 'hidden',
              name: 'ids',
              value: records.map(recordId).filter(Boolean).join(','),
            }),
          ]),
      ...(listQuery(state) === ''
        ? []
        : [h('input', { type: 'hidden', name: '_back', value: listQuery(state) })]),
      h('button', { type: 'submit' }, 'Confirm'),
    ),
    h('a', { href: `${root}${buildQuery(state)}` }, 'Cancel'),
  );
  return renderAdminDocumentWithTheme(
    {
      title: `${panel.title} - ${action.label}`,
      theme: panel.theme,
      themeCustomization: panel.themeCustomization,
      themeTokens: panel.themeTokens,
    },
    ...children,
  );
}
