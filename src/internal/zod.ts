/**
 * Canonical Zod-issue mapper: a single, value-free {@link mapZodIssues} shared
 * by every module that translates Zod validation failures into structured
 * field errors.
 *
 * This module is INTERNAL ONLY — it is never exported from the root `jsails`
 * entry or from `jsails/extensions`. Call sites import it directly.
 */

import type { z } from 'zod';

/** A single value-free field error mapped from a Zod issue. */
export interface ZodIssueEntry {
  /** Dotted path to the failing field, e.g. `"user.name"` or `"tags.0"`. An empty-path (root) failure uses `"_root"`. */
  readonly path: string;
  /** Zod issue code, e.g. `"invalid_type"`, `"too_small"`. */
  readonly code: string;
  /** Short, value-free description derived only from the schema, never from input values. */
  readonly message: string;
}

/**
 * Translate Zod validation failures into a flat array of value-free
 * `ZodIssueEntry` objects. Accepts either a `ZodError` or its `issues` array.
 *
 * Every message is derived from the schema (expected type, bounds, format)
 * and never echoes input values. `unrecognized_keys` issues are expanded:
 * each unrecognized key produces its own entry with the key name appended to
 * the path.
 *
 * The `path` is a dotted string joining array segments: `["user", "tags", 2]`
 * becomes `"user.tags.2"`. An empty path (root-level failure) becomes `"_root"`.
 */
export function mapZodIssues(input: z.ZodError | readonly z.ZodIssue[]): ZodIssueEntry[] {
  // Normalize: a ZodError carries its issues under `.issues`; an array is
  // already the issue list. We check structurally so only a type import is
  // needed — no runtime Zod dependency.
  const issues = Array.isArray(input) ? input : (input as z.ZodError).issues;
  return issues.flatMap(mapIssue);
}

function mapIssue(issue: z.ZodIssue): ZodIssueEntry[] {
  const path = formatPath(issue.path);
  const message = describeIssue(issue);
  // Expand unrecognized_keys so each unknown key is its own entry with a
  // precise dotted path. The key is input-provided, so it appears only in the
  // path, never in the message.
  if (issue.code === 'unrecognized_keys') {
    return issue.keys.map((key) => ({
      path: path === '_root' ? key : `${path}.${key}`,
      code: 'unrecognized_keys',
      message: 'unrecognized field',
    }));
  }
  return [{ path, code: issue.code, message }];
}

/** Join a Zod path into a dotted string. Empty path returns `"_root"`. */
/**
 * Zod issue paths are `PropertyKey[]` at the type level (string | number | symbol),
 * but in practice they are always `(string | number)[]`. The cast mirrors
 * every existing mapper in the codebase.
 */
function formatPath(path: readonly PropertyKey[]): string {
  return path.length === 0 ? '_root' : path.join('.');
}

/**
 * Produce a value-free message for a Zod issue. Only schema-derived facts
 * (bounds, expected types) are emitted; the raw input and the `received` field
 * Zod attaches to issues are never echoed.
 */
function describeIssue(issue: z.ZodIssue): string {
  switch (issue.code) {
    case 'invalid_type':
      return `expected ${typeName(issue.expected)}`;
    case 'too_small':
      return `must be at least ${issue.minimum}`;
    case 'too_big':
      return `must be at most ${issue.maximum}`;
    case 'invalid_format':
      return 'invalid format';
    case 'invalid_value':
      return 'invalid value';
    // Zod emits 'custom' for .refine() / .superRefine() failures. Map it to
    // the same stable message so callers don't need their own custom-code switch.
    case 'custom':
      return 'invalid value';
    default:
      // For any other Zod issue code, use the code itself as a stable,
      // value-free message rather than echoing Zod's `issue.message` (which
      // may contain user-supplied text from `.describe()` or custom errors).
      return issue.code;
  }
}

function typeName(expected: string): string {
  switch (expected) {
    case 'string':
      return 'a string';
    case 'number':
    case 'int':
      return 'a number';
    case 'boolean':
      return 'a boolean';
    case 'object':
    case 'record':
      return 'an object';
    case 'array':
    case 'tuple':
      return 'an array';
    default:
      return 'a valid value';
  }
}
