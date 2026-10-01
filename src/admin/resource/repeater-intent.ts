/**
 * Admin resource repeater/formset mutation intent: detecting an add/remove
 * button submission and applying it to a flat values map.
 *
 * This is pure, render-free logic shared with the CRUD POST handler: it derives
 * a bounded mutation from internal markers the repeater buttons submit, so a
 * hostile value is a harmless no-op. The flat-key parsing helpers live in
 * `render-shared.ts`.
 *
 * The module is ORM-free and performs no I/O. It is consumed by the CRUD route
 * handler under `../resource-routes/`, never by the `jsails/admin` public
 * surface.
 */

import type { Resource } from './resource-descriptor.js';
import { DEFAULT_MAX_REPEATER_ITEMS } from './fields.js';
import { rawRepeaterItemCount, repeaterKeyIndex } from './render-shared.js';

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
