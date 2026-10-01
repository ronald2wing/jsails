/**
 * Admin resource rendering: the server-rendered form and list-table markup for
 * a resource descriptor.
 *
 * `renderListPage(...)` renders the paginated, sortable, filterable, searchable
 * list table; `renderFormPage(...)` renders the shared create/edit form (also
 * used for a 422 re-render). Every dynamic value — cell text, field values,
 * labels, and filters — is emitted as a text child or attribute so Preact owns
 * all escaping; `colors` values are author-supplied (trusted) styling hooks.
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
import {
  DEFAULT_MAX_REPEATER_ITEMS,
  type ResourceField,
  type ResourceFormsetConfig,
  type ResourceRepeaterConfig,
  type ResourceRepeaterItemField,
  type ResourceSelectOption,
} from './fields.js';
import {
  type ResourceColumn,
  type ResourceColumnFormat,
  type ResourceInfolist,
  type ResourceInfolistEntry,
} from './columns.js';
import { stringifyCell } from './export.js';

// ---------------------------------------------------------------------------
// List table rendering
// ---------------------------------------------------------------------------

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

/** Render a value according to a cell format; escaping owned by Preact. */
function renderFormattedValue(
  format: ResourceColumnFormat | undefined,
  colors: Readonly<Record<string, string>> | undefined,
  value: unknown,
  imageBaseUrl?: string,
  tagSeparator?: string,
): ComponentChild {
  switch (format) {
    case 'badge': {
      const text = stringifyCell(value);
      const color = colors?.[String(value ?? '')];
      return h(
        'span',
        { class: 'admin-badge', ...(color === undefined ? {} : { style: { color } }) },
        text,
      );
    }
    case 'boolean': {
      const bool = value === true || value === 'true' || value === 1;
      const text = bool ? 'Yes' : 'No';
      const color = colors?.[String(bool)];
      return h(
        'span',
        { class: 'admin-boolean', ...(color === undefined ? {} : { style: { color } }) },
        text,
      );
    }
    case 'date':
      return h('span', { class: 'admin-date' }, formatDate(value));
    case 'image':
      return h('img', {
        src: `${imageBaseUrl ?? ''}${stringifyCell(value)}`,
        alt: '',
      });
    case 'icon':
      return h('span', { class: 'admin-icon' }, stringifyCell(value));
    case 'color':
      return h('span', { class: 'admin-color', style: { backgroundColor: stringifyCell(value) } });
    case 'tags': {
      const separator = tagSeparator ?? ',';
      const tags = stringifyCell(value)
        .split(separator)
        .map((t) => t.trim())
        .filter((t) => t !== '');
      return h('span', null, ...tags.map((t) => h('span', { class: 'admin-tag' }, t)));
    }
    default:
      return stringifyCell(value);
  }
}

// ---------------------------------------------------------------------------
// Form rendering
// ---------------------------------------------------------------------------

/** The shared create/edit form document. */
export function renderFormPage(
  panel: AdminPanel,
  resource: Resource,
  state: FormRenderState,
): string {
  const heading = state.id === null ? `New ${resource.label}` : `Edit ${resource.label}`;
  const body: ComponentChild[] = [h('h1', null, heading)];
  if (resource.infolist !== undefined && state.record != null) {
    body.push(renderInfolist(resource.infolist, state.record));
  }
  body.push(renderForm(resource, state));
  // Render inline relation manager tables below the main form fields.
  // `relationManagerHtml` is produced exclusively by `renderRelationManager`,
  // which server-renders each table through Preact (escaping every cell value
  // in `renderCellValue`). It is therefore the ONLY trusted source for raw
  // HTML injection here — never a caller-supplied string, never a column value.
  if (state.relationManagerHtml !== undefined && state.relationManagerHtml.length > 0) {
    for (const html of state.relationManagerHtml) {
      body.push(
        h('div', {
          class: 'admin-relation-inline',
          dangerouslySetInnerHTML: { __html: html },
        }),
      );
    }
  }
  body.push(
    h(
      'a',
      { href: `${panel.path}/${resource.slug}${state.back === '' ? '' : `?${state.back}`}` },
      'Back to list',
    ),
  );
  return renderAdminDocumentWithTheme(
    {
      title: `${panel.title} - ${heading}`,
      theme: panel.theme,
      themeCustomization: panel.themeCustomization,
      themeTokens: panel.themeTokens,
    },
    ...body,
  );
}

/** State for one form render (create, edit, or a 422 re-render). */
export interface FormRenderState {
  readonly id: string | null;
  readonly record?: Record<string, unknown> | null;
  readonly values: Record<string, string>;
  readonly errors: Record<string, string>;
  readonly csrf: string;
  readonly action: string;
  /** Canonical table-state query string (no leading `?`) preserved through save. */
  readonly back: string;
  /**
   * Pre-rendered relation manager HTML strings, one per manager in order.
   * When present each is embedded as trusted producer output below the form
   * fields (and above the Back link). Only meaningful on an edit page.
   */
  readonly relationManagerHtml?: readonly string[];
}

/** Render the form element: hidden CSRF/back tokens, fields, and a submit button. */
function renderForm(resource: Resource, state: FormRenderState): ComponentChild {
  return h(
    'form',
    { method: 'post', action: state.action },
    h('input', { type: 'hidden', name: '_csrf', value: state.csrf }),
    ...(state.back === ''
      ? []
      : [h('input', { type: 'hidden', name: '_back', value: state.back })]),
    ...resource.fields.map((field) => renderField(field, state)),
    h('button', { type: 'submit' }, 'Save'),
  );
}

/** Render one field: a label, the input, and any validation error. */
function renderField(field: Resource['fields'][number], state: FormRenderState): ComponentChild {
  const id = `field-${field.name}`;
  const error = state.errors[field.name];
  return h(
    'div',
    null,
    h('label', { htmlFor: id }, field.label),
    renderFieldInput(field, state, id),
    ...(error === undefined ? [] : [h('p', { role: 'alert' }, error)]),
  );
}

/** Render the input element for a field type. */
function renderFieldInput(
  field: ResourceField,
  state: FormRenderState,
  id: string,
): ComponentChild {
  if (field.type === 'repeater') {
    if (field.formset !== undefined) {
      return renderFormset(field, state);
    }
    return renderRepeater(field, state);
  }
  if (field.type === 'file') {
    return renderFileInput(field, state, id);
  }
  return renderScalarInput(
    field.type,
    field.name,
    id,
    fieldValue(field, state),
    toggleChecked(field, state),
    field.options,
    field.min,
    field.max,
    field.step,
  );
}

/** Render a scalar input element (every kind except repeater/file). */
function renderScalarInput(
  type: string,
  name: string,
  id: string,
  value: string,
  checked: boolean,
  options: readonly ResourceSelectOption[] | undefined,
  sliderMin?: number,
  sliderMax?: number,
  sliderStep?: number,
): ComponentChild {
  switch (type) {
    case 'textarea':
      return h('textarea', { name, id }, value);
    case 'select':
      return h(
        'select',
        { name, id },
        ...(options ?? []).map((option) =>
          h(
            'option',
            { value: option.value, ...(option.value === value ? { selected: true } : {}) },
            option.label,
          ),
        ),
      );
    case 'radio':
      return h(
        'div',
        null,
        ...(options ?? []).map((option) =>
          h(
            'label',
            null,
            h('input', {
              type: 'radio',
              name,
              value: option.value,
              ...(option.value === value ? { checked: true } : {}),
            }),
            option.label,
          ),
        ),
      );
    case 'toggle':
      return h('input', {
        type: 'checkbox',
        name,
        id,
        value: 'on',
        ...(checked ? { checked: true } : {}),
      });
    case 'checkbox':
      return h('input', {
        type: 'checkbox',
        name,
        id,
        value: '1',
        ...(checked ? { checked: true } : {}),
      });
    case 'number':
      return h('input', { type: 'number', name, id, value });
    case 'date':
      return h('input', { type: 'date', name, id, value });
    case 'datetime':
      return h('input', { type: 'datetime-local', name, id, value });
    case 'slider':
      return h('input', {
        type: 'range',
        name,
        id,
        value,
        ...(sliderMin === undefined ? {} : { min: String(sliderMin) }),
        ...(sliderMax === undefined ? {} : { max: String(sliderMax) }),
        ...(sliderStep === undefined ? {} : { step: String(sliderStep) }),
      });
    case 'color':
      return h('input', { type: 'color', name, id, value });
    case 'autocomplete':
      // Server-rendered text input with a `data-jsails-autocomplete` marker.
      // The autocomplete client binding (debounced fetch + dropdown) is
      // app-owned — no client bundle ships in JSails core.
      return h('input', {
        type: 'text',
        name,
        id,
        value,
        'data-jsails-autocomplete': '',
      });
    case 'tags':
    case 'code':
    case 'keyvalue':
    case 'markdown':
      return h('textarea', { name, id }, value);
    case 'text':
    default:
      return h('input', { type: 'text', name, id, value });
  }
}

/** Render a repeater: one fieldset per item plus an Add button under the bound. */
function renderRepeater(field: ResourceField, state: FormRenderState): ComponentChild {
  const config = field.repeater!;
  const maxItems = config.maxItems ?? DEFAULT_MAX_REPEATER_ITEMS;
  const count = repeaterItemCount(field.name, config, state);
  const items: ComponentChild[] = [];
  for (let i = 0; i < count; i += 1) {
    items.push(renderRepeaterItem(field, config, state, i));
  }
  const children: ComponentChild[] = [h('fieldset', null, ...items)];
  if (count < maxItems) {
    children.push(
      h('button', { type: 'submit', name: '_repeater_add', value: field.name }, 'Add item'),
    );
  }
  return h('div', { class: 'admin-repeater' }, ...children);
}

/** Render one repeater item: each item field plus a Remove button. */
function renderRepeaterItem(
  field: ResourceField,
  config: ResourceRepeaterConfig,
  state: FormRenderState,
  index: number,
): ComponentChild {
  const children: ComponentChild[] = [];
  for (const itemField of config.fields) {
    const name = `${field.name}[${index}].${itemField.name}`;
    const id = `field-${name}`;
    const error = state.errors[`${field.name}.${index}.${itemField.name}`];
    children.push(
      h(
        'div',
        null,
        h('label', { htmlFor: id }, itemField.label),
        renderScalarInput(
          itemField.type,
          name,
          id,
          repeaterItemValue(field.name, itemField, index, state),
          repeaterItemChecked(field.name, itemField, index, state),
          itemField.options,
          itemField.min,
          itemField.max,
          itemField.step,
        ),
        ...(error === undefined ? [] : [h('p', { role: 'alert' }, error)]),
      ),
    );
  }
  children.push(
    h(
      'button',
      { type: 'submit', name: '_repeater_remove', value: `${field.name}.${index}` },
      'Remove',
    ),
  );
  return h('div', { class: 'admin-repeater-item' }, ...children);
}

/** Count the rendered repeater items from submitted values, then the record. */
function repeaterItemCount(
  fieldName: string,
  config: ResourceRepeaterConfig,
  state: FormRenderState,
): number {
  const maxItems = config.maxItems ?? DEFAULT_MAX_REPEATER_ITEMS;
  const raw = rawRepeaterItemCount(fieldName, state.values);
  if (raw > 0) {
    return Math.min(raw, maxItems);
  }
  const record = state.record;
  if (record != null) {
    const value = record[fieldName];
    if (Array.isArray(value)) {
      return Math.min(Math.max(value.length, 1), maxItems);
    }
  }
  return 1;
}

/** The number of repeater items present in a flat values map (0 when absent). */
function rawRepeaterItemCount(fieldName: string, values: Record<string, string>): number {
  let maxIndex = -1;
  for (const key of Object.keys(values)) {
    const index = repeaterKeyIndex(fieldName, key);
    if (index !== undefined && index > maxIndex) maxIndex = index;
  }
  return maxIndex + 1;
}

/** The raw submitted/record value for one item field, preferring submitted data. */
function repeaterItemRaw(
  fieldName: string,
  itemField: { name: string },
  index: number,
  state: FormRenderState,
): unknown {
  const name = `${fieldName}[${index}].${itemField.name}`;
  if (Object.hasOwn(state.values, name)) {
    return state.values[name];
  }
  const record = state.record;
  if (record != null) {
    const items = record[fieldName];
    if (Array.isArray(items)) {
      const item = items[index];
      if (item !== null && typeof item === 'object') {
        return (item as Record<string, unknown>)[itemField.name];
      }
    }
  }
  return undefined;
}

/** Resolve an item field's string value for rendering. */
function repeaterItemValue(
  fieldName: string,
  itemField: ResourceRepeaterItemField,
  index: number,
  state: FormRenderState,
): string {
  const raw = repeaterItemRaw(fieldName, itemField, index, state);
  if (raw === undefined || raw === null) {
    return '';
  }
  return typeof raw === 'string' ? raw : String(raw);
}

/** Resolve an item field's checkbox checked state for rendering. */
function repeaterItemChecked(
  fieldName: string,
  itemField: ResourceRepeaterItemField,
  index: number,
  state: FormRenderState,
): boolean {
  const name = `${fieldName}[${index}].${itemField.name}`;
  if (Object.hasOwn(state.values, name)) {
    return state.values[name] === 'on' || state.values[name] === '1';
  }
  return repeaterItemRaw(fieldName, itemField, index, state) === true;
}

// ---------------------------------------------------------------------------
// Formset rendering (reuses the same flat-key `name[i].sub` convention)
// ---------------------------------------------------------------------------

/** Render a formset: one fieldset per row plus an Add button under the bound. */
function renderFormset(field: ResourceField, state: FormRenderState): ComponentChild {
  const config = field.formset!;
  const maxItems = config.maxItems ?? DEFAULT_MAX_REPEATER_ITEMS;
  const count = formsetItemCount(field.name, config, state);
  const items: ComponentChild[] = [];
  for (let i = 0; i < count; i += 1) {
    items.push(renderFormsetItem(field, config, state, i));
  }
  const children: ComponentChild[] = [h('fieldset', null, ...items)];
  if (count < maxItems) {
    children.push(
      h('button', { type: 'submit', name: '_repeater_add', value: field.name }, 'Add row'),
    );
  }
  return h('div', { class: 'admin-repeater' }, ...children);
}

/** Render one formset row: each declared sub-field plus a Remove button. */
function renderFormsetItem(
  field: ResourceField,
  config: ResourceFormsetConfig,
  state: FormRenderState,
  index: number,
): ComponentChild {
  const children: ComponentChild[] = [];
  for (const subField of config.fields) {
    const flatName = `${field.name}[${index}].${subField.name}`;
    const id = `field-${flatName}`;
    const errorKey = `${field.name}.${index}.${subField.name}`;
    const error = state.errors[errorKey];
    children.push(
      h(
        'div',
        null,
        h('label', { htmlFor: id }, subField.label),
        renderFormsetItemInput(field.name, index, subField, state, id, flatName),
        ...(error === undefined ? [] : [h('p', { role: 'alert' }, error)]),
      ),
    );
  }
  children.push(
    h(
      'button',
      { type: 'submit', name: '_repeater_remove', value: `${field.name}.${index}` },
      'Remove',
    ),
  );
  return h('div', { class: 'admin-repeater-item' }, ...children);
}

/** Render one formset sub-field input, choosing the right element for its type. */
function renderFormsetItemInput(
  formsetName: string,
  index: number,
  subField: ResourceField,
  state: FormRenderState,
  id: string,
  flatName: string,
): ComponentChild {
  if (subField.type === 'file') {
    // File inputs need the flat-key name so the upload handler can map them.
    return renderFileInput({ ...subField, name: flatName }, state, id);
  }
  return renderScalarInput(
    subField.type,
    flatName,
    id,
    formsetItemValue(formsetName, subField, index, state),
    formsetItemChecked(formsetName, subField, index, state),
    subField.options,
    subField.min,
    subField.max,
    subField.step,
  );
}

/** Count the rendered formset rows from submitted values, then the record. */
function formsetItemCount(
  fieldName: string,
  config: ResourceFormsetConfig,
  state: FormRenderState,
): number {
  const maxItems = config.maxItems ?? DEFAULT_MAX_REPEATER_ITEMS;
  const raw = rawRepeaterItemCount(fieldName, state.values);
  if (raw > 0) {
    return Math.min(raw, maxItems);
  }
  const record = state.record;
  if (record != null) {
    const value = record[fieldName];
    if (Array.isArray(value)) {
      return Math.min(Math.max(value.length, 1), maxItems);
    }
  }
  return 1;
}

/** Resolve a formset item field's string value for rendering. */
function formsetItemValue(
  fieldName: string,
  itemField: { name: string },
  index: number,
  state: FormRenderState,
): string {
  const raw = repeaterItemRaw(fieldName, itemField, index, state);
  if (raw === undefined || raw === null) {
    return '';
  }
  return typeof raw === 'string' ? raw : String(raw);
}

/** Resolve a formset item field's checkbox checked state for rendering. */
function formsetItemChecked(
  fieldName: string,
  itemField: { name: string },
  index: number,
  state: FormRenderState,
): boolean {
  const name = `${fieldName}[${index}].${itemField.name}`;
  if (Object.hasOwn(state.values, name)) {
    return state.values[name] === 'on' || state.values[name] === '1';
  }
  return repeaterItemRaw(fieldName, itemField, index, state) === true;
}

/** Parse a flat repeater key's item index (`name[i].sub` -> `i`). */
function repeaterKeyIndex(fieldName: string, key: string): number | undefined {
  const prefix = `${fieldName}[`;
  if (!key.startsWith(prefix)) return undefined;
  const rest = key.slice(prefix.length);
  const close = rest.indexOf(']');
  if (close <= 0) return undefined;
  const digits = rest.slice(0, close);
  if (!/^\d+$/.test(digits)) return undefined;
  const index = Number(digits);
  return Number.isSafeInteger(index) ? index : undefined;
}

// ---------------------------------------------------------------------------
// Repeater add/remove intent (exported for the CRUD POST handler)
// ---------------------------------------------------------------------------

/** A resolved repeater mutation intent from an add/remove button submission. */
export type RepeaterIntent =
  | { readonly kind: 'add'; readonly field: string }
  | { readonly kind: 'remove'; readonly field: string; readonly index: number };

/**
 * Detect a repeater add/remove intent from the internal markers the repeater
 * buttons submit. A marker that does not name a repeater field (or names an
 * out-of-shape index) is ignored, so a hostile value is a harmless no-op.
 */
export function detectRepeaterIntent(
  resource: Resource,
  body: Record<string, string>,
): RepeaterIntent | undefined {
  const add = body['_repeater_add'];
  if (add !== undefined && add !== '' && isRepeaterField(resource, add)) {
    return { kind: 'add', field: add };
  }
  const remove = body['_repeater_remove'];
  if (remove !== undefined && remove !== '') {
    const dot = remove.lastIndexOf('.');
    if (dot > 0) {
      const field = remove.slice(0, dot);
      const indexStr = remove.slice(dot + 1);
      if (isRepeaterField(resource, field) && /^\d+$/.test(indexStr)) {
        const index = Number(indexStr);
        if (Number.isSafeInteger(index) && index >= 0) {
          return { kind: 'remove', field, index };
        }
      }
    }
  }
  return undefined;
}

/** Apply a detected repeater intent to a flat values map, returning a new map. */
export function applyRepeaterIntent(
  resource: Resource,
  intent: RepeaterIntent,
  values: Record<string, string>,
): Record<string, string> {
  return intent.kind === 'add'
    ? addRepeaterItem(resource, intent.field, values)
    : removeRepeaterItem(resource, intent.field, intent.index, values);
}

/** Whether `name` is a repeater-typed field on the resource. */
function isRepeaterField(resource: Resource, name: string): boolean {
  return resource.fields.some((field) => field.name === name && field.type === 'repeater');
}

/** Append one empty repeater or formset item (bounded by `maxItems`). */
function addRepeaterItem(
  resource: Resource,
  fieldName: string,
  values: Record<string, string>,
): Record<string, string> {
  const field = resource.fields.find((f) => f.name === fieldName);
  if (field === undefined) return values;
  const itemFields = field.formset?.fields ?? field.repeater?.fields;
  if (itemFields === undefined) return values;
  const maxItems =
    field.formset?.maxItems ?? field.repeater?.maxItems ?? DEFAULT_MAX_REPEATER_ITEMS;
  const count = rawRepeaterItemCount(fieldName, values);
  if (count >= maxItems) return values;
  const next: Record<string, string> = { ...values };
  for (const itemField of itemFields) {
    next[`${fieldName}[${count}].${itemField.name}`] = '';
  }
  return next;
}

/** Remove a repeater or formset item and renumber the items after it (keeps at least one). */
function removeRepeaterItem(
  resource: Resource,
  fieldName: string,
  index: number,
  values: Record<string, string>,
): Record<string, string> {
  const field = resource.fields.find((f) => f.name === fieldName);
  if (field === undefined) return values;
  const itemFields = field.formset?.fields ?? field.repeater?.fields;
  if (itemFields === undefined) return values;
  if (rawRepeaterItemCount(fieldName, values) <= 1) return values;
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    const parsed = repeaterKeyIndex(fieldName, key);
    if (parsed === undefined) {
      result[key] = value;
      continue;
    }
    if (parsed === index) continue;
    result[renameRepeaterKey(key, parsed > index ? parsed - 1 : parsed)] = value;
  }
  return result;
}

/** Rewrite a flat repeater key's item index in place (`name[i].sub` -> `name[j].sub`). */
function renameRepeaterKey(key: string, newIndex: number): string {
  const open = key.indexOf('[');
  const close = key.indexOf(']');
  if (open < 0 || close <= open) return key;
  return `${key.slice(0, open)}[${newIndex}]${key.slice(close + 1)}`;
}

/** Render a file field: the file input plus the current stored key, when present. */
function renderFileInput(field: ResourceField, state: FormRenderState, id: string): ComponentChild {
  const current = fieldValue(field, state);
  return h(
    'div',
    null,
    h('input', {
      type: 'file',
      name: field.name,
      id,
      ...(field.accept === undefined ? {} : { accept: field.accept }),
    }),
    ...(current === '' ? [] : [h('p', null, 'Current: ', h('code', null, current))]),
  );
}

/** Render the read-only detail section shown above the edit form. */
function renderInfolist(
  infolist: ResourceInfolist,
  record: Record<string, unknown>,
): ComponentChild {
  return h(
    'section',
    { class: 'admin-infolist' },
    h('h2', null, infolist.label),
    h(
      'dl',
      null,
      ...infolist.entries.map((entry) =>
        h(
          'div',
          null,
          h('dt', null, entry.label),
          h('dd', null, renderInfolistValue(entry, record[entry.name])),
        ),
      ),
    ),
  );
}

/** Render one infolist entry value through the shared cell formatter. */
function renderInfolistValue(entry: ResourceInfolistEntry, value: unknown): ComponentChild {
  return renderFormattedValue(entry.format, entry.colors, value);
}

/** Resolve a field's string value from submitted values or the record. */
function fieldValue(field: Resource['fields'][number], state: FormRenderState): string {
  const submitted = state.values[field.name];
  if (submitted !== undefined) {
    return submitted;
  }
  if (state.record != null) {
    const raw = state.record[field.name];
    if (raw === undefined || raw === null) {
      return '';
    }
    if (typeof raw === 'string') {
      return raw;
    }
    return String(raw);
  }
  return '';
}

/** Resolve a checkbox's checked state from submitted values or the record. */
function toggleChecked(field: Resource['fields'][number], state: FormRenderState): boolean {
  if (Object.hasOwn(state.values, field.name)) {
    return state.values[field.name] === 'on' || state.values[field.name] === '1';
  }
  if (state.record != null) {
    return state.record[field.name] === true;
  }
  return false;
}

/** Render a date cell value, extracting the date portion of an ISO string. */
function formatDate(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  const text = String(value);
  // `YYYY-MM-DD...` -> `YYYY-MM-DD`; anything else is passed through escaped.
  return text.length >= 10 && /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : text;
}
