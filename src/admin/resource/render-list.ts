/**
 * Admin resource list rendering: the paginated, sortable, filterable,
 * searchable list table for a resource descriptor.
 *
 * `renderListPage(...)` renders the search/filter form, the table (with its
 * optional bulk-selection wrapper), and the pager. Every dynamic value — cell
 * text, filter labels, headers — is emitted as a text child or attribute so
 * Preact owns all escaping; `colors` values are author-supplied (trusted)
 * styling hooks. Cell formatting is shared with the form module via
 * `render-shared.ts`.
 *
 * The module is ORM-free and performs no I/O. It is consumed by the route
 * handlers under `../resource-routes/`, never by the `jsails/admin` public
 * surface.
 */

import { h, type ComponentChild } from 'preact';

import type { AdminAction } from '../actions.js';
import { renderAdminDocumentWithTheme } from '../document.js';
import { DEFAULT_PAGE_SIZE } from '../../api/pagination.js';
import { buildQuery, type ListState } from '../list-query.js';
import type { AdminPanel } from '../panel.js';
import { recordId, renderNotice } from '../routes.js';
import type { Resource } from './resource-descriptor.js';
import { type ResourceColumn } from './columns.js';
import { renderFormattedValue } from './render-shared.js';

/** Render the paginated, sortable, filterable, searchable list table. */
export async function renderListPage(
  panel: AdminPanel,
  resource: Resource,
  result: {
    readonly rows: readonly Record<string, unknown>[];
    readonly total: number;
  },
  state: ListState,
  notice: string | undefined,
): Promise<string> {
  const root = `${panel.path}/${resource.slug}`;
  const totalPages = result.total === 0 ? 0 : Math.ceil(result.total / state.pageSize);
  const heading = h('h1', null, resource.label);
  const headerActions = resource.actions?.header ?? [];
  const rowActions = resource.actions?.row ?? [];
  const bulkActions = resource.actions?.bulk ?? [];

  const body: ComponentChild[] = [heading];
  if (notice !== undefined) {
    body.push(renderNotice(notice));
  }
  if (resource.save !== undefined) {
    body.push(h('a', { href: `${root}/new${buildQuery(state)}` }, `New ${resource.label}`));
  }
  for (const action of headerActions) {
    body.push(h('a', { href: `${root}/actions/${action.name}${buildQuery(state)}` }, action.label));
  }
  body.push(renderFiltersForm(resource, state));
  body.push(await renderTable(resource, result.rows, rowActions, bulkActions, state, root));

  if (result.rows.length === 0) {
    body.push(h('p', null, 'No records.'));
  }

  body.push(
    h(
      'p',
      null,
      h('span', null, `Page ${state.page} of ${Math.max(totalPages, 1)} (${result.total} total)`),
      ...(state.page > 1
        ? [
            ' ',
            h(
              'a',
              { href: `${root}${buildQuery({ ...state, page: state.page - 1 })}` },
              'Previous',
            ),
          ]
        : []),
      ...(state.page < totalPages
        ? [
            ' ',
            h('a', { href: `${root}${buildQuery({ ...state, page: state.page + 1 })}` }, 'Next'),
          ]
        : []),
    ),
  );
  body.push(h('a', { href: panel.path }, 'Back to dashboard'));

  return renderAdminDocumentWithTheme(
    {
      title: `${panel.title} - ${resource.label}`,
      theme: panel.theme,
      themeCustomization: panel.themeCustomization,
      themeTokens: panel.themeTokens,
    },
    ...body,
  );
}

/** Render the search + select-filter form (a GET that resets the page). */
function renderFiltersForm(resource: Resource, state: ListState): ComponentChild {
  const filterable = resource.columns.filter((column) => column.filter !== undefined);
  const hasSearchable = resource.columns.some((column) => column.searchable === true);
  if (!hasSearchable && filterable.length === 0) return null;

  const children: ComponentChild[] = [];
  if (hasSearchable) {
    children.push(
      h('input', {
        type: 'text',
        name: 'search',
        value: state.search ?? '',
        placeholder: 'Search',
      }),
    );
  }
  for (const column of filterable) {
    const selected = state.filters[column.name] ?? '';
    children.push(
      h(
        'select',
        { name: `f_${column.name}` },
        h('option', { value: '' }, column.label),
        ...(column.filter ?? []).map((option) =>
          h(
            'option',
            { value: option.value, ...(option.value === selected ? { selected: true } : {}) },
            option.label,
          ),
        ),
      ),
    );
  }
  // Preserve sort/direction across a filter change.
  if (state.sort !== undefined) {
    children.push(h('input', { type: 'hidden', name: 'sort', value: state.sort }));
    children.push(h('input', { type: 'hidden', name: 'direction', value: state.direction }));
  }
  children.push(h('button', { type: 'submit' }, 'Apply'));
  return h('form', { method: 'get', action: '' }, ...children);
}

/** Render the table, wrapped in a bulk-selection form when bulk actions exist. */
async function renderTable(
  resource: Resource,
  rows: readonly Record<string, unknown>[],
  rowActions: readonly AdminAction[],
  bulkActions: readonly AdminAction[],
  state: ListState,
  root: string,
): Promise<ComponentChild> {
  const hasActionsColumn = resource.get !== undefined || rowActions.length > 0;
  const hasBulkColumn = bulkActions.length > 0;

  const headerCells: ComponentChild[] = [];
  if (hasBulkColumn) {
    headerCells.push(h('th', null, 'Select'));
  }
  for (const column of resource.columns) {
    headerCells.push(renderColumnHeader(column, state, root));
  }
  if (hasActionsColumn) {
    headerCells.push(h('th', null, 'Actions'));
  }

  const bodyRows: ComponentChild[] = [];
  for (const row of rows) {
    const id = recordId(row);
    const cells: ComponentChild[] = [];
    if (hasBulkColumn) {
      cells.push(
        h(
          'td',
          null,
          id === undefined ? '' : h('input', { type: 'checkbox', name: 'ids', value: id }),
        ),
      );
    }
    for (const column of resource.columns) {
      cells.push(h('td', null, await renderCellValue(column, row)));
    }
    if (hasActionsColumn) {
      cells.push(h('td', null, renderRowActions(resource, row, id, rowActions, state, root)));
    }
    bodyRows.push(h('tr', null, ...cells));
  }

  const table = h(
    'table',
    null,
    h('thead', null, h('tr', null, ...headerCells)),
    h('tbody', null, ...bodyRows),
  );

  if (!hasBulkColumn) return table;

  const bulkButtons = bulkActions.map((action) =>
    h(
      'button',
      { type: 'submit', formaction: `${root}/actions/${action.name}`, name: action.name },
      action.label,
    ),
  );
  return h('form', { method: 'get', action: root }, ...stateHiddens(state), ...bulkButtons, table);
}

/** Hidden inputs carrying the full list state through a bulk-selection form. */
function stateHiddens(state: ListState): ComponentChild[] {
  const inputs: ComponentChild[] = [];
  if (state.page !== 1)
    inputs.push(h('input', { type: 'hidden', name: 'page', value: String(state.page) }));
  if (state.pageSize !== DEFAULT_PAGE_SIZE) {
    inputs.push(h('input', { type: 'hidden', name: 'pageSize', value: String(state.pageSize) }));
  }
  if (state.sort !== undefined)
    inputs.push(h('input', { type: 'hidden', name: 'sort', value: state.sort }));
  if (state.sort !== undefined && state.direction !== 'asc') {
    inputs.push(h('input', { type: 'hidden', name: 'direction', value: state.direction }));
  }
  if (state.search !== undefined)
    inputs.push(h('input', { type: 'hidden', name: 'search', value: state.search }));
  for (const [name, value] of Object.entries(state.filters)) {
    inputs.push(h('input', { type: 'hidden', name: `f_${name}`, value }));
  }
  return inputs;
}

/** Render a column header: a sort link when sortable, a plain label otherwise. */
function renderColumnHeader(
  column: ResourceColumn,
  state: ListState,
  root: string,
): ComponentChild {
  if (column.sortable !== true) {
    return h('th', null, column.label);
  }
  const isSorted = state.sort === column.name;
  const nextDirection: 'asc' | 'desc' = isSorted && state.direction === 'asc' ? 'desc' : 'asc';
  const nextState: ListState = { ...state, page: 1, sort: column.name, direction: nextDirection };
  const indicator = isSorted ? (state.direction === 'asc' ? ' ↑' : ' ↓') : '';
  return h(
    'th',
    null,
    h('a', { href: `${root}${buildQuery(nextState)}` }, column.label, indicator),
  );
}

/** Render a row's action links: the Edit link plus each row action. */
function renderRowActions(
  resource: Resource,
  _row: Record<string, unknown>,
  id: string | undefined,
  rowActions: readonly AdminAction[],
  state: ListState,
  root: string,
): ComponentChild {
  const links: ComponentChild[] = [];
  if (resource.get !== undefined && id !== undefined) {
    links.push(h('a', { href: `${root}/${id}${buildQuery(state)}` }, 'Edit'));
  }
  for (const action of rowActions) {
    if (id === undefined) continue;
    links.push(
      h('a', { href: `${root}/${id}/actions/${action.name}${buildQuery(state)}` }, action.label),
    );
  }
  if (links.length === 0) return '';
  return h('span', null, ...intersperse(links, ' '));
}

/** Insert a separator node between elements. */
function intersperse(
  nodes: readonly ComponentChild[],
  separator: ComponentChild,
): ComponentChild[] {
  const out: ComponentChild[] = [];
  for (let i = 0; i < nodes.length; i += 1) {
    if (i > 0) out.push(separator);
    out.push(nodes[i]);
  }
  return out;
}

/** Resolve a single cell's markup: relation columns await their labels, others format the value. */
async function renderCellValue(
  column: ResourceColumn,
  row: Record<string, unknown>,
): Promise<ComponentChild> {
  if (column.type === 'relation') {
    return renderRelationCell(column, row);
  }
  return renderFormattedValue(
    column.format,
    column.colors,
    row[column.name],
    column.imageBaseUrl,
    column.tagSeparator,
  );
}

/** Render a relation column's resolved labels; a resolver failure renders empty. */
async function renderRelationCell(
  column: ResourceColumn,
  row: Record<string, unknown>,
): Promise<ComponentChild> {
  const resolve = column.resolve;
  if (resolve === undefined) {
    return '';
  }
  let labels: readonly string[];
  try {
    labels = (await resolve(row)) ?? [];
  } catch {
    labels = [];
  }
  if (labels.length === 0) {
    return '';
  }
  return h('ul', { class: 'admin-relation' }, ...labels.map((label) => h('li', null, label)));
}
