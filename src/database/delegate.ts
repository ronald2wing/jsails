/**
 * `delegate` — forward a property (getter or method) through a relation on
 * a TypeORM Active Record entity.  The delegatee is `this[to][method]`; every
 * access checks the relation for `null`/`undefined` and raises a value-free
 * {@link DelegateError} (`nil_target`) when `allow_nil` is off.
 *
 * Import from `jsails/database` or the root `jsails` entry.
 *
 * ## Forms
 *
 * ```ts
 * // Single property, same name on both sides.
 * delegate('name', { to: 'author' });
 *
 * // Single property, renamed target method.
 * delegate('author_name', { to: 'author', method: 'name' });
 *
 * // Array of same-named properties.
 * delegate(['title', 'body'], { to: 'post' });
 *
 * // Map of class-key → target-method (keys used verbatim).
 * delegate({ author_name: 'name', author_email: 'email' }, { to: 'author' });
 * ```
 *
 * ## Options
 *
 * | Option      | Type               | Default     | Description |
 * |-------------|--------------------|-------------|-------------|
 * | `method`    | `string`           | —           | Target method rename (string form only). |
 * | `prefix`    | `string \| boolean` | —           | `true` → `"<to>_"`; `string` → `"<prefix>_"`. |
 * | `allow_nil` | `boolean`          | `false`     | When `true`, a `null`/`undefined` target returns `undefined`. |
 *
 * ## Errors
 *
 * {@link DelegateError} (value-free):
 * - `nil_target` — the relation is `null`/`undefined` and `allow_nil` is `false`.
 * - `invalid_delegate` — the arguments are malformed (empty `to`, empty methods, …).
 */

import type { ObjectLiteral } from 'typeorm';

// -- types --------------------------------------------------------------------

/** The allowed `methods` argument shapes. */
export type DelegateMethods = string | readonly string[] | Record<string, string>;

/** Options controlling {@link delegate}. */
export interface DelegateOptions {
  /** The relation property name on the source entity (required). */
  readonly to: string;

  /**
   * Target method rename when `methods` is a single string.
   * E.g. `delegate('author_name', { to: 'author', method: 'name' })` forwards
   * `author_name` to `this.author.name`.
   */
  readonly method?: string;

  /**
   * Prefix each generated property key.
   * - `true` → `"<to>_<method>"`.
   * - `string` → `"<prefix>_<method>"`.
   *
   * Applies to string and array `methods` only; map keys are used verbatim.
   */
  readonly prefix?: string | boolean;

  /** When `true`, a `null`/`undefined` target returns `undefined` (no error). */
  readonly allow_nil?: boolean;
}

// -- errors -------------------------------------------------------------------

type DelegateErrorCode = 'nil_target' | 'invalid_delegate';

/** Raised for a missing relation target or an invalid delegate declaration. */
export class DelegateError extends Error {
  /** The error code (value-free). */
  readonly code: DelegateErrorCode;

  constructor(code: DelegateErrorCode, message: string) {
    super(message);
    this.name = 'DelegateError';
    this.code = code;
  }
}

// -- helpers ------------------------------------------------------------------

function isRecord(methods: DelegateMethods): methods is Record<string, string> {
  return typeof methods === 'object' && !Array.isArray(methods) && methods !== null;
}

function isArray(methods: DelegateMethods): methods is readonly string[] {
  return Array.isArray(methods);
}

/**
 * Resolve the prefix string (or `''`) from `options.prefix` + `options.to`.
 * Returns `''` when no prefix is configured.
 */
function resolvePrefix(options: DelegateOptions): string {
  const { prefix, to } = options;
  if (prefix === true) return `${to}_`;
  if (typeof prefix === 'string') return `${prefix}_`;
  return '';
}

/**
 * Build the list of `[classKey, targetMethod]` entries from the `methods`
 * argument and options.
 */
function resolveEntries(
  methods: DelegateMethods,
  options: DelegateOptions,
): Array<[string, string]> {
  const prefix = resolvePrefix(options);

  if (typeof methods === 'string') {
    const classKey = `${prefix}${methods}`;
    const targetMethod = options.method ?? methods;
    return [[classKey, targetMethod]];
  }

  if (isArray(methods)) {
    if (methods.length === 0) {
      throw new DelegateError('invalid_delegate', 'methods array is empty');
    }
    return methods.map((name) => [`${prefix}${name}`, name]);
  }

  if (isRecord(methods)) {
    const entries = Object.entries(methods);
    if (entries.length === 0) {
      throw new DelegateError('invalid_delegate', 'methods map is empty');
    }
    // Validate each entry
    for (const [key, value] of entries) {
      if (typeof key !== 'string' || key.length === 0) {
        throw new DelegateError('invalid_delegate', 'methods map contains an empty key');
      }
      if (typeof value !== 'string' || value.length === 0) {
        throw new DelegateError('invalid_delegate', 'methods map contains an empty value');
      }
    }
    return entries;
  }

  throw new DelegateError(
    'invalid_delegate',
    'methods must be a string, string[], or Record<string,string>',
  );
}

/** Validate options before use. Throws {@link DelegateError} on invalid input. */
function validateOptions(options: DelegateOptions): void {
  if (!options || typeof options.to !== 'string' || options.to.length === 0) {
    throw new DelegateError('invalid_delegate', '"to" option must be a non-empty string');
  }

  // `method` is only valid when `methods` is a string — validated late in
  // resolveEntries, so skip here.
}

// -- property definition ------------------------------------------------------

/**
 * Install a forwarding getter for `classKey` on `proto` that delegates to
 * `this[to][targetMethod]`.
 */
function defineDelegateProperty(
  proto: unknown,
  classKey: string,
  to: string,
  targetMethod: string,
  allowNil: boolean,
): void {
  Object.defineProperty(proto, classKey, {
    configurable: true,
    enumerable: true,
    get(this: ObjectLiteral) {
      const target = this[to as keyof typeof this] as ObjectLiteral | null | undefined;

      if (target == null) {
        if (allowNil) return undefined;
        throw new DelegateError('nil_target', `Cannot delegate '${classKey}' — ${to} is nil`);
      }

      const value = target[targetMethod as keyof typeof target];

      // Forward methods: bind `this` to the target so the receiver is the
      // relation target, not the delegating entity.
      if (typeof value === 'function') {
        return (value as (...args: unknown[]) => unknown).bind(target);
      }

      return value;
    },
  });
}

// -- public API ---------------------------------------------------------------

/**
 * Install forwarding getters on a class's prototype that delegate to a
 * relation target.
 *
 * Usable as a class decorator (`@delegate(...)`) or called directly
 * (`delegate(...)(MyEntity)`).
 *
 * @param methods  — Single property name, array of names, or a rename map.
 * @param options  — `to` (required), plus optional `method`, `prefix`, `allow_nil`.
 * @returns A function that, when called with a class constructor, modifies its prototype.
 * @throws {DelegateError} (`invalid_delegate`) on malformed arguments.
 */
export function delegate(
  methods: DelegateMethods,
  options: DelegateOptions,
): (target: Function) => void {
  validateOptions(options);
  const entries = resolveEntries(methods, options);
  const { to } = options;
  const allowNil = options.allow_nil === true;

  return (target: Function): void => {
    const proto = 'prototype' in target ? (target as { prototype: unknown }).prototype : target;

    for (const [classKey, targetMethod] of entries) {
      defineDelegateProperty(proto, classKey, to, targetMethod, allowNil);
    }
  };
}
