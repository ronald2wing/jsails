/**
 * Internal JSON-shape helpers shared across the schema, snapshot, upload,
 * deploy, scaffold, and client-state surfaces.
 *
 * Kept dependency-free (no Node runtime imports, no browser globals) so both
 * the browser-safe `jsails/client` bundle and server modules can import it.
 * Nothing here is re-exported from the package entry (`src/index.ts`).
 *
 * ## JSON value types
 *
 * {@link JsonValue} and {@link JsonObject} are the canonical type definitions
 * shared across kernel HTTP contracts and browser-safe broadcast client code.
 * They are pure type aliases — erased at compile time — so importing them adds
 * no runtime weight and no dependency.
 */

/** A JSON-compatible value. */
export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** A string-keyed JSON object. */
export type JsonObject = { [key: string]: JsonValue };

/**
 * True for a plain object (object literal or `Object.create(null)`), never an
 * array, `null`, or a class instance.
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Deep-clone an already JSON-safe value so callers can never mutate live shared
 * state through a reference shared with the original.
 */
export function deepCloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Own object keys that must never appear in client state, snapshots, or args. */
export const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** True when `key` is a dangerous own key that must be rejected at any depth. */
export function isForbiddenKey(key: string): boolean {
  return FORBIDDEN_KEYS.has(key);
}
