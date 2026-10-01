/**
 * Shared rendering helpers for the admin resource list and form modules.
 *
 * Two concerns used by both `render-list.ts` and `render-form.ts` live here:
 * cell-value formatting (`renderFormattedValue`, `formatDate`) and the flat
 * repeater/formset key parser (`repeaterKeyIndex`, `rawRepeaterItemCount`).
 * Keeping them in one module avoids a list<->form dependency: the list module
 * and the form module each import from here, never from each other.
 *
 * The module is ORM-free and performs no I/O.
 */

import { h, type ComponentChild } from 'preact';

import { type ResourceColumnFormat } from './columns.js';
import { stringifyCell } from './export.js';

/** Render a value according to a cell format; escaping owned by Preact. */
export function renderFormattedValue(
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

/** Parse a flat repeater key's item index (`name[i].sub` -> `i`). */
export function repeaterKeyIndex(fieldName: string, key: string): number | undefined {
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

/** The number of repeater items present in a flat values map (0 when absent). */
export function rawRepeaterItemCount(fieldName: string, values: Record<string, string>): number {
  let maxIndex = -1;
  for (const key of Object.keys(values)) {
    const index = repeaterKeyIndex(fieldName, key);
    if (index !== undefined && index > maxIndex) maxIndex = index;
  }
  return maxIndex + 1;
}
