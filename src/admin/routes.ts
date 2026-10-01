/**
 * Admin routes: the panel/page mounting and the shared default-deny gates.
 *
 * `registerAdminRoutes(app, panel, contributions)` mounts the dashboard, the
 * global search page, and every page's `GET`/`POST` under `panel.path`;
 * `registerAdminNotFound(app, panel)` mounts the catch-all 404 that must be
 * registered last. Resource CRUD and action routes are registered separately by
 * `registerResourceRoutes` (see `resource-routes.ts`), so the caller wires the
 * full sequence — dashboard, search, pages, then resources, then the catch-all —
 * in that order.
 *
 * The shared gates live here and are re-used by the resource and action route
 * modules: `resourceAllowed` runs a resource's own `authorize` (default-allow
 * when absent, exact `true` when present), and `guarded` wraps a plain renderer
 * with the panel's `assertAdminSession` default-deny gate. The value-free deny
 * responses (`forbiddenResponse`, `notFoundResponse`, `readOnlyResponse`,
 * `pageReadOnlyResponse`, `serverErrorResponse`), the `readNotice` flash
 * resolver, and the `recordId` row-key helper are exported for the same reason.
 *
 * Every route runs the same default-deny auth gate first: resolve the session
 * through the trusted `resolveSession` (a throwing or rejecting resolver fails
 * closed), then require the `authorize` callback to resolve to exactly `true`.
 * Pages are server-rendered through Preact and the shared render-to-string
 * wrapper; every dynamic value is emitted as a text child or attribute so
 * Preact owns escaping.
 */

import type { Context, Hono } from 'hono';
import { h, type ComponentChild } from 'preact';

import type { Session } from '../contracts/http.js';
import {
  adminHtmlResponse,
  renderAdminDocument,
  renderAdminDocumentWithTheme,
} from './document.js';
import { assertAdminMutation, assertAdminSession, readFormBody } from './guards.js';
import { renderGlobalSearch } from './global-search.js';
import { ADMIN_ACTION_SUCCESS_NOTICE, type Notice } from './notices.js';
import type { AdminNavigationItem } from './admin-plugin.js';
import type { AdminPage } from './page.js';
import type { AdminPanel } from './panel.js';
import type { Resource, ResourceAction } from './resource.js';

/** Every contribution mounted under the panel path, collected once at setup. */
export interface Contributions {
  readonly pages: readonly AdminPage[];
  readonly resources: readonly Resource[];
  readonly navItems: readonly AdminNavigationItem[];
}

/** A normalized navigation entry (group keyed as `''` for top-level). */
interface NavItem {
  readonly label: string;
  readonly href: string;
  readonly group: string;
  readonly sort: number;
  readonly badge?: string;
}

/** Register the dashboard, page, and search routes under the panel path. */
export function registerAdminRoutes(
  app: Hono,
  panel: AdminPanel,
  contributions: Contributions,
): void {
  const base = panel.path;
  app.get(base, (c) => handleDashboard(panel, contributions, c));
  app.get(`${base}/_search`, (c) => handleGlobalSearch(panel, contributions, c));
  for (const page of contributions.pages) {
    app.get(`${base}/${page.slug}`, (c) => handlePageGet(panel, page, c));
    app.post(`${base}/${page.slug}`, (c) => handlePagePost(panel, page, c));
  }
}

/** Register the catch-all 404, which must be mounted after every other route. */
export function registerAdminNotFound(app: Hono, panel: AdminPanel): void {
  app.get(
    `${panel.path}/*`,
    guarded(panel, () => renderNotFound(panel), 404),
  );
}

/** Wrap a page renderer with the shared default-deny auth gate. */
function guarded(
  panel: AdminPanel,
  render: () => string,
  status = 200,
): (c: Context) => Promise<Response> {
  return async (c) => {
    if ((await assertAdminSession(panel, c.req.raw)) === null) {
      return forbiddenResponse();
    }
    return adminHtmlResponse(render(), status);
  };
}

// ---------------------------------------------------------------------------
// Page route handlers
// ---------------------------------------------------------------------------

/** GET <slug>: render the page's full document HTML. */
async function handlePageGet(panel: AdminPanel, page: AdminPage, c: Context): Promise<Response> {
  const session = await assertAdminSession(panel, c.req.raw);
  if (session === null) {
    return forbiddenResponse();
  }
  let html: unknown;
  try {
    html = await page.render(pageRenderContext(panel, page, session, c));
  } catch {
    return serverErrorResponse();
  }
  if (typeof html !== 'string') {
    return serverErrorResponse();
  }
  return adminHtmlResponse(html, 200);
}

/** POST <slug>: enforce origin/CSRF, then delegate to the page's `handlePost`. */
async function handlePagePost(panel: AdminPanel, page: AdminPage, c: Context): Promise<Response> {
  const session = await assertAdminSession(panel, c.req.raw);
  if (session === null) {
    return forbiddenResponse();
  }
  const handlePost = page.handlePost;
  if (handlePost === undefined) {
    return pageReadOnlyResponse();
  }
  const body = await readFormBody(c.req.raw);
  if (!assertAdminMutation(c.req.raw, session, body)) {
    return forbiddenResponse();
  }
  try {
    return await handlePost(pagePostContext(panel, page, session, c, body));
  } catch {
    return serverErrorResponse();
  }
}

/** Build the read-only `GET` context for a page. */
function pageRenderContext(
  panel: AdminPanel,
  _page: AdminPage,
  session: Session,
  c: Context,
): Parameters<AdminPage['render']>[0] {
  return {
    session,
    path: panel.path,
    request: c.req.raw,
    url: new URL(c.req.raw.url),
    theme: panel.theme,
    themeCustomization: panel.themeCustomization,
    themeTokens: panel.themeTokens,
  };
}

/** Build the `POST` context for a page, carrying the parsed form body. */
function pagePostContext(
  panel: AdminPanel,
  _page: AdminPage,
  session: Session,
  c: Context,
  body: Record<string, string>,
): Parameters<NonNullable<AdminPage['handlePost']>>[0] {
  return {
    session,
    path: panel.path,
    request: c.req.raw,
    url: new URL(c.req.raw.url),
    theme: panel.theme,
    themeCustomization: panel.themeCustomization,
    themeTokens: panel.themeTokens,
    body,
  };
}

/** Run a resource's `authorize`, default-allow when absent, exact `true` when present. */
export async function resourceAllowed(
  resource: Resource,
  session: Session,
  action: ResourceAction,
  recordId?: string,
): Promise<boolean> {
  if (resource.authorize === undefined) {
    return true;
  }
  try {
    return (await resource.authorize({ session, action, recordId })) === true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Dashboard, global search, and notices
// ---------------------------------------------------------------------------

/** GET <path>: render the dashboard with widgets and any mapped notice. */
async function handleDashboard(
  panel: AdminPanel,
  contributions: Contributions,
  c: Context,
): Promise<Response> {
  const session = await assertAdminSession(panel, c.req.raw);
  if (session === null) {
    return forbiddenResponse();
  }
  const notice = readNotice(new URL(c.req.raw.url), panel);
  return adminHtmlResponse(await renderDashboard(panel, contributions, session, notice), 200);
}

/** GET <path>/_search: the global search page over searchable resources. */
async function handleGlobalSearch(
  panel: AdminPanel,
  contributions: Contributions,
  c: Context,
): Promise<Response> {
  const session = await assertAdminSession(panel, c.req.raw);
  if (session === null) {
    return forbiddenResponse();
  }
  const term = new URL(c.req.raw.url).searchParams.get('q') ?? '';
  let html: string;
  try {
    html = await renderGlobalSearch(panel, contributions.resources, session, term);
  } catch {
    return serverErrorResponse();
  }
  return adminHtmlResponse(html, 200);
}

/** Resolve a `?_notice=` code to its message; unknown codes are dropped. */
export function readNotice(url: URL, panel: AdminPanel): string | undefined {
  const code = url.searchParams.get('_notice');
  if (code === null || code === '') return undefined;
  return noticeRegistry(panel).get(code)?.message;
}

/** Build the notice registry: panel notices plus the built-in success notice. */
function noticeRegistry(panel: AdminPanel): ReadonlyMap<string, Notice> {
  const map = new Map<string, Notice>();
  map.set(ADMIN_ACTION_SUCCESS_NOTICE.code, ADMIN_ACTION_SUCCESS_NOTICE);
  for (const notice of panel.notices ?? []) {
    map.set(notice.code, notice);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Navigation and dashboard rendering
// ---------------------------------------------------------------------------

/** Build the flat, normalized navigation over pages, resources, and links. */
function buildNavigation(panel: AdminPanel, contributions: Contributions): readonly NavItem[] {
  const items: NavItem[] = [];
  for (const page of contributions.pages) {
    items.push({
      label: page.label,
      href: `${panel.path}/${page.slug}`,
      group: page.group ?? '',
      sort: page.sort ?? 0,
      ...(page.badge === undefined ? {} : { badge: page.badge }),
    });
  }
  for (const resource of contributions.resources) {
    items.push({
      label: resource.label,
      href: `${panel.path}/${resource.slug}`,
      group: '',
      sort: 0,
    });
  }
  for (const item of contributions.navItems) {
    items.push({
      label: item.label,
      href: item.href,
      group: item.group ?? '',
      sort: item.sort ?? 0,
    });
  }
  return items;
}

/** The dashboard: a title, widgets, and the grouped, sorted navigation. */
async function renderDashboard(
  panel: AdminPanel,
  contributions: Contributions,
  session: Session,
  notice: string | undefined,
): Promise<string> {
  const children: ComponentChild[] = [h('h1', null, panel.title)];
  if (notice !== undefined) {
    children.push(renderNotice(notice));
  }
  children.push(await renderWidgets(panel, session));
  children.push(await renderCharts(panel, session));
  children.push(renderNavigation(buildNavigation(panel, contributions)));
  return renderAdminDocumentWithTheme(
    {
      title: panel.title,
      theme: panel.theme,
      themeCustomization: panel.themeCustomization,
      themeTokens: panel.themeTokens,
    },
    ...children,
  );
}

/** Render the panel's widgets as stat cards (label plus escaped value). */
async function renderWidgets(panel: AdminPanel, session: Session): Promise<ComponentChild | null> {
  const widgets = panel.widgets ?? [];
  if (widgets.length === 0) return null;
  const cards: ComponentChild[] = [];
  for (const widget of widgets) {
    let value: unknown;
    try {
      value = await widget.render({ session, path: panel.path });
    } catch {
      value = '';
    }
    const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value : '';
    cards.push(
      h(
        'div',
        { class: 'admin-widget' },
        h('span', { class: 'admin-widget-value' }, text),
        h('span', { class: 'admin-widget-label' }, widget.label),
      ),
    );
  }
  return h('div', { class: 'admin-widgets' }, ...cards);
}

/** Render the panel's charts as cards, each carrying its trusted SVG markup. */
async function renderCharts(panel: AdminPanel, session: Session): Promise<ComponentChild | null> {
  const charts = panel.charts ?? [];
  if (charts.length === 0) return null;
  const cards: ComponentChild[] = [];
  for (const chart of charts) {
    let svg: string;
    try {
      svg = await chart.render({ session, path: panel.path });
    } catch {
      svg = '';
    }
    if (typeof svg !== 'string') {
      svg = '';
    }
    cards.push(
      h(
        'div',
        { class: 'admin-chart-card' },
        h('span', { class: 'admin-chart-label' }, chart.label),
        // The chart renderer is trusted code that owns its output escaping.
        h('div', { class: 'admin-chart-body', dangerouslySetInnerHTML: { __html: svg } }),
      ),
    );
  }
  return h('div', { class: 'admin-charts' }, ...cards);
}

/** Render a single notice message. */
export function renderNotice(message: string): ComponentChild {
  return h('p', { class: 'admin-notice', role: 'status' }, message);
}

/** Render the grouped, sorted navigation (top-level first, then group name). */
function renderNavigation(items: readonly NavItem[]): ComponentChild {
  const byGroup = new Map<string, NavItem[]>();
  for (const item of items) {
    const list = byGroup.get(item.group) ?? [];
    list.push(item);
    byGroup.set(item.group, list);
  }

  const groups = [...byGroup.keys()].sort(compareGroup);
  const children: ComponentChild[] = [];
  for (const group of groups) {
    const list = byGroup.get(group)!;
    list.sort(compareItem);
    if (group !== '') {
      children.push(h('h2', null, group));
    }
    children.push(h('ul', null, ...list.map(renderNavItem)));
  }
  return h('nav', null, ...children);
}

/** A single navigation link, with an optional trailing badge. */
function renderNavItem(item: NavItem): ComponentChild {
  return h(
    'li',
    null,
    h('a', { href: item.href }, item.label),
    ...(item.badge === undefined ? [] : [' ', h('span', null, item.badge)]),
  );
}

/** Order groups: top-level first, then alphabetically by name. */
function compareGroup(a: string, b: string): number {
  if (a === '') return -1;
  if (b === '') return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Order items: sort weight ascending, then label ascending. */
function compareItem(a: NavItem, b: NavItem): number {
  if (a.sort !== b.sort) return a.sort - b.sort;
  return a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
}

/** The catch-all 404 for unknown admin paths. */
function renderNotFound(panel: AdminPanel): string {
  return renderAdminDocumentWithTheme(
    {
      title: `${panel.title} - Not Found`,
      theme: panel.theme,
      themeCustomization: panel.themeCustomization,
      themeTokens: panel.themeTokens,
    },
    h('h1', null, 'Not Found'),
  );
}

// ---------------------------------------------------------------------------
// Shared helpers (re-used by the resource and action route modules)
// ---------------------------------------------------------------------------

/** The row's record identifier (the `id` property), stringified when present. */
export function recordId(row: Record<string, unknown>): string | undefined {
  const id = row['id'];
  if (id === undefined || id === null) {
    return undefined;
  }
  return String(id);
}

/** A value-free 403 document; the reason and session id are never emitted. */
export function forbiddenResponse(): Response {
  return adminHtmlResponse(
    renderAdminDocument('Forbidden', undefined, h('h1', null, 'Forbidden')),
    403,
  );
}

/** A value-free 404 document. */
export function notFoundResponse(): Response {
  return adminHtmlResponse(
    renderAdminDocument('Not Found', undefined, h('h1', null, 'Not Found')),
    404,
  );
}

/** A 405 for a mutation on a read-only resource, with a clear message. */
export function readOnlyResponse(): Response {
  return adminHtmlResponse(
    renderAdminDocument(
      'Method Not Allowed',
      undefined,
      h('h1', null, 'Method Not Allowed'),
      h('p', null, 'This resource is read-only.'),
    ),
    405,
  );
}

/** A 405 for a `POST` to a page that declares no `handlePost`. */
function pageReadOnlyResponse(): Response {
  return adminHtmlResponse(
    renderAdminDocument(
      'Method Not Allowed',
      undefined,
      h('h1', null, 'Method Not Allowed'),
      h('p', null, 'This page does not accept mutations.'),
    ),
    405,
  );
}

/** A value-free 500 document; internal details are never emitted. */
export function serverErrorResponse(): Response {
  return adminHtmlResponse(
    renderAdminDocument('Internal Server Error', undefined, h('h1', null, 'Internal Server Error')),
    500,
  );
}
