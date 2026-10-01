/**
 * Prototype-pollution guard for client-decoded JSON.
 *
 * Decoded snapshots, action args, and field keys are untrusted client data.
 * Before any value enters working state the client refuses own object keys that
 * can pollute a prototype (`__proto__`, `constructor`, `prototype`) and keys
 * that shadow an inherited property of a plain object.
 *
 * `isForbiddenKey` is re-exported from the canonical `FORBIDDEN_KEYS` set in
 * `src/internal/json-safe.ts`; `shadowsObjectPrototype` stays here because it
 * checks *all* `Object.prototype` properties, not just the forbidden three.
 */

export { isForbiddenKey } from '../../internal/json-safe.js';

/** True when `key` is an own/inherited property of a plain object's prototype. */
export function shadowsObjectPrototype(key: string): boolean {
  return key in Object.prototype;
}
