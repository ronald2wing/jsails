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
import type { ServerComponentDownload } from './downloads.js';

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
  /** Present when `bind(name, { debounceMs })` requests client-side debounce. */
  readonly 'data-jsails-debounce'?: string;
  /** Bounded JSON validation rules derived from the field's Zod schema. */
  readonly 'data-jsails-rules'?: string;
}

/** Options accepted by `bind(name, options?)` for a debounced control. */
export interface ServerComponentBindOptions {
  /** Debounce window, in milliseconds, before the client flushes the edit. */
  readonly debounceMs?: number;
}

/** Options accepted by `poll(options)` for a root-level poll marker. */
export interface ServerComponentPollOptions {
  readonly intervalMs: number;
  readonly pauseWhenHidden?: boolean;
  readonly pauseWhenOffline?: boolean;
}

/** Attributes `poll(options)` returns for spreading onto a component root. */
export interface ServerComponentPollAttrs {
  readonly 'data-jsails-poll': string;
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
 * A computed property: a derived, read-only view value resolved at render time.
 *
 * Computed values are never part of persisted state and never client-writable:
 * they are derived from the current state (and request context) each render and
 * exposed to `render` through `tools.computed(name)`. The result may be any
 * renderable value, including a Promise for async derivation; it is memoized per
 * render so multiple accesses evaluate the function once.
 */
export type ServerComponentComputed<State extends ServerComponentState = ServerComponentState> = (
  state: State,
  context: RequestContext,
) => unknown;

/**
 * Render tools threaded into `render` alongside the current state.
 *
 * `bind`, `call`, and `submit` are the runtime's serialization helpers: they
 * return attribute maps to spread onto elements rather than rendering the
 * transport themselves. `errors` maps form field names to validation messages
 * (empty when the render is not the result of a rejected submission); `values`
 * holds the raw submitted string values for repopulation; `context` is the live
 * request context. `computed(name)` resolves a declared {@link ServerComponentComputed}
 * to its current value (read-only, never persisted).
 */
export interface ServerComponentRenderTools<
  State extends ServerComponentState = ServerComponentState,
> {
  readonly bind: (
    name: keyof State & string,
    options?: ServerComponentBindOptions,
  ) => ServerComponentModelAttrs;
  readonly call: (action: string, args?: JsonValue) => ServerComponentCallAttrs;
  readonly submit: (action: string, args?: JsonValue) => ServerComponentSubmitAttrs;
  readonly poll: (options: ServerComponentPollOptions) => ServerComponentPollAttrs;
  readonly confirm: (message: string) => Record<string, string>;
  readonly loadingTarget: (target: string) => Record<string, string>;
  readonly show: (field: string) => Record<string, string>;
  readonly text: (field: string) => Record<string, string>;
  readonly sort: (field: string) => Record<string, string>;
  readonly intersect: (action: string) => Record<string, string>;
  readonly ref: (name: string) => Record<string, string>;
  readonly ignore: () => Record<string, string>;
  readonly computed: (name: string) => unknown;
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
 * in place; returning a {@link ServerComponentRedirect} signals a client-side
 * navigation after the render is applied, and `undefined`/`void` means no
 * redirect.
 */
export interface ServerComponentAction<State, Input> {
  readonly input?: z.ZodObject<any>;
  authorize?(context: RequestContext, state: State, input: Input): boolean | Promise<boolean>;
  run(
    state: State,
    input: Input,
    context: RequestContext,
  ):
    | void
    | ServerComponentRedirect
    | ServerComponentDownload
    | Promise<void | ServerComponentRedirect | ServerComponentDownload>;
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
  /**
   * Top-level state field names seeded from the request URL's query string on
   * the first (mount) render only. Each entry names a field whose value is
   * read from `?<name>=<value>`, coerced to the field's declared Zod type, and
   * overlaid onto initialState before the schema parse. Subsequent updates
   * reconstruct state only from the signed snapshot — the URL is never re-read
   * after mount. Declare this for read-only URL seeding (Livewire `$queryString`
   * equivalent, scoped down); never for write-back URL manipulation.
   */
  readonly urlBinding?: readonly string[];
  initialState(context: RequestContext): State | Promise<State>;
  authorize(context: RequestContext): boolean | Promise<boolean>;
  // NoInfer stops the actions record from widening `State` back to `JsonObject`
  // during inference, so `State` is derived from `stateSchema` alone.
  readonly actions?: Readonly<Record<string, ServerComponentAction<NoInfer<State>, any>>>;
  /**
   * Lifecycle hooks, all optional and awaited in order. `hydrate` runs after a
   * snapshot is verified and before any client edit (server-side rehydration of
   * the reconstructed state); `updating` runs before client edits are applied
   * and may throw a value-free error to reject the update; `updated` runs after
   * a successful update or action, before the re-render; `mount` runs once on
   * the first (live) server render. Hooks receive the mutable server-side state
   * (except `mount`, which receives only the context) and may mutate it in place.
   */
  hydrate?(state: State, context: RequestContext): void | Promise<void>;
  updating?(state: State, context: RequestContext): void | Promise<void>;
  updated?(state: State, context: RequestContext): void | Promise<void>;
  mount?(context: RequestContext): void | Promise<void>;
  /**
   * Computed properties keyed by name. Each function derives a read-only view
   * value from the current state and request context at render time; names must
   * not collide with a top-level state field (rejected at definition time).
   * `NoInfer` keeps `State` derived from `stateSchema` alone, matching `actions`.
   */
  readonly computed?: Readonly<Record<string, ServerComponentComputed<NoInfer<State>>>>;
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

// ---------------------------------------------------------------------------
// Action redirect
// ---------------------------------------------------------------------------

/**
 * The value a server-component action returns to signal a client-side
 * navigation. The runtime carries the target URL in the update response; the
 * client applies the render, then navigates (via Turbo soft-navigation when
 * available, or `location.assign` as a fallback).
 *
 * A structural discriminator (`__jsailsRedirect: true`) matches the other
 * reserved-key payload guards in this framework (`isChainDescriptor`,
 * `isBatchDescriptor`, `isOverlapDescriptor`). A Symbol brand is unnecessary:
 * the runtime reads only the direct return value of the trusted `run` function
 * (producer code, not client input), so the discriminator is a type-level
 * narrowing aid, never a security boundary.
 */
export interface ServerComponentRedirect {
  readonly __jsailsRedirect: true;
  /** The navigation target URL, validated server-side. */
  readonly url: string;
}

/**
 * Structural guard: the value is a {@link ServerComponentRedirect} produced by
 * {@link redirect}. Read-only detection, never a spoofing boundary — the
 * runtime's input is the action's own return value (trusted producer code).
 */
export function isRedirect(value: unknown): value is ServerComponentRedirect {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  return (value as { __jsailsRedirect?: unknown }).__jsailsRedirect === true;
}

/**
 * Signal a client-side navigation from a server-component action.
 *
 * The URL is validated eagerly: it must be a non-empty string with no control
 * characters or whitespace, and it must not use a `javascript:`, `data:`, or
 * `vbscript:` scheme — these are open-redirect / XSS vectors that turn a
 * user-controlled navigation target into script execution. Relative paths
 * (`/dashboard`), absolute `http(s)://` URLs, and other safe schemes are
 * allowed.
 *
 * Throw a value-free `TypeError` on invalid input.
 * The returned value is a signal to the runtime; it carries no transport logic.
 */
export function redirect(url: string): ServerComponentRedirect {
  if (typeof url !== 'string' || url.trim() === '') {
    throw new TypeError('redirect url must be a non-empty string');
  }
  // Reject control characters and whitespace so the URL cannot embed a newline
  // or null byte that escapes the HTTP header / transport envelope.
  if (/[\x00-\x1f\x7f\s]/.test(url)) {
    throw new TypeError('redirect url must not contain control characters or whitespace');
  }
  // Reject javascript:/data:/vbscript: schemes (case-insensitive) to prevent
  // an open redirect from executing script in the browser. The caller may still
  // compose the URL from user input; this check is the last line of defense
  // against a `javascript:alert(1)` payload.
  const trimmed = url.trim();
  const schemeEnd = trimmed.indexOf(':');
  if (schemeEnd !== -1) {
    const scheme = trimmed.slice(0, schemeEnd).toLowerCase();
    if (scheme === 'javascript' || scheme === 'data' || scheme === 'vbscript') {
      throw new TypeError('redirect url must not use a javascript:, data:, or vbscript: scheme');
    }
  }
  return { __jsailsRedirect: true, url: trimmed };
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
  ):
    | void
    | ServerComponentRedirect
    | ServerComponentDownload
    | Promise<void | ServerComponentRedirect | ServerComponentDownload>;
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
  const computed = normalizeComputed(definition.stateSchema, definition.computed);
  return {
    ...definition,
    stateSchema,
    writableKeys,
    ...(actions === undefined ? {} : { actions: normalizeActions(actions) }),
    ...(computed === undefined ? {} : { computed }),
  };
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
  // urlBinding, when declared, must be a non-empty array of non-empty strings.
  // Duplicate field names are tolerated (Set semantics dedupe in the runtime).
  if (definition.urlBinding !== undefined) {
    if (!Array.isArray(definition.urlBinding) || definition.urlBinding.length === 0) {
      throw new ServerComponentDefinitionError(
        'urlBinding must be a non-empty array of field names',
      );
    }
    for (let i = 0; i < definition.urlBinding.length; i++) {
      const field = definition.urlBinding[i];
      if (typeof field !== 'string' || field.trim() === '') {
        throw new ServerComponentDefinitionError(
          'urlBinding must contain only non-empty string field names',
        );
      }
    }
  }
  // Lifecycle hooks are optional; when declared they must be callable.
  for (const hook of ['hydrate', 'updating', 'updated', 'mount'] as const) {
    if (definition[hook] !== undefined && typeof definition[hook] !== 'function') {
      throw new ServerComponentDefinitionError(`${hook} must be a function when present`);
    }
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

/**
 * Validate and normalize the `computed` map. Each name must be a non-empty,
 * non-inherited key that does not collide with a top-level state field, and each
 * entry must be a function. Returns `undefined` when omitted (so a definition
 * without computed properties stays absent, matching the pre-computed shape).
 */
function normalizeComputed(
  schema: z.ZodType<any>,
  computed: Readonly<Record<string, ServerComponentComputed<any>>> | undefined,
): Readonly<Record<string, ServerComponentComputed<any>>> | undefined {
  if (computed === undefined) {
    return undefined;
  }
  // A `__proto__` key in an object literal sets the prototype rather than adding
  // an own key, silently dropping the entry; reject that shape up front.
  const prototype = Object.getPrototypeOf(computed);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ServerComponentDefinitionError('computed must be a plain object literal');
  }

  const known = Object.keys((schema as z.ZodObject<any>).shape);
  const normalized: Record<string, ServerComponentComputed<any>> = {};
  for (const [name, fn] of Object.entries(computed)) {
    validateComputedName(name, known);
    if (typeof fn !== 'function') {
      throw new ServerComponentDefinitionError('computed property must be a function');
    }
    normalized[name] = fn;
  }
  return normalized;
}

function validateComputedName(name: string, known: readonly string[]): void {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new ServerComponentDefinitionError('computed property name must be a non-empty string');
  }
  if (name in Object.prototype) {
    throw new ServerComponentDefinitionError(
      'computed property name must not shadow an inherited object property',
    );
  }
  if (known.includes(name)) {
    throw new ServerComponentDefinitionError(
      'computed property name must not collide with a top-level state field',
    );
  }
}
