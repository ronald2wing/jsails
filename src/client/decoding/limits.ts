/**
 * Bounds and bounded-JSON machinery for the client component controller.
 *
 * Every numeric limit the controller enforces (snapshot token/payload size,
 * response body sizes, JSON nesting depth, arg key count, queue depth) lives
 * here, together with the iterative value scanner that rejects excessive
 * nesting, non-finite numbers, non-plain objects, dangerous keys (via
 * `./proto-guard.js`), cycles, and non-JSON values — plus the structural
 * equality helper the dirty-diff uses.
 */

import { isPlainObject } from '../../internal/json-safe.js';
import { isForbiddenKey } from './proto-guard.js';

/** Maximum accepted snapshot token length (base64url payload + signature). */
export const MAX_SNAPSHOT_TOKEN_LENGTH = 512 * 1024;
/** Maximum accepted decoded snapshot payload size, in bytes. */
export const MAX_SNAPSHOT_PAYLOAD_BYTES = 384 * 1024;
/** Maximum accepted update response body size, in characters. */
export const MAX_RESPONSE_BODY_LENGTH = 2 * 1024 * 1024;
/** Maximum accepted upload response body size, in characters. */
export const MAX_UPLOAD_RESPONSE_BODY_LENGTH = 64 * 1024;
/** Maximum JSON nesting depth accepted from a snapshot or a local edit. */
export const MAX_JSON_DEPTH = 64;
/** Maximum number of keys accepted in an action args object. */
export const MAX_ARGS_KEYS = 1000;
/** Default bound on the number of queued (not yet dispatched) actions. */
export const DEFAULT_MAX_QUEUE = 8;

export type JsonViolation =
  'depth' | 'non-finite' | 'non-plain' | 'forbidden-key' | 'non-json' | 'circular';

type ScanFrame =
  | { readonly kind: 'enter'; readonly value: unknown; readonly depth: number }
  | { readonly kind: 'exit'; readonly value: object };

/**
 * Scan an arbitrary value for the first portability/safety violation: excessive
 * nesting, non-finite numbers, non-plain objects, dangerous own keys, cycles, or
 * values that are not JSON at all. Iterative (explicit stack) so a deeply nested
 * value cannot overflow the call stack. Returns `null` when the value is safe.
 */
export function scanJson(root: unknown): JsonViolation | null {
  const stack: ScanFrame[] = [{ kind: 'enter', value: root, depth: 0 }];
  const ancestors = new Set<object>();

  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (frame.kind === 'exit') {
      ancestors.delete(frame.value);
      continue;
    }

    const { value, depth } = frame;
    if (depth > MAX_JSON_DEPTH) {
      return 'depth';
    }
    if (value === null) {
      continue;
    }

    const type = typeof value;
    if (type === 'string' || type === 'boolean') {
      continue;
    }
    if (type === 'number') {
      if (!Number.isFinite(value)) {
        return 'non-finite';
      }
      continue;
    }
    if (Array.isArray(value)) {
      if (ancestors.has(value)) {
        return 'circular';
      }
      ancestors.add(value);
      stack.push({ kind: 'exit', value });
      for (const item of value) {
        stack.push({ kind: 'enter', value: item, depth: depth + 1 });
      }
      continue;
    }
    if (type === 'object') {
      if (!isPlainObject(value)) {
        return 'non-plain';
      }
      if (ancestors.has(value)) {
        return 'circular';
      }
      ancestors.add(value);
      stack.push({ kind: 'exit', value });
      const record = value;
      for (const key of Object.keys(record)) {
        if (isForbiddenKey(key)) {
          return 'forbidden-key';
        }
        stack.push({ kind: 'enter', value: record[key], depth: depth + 1 });
      }
      continue;
    }
    return 'non-json';
  }

  return null;
}

export function jsonViolationMessage(violation: JsonViolation): string {
  switch (violation) {
    case 'depth':
      return 'value exceeds the maximum nesting depth';
    case 'non-finite':
      return 'value contains a non-finite number';
    case 'non-plain':
      return 'value must contain only plain JSON objects';
    case 'forbidden-key':
      return 'value contains a forbidden key';
    case 'circular':
      return 'value must not contain circular references';
    case 'non-json':
      return 'value must contain only JSON values';
  }
}

/** Structural JSON equality (no cycles; inputs are validated JSON values). */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      return false;
    }
    for (let i = 0; i < a.length; i += 1) {
      if (!jsonEqual(a[i], b[i])) {
        return false;
      }
    }
    return true;
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) {
      return false;
    }
    for (const key of aKeys) {
      if (!Object.hasOwn(b, key) || !jsonEqual(a[key], b[key])) {
        return false;
      }
    }
    return true;
  }
  return false;
}
