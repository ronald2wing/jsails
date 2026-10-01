/**
 * Server component definition: the author-facing contract for a stateful,
 * server-rendered component with backend actions.
 *
 * A server component is a plain definition object, not a class or decorator:
 * `defineServerComponent` validates it and `defineAction` preserves per-action
 * input typing. Nothing here opens a connection, mutates the author's object in
 * place, or executes any component callback — validation is structural, and
 * `initialState` / `authorize` / `run` / `render` / `staticFallback` are all
 * deferred to the runtime that consumes the definition.
 *
 * State is declared with `stateSchema` (a Zod object schema), which is the
 * single source of truth for what a component may persist; it is forced
 * `.strict()` so no undeclared field survives a client round-trip (an app
 * secret is never auto-serialized beyond the declared schema). `writableKeys`
 * names the top-level fields a CLIENT update may set — defaulting to none — and
 * each must be a real top-level schema field. This restricts client edits only:
 * actions run server-side and may change any schema-valid field regardless of
 * `writableKeys`.
 *
 * Action input is a separate args object from state, never an assumed
 * `FormData` mapping: `defineAction` declares the args schema and the runtime
 * hands `run(state, args, context)` exactly those parsed args.
 *
 * This module is foundation only. It carries no transport, no renderer, and no
 * persistence: the `bind` / `call` / `submit` helpers it threads into `render`
 * are typed contracts whose implementations the runtime provides, and it holds
 * no store, token, or HMAC logic.
 */

import { z } from 'zod';

import type { RenderChild } from '../contracts/component.js';
import type { JsonObject, JsonValue, RequestContext } from '../contracts/http.js';

/** The state a server component operates on: a JSON-compatible plain object. */
export type ServerComponentState = JsonObject;

/**
 * Attributes `bind(name)` returns for spreading onto a model-bound element.
 *
 * `data-jsails-model` names the top-level state field the element binds to; the
 * runtime reads the element's initial value from that field and writes client
 * edits back to it (only when the field is in `writableKeys`).
 */
export interface ServerComponentModelAttrs {
  readonly 'data-jsails-model': string;
}

/** Attributes `call(action, args?)` returns for spreading onto an action trigger. */
export interface ServerComponentCallAttrs {
  readonly 'data-jsails-call': string;
  readonly 'data-jsails-args'?: string;
}

/**
 * Attributes `submit(action, args?)` returns for spreading onto a form or submit
 * control. `data-turbo` is always `false` so a submit is a plain form POST the
 * runtime handles, never a Turbo-driven client navigation.
 */
export interface ServerComponentSubmitAttrs {
  readonly 'data-jsails-submit': string;
  readonly 'data-jsails-args'?: string;
  readonly 'data-turbo': false;
}

/**
 * Render tools threaded into `render` alongside the current state.
 *
 * `bind`, `call`, and `submit` are the runtime's serialization helpers: they
 * return attribute maps to spread onto elements rather than rendering the
 * transport themselves. `errors` maps form field names to validation messages
 * (empty when the render is not the result of a rejected submission); `values`
 * holds the raw submitted string values for repopulation; `context` is the live
 * request context.
 */
export interface ServerComponentRenderTools<
  State extends ServerComponentState = ServerComponentState,
> {
  readonly bind: (name: keyof State & string) => ServerComponentModelAttrs;
  readonly call: (action: string, args?: JsonValue) => ServerComponentCallAttrs;
  readonly submit: (action: string, args?: JsonValue) => ServerComponentSubmitAttrs;
  readonly errors: Readonly<Record<string, string | undefined>>;
  readonly values: Readonly<Record<string, string>>;
  readonly context: RequestContext;
}

/** The validated input type of an action: the schema's inferred type, or `undefined` when no schema. */
export type ServerComponentActionInput<I> = I extends z.ZodObject<any> ? z.infer<I> : undefined;

/**
 * A single backend action.
 *
 * `input` declares the args schema (a Zod object); args are separate from
 * component state and are never derived from an assumed `FormData` shape.
 * `authorize` optionally further restricts the action for this request beyond
 * the component-level policy; when it returns anything but `true` (or when it
 * is absent) the runtime denies. `run` mutates the request-local `state` clone
 * in place; a returned value is ignored.
 */
export interface ServerComponentAction<State, Input> {
  readonly input?: z.ZodObject<any>;
  authorize?(context: RequestContext, state: State, input: Input): boolean | Promise<boolean>;
  run(state: State, input: Input, context: RequestContext): void | Promise<void>;
}

/**
 * A validated server component definition.
 *
 * `stateSchema` declares the persisted state shape and is REQUIRED; the runtime
 * derives `State` from it. `writableKeys` restricts which top-level fields a
 * CLIENT update may set (defaulting to none). `authorize` is REQUIRED and is the
 * explicit access policy — there is no implicit-public default. `initialState`
 * produces the schema-valid state (async allowed). `actions` is keyed by action
 * name. `render` renders the state; `staticFallback` is the optional no-context
 * render used during static export.
 */
export interface ServerComponentDefinition<
  State extends ServerComponentState = ServerComponentState,
> {
  readonly name: string;
  readonly stateSchema: z.ZodType<State>;
  readonly writableKeys?: readonly (keyof State & string)[];
  initialState(context: RequestContext): State | Promise<State>;
  authorize(context: RequestContext): boolean | Promise<boolean>;
  // NoInfer stops the actions record from widening `State` back to `JsonObject`
  // during inference, so `State` is derived from `stateSchema` alone.
  readonly actions?: Readonly<Record<string, ServerComponentAction<NoInfer<State>, any>>>;
  render(
    state: State,
    tools: ServerComponentRenderTools<State>,
  ): RenderChild | Promise<RenderChild>;
  staticFallback?(context: RequestContext): RenderChild | Promise<RenderChild>;
}

/** Raised when a definition fails structural validation. Messages are value-free. */
export class ServerComponentDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServerComponentDefinitionError';
  }
}

/**
 * Define one action, preserving the input schema's inferred type for `run` and
 * `authorize`.
 *
 * This helper exists for inference: writing the action inline would type the
 * `input` parameter as `any`. `State` is inferred from the component when the
 * definition is given an explicit state type (either `defineServerComponent<S>`
 * or a concretely-typed `stateSchema`); otherwise it widens to the component's
 * state type through the definition's own inference.
 */
export function defineAction<
  State extends ServerComponentState,
  const I extends z.ZodObject<any> | undefined = undefined,
>(definition: {
  input?: I;
  authorize?(
    context: RequestContext,
    state: State,
    input: ServerComponentActionInput<I>,
  ): boolean | Promise<boolean>;
  run(
    state: State,
    input: ServerComponentActionInput<I>,
    context: RequestContext,
  ): void | Promise<void>;
}): ServerComponentAction<State, ServerComponentActionInput<I>> {
  return definition;
}

/** Validate and normalize a definition, forcing strict state and input schemas. */
export function defineServerComponent<State extends ServerComponentState>(
  definition: ServerComponentDefinition<State>,
): ServerComponentDefinition<State> {
  validateDefinition(definition);
  const stateSchema = normalizeStateSchema(definition.stateSchema);
  const writableKeys = normalizeWritableKeys(definition.stateSchema, definition.writableKeys);
  const actions = definition.actions;
  if (actions === undefined) {
    return { ...definition, stateSchema, writableKeys };
  }
  return { ...definition, stateSchema, writableKeys, actions: normalizeActions(actions) };
}

function validateDefinition(definition: ServerComponentDefinition<any>): void {
  if (typeof definition !== 'object' || definition === null) {
    throw new ServerComponentDefinitionError('server component definition must be an object');
  }
  if (typeof definition.name !== 'string' || definition.name.trim() === '') {
    throw new ServerComponentDefinitionError('component name must be a non-empty string');
  }
  if (!(definition.stateSchema instanceof z.ZodObject)) {
    throw new ServerComponentDefinitionError(
      'component must define a stateSchema as a Zod object schema',
    );
  }
  if (typeof definition.initialState !== 'function') {
    throw new ServerComponentDefinitionError('component must define an initialState function');
  }
  if (typeof definition.authorize !== 'function') {
    throw new ServerComponentDefinitionError('component must define an authorize function');
  }
  if (typeof definition.render !== 'function') {
    throw new ServerComponentDefinitionError('component must define a render function');
  }
  if (definition.staticFallback !== undefined && typeof definition.staticFallback !== 'function') {
    throw new ServerComponentDefinitionError('staticFallback must be a function when present');
  }
}

/**
 * Force the state schema `.strict()`. `.strict()` is idempotent and preserves
 * the output type, so re-typing the normalized object as `z.ZodType<State>`
 * keeps `State` unchanged; the caller has already validated it is a ZodObject.
 */
function normalizeStateSchema<State extends ServerComponentState>(
  schema: z.ZodType<State>,
): z.ZodType<State> {
  return (schema as z.ZodObject<any>).strict() as z.ZodType<State>;
}

/**
 * Validate `writableKeys` against the schema's top-level shape and return a
 * frozen copy (an empty frozen array when omitted, so the no-write default is
 * locked in place).
 */
function normalizeWritableKeys<State extends ServerComponentState>(
  schema: z.ZodType<State>,
  keys: readonly (keyof State & string)[] | undefined,
): readonly (keyof State & string)[] {
  if (keys === undefined) {
    return Object.freeze([]);
  }
  const known = Object.keys((schema as z.ZodObject<any>).shape);
  for (const key of keys) {
    validateWritableKey(key, known);
  }
  return Object.freeze([...keys]);
}

function validateWritableKey(key: string, known: readonly string[]): void {
  if (typeof key !== 'string' || key.trim() === '') {
    throw new ServerComponentDefinitionError('writable key must be a non-empty string');
  }
  // `key in Object.prototype` catches `__proto__`, `constructor`, and every
  // other inherited property; a writable key must be an own schema field.
  if (key in Object.prototype) {
    throw new ServerComponentDefinitionError(
      'writable key must not shadow an inherited object property',
    );
  }
  if (!known.includes(key)) {
    throw new ServerComponentDefinitionError('writable key must be a top-level state schema field');
  }
}

function normalizeActions(
  actions: Readonly<Record<string, ServerComponentAction<any, any>>>,
): Readonly<Record<string, ServerComponentAction<any, any>>> {
  // A `__proto__` key in an object literal sets the prototype rather than adding
  // an own key, silently dropping the action; reject that shape up front.
  const prototype = Object.getPrototypeOf(actions);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ServerComponentDefinitionError('actions must be a plain object literal');
  }

  const normalized: Record<string, ServerComponentAction<any, any>> = {};
  for (const [name, action] of Object.entries(actions)) {
    validateActionName(name);
    normalized[name] = normalizeAction(action);
  }
  return normalized;
}

function validateActionName(name: string): void {
  if (name.trim() === '') {
    throw new ServerComponentDefinitionError('action name must be a non-empty string');
  }
  if (name in Object.prototype) {
    throw new ServerComponentDefinitionError(
      'action name must not shadow an inherited object property',
    );
  }
}

function normalizeAction(action: ServerComponentAction<any, any>): ServerComponentAction<any, any> {
  if (typeof action !== 'object' || action === null) {
    throw new ServerComponentDefinitionError('action must be an object');
  }
  if (typeof action.run !== 'function') {
    throw new ServerComponentDefinitionError('action must define a run function');
  }
  if (action.authorize !== undefined && typeof action.authorize !== 'function') {
    throw new ServerComponentDefinitionError('action authorize must be a function when present');
  }
  if (action.input === undefined) {
    return action;
  }
  if (!(action.input instanceof z.ZodObject)) {
    throw new ServerComponentDefinitionError('action input must be a Zod object schema');
  }
  // Force strict: unknown keys are rejected regardless of the author's schema
  // mode, so attacker-supplied fields never slip through a strip/passthrough
  // schema. `.strict()` is idempotent and preserves the output type.
  return { ...action, input: action.input.strict() };
}
