/**
 * Admin resource field schemas: the strict Zod object schema derived from a
 * resource's validated fields.
 *
 * The schema is `.strict()`, so unknown keys are always rejected. The schema is
 * derived, not author-supplied, so it is left unfrozen while every
 * author-supplied collection is deep-frozen elsewhere. Repeater fields arrive
 * as a set of flat `name[i].sub` keys, so they are lifted into an array value
 * before the strict object schema sees the flat map.
 *
 * The module is ORM-free and performs no I/O; it imports only the field types
 * and the rich-text factory.
 */

import { z } from 'zod';

import { createRichText } from '../../filesystem/rich-text.js';
import {
  DEFAULT_MAX_REPEATER_ITEMS,
  type ResourceField,
  type ResourceRepeaterItemType,
  type ResourceSelectOption,
} from './fields.js';

/** Upper safety bound on a single submitted repeater index. */
const MAX_REPEATER_ITEMS = 1000;

/** ISO date (`YYYY-MM-DD`) shape. */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** ISO datetime shape (local `YYYY-MM-DDTHH:MM` with optional seconds/zone). */
const DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})?$/;

/** Build a strict Zod object schema from the validated fields. */
export function buildSchema(fields: readonly ResourceField[]): z.ZodType<Record<string, unknown>> {
  const shape: Record<string, z.ZodType> = {};
  for (const field of fields) {
    shape[field.name] = buildFieldSchema(field);
  }
  const objectSchema = z.object(shape).strict();
  if (!fields.some((field) => field.type === 'repeater')) {
    return objectSchema;
  }
  // Repeater fields arrive as a set of flat `name[i].sub` keys, so lift them
  // into an array value before the strict object schema sees the flat map.
  return z.preprocess((value) => liftRepeaters(fields, value), objectSchema);
}

/** Build the coercion + presence schema for a single field. */
function buildFieldSchema(field: ResourceField): z.ZodType {
  const { type } = field;
  switch (type) {
    case 'repeater':
      return buildRepeaterSchema(field);
    case 'file':
      // A file field persists as a string (a disk key or a filename reference).
      return applyPresence(z.string(), field.required);
    default:
      return buildScalarFieldSchema({
        type,
        required: field.required,
        options: field.options,
        min: field.min,
        max: field.max,
        step: field.step,
        language: field.language,
        sanitize: field.sanitize,
      });
  }
}

/** Build the coercion + presence schema for a scalar (non-repeater/file) field. */
function buildScalarFieldSchema(field: {
  readonly type: ResourceRepeaterItemType | 'keyvalue' | 'code' | 'markdown' | 'autocomplete';
  readonly required?: boolean;
  readonly options?: readonly ResourceSelectOption[];
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly language?: string;
  readonly sanitize?: (html: string) => string;
}): z.ZodType {
  switch (field.type) {
    case 'text':
    case 'textarea':
    case 'autocomplete':
      return applyPresence(z.string(), field.required);
    case 'select':
    case 'radio':
      // Radio always carries options (enforced at validation), so it is an enum.
      return buildChoiceSchema(field);
    case 'toggle':
      // A checkbox submits nothing when unchecked, so an absent key means
      // `false`; `required` is not meaningful for a boolean and is ignored.
      return z.preprocess(coerceToggle, z.boolean());
    case 'checkbox':
      return z.preprocess(coerceCheckbox, z.boolean());
    case 'number':
      return applyPresence(z.preprocess(coerceNumber, z.number()), field.required);
    case 'date':
      return applyPresence(
        z.preprocess(emptyStringToUndefined, z.string().regex(DATE_PATTERN)),
        field.required,
      );
    case 'datetime':
      return applyPresence(
        z.preprocess(emptyStringToUndefined, z.string().regex(DATETIME_PATTERN)),
        field.required,
      );
    case 'slider':
      return applyPresence(
        z.preprocess(coerceNumber, z.number().min(field.min!).max(field.max!)),
        field.required,
      );
    case 'tags':
      return applyPresence(z.string(), field.required);
    case 'color':
      return applyPresence(z.string().regex(/^#[0-9a-fA-F]{6}$/), field.required);
    case 'code':
      return applyPresence(z.string(), field.required);
    case 'keyvalue':
      return applyPresence(
        z.preprocess(parseJsonObject, z.record(z.string(), z.string())),
        field.required,
      );
    case 'markdown':
      return applyPresence(
        z.string().transform((v) => createRichText({ sanitize: field.sanitize! }).fromHtml(v).html),
        field.required,
      );
  }
}

/** Build a repeater or formset field schema: a bounded array of validated item objects. */
function buildRepeaterSchema(field: ResourceField): z.ZodType {
  const formset = field.formset;
  if (formset !== undefined) {
    const shape: Record<string, z.ZodType> = {};
    for (const subField of formset.fields) {
      shape[subField.name] = buildFieldSchema(subField);
    }
    const itemSchema = z.object(shape).strict();
    const maxItems = formset.maxItems ?? DEFAULT_MAX_REPEATER_ITEMS;
    const minItems = formset.minItems ?? 0;
    const arraySchema = z.array(itemSchema).max(maxItems);
    return minItems > 0 ? arraySchema.min(minItems) : arraySchema;
  }
  const config = field.repeater!;
  const shape: Record<string, z.ZodType> = {};
  for (const itemField of config.fields) {
    shape[itemField.name] = buildScalarFieldSchema(itemField);
  }
  const itemSchema = z.object(shape).strict();
  const arraySchema = z.array(itemSchema).max(config.maxItems ?? DEFAULT_MAX_REPEATER_ITEMS);
  return field.required === false ? arraySchema : arraySchema.min(1);
}

/**
 * Lift every repeater field's flat `name[i].sub` keys into a single array value
 * (and drop those flat keys) so the strict object schema validates the rest.
 * Exported so the CRUD handler can reconstruct the lifted shape for error
 * mapping (a Zod issue path is nested, not flat).
 */
export function liftRepeaters(fields: readonly ResourceField[], value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }
  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  const consumed = new Set<string>();
  for (const field of fields) {
    if (field.type !== 'repeater') continue;
    const itemFields: readonly { name: string }[] = field.formset?.fields ?? field.repeater!.fields;
    result[field.name] = extractRepeaterItems(field.name, itemFields, source);
    for (const key of Object.keys(source)) {
      if (key === field.name || key.startsWith(`${field.name}[`)) {
        consumed.add(key);
      }
    }
  }
  for (const [key, entryValue] of Object.entries(source)) {
    if (!consumed.has(key)) {
      result[key] = entryValue;
    }
  }
  return result;
}

/** Collect the submitted repeater or formset items (one object per contiguous index). */
function extractRepeaterItems(
  fieldName: string,
  itemFields: readonly { name: string }[],
  source: Record<string, unknown>,
): unknown[] {
  const prefix = `${fieldName}[`;
  let maxIndex = -1;
  for (const key of Object.keys(source)) {
    if (!key.startsWith(prefix)) continue;
    const index = parseItemIndex(fieldName, key);
    if (index !== undefined && index > maxIndex) maxIndex = index;
  }
  if (maxIndex < 0) {
    // No indexed keys were submitted; a direct array (defensive) passes through.
    const direct = source[fieldName];
    return Array.isArray(direct) ? direct : [];
  }
  const items: unknown[] = [];
  for (let i = 0; i <= maxIndex; i += 1) {
    const item: Record<string, unknown> = {};
    let present = false;
    for (const sub of itemFields) {
      const key = `${fieldName}[${i}].${sub.name}`;
      if (Object.hasOwn(source, key)) {
        item[sub.name] = source[key];
        present = true;
      }
    }
    if (present) items.push(item);
  }
  return items;
}

/** Parse a flat key's item index (`name[i].sub` -> `i`), bounded and digits-only. */
function parseItemIndex(fieldName: string, key: string): number | undefined {
  const prefix = `${fieldName}[`;
  if (!key.startsWith(prefix)) return undefined;
  const rest = key.slice(prefix.length);
  const close = rest.indexOf(']');
  if (close <= 0) return undefined;
  const digits = rest.slice(0, close);
  if (!/^\d+$/.test(digits)) return undefined;
  const index = Number(digits);
  if (!Number.isSafeInteger(index) || index >= MAX_REPEATER_ITEMS) return undefined;
  return index;
}

/** A select/radio is either a free string or a constrained enum of its options. */
function buildChoiceSchema(field: {
  readonly required?: boolean;
  readonly options?: readonly ResourceSelectOption[];
}): z.ZodType {
  if (field.options === undefined || field.options.length === 0) {
    return applyPresence(z.string(), field.required);
  }
  const values = field.options.map((option) => option.value) as [string, ...string[]];
  // An empty selection is "no value": required fields reject it, optional
  // fields pass `undefined` through.
  const base = z.preprocess(emptyStringToUndefined, z.enum(values));
  return applyPresence(base, field.required);
}

/** Apply the `required` presence rule (defaults to required). */
function applyPresence(base: z.ZodType, required: boolean | undefined): z.ZodType {
  return required === false ? base.optional() : base;
}

/** Map an empty string to `undefined` so a blank choice is "no selection". */
function emptyStringToUndefined(value: unknown): unknown {
  return typeof value === 'string' && value === '' ? undefined : value;
}

/** Coerce a checkbox submission: an absent/blank value is `false`. */
function coerceToggle(value: unknown): unknown {
  return coerceCheckbox(value);
}

/** Coerce a checkbox submission: absent/blank is `false`, known truths are `true`. */
function coerceCheckbox(value: unknown): unknown {
  if (value === undefined || value === null || value === '') {
    return false;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    return value === 'on' || value === 'true' || value === '1' || value === 'yes';
  }
  return false;
}

/** Coerce a number field: numeric strings become numbers, blank becomes absent. */
function coerceNumber(value: unknown): unknown {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') {
      return undefined;
    }
    return Number(trimmed); // NaN stays NaN so `z.number()` rejects it.
  }
  return value;
}

/** Parse a JSON string into an object; returns `undefined` for blank, leaves non-strings alone. */
function parseJsonObject(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  return JSON.parse(trimmed);
}
