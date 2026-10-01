/**
 * Declarative, read-only URL query-string binding for server components.
 *
 * A component declares which state fields are seeded from the request URL's
 * query string on the first (mount) render. Seeding runs exactly once, before
 * the initial state is schema-parsed and signed; subsequent updates reconstruct
 * state only from the signed snapshot (the URL is never re-read after mount).
 *
 * This module is pure and server-only (no I/O, no `node:*`).
 */

import type { ZodObject } from 'zod';
import { z } from 'zod';

import type { JsonValue } from '../contracts/http.js';
import type { ServerComponentState } from './component.js';

/** The list of state field names to seed from the URL query string on mount. */
export type ServerComponentUrlBinding = readonly string[];

// ---------------------------------------------------------------------------
// Schema-kind detection
// ---------------------------------------------------------------------------

/**
 * Classify a Zod schema into one of three coercible primitives or `'other'`.
 *
 * Returns `'string'`, `'number'`, or `'boolean'` when the inner schema (after
 * peeling Optional/Nullable/Default wrappers and Pipe layers) is a ZodString,
 * ZodNumber, or ZodBoolean. A `z.coerce.number()` is already an instance of
 * `ZodNumber` in Zod 4, so coercion is transparent.
 *
 * Anything else returns `'other'` and will be silently skipped during seeding.
 */
function schemaKind(fieldSchema: z.ZodType | undefined): 'string' | 'number' | 'boolean' | 'other' {
  if (fieldSchema === undefined) {
    return 'other';
  }

  const base = unwrapBase(fieldSchema);

  if (base instanceof z.ZodString) {
    return 'string';
  }
  if (base instanceof z.ZodNumber) {
    return 'number';
  }
  if (base instanceof z.ZodBoolean) {
    return 'boolean';
  }
  return 'other';
}

/**
 * Peel Optional/Nullable/Default wrappers and one Pip layer to reach the
 * underlying schema. Follows the same pattern as `unwrap()` in
 * `validation-meta.ts`.
 */
function unwrapBase(schema: z.ZodType): z.ZodType {
  let current = schema;
  for (;;) {
    if (
      current instanceof z.ZodOptional ||
      current instanceof z.ZodNullable ||
      current instanceof z.ZodDefault
    ) {
      current = current.unwrap() as unknown as z.ZodType;
      continue;
    }
    if (current instanceof z.ZodPipe) {
      const out = (current as unknown as { _zod?: { def?: { out?: z.ZodType } } })._zod?.def?.out;
      if (out !== undefined && out !== current) {
        current = out;
        continue;
      }
    }
    break;
  }
  return current;
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

/**
 * Seed declared state fields from the request URL's query string.
 *
 * For each field name in `fields`, read `url.searchParams.get(field)`. When the
 * value is present, coerce it to the field's declared type (as determined by
 * {@link schemaKind}); when it coerces cleanly, set it on a new shallow-copied
 * state object. When absent, uncoercible, or of an unsupported schema kind,
 * leave the existing `state[field]` untouched.
 *
 * This function NEVER throws and NEVER echoes raw query values in errors — the
 * query string is hostile/untrusted input and seeding is a graceful hint, not a
 * validation gate. Subsequent `stateSchema.parse()` in mount is the canonical
 * validation.
 *
 * @param state  The initial state produced by `initialState()`.
 * @param schema The component's Zod state schema (for per-field type lookup).
 * @param url    The request URL whose query string is examined.
 * @param fields The set of field names declared in `urlBinding` (deduped).
 * @returns A new shallow-copied state object with seed fields overlaid.
 */
export function seedFromUrl(
  state: ServerComponentState,
  schema: ZodObject<any>,
  url: URL,
  fields: ReadonlySet<string>,
): ServerComponentState {
  // Short-circuit: no fields to seed.
  if (fields.size === 0) {
    return state;
  }

  const shape = (schema as ZodObject<any> & { shape: Record<string, z.ZodType | undefined> }).shape;
  const seeded = { ...state };
  let changed = false;

  for (const field of fields) {
    const raw = url.searchParams.get(field);
    if (raw === null) {
      continue;
    }

    const kind = schemaKind(shape[field]);
    let coerced: unknown;

    switch (kind) {
      case 'string':
        coerced = raw;
        break;
      case 'number': {
        const n = Number(raw);
        if (isNaN(n)) {
          continue;
        }
        coerced = n;
        break;
      }
      case 'boolean': {
        if (raw === 'true') {
          coerced = true;
        } else if (raw === 'false') {
          coerced = false;
        } else {
          continue;
        }
        break;
      }
      default:
        // Unsupported schema kind (enum, array, object, optional, union, etc.)
        // — skip silently. The query string is untrusted; never guess.
        continue;
    }

    // coerced is always a JsonValue at this point (string, number, or boolean).
    seeded[field] = coerced as JsonValue;
    changed = true;
  }

  // Avoid allocating when no field was actually seeded.
  return changed ? seeded : state;
}
