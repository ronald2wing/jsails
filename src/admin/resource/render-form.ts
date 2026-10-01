/**
 * Admin resource form rendering: the shared create/edit form (also used for a
 * 422 re-render) for a resource descriptor.
 *
 * `renderFormPage(...)` renders the read-only infolist, the form element
 * (hidden CSRF/back tokens, fields, a submit button), any inline relation
 * manager tables, and the Back link. Every field value and label is emitted as
 * a text child or attribute so Preact owns all escaping.
 *
 * The module is ORM-free and performs no I/O. It is consumed by the route
 * handlers under `../resource-routes/`, never by the `jsails/admin` public
 * surface.
 */

import { h, type ComponentChild } from 'preact';

import { renderAdminDocumentWithTheme } from '../document.js';
import type { AdminPanel } from '../panel.js';
import type { Resource } from './resource-descriptor.js';
import {
  DEFAULT_MAX_REPEATER_ITEMS,
  type ResourceField,
  type ResourceFormsetConfig,
  type ResourceRepeaterConfig,
  type ResourceRepeaterItemField,
  type ResourceSelectOption,
} from './fields.js';
import { type ResourceInfolist, type ResourceInfolistEntry } from './columns.js';
import { rawRepeaterItemCount, renderFormattedValue } from './render-shared.js';

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
  // in the list renderer). It is therefore the ONLY trusted source for raw
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
