/**
 * Admin global search: a server-rendered page that searches across every
 * resource with at least one `searchable` column.
 *
 * `renderGlobalSearch(panel, resources, session, term)` queries each eligible
 * resource's `list` callback with the search term, then filters the returned
 * rows to those the resource's own `authorize` allows for the current session.
 * Only resources the session may `list` — and only rows it may `view` — are
 * returned; a resource whose `list` throws is skipped rather than failing the
 * whole page. The term is length-clamped and rendered as an escaped value.
 *
 * The module is ORM-free and performs no I/O beyond invoking the resource's
 * already-trusted callbacks.
 */

import { h, type ComponentChild } from 'preact';

import type { Session } from '../contracts/http.js';
import { renderAdminDocumentWithTheme } from './document.js';
import type { AdminPanel } from './panel.js';
import type { Resource } from './resource.js';

/** Maximum characters accepted from a search query. */
const MAX_QUERY_LENGTH = 200;

/** Rows fetched per resource for the search results. */
const RESULTS_PER_RESOURCE = 10;

/** A resource plus its authorized matching rows. */
interface SearchGroup {
  readonly resource: Resource;
  readonly rows: readonly Record<string, unknown>[];
}

/**
 * Render the full global-search document. The term is clamped; resources and
 * rows the session is not authorized for are never included.
 */
export async function renderGlobalSearch(
  panel: AdminPanel,
  resources: readonly Resource[],
  session: Session,
  term: string,
): Promise<string> {
  const query = term.slice(0, MAX_QUERY_LENGTH);
  const groups: SearchGroup[] = [];
  for (const resource of resources) {
    if (!resource.columns.some((column) => column.searchable === true)) {
      continue;
    }
    if (!(await listAllowed(resource, session))) {
      continue;
    }
    let rows: readonly Record<string, unknown>[];
    try {
      const result = await resource.list({
        session,
        page: 1,
        pageSize: RESULTS_PER_RESOURCE,
        search: query,
      });
      rows = result.rows;
    } catch {
      continue;
    }
    const authorized: Record<string, unknown>[] = [];
    for (const row of rows) {
      const id = recordId(row);
      if (id === undefined) continue;
      if (!(await rowAllowed(resource, session, id))) continue;
      authorized.push(row);
    }
    if (authorized.length > 0) {
      groups.push({ resource, rows: authorized });
    }
  }
  return renderAdminDocumentWithTheme(
    {
      title: `${panel.title} - Search`,
      theme: panel.theme,
      themeCustomization: panel.themeCustomization,
      themeTokens: panel.themeTokens,
    },
    h('main', null, ...renderSearchBody(panel, query, groups)),
  );
}

/** A resource's `list` action authorization, default-allow when absent. */
async function listAllowed(resource: Resource, session: Session): Promise<boolean> {
  if (resource.authorize === undefined) return true;
  try {
    return (await resource.authorize({ session, action: 'list' })) === true;
  } catch {
    return false;
  }
}

/** A row's `view` action authorization, default-allow when absent. */
async function rowAllowed(resource: Resource, session: Session, id: string): Promise<boolean> {
  if (resource.authorize === undefined) return true;
  try {
    return (await resource.authorize({ session, action: 'view', recordId: id })) === true;
  } catch {
    return false;
  }
}

/** The row's record identifier (the `id` property), stringified when present. */
function recordId(row: Record<string, unknown>): string | undefined {
  const id = row['id'];
  if (id === undefined || id === null) return undefined;
  return String(id);
}

/** The page body: a search form, the grouped results, and a dashboard link. */
function renderSearchBody(
  panel: AdminPanel,
  query: string,
  groups: readonly SearchGroup[],
): ComponentChild[] {
  const children: ComponentChild[] = [h('h1', null, 'Search'), renderSearchForm(panel.path, query)];
  if (groups.length === 0) {
    children.push(h('p', null, query === '' ? 'Enter a search term.' : 'No results.'));
  } else {
    children.push(...groups.map((group) => renderSearchGroup(panel.path, group)));
  }
  children.push(h('a', { href: panel.path }, 'Back to dashboard'));
  return children;
}

/** The search form: a single `q` input posting back to the search page. */
function renderSearchForm(path: string, query: string): ComponentChild {
  return h(
    'form',
    { method: 'get', action: `${path}/_search` },
    h('input', { type: 'text', name: 'q', value: query }),
    h('button', { type: 'submit' }, 'Search'),
  );
}

/** One resource's results: a heading plus a list of row links. */
function renderSearchGroup(path: string, group: SearchGroup): ComponentChild {
  const items = group.rows.map((row) => {
    const id = recordId(row);
    const label = rowLabel(group.resource, row, id);
    return h(
      'li',
      null,
      h(
        'a',
        {
          href:
            id === undefined
              ? `${path}/${group.resource.slug}`
              : `${path}/${group.resource.slug}/${id}`,
        },
        label,
      ),
    );
  });
  return h('section', null, h('h2', null, group.resource.label), h('ul', null, ...items));
}

/** A stable, escaped label for a search result row. */
function rowLabel(
  resource: Resource,
  row: Record<string, unknown>,
  id: string | undefined,
): string {
  const first = resource.columns[0];
  if (first !== undefined) {
    const value = row[first.name];
    if (value !== null && value !== undefined) return String(value);
  }
  return id ?? '';
}
