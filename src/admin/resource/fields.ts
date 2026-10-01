/**
 * Admin resource field descriptors: the form-field type definitions and their
 * validation.
 *
 * The field model is deliberately small and drives both the form markup and the
 * validation schema:
 *
 * - `text`/`textarea` validate as strings (textarea only changes the input);
 * - `select` validates as a string, or as one of its `options` values when
 *   options are declared;
 * - `radio` requires `options` and validates as one of them (single choice);
 * - `toggle`/`checkbox` coerce an unchecked box (an absent key) to `false` and
 *   never honor `required` (a boolean is either checked or not);
 * - `number` coerces numeric strings to numbers; an empty or non-numeric value
 *   is a validation error (never a silent `0`);
 * - `date`/`datetime` validate as ISO date/datetime strings (rendered as the
 *   matching HTML input kinds).
 *
 * `required` defaults to `true`: a missing field is rejected. `required: false`
 * makes the field optional (an absent value parses to `undefined`). Every
 * author-supplied collection is deep-frozen by {@link freezeFields}.
 *
 * The module is ORM-free: it imports only the resource error and performs no
 * I/O. The Zod coercion for these fields lives in `field-schemas.ts`.
 */

import { ResourceError } from './error.js';

/** Field input kinds the resource form renders and validates. */
export type ResourceFieldType =
  | 'text'
  | 'textarea'
  | 'select'
  | 'toggle'
  | 'number'
  | 'date'
  | 'datetime'
  | 'checkbox'
  | 'radio'
  | 'repeater'
  | 'file'
  | 'keyvalue'
  | 'tags'
  | 'color'
  | 'slider'
  | 'code'
  | 'markdown'
  | 'autocomplete';

/** A single select/radio option: a machine value plus a human label. */
export interface ResourceSelectOption {
  readonly value: string;
  readonly label: string;
}

/** Input kinds a repeater item field may use (the scalar kinds only). */
export type ResourceRepeaterItemType = Exclude<ResourceFieldType, 'repeater' | 'file' | 'keyvalue'>;

/** One field inside a repeater item. */
export interface ResourceRepeaterItemField {
  /** Item field name (the key within each item object). */
  readonly name: string;
  /** Human label rendered next to the input. */
  readonly label: string;
  /** Input kind; a scalar kind, never `repeater`/`file`. */
  readonly type: ResourceRepeaterItemType;
  /** When `false`, the item field is optional. Defaults to `true`. */
  readonly required?: boolean;
  /** Choices; required for `radio`, optional for `select`. */
  readonly options?: readonly ResourceSelectOption[];
  /** Minimum value for a `slider` item field. */
  readonly min?: number;
  /** Maximum value for a `slider` item field. */
  readonly max?: number;
  /** Step increment for a `slider` item field. */
  readonly step?: number;
}

/** Configuration for a `repeater` field. */
export interface ResourceRepeaterConfig {
  /** The fields each item renders and validates. */
  readonly fields: readonly ResourceRepeaterItemField[];
  /** Maximum item count (1..100); defaults to {@link DEFAULT_MAX_REPEATER_ITEMS}. */
  readonly maxItems?: number;
}

/** Configuration for a `formset` field (inline child-records within a repeater-like field). */
export interface ResourceFormsetConfig {
  /** The fields each formset row renders and validates. */
  readonly fields: readonly ResourceField[];
  /** Maximum row count (1..100); defaults to {@link DEFAULT_MAX_REPEATER_ITEMS}. */
  readonly maxItems?: number;
  /** Minimum row count (0..maxItems); defaults to 0. */
  readonly minItems?: number;
}

/** Configuration for an `autocomplete` field. */
export interface ResourceAutocompleteConfig {
  /** Async search function; returns matching options for the query string. */
  readonly search: (query: string) => Promise<readonly ResourceSelectOption[]>;
  /** Minimum characters before a search is triggered; defaults to 2. */
  readonly minChars?: number;
}

/** A single form field. */
export interface ResourceField {
  /** Form field name (and the object key persisted by `save`). */
  readonly name: string;
  /** Human label rendered next to the input. */
  readonly label: string;
  /** Input kind; drives the form markup and the Zod coercion. */
  readonly type: ResourceFieldType;
  /** When `false`, the field is optional. Defaults to `true`. */
  readonly required?: boolean;
  /** Choices; required for `radio`, optional for `select`. */
  readonly options?: readonly ResourceSelectOption[];
  /** Item fields and bounds; required and only valid for a `repeater` field. */
  readonly repeater?: ResourceRepeaterConfig;
  /** Inline formset fields and bounds; only valid on a `repeater`-type field. */
  readonly formset?: ResourceFormsetConfig;
  /** Accepted MIME/extension hint for a `file` field's `<input accept>`; only valid there. */
  readonly accept?: string;
  /** Search config; required and only valid when `type` is `'autocomplete'`. */
  readonly autocomplete?: ResourceAutocompleteConfig;
  /** Minimum value for a `slider` field. Only valid when `type` is `'slider'`. */
  readonly min?: number;
  /** Maximum value for a `slider` field. Only valid when `type` is `'slider'`. */
  readonly max?: number;
  /** Step increment for a `slider` field. Only valid when `type` is `'slider'`. */
  readonly step?: number;
  /** Advisory language hint for a `code` field. Only valid when `type` is `'code'`. */
  readonly language?: string;
  /**
   * Sanitize untrusted HTML for a `markdown` field. Required when `type` is
   * `'markdown'`; the sanitizer receives raw HTML and must return safe HTML.
   */
  readonly sanitize?: (html: string) => string;
}

/** Default upper bound on repeater items when `maxItems` is omitted. */
export const DEFAULT_MAX_REPEATER_ITEMS = 10;

const FIELD_TYPES: ReadonlySet<string> = new Set([
  'text',
  'textarea',
  'select',
  'toggle',
  'number',
  'date',
  'datetime',
  'checkbox',
  'radio',
  'repeater',
  'file',
  'keyvalue',
  'tags',
  'color',
  'slider',
  'code',
  'markdown',
  'autocomplete',
]);

/** Scalar field kinds a repeater item may use (everything except repeater/file/keyvalue). */
const REPEATER_ITEM_TYPES: ReadonlySet<string> = new Set([
  'text',
  'textarea',
  'select',
  'toggle',
  'number',
  'date',
  'datetime',
  'checkbox',
  'radio',
  'tags',
  'color',
  'slider',
  'code',
]);

/** Validate the form fields: names, types, options, and uniqueness. */
export function validateFields(value: unknown): void {
  if (!Array.isArray(value)) {
    throw new ResourceError('resource fields must be an array');
  }
  const seen = new Set<string>();
  for (const field of value) {
    if (field === null || typeof field !== 'object') {
      throw new ResourceError('resource field must be an object');
    }
    const candidate = field as ResourceField;
    const name = candidate.name;
    if (typeof name !== 'string' || name.trim() === '') {
      throw new ResourceError('resource field name must be a non-empty string');
    }
    if (name in Object.prototype) {
      throw new ResourceError('resource field name must not shadow an inherited property');
    }
    if (seen.has(name)) {
      throw new ResourceError('resource field names must be unique');
    }
    seen.add(name);
    if (typeof candidate.label !== 'string' || candidate.label.trim() === '') {
      throw new ResourceError('resource field label must be a non-empty string');
    }
    if (typeof candidate.type !== 'string' || !FIELD_TYPES.has(candidate.type)) {
      throw new ResourceError('resource field type is not supported');
    }
    if (candidate.required !== undefined && typeof candidate.required !== 'boolean') {
      throw new ResourceError('resource field required must be a boolean');
    }
    if (candidate.type === 'repeater') {
      if (candidate.formset !== undefined) {
        validateFormset(candidate);
      } else {
        validateRepeater(candidate);
      }
    } else {
      if (candidate.repeater !== undefined) {
        throw new ResourceError('resource field repeater is only valid for repeater fields');
      }
      if (candidate.formset !== undefined) {
        throw new ResourceError('resource field formset is only valid for repeater fields');
      }
    }
    if (candidate.type === 'file') {
      if (candidate.accept !== undefined && typeof candidate.accept !== 'string') {
        throw new ResourceError('file field accept must be a string');
      }
    } else if (candidate.accept !== undefined) {
      throw new ResourceError('resource field accept is only valid for file fields');
    }
    if (candidate.type === 'slider') {
      if (
        typeof candidate.min !== 'number' ||
        typeof candidate.max !== 'number' ||
        candidate.min >= candidate.max
      ) {
        throw new ResourceError('slider field must define numeric min and max with min < max');
      }
      if (
        candidate.step !== undefined &&
        (typeof candidate.step !== 'number' || candidate.step <= 0)
      ) {
        throw new ResourceError('slider step must be a positive number');
      }
    } else {
      if (candidate.min !== undefined) {
        throw new ResourceError('min is only valid for slider fields');
      }
      if (candidate.max !== undefined) {
        throw new ResourceError('max is only valid for slider fields');
      }
      if (candidate.step !== undefined) {
        throw new ResourceError('step is only valid for slider fields');
      }
    }
    if (candidate.type === 'code') {
      if (candidate.language !== undefined && typeof candidate.language !== 'string') {
        throw new ResourceError('code field language must be a string');
      }
    } else if (candidate.language !== undefined) {
      throw new ResourceError('language is only valid for code fields');
    }
    if (candidate.type === 'markdown') {
      if (typeof candidate.sanitize !== 'function') {
        throw new ResourceError('markdown field must define a sanitize function');
      }
    } else if (candidate.sanitize !== undefined) {
      throw new ResourceError('sanitize is only valid for markdown fields');
    }
    if (candidate.type === 'autocomplete') {
      const ac = candidate.autocomplete;
      if (ac === null || typeof ac !== 'object' || Array.isArray(ac)) {
        throw new ResourceError('autocomplete field must define an autocomplete config object');
      }
      if (typeof ac.search !== 'function') {
        throw new ResourceError('autocomplete search must be a function');
      }
      if (ac.minChars !== undefined) {
        if (
          typeof ac.minChars !== 'number' ||
          !Number.isSafeInteger(ac.minChars) ||
          ac.minChars < 1
        ) {
          throw new ResourceError('autocomplete minChars must be a positive integer');
        }
      }
    } else if (candidate.autocomplete !== undefined) {
      throw new ResourceError('autocomplete config is only valid for autocomplete fields');
    }
    if (candidate.type === 'radio' || candidate.options !== undefined) {
      validateOptions(candidate);
    }
  }
}

/** Validate a `repeater` field's item fields and `maxItems` bound. */
function validateRepeater(field: ResourceField): void {
  const config = field.repeater;
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new ResourceError('repeater config must be an object');
  }
  if (!Array.isArray(config.fields) || config.fields.length === 0) {
    throw new ResourceError('repeater fields must be a non-empty array');
  }
  if (
    config.maxItems !== undefined &&
    (typeof config.maxItems !== 'number' ||
      !Number.isSafeInteger(config.maxItems) ||
      config.maxItems < 1 ||
      config.maxItems > 100)
  ) {
    throw new ResourceError('repeater maxItems must be an integer between 1 and 100');
  }
  const seen = new Set<string>();
  for (const itemField of config.fields) {
    if (itemField === null || typeof itemField !== 'object') {
      throw new ResourceError('repeater item field must be an object');
    }
    const candidate = itemField as ResourceRepeaterItemField;
    if (typeof candidate.name !== 'string' || candidate.name.trim() === '') {
      throw new ResourceError('repeater item field name must be a non-empty string');
    }
    if (candidate.name in Object.prototype) {
      throw new ResourceError('repeater item field name must not shadow an inherited property');
    }
    if (seen.has(candidate.name)) {
      throw new ResourceError('repeater item field names must be unique');
    }
    seen.add(candidate.name);
    if (typeof candidate.label !== 'string' || candidate.label.trim() === '') {
      throw new ResourceError('repeater item field label must be a non-empty string');
    }
    if (typeof candidate.type !== 'string' || !REPEATER_ITEM_TYPES.has(candidate.type)) {
      throw new ResourceError('repeater item field type is not supported');
    }
    if (candidate.required !== undefined && typeof candidate.required !== 'boolean') {
      throw new ResourceError('repeater item field required must be a boolean');
    }
    if (candidate.type === 'slider') {
      if (
        typeof candidate.min !== 'number' ||
        typeof candidate.max !== 'number' ||
        candidate.min >= candidate.max
      ) {
        throw new ResourceError(
          'repeater slider item field must define numeric min and max with min < max',
        );
      }
      if (
        candidate.step !== undefined &&
        (typeof candidate.step !== 'number' || candidate.step <= 0)
      ) {
        throw new ResourceError('repeater slider step must be a positive number');
      }
    }
    if (candidate.type === 'radio' || candidate.options !== undefined) {
      validateOptions(candidate);
    }
  }
}

/** Validate a `formset` field's item fields and minItems/maxItems bounds. */
function validateFormset(field: ResourceField): void {
  const config = field.formset;
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new ResourceError('formset config must be an object');
  }
  if (!Array.isArray(config.fields) || config.fields.length === 0) {
    throw new ResourceError('formset fields must be a non-empty array');
  }
  const minItems = config.minItems ?? 0;
  const maxItems = config.maxItems ?? DEFAULT_MAX_REPEATER_ITEMS;
  if (typeof minItems !== 'number' || !Number.isSafeInteger(minItems) || minItems < 0) {
    throw new ResourceError('formset minItems must be a non-negative integer');
  }
  if (
    typeof maxItems !== 'number' ||
    !Number.isSafeInteger(maxItems) ||
    maxItems < 1 ||
    maxItems > 100
  ) {
    throw new ResourceError('formset maxItems must be an integer between 1 and 100');
  }
  if (minItems > maxItems) {
    throw new ResourceError('formset minItems must not exceed maxItems');
  }
  if (field.repeater !== undefined) {
    throw new ResourceError('repeater field must not declare both repeater and formset configs');
  }
  const seen = new Set<string>();
  for (const subField of config.fields) {
    if (subField === null || typeof subField !== 'object') {
      throw new ResourceError('formset item field must be an object');
    }
    if (typeof subField.name !== 'string' || subField.name.trim() === '') {
      throw new ResourceError('formset item field name must be a non-empty string');
    }
    if (subField.name in Object.prototype) {
      throw new ResourceError('formset item field name must not shadow an inherited property');
    }
    if (seen.has(subField.name)) {
      throw new ResourceError('formset item field names must be unique');
    }
    seen.add(subField.name);
    if (typeof subField.label !== 'string' || subField.label.trim() === '') {
      throw new ResourceError('formset item field label must be a non-empty string');
    }
    if (typeof subField.type !== 'string' || !FIELD_TYPES.has(subField.type)) {
      throw new ResourceError('formset item field type is not supported');
    }
    if (subField.required !== undefined && typeof subField.required !== 'boolean') {
      throw new ResourceError('formset item field required must be a boolean');
    }
    if (subField.type === 'repeater') {
      throw new ResourceError('formset item field must not be a repeater');
    }
  }
}

/** Validate select/radio options; only those two types may declare them. */
function validateOptions(field: ResourceField): void {
  if (field.type !== 'select' && field.type !== 'radio') {
    throw new ResourceError('resource field options are only valid for select or radio fields');
  }
  if (!Array.isArray(field.options) || field.options.length === 0) {
    throw new ResourceError(
      field.type === 'radio'
        ? 'radio options must be a non-empty array'
        : 'select options must be a non-empty array',
    );
  }
  const seen = new Set<string>();
  for (const option of field.options) {
    if (option === null || typeof option !== 'object') {
      throw new ResourceError('select option must be an object');
    }
    const value = (option as ResourceSelectOption).value;
    const label = (option as ResourceSelectOption).label;
    if (typeof value !== 'string' || value.trim() === '') {
      throw new ResourceError('select option value must be a non-empty string');
    }
    if (typeof label !== 'string' || label.trim() === '') {
      throw new ResourceError('select option label must be a non-empty string');
    }
    if (seen.has(value)) {
      throw new ResourceError('select option values must be unique');
    }
    seen.add(value);
  }
}

/** Deep-freeze a defensive copy of the fields (and their options/repeater config). */
export function freezeFields(fields: readonly ResourceField[]): readonly ResourceField[] {
  return Object.freeze(
    fields.map((field) =>
      Object.freeze({
        name: field.name,
        label: field.label,
        type: field.type,
        ...(field.required === undefined ? {} : { required: field.required }),
        ...(field.accept === undefined ? {} : { accept: field.accept }),
        ...(field.autocomplete === undefined
          ? {}
          : {
              autocomplete: {
                search: field.autocomplete.search,
                ...(field.autocomplete.minChars === undefined
                  ? {}
                  : { minChars: field.autocomplete.minChars }),
              },
            }),
        ...(field.min === undefined ? {} : { min: field.min }),
        ...(field.max === undefined ? {} : { max: field.max }),
        ...(field.step === undefined ? {} : { step: field.step }),
        ...(field.language === undefined ? {} : { language: field.language }),
        ...(field.sanitize === undefined ? {} : { sanitize: field.sanitize }),
        ...(field.options === undefined
          ? {}
          : {
              options: Object.freeze(
                field.options.map((option) =>
                  Object.freeze({ value: option.value, label: option.label }),
                ),
              ),
            }),
        ...(field.repeater === undefined
          ? {}
          : {
              repeater: Object.freeze({
                fields: Object.freeze(
                  field.repeater.fields.map((itemField) =>
                    Object.freeze({
                      name: itemField.name,
                      label: itemField.label,
                      type: itemField.type,
                      ...(itemField.required === undefined ? {} : { required: itemField.required }),
                      ...(itemField.min === undefined ? {} : { min: itemField.min }),
                      ...(itemField.max === undefined ? {} : { max: itemField.max }),
                      ...(itemField.step === undefined ? {} : { step: itemField.step }),
                      ...(itemField.options === undefined
                        ? {}
                        : {
                            options: Object.freeze(
                              itemField.options.map((option) =>
                                Object.freeze({ value: option.value, label: option.label }),
                              ),
                            ),
                          }),
                    }),
                  ),
                ),
                ...(field.repeater.maxItems === undefined
                  ? {}
                  : { maxItems: field.repeater.maxItems }),
              }),
            }),
        ...(field.formset === undefined
          ? {}
          : {
              formset: Object.freeze({
                fields: Object.freeze(
                  field.formset.fields.map((subField) =>
                    Object.freeze({
                      name: subField.name,
                      label: subField.label,
                      type: subField.type,
                      ...(subField.required === undefined ? {} : { required: subField.required }),
                      ...(subField.accept === undefined ? {} : { accept: subField.accept }),
                      ...(subField.options === undefined
                        ? {}
                        : {
                            options: Object.freeze(
                              subField.options.map((option) =>
                                Object.freeze({ value: option.value, label: option.label }),
                              ),
                            ),
                          }),
                      ...(subField.min === undefined ? {} : { min: subField.min }),
                      ...(subField.max === undefined ? {} : { max: subField.max }),
                      ...(subField.step === undefined ? {} : { step: subField.step }),
                      ...(subField.language === undefined ? {} : { language: subField.language }),
                      ...(subField.sanitize === undefined ? {} : { sanitize: subField.sanitize }),
                    }),
                  ),
                ),
                ...(field.formset.maxItems === undefined
                  ? {}
                  : { maxItems: field.formset.maxItems }),
                ...(field.formset.minItems === undefined
                  ? {}
                  : { minItems: field.formset.minItems }),
              }),
            }),
      }),
    ),
  );
}
