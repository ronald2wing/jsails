/**
 * `defineSimpleComponent` — thin sugar over `defineServerComponent` for the
 * 80%-case: a form, toggle, or counter whose state is declared as a `fields`
 * map and whose single action is a `run` function.
 *
 * Delegates to `defineServerComponent` after deriving `stateSchema`,
 * `writableKeys`, and the `'submit'` action from the sugar input.  This module
 * adds no runtime, no transport, and no new error class — it reuses the
 * existing validation in `defineServerComponent` and produces the same frozen
 * `ServerComponentDefinition`.
 */

import { z } from 'zod';

import type { RenderChild } from '../contracts/component.js';
import type { RequestContext } from '../contracts/http.js';
import {
  defineAction,
  defineServerComponent,
  ServerComponentDefinitionError,
} from './component.js';
import type {
  ServerComponentDefinition,
  ServerComponentRenderTools,
  ServerComponentState,
} from './component.js';

// Re-export so callers can catch the same error class.
export { ServerComponentDefinitionError };

// ---------------------------------------------------------------------------
// Field spec helpers
// ---------------------------------------------------------------------------

/**
 * A single entry in the `fields` map.
 *
 * Bare Zod schema form — the field is writable by default.
 *
 * Object form — `schema` is required; `writable` gates client edits (defaults
 * to `false` when the object form is used without an explicit `writable`).
 */
type FieldEntry = z.ZodTypeAny | { readonly schema: z.ZodTypeAny; readonly writable?: boolean };

function extractSchema(entry: FieldEntry): z.ZodTypeAny {
  if (entry instanceof z.ZodType) {
    return entry;
  }
  return entry.schema;
}

/**
 * A field entered as a bare Zod schema is always writable.  A field entered as
 * `{ schema, writable }` is writable only when `writable` is explicitly `true` —
 * an absent `writable` key means the field is read-only.
 */
function fieldIsWritable(entry: FieldEntry): boolean {
  if (entry instanceof z.ZodType) {
    return true;
  }
  return entry.writable === true;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateSimpleComponent(name: string, spec: Record<string, unknown>): void {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new ServerComponentDefinitionError('component name must be a non-empty string');
  }
  if (typeof spec !== 'object' || spec === null) {
    throw new ServerComponentDefinitionError('spec must be an object');
  }
  if (typeof spec.fields !== 'object' || spec.fields === null || Array.isArray(spec.fields)) {
    throw new ServerComponentDefinitionError('fields must be a non-empty plain object');
  }
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
  if (Object.keys(spec.fields as Record<string, unknown>).length === 0) {
    throw new ServerComponentDefinitionError('fields must be a non-empty plain object');
  }
  if (typeof spec.render !== 'function') {
    throw new ServerComponentDefinitionError('render must be a function');
  }
}

function validateFieldEntry(key: string, entry: unknown): void {
  if (entry === null || typeof entry !== 'object') {
    throw new ServerComponentDefinitionError(
      `field "${key}" must be a Zod schema or a { schema, writable? } object`,
    );
  }
  if (entry instanceof z.ZodType) {
    return;
  }
  const obj = entry as Record<string, unknown>;
  if (!(obj.schema instanceof z.ZodType)) {
    throw new ServerComponentDefinitionError(
      `field "${key}" must have a "schema" property that is a Zod schema`,
    );
  }
  if (obj.writable !== undefined && typeof obj.writable !== 'boolean') {
    throw new ServerComponentDefinitionError(
      `field "${key}" writable must be a boolean when present`,
    );
  }
}

// ---------------------------------------------------------------------------
// Derivation helpers
// ---------------------------------------------------------------------------

function deriveFields(fields: Record<string, FieldEntry>): {
  stateSchema: z.ZodObject<any>;
  writableKeys: readonly string[];
} {
  const shape: Record<string, z.ZodTypeAny> = {};
  const writable: string[] = [];

  for (const [key, entry] of Object.entries(fields)) {
    validateFieldEntry(key, entry);
    shape[key] = extractSchema(entry);
    if (fieldIsWritable(entry)) {
      writable.push(key);
    }
  }

  return {
    stateSchema: z.object(shape),
    writableKeys: Object.freeze(writable),
  };
}

/**
 * Derive an `initialState` from the fields' Zod schemas.  Each schema is
 * inspected for an explicit `.default()`; when absent, a type-appropriate zero
 * value is used (empty string, 0, false, [], {}).  Schemas whose type cannot be
 * determined fall back to `undefined` — the strict schema parse will catch
 * those at runtime, and the caller should supply an explicit `initialState`.
 */
function deriveInitialState(fields: Record<string, FieldEntry>): Record<string, unknown> {
  const state: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(fields)) {
    const schema = extractSchema(entry);
    state[key] = defaultValueFor(schema);
  }
  return state;
}

function defaultValueFor(schema: z.ZodTypeAny): unknown {
  const def = (schema as any)._def;
  // Zod v3 uses `_def.type`, not `_def.typeName`.
  if (def.type === 'default') {
    const dv = def.defaultValue;
    return typeof dv === 'function' ? dv() : dv;
  }
  if (def.type === 'string') {
    return '';
  }
  if (def.type === 'number' || def.type === 'bigint') {
    return 0;
  }
  if (def.type === 'boolean') {
    return false;
  }
  if (def.type === 'array') {
    return [];
  }
  if (def.type === 'object') {
    return {};
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Options accepted by `defineSimpleComponent`. */
export interface DefineSimpleComponentOptions<State extends ServerComponentState> {
  readonly fields: Record<string, FieldEntry>;
  /** The single action, dispatched as `'submit'` with no args. */
  run?(state: State, context: RequestContext): void | Promise<void>;
  render(
    state: State,
    tools: ServerComponentRenderTools<State>,
  ): RenderChild | Promise<RenderChild>;
  readonly authorize?: (context: RequestContext) => boolean | Promise<boolean>;
  readonly initialState?: (context: RequestContext) => State | Promise<State>;
  readonly staticFallback?: (context: RequestContext) => RenderChild | Promise<RenderChild>;
  readonly urlBinding?: readonly string[];
  readonly computed?: Readonly<Record<string, (state: State, context: RequestContext) => unknown>>;
  readonly hydrate?: (state: State, context: RequestContext) => void | Promise<void>;
  readonly updating?: (state: State, context: RequestContext) => void | Promise<void>;
  readonly updated?: (state: State, context: RequestContext) => void | Promise<void>;
  readonly mount?: (context: RequestContext) => void | Promise<void>;
}

/**
 * Define a server component from a `fields` map rather than an explicit
 * `stateSchema` + `writableKeys` + `actions` record.
 *
 * - `fields` — a map where each value is either a bare Zod schema (field is
 *   writable by default) or a `{ schema, writable? }` object (writable only
 *   when `writable` is explicitly `true`).
 * - `run` — optional single action dispatched as `'submit'` with no args.
 * - `render` — the render function (required).
 * - `authorize` — optional; defaults to `() => true` (public component).
 * - `initialState` — optional; defaults to a zero-value object derived from
 *   each field's Zod type or explicit `.default()`.
 * - Lifecycle hooks and `computed` / `urlBinding` / `staticFallback` pass
 *   through to `defineServerComponent` when present.
 *
 * Delegates to `defineServerComponent` for final validation and normalization;
 * returns the same frozen `ServerComponentDefinition`.
 */
export function defineSimpleComponent<State extends ServerComponentState>(
  name: string,
  spec: DefineSimpleComponentOptions<State>,
): ServerComponentDefinition<State> {
  validateSimpleComponent(name, spec as unknown as Record<string, unknown>);

  const { stateSchema, writableKeys } = deriveFields(spec.fields);

  const runFn = spec.run;
  const actions: Record<string, any> | undefined = runFn
    ? {
        submit: defineAction({
          input: z.object({}),
          run(state: State, _input: Record<string, never>, context: RequestContext) {
            return runFn(state, context);
          },
        }),
      }
    : undefined;

  // Build the full definition at once — ServerComponentDefinition fields are
  // `readonly`, so incremental assignment is not allowed.
  const definition = {
    name,
    stateSchema,
    writableKeys,
    authorize: spec.authorize ?? (() => true),
    initialState: spec.initialState ?? (() => deriveInitialState(spec.fields) as State),
    render: spec.render,
    ...(actions === undefined ? {} : { actions }),
    ...(spec.staticFallback === undefined ? {} : { staticFallback: spec.staticFallback }),
    ...(spec.urlBinding === undefined ? {} : { urlBinding: spec.urlBinding }),
    ...(spec.computed === undefined ? {} : { computed: spec.computed }),
    ...(spec.hydrate === undefined ? {} : { hydrate: spec.hydrate }),
    ...(spec.updating === undefined ? {} : { updating: spec.updating }),
    ...(spec.updated === undefined ? {} : { updated: spec.updated }),
    ...(spec.mount === undefined ? {} : { mount: spec.mount }),
  } as unknown as ServerComponentDefinition<State>;

  return defineServerComponent(definition);
}
