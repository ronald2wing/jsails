/**
 * Server component runtime: the transport half of the stateful component story.
 *
 * `createServerComponentsRuntime({ components, signer })` returns a handle with
 * three operations:
 *
 * - `render(name, context, { staticMode?, origin? })` renders a component to an
 *   HTML string (the "mount"): authorize, produce initial state, validate it,
 *   sign a snapshot token, and render a Preact SSR root carrying the snapshot,
 *   CSRF, and id markers. In `staticMode` it renders only the author's
 *   `staticFallback` — no initialState, no signing, no state allocation — and
 *   throws a clear, value-free error when no fallback is declared.
 * - `update(payload, context, { origin? })` handles one update POST, returning
 *   `{ status, body }` for an HTTP layer to serialize directly. It verifies the
 *   snapshot (HMAC, expiry, subject, origin) before looking the component up,
 *   enforces the same-origin/CSRF boundary, re-applies authorization, applies
 *   client edits under `writableKeys`, runs at most one action, re-validates the
 *   full state strictly, and returns a re-signed snapshot with synchronized
 *   HTML for the client to morph.
 * - `close()` — idempotent; the runtime owns no store, listener, or connection,
 *   so it only flips a closed guard.
 *
 * The runtime is stateless across requests: there is no persistent UI store and
 * every request reconstructs its verified state from the signed snapshot, so an
 * update is re-playable (at-least-once, never exactly-once, no atomic DB
 * rollback) and a handler must make its own persistence idempotent.
 *
 * Security posture:
 * - Authorization is default-deny and requires an exact `true`; truthy
 *   non-booleans, throws, and rejections all deny. There is no implicit
 *   role/login identity and the runtime never fabricates one.
 * - Client edits may touch only `writableKeys`; actions run server-side and may
 *   change any schema-valid field. All validation is the strict state schema.
 * - The anonymous CSRF token is the verified snapshot id — a possession token,
 *   not an authentication identity; the session CSRF token is the session's.
 *   The token header is required in all cases and compared constant-time.
 * - Errors never leak the key, state, token, session, or raw submitted values.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { Fragment, h } from 'preact';
import { ZodError } from 'zod';
import type { ZodIssue } from 'zod';

import type { JsonObject, JsonValue, RequestContext } from '../contracts/http.js';
import { renderToString } from '../render/render-to-string.js';
import type {
  ServerComponentAction,
  ServerComponentCallAttrs,
  ServerComponentDefinition,
  ServerComponentModelAttrs,
  ServerComponentRenderTools,
  ServerComponentState,
  ServerComponentSubmitAttrs,
} from './component.js';
import {
  ARGS_ATTRIBUTE,
  CALL_ATTRIBUTE,
  COMPONENT_ATTRIBUTE,
  COMPONENT_CSRF_ATTRIBUTE,
  COMPONENT_CSRF_HEADER,
  COMPONENT_NAME_ATTRIBUTE,
  COMPONENT_ROOT_ID_PREFIX,
  COMPONENT_SNAPSHOT_ATTRIBUTE,
  MODEL_ATTRIBUTE,
  SUBMIT_ATTRIBUTE,
  TURBO_ATTRIBUTE,
  type ComponentUpdateErrorCode,
  type ComponentUpdateResponse,
} from './protocol.js';
import { SnapshotError, type ComponentSigner, type SnapshotPayload } from './snapshot.js';

/** Raised for render-time failures (denied, unknown, missing fallback, closed). Value-free. */
export class ServerComponentRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServerComponentRuntimeError';
  }
}

/** Options for {@link createServerComponentsRuntime}. */
export interface CreateServerComponentsRuntimeOptions {
  /** Registered components keyed by name. The runtime reads, never mutates, them. */
  readonly components: Readonly<Record<string, ServerComponentDefinition<any>>>;
  /** The signer used to mint and verify snapshot tokens. */
  readonly signer: ComponentSigner;
}

/** Options controlling a single `render` (mount). */
export interface ServerComponentRenderOptions {
  /** Render only the author's static fallback; no state, signing, or id. */
  readonly staticMode?: boolean;
  /**
   * Trusted origin bound into the snapshot. Defaults to `context.url.origin`.
   * Supply the public origin when the app sits behind a TLS-terminating proxy.
   */
  readonly origin?: string;
}

/** Options controlling a single `update`. */
export interface ServerComponentUpdateOptions {
  /**
   * Trusted origin the request `Origin` header and snapshot scope must match.
   * Defaults to `context.url.origin`.
   */
  readonly origin?: string;
}

/** The HTTP-facing result of an update: a status plus a serializable body. */
export interface ServerComponentUpdateResult {
  readonly status: number;
  readonly body: ComponentUpdateResponse;
}

/** The assembled runtime handle. */
export interface ServerComponentsRuntime {
  render(
    name: string,
    context: RequestContext,
    options?: ServerComponentRenderOptions,
  ): Promise<string>;
  update(
    payload: unknown,
    context: RequestContext,
    options?: ServerComponentUpdateOptions,
  ): Promise<ServerComponentUpdateResult>;
  close(): void;
}

/** Random bytes minted for a new component instance id. */
const ID_BYTES = 16;

/** Upper bound on the number of keys a client update object may carry. */
const MAX_UPDATE_KEYS = 1000;

/** Own object keys that must never be applied as client state edits. */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** A parsed and shape-validated update request. */
interface ParsedUpdate {
  readonly snapshot: string;
  readonly updates: JsonObject;
  readonly action: { readonly name: string; readonly args?: JsonObject } | undefined;
  readonly sequence: number;
}

type ParseUpdateResult =
  | { readonly ok: true; readonly value: ParsedUpdate }
  | { readonly ok: false; readonly sequence: number };

type ParseActionResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly errors: Readonly<Record<string, string>> };

/** Wrapper options for rendering a component root to HTML. */
interface RenderHtmlOptions {
  readonly id?: string;
  readonly token?: string;
  readonly csrfToken?: string;
  readonly errors: Readonly<Record<string, string | undefined>>;
  readonly values: Readonly<Record<string, string>>;
  readonly context: RequestContext;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** True for `http(s)` origins only: no path, query, fragment, or credentials. */
function isHttpOrigin(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.username === '' &&
      url.password === '' &&
      url.pathname === '/' &&
      url.search === '' &&
      url.hash === ''
    );
  } catch {
    return false;
  }
}

/** Constant-time string comparison that is safe across differing lengths. */
function safeEqualStrings(a: string, b: string): boolean {
  const aBuffer = Buffer.from(a, 'utf8');
  const bBuffer = Buffer.from(b, 'utf8');
  if (aBuffer.length === bBuffer.length) {
    return timingSafeEqual(aBuffer, bBuffer);
  }
  const aDigest = createHash('sha256').update(aBuffer).digest();
  const bDigest = createHash('sha256').update(bBuffer).digest();
  return timingSafeEqual(aDigest, bDigest);
}

function generateComponentId(): string {
  return randomBytes(ID_BYTES).toString('base64url');
}

/** Authorize a component callback, succeeding only on an exact `true`. */
async function authorizeAllows(
  authorize: (context: RequestContext) => boolean | Promise<boolean>,
  context: RequestContext,
): Promise<boolean> {
  try {
    return (await authorize(context)) === true;
  } catch {
    return false;
  }
}

/** Authorize an action callback, succeeding only on an exact `true`. */
async function actionAuthorizeAllows(
  authorize: (
    context: RequestContext,
    state: ServerComponentState,
    input: unknown,
  ) => boolean | Promise<boolean>,
  context: RequestContext,
  state: ServerComponentState,
  input: unknown,
): Promise<boolean> {
  try {
    return (await authorize(context, state, input)) === true;
  } catch {
    return false;
  }
}

/** Resolve and validate the trusted origin (explicit option, else the request URL). */
function resolveTrustedOrigin(origin: string | undefined, context: RequestContext): string {
  const candidate = origin ?? context.url.origin;
  if (!isHttpOrigin(candidate)) {
    throw new ServerComponentRuntimeError('origin must be an http(s) origin');
  }
  return candidate;
}

/** Reconstruct the mount-time request context from the signed page provenance. */
function reconstructContext(
  context: RequestContext,
  snapshot: SnapshotPayload,
  origin: string,
): RequestContext {
  return {
    // The update request itself stays the actual POST; only url/params are
    // reconstructed from the page the component was signed on.
    request: context.request,
    url: new URL(snapshot.page.path, origin),
    params: { ...snapshot.page.params },
    session: context.session,
    ...(context.publicOrigin === undefined ? {} : { publicOrigin: context.publicOrigin }),
    ...(context.renderMode === undefined ? {} : { renderMode: context.renderMode }),
    ...(context.services === undefined ? {} : { services: context.services }),
    ...(context.assetUrl === undefined ? {} : { assetUrl: context.assetUrl }),
    ...(context.storagePath === undefined ? {} : { storagePath: context.storagePath }),
  };
}

/** Look up an action by name without tripping over inherited properties. */
function lookupAction(
  component: ServerComponentDefinition<any>,
  name: string,
): ServerComponentAction<any, any> | undefined {
  const actions = component.actions;
  if (actions === undefined || !Object.hasOwn(actions, name)) {
    return undefined;
  }
  return actions[name];
}

/** Stringify a bound state value for an element's `value` attribute. */
function serializeStateValue(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number') {
    return String(value);
  }
  return JSON.stringify(value);
}

/** Serialize args for a `call`/`submit` marker, validating against the action. */
function serializeActionArgs(
  component: ServerComponentDefinition<any>,
  action: string,
  args: JsonValue | undefined,
): string | undefined {
  const definition = lookupAction(component, action);
  if (definition === undefined) {
    throw new ServerComponentRuntimeError('unknown component action');
  }
  if (args === undefined) {
    return undefined;
  }
  if (definition.input === undefined) {
    if (isPlainObject(args) && Object.keys(args).length > 0) {
      throw new ServerComponentRuntimeError('action does not accept arguments');
    }
    return undefined;
  }
  const parsed = definition.input.safeParse(args);
  if (!parsed.success) {
    throw new ServerComponentRuntimeError('invalid action arguments');
  }
  return JSON.stringify(parsed.data);
}

/** Build the `bind`/`call`/`submit` tools handed to a component's `render`. */
function makeRenderTools(
  component: ServerComponentDefinition<any>,
  state: ServerComponentState,
  errors: Readonly<Record<string, string | undefined>>,
  values: Readonly<Record<string, string>>,
  context: RequestContext,
): ServerComponentRenderTools<any> {
  const bind = (name: keyof ServerComponentState & string): ServerComponentModelAttrs => {
    const value = state[name];
    const attrs: Record<string, unknown> = { [MODEL_ATTRIBUTE]: name };
    if (typeof value === 'boolean') {
      attrs.checked = value;
    } else {
      attrs.value = serializeStateValue(value);
    }
    return attrs as unknown as ServerComponentModelAttrs;
  };

  const call = (action: string, args?: JsonValue): ServerComponentCallAttrs => {
    const serialized = serializeActionArgs(component, action, args);
    return {
      [CALL_ATTRIBUTE]: action,
      ...(serialized === undefined ? {} : { [ARGS_ATTRIBUTE]: serialized }),
    };
  };

  const submit = (action: string, args?: JsonValue): ServerComponentSubmitAttrs => {
    const serialized = serializeActionArgs(component, action, args);
    return {
      [SUBMIT_ATTRIBUTE]: action,
      [TURBO_ATTRIBUTE]: false,
      ...(serialized === undefined ? {} : { [ARGS_ATTRIBUTE]: serialized }),
    };
  };

  return { bind, call, submit, errors, values, context };
}

/** Render a component's current state inside the owned root element. */
async function renderComponentHtml(
  component: ServerComponentDefinition<any>,
  state: ServerComponentState,
  options: RenderHtmlOptions,
): Promise<string> {
  const tools = makeRenderTools(component, state, options.errors, options.values, options.context);
  const children = await component.render(state, tools);

  const attrs: Record<string, unknown> = {
    [COMPONENT_ATTRIBUTE]: component.name,
    [COMPONENT_NAME_ATTRIBUTE]: component.name,
  };
  if (options.id !== undefined && options.token !== undefined) {
    attrs.id = COMPONENT_ROOT_ID_PREFIX + options.id;
    attrs[COMPONENT_SNAPSHOT_ATTRIBUTE] = options.token;
    attrs[COMPONENT_CSRF_ATTRIBUTE] = options.csrfToken;
  }

  return renderToString(h('div', attrs, h(Fragment, null, children)));
}

// ---------------------------------------------------------------------------
// Zod issue mapping (value-free, stable messages; never echoes raw input)
// ---------------------------------------------------------------------------

function valueAtPath(input: unknown, path: readonly PropertyKey[]): unknown {
  let value = input;
  for (const segment of path) {
    if (value === null || value === undefined || typeof value !== 'object') {
      return undefined;
    }
    value = (value as Record<PropertyKey, unknown>)[segment];
  }
  return value;
}

function typeMessage(expected: string): string {
  switch (expected) {
    case 'string':
      return 'Expected a string';
    case 'number':
      return 'Expected a number';
    case 'int':
    case 'integer':
    case 'safeint':
      return 'Expected an integer';
    case 'boolean':
      return 'Expected a boolean';
    case 'object':
    case 'record':
      return 'Expected an object';
    case 'array':
    case 'tuple':
      return 'Expected an array';
    default:
      return 'Expected a valid value';
  }
}

function boundMessage(origin: string, bound: number | bigint, isMax: boolean): string {
  const qualifier = isMax ? 'at most' : 'at least';
  switch (origin) {
    case 'string':
      return `Must be ${qualifier} ${bound} characters`;
    case 'number':
    case 'int':
    case 'integer':
    case 'safeint':
    case 'bigint':
      return `Must be ${qualifier} ${bound}`;
    case 'array':
    case 'set':
      return `Must have ${qualifier} ${bound} items`;
    default:
      return 'Invalid value';
  }
}

function describeZodIssue(issue: ZodIssue, input: unknown): string {
  switch (issue.code) {
    case 'invalid_type': {
      const received = valueAtPath(input, issue.path);
      if (received === undefined) {
        return 'This field is required';
      }
      if (received === null) {
        return 'Value must not be null';
      }
      return typeMessage(issue.expected);
    }
    case 'too_small':
      return boundMessage(issue.origin, issue.minimum, false);
    case 'too_big':
      return boundMessage(issue.origin, issue.maximum, true);
    case 'unrecognized_keys':
      return 'Unknown field';
    default:
      return 'Invalid value';
  }
}

function zodIssuesToFieldErrors(
  issues: readonly ZodIssue[],
  input: unknown,
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const issue of issues) {
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) {
        const path = [...issue.path, key].map(String).join('.');
        errors[path] = 'Unknown field';
      }
      continue;
    }
    const path = issue.path.map(String).join('.');
    errors[path === '' ? 'form' : path] = describeZodIssue(issue, input);
  }
  return errors;
}

/**
 * Deep-clone an already JSON-safe value. A `z.any` schema field is parsed by
 * identity, so without a clone an action mutating nested state would reach into
 * the verified snapshot's objects and leave the original partially mutated when
 * the action fails.
 */
function deepCloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Probe the signer's existing JSON-safety validation without keeping the token.
 *
 * The signer rejects forbidden own keys, non-plain/non-finite values, cycles,
 * and over-deep nesting before it signs. That check otherwise runs only at the
 * final sign, after an action has already taken effect, so probe it up front to
 * reject a nested dangerous/non-JSON update or arg before any side effect.
 */
function isJsonSafeState(
  signer: ComponentSigner,
  snapshot: SnapshotPayload,
  state: unknown,
): boolean {
  try {
    signer.sign({
      v: 1,
      component: snapshot.component,
      id: snapshot.id,
      state: state as JsonObject,
      page: snapshot.page,
      origin: snapshot.origin,
      subject: snapshot.subject,
      revision: snapshot.revision,
    });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Update request parsing
// ---------------------------------------------------------------------------

function parseUpdatePayload(payload: unknown): ParseUpdateResult {
  if (!isPlainObject(payload)) {
    return { ok: false, sequence: 0 };
  }
  const sequence = payload.sequence;
  if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 0) {
    return { ok: false, sequence: 0 };
  }

  const snapshot = payload.snapshot;
  if (typeof snapshot !== 'string' || snapshot.length === 0) {
    return { ok: false, sequence };
  }

  const updates = payload.updates;
  if (!isPlainObject(updates) || Object.keys(updates).length > MAX_UPDATE_KEYS) {
    return { ok: false, sequence };
  }
  for (const key of Object.keys(updates)) {
    if (FORBIDDEN_KEYS.has(key)) {
      return { ok: false, sequence };
    }
  }

  let action: { readonly name: string; readonly args?: JsonObject } | undefined;
  const rawAction = payload.action;
  if (rawAction !== undefined) {
    if (!isPlainObject(rawAction)) {
      return { ok: false, sequence };
    }
    const name = rawAction.name;
    if (typeof name !== 'string' || name.trim() === '' || name in Object.prototype) {
      return { ok: false, sequence };
    }
    const args = rawAction.args;
    if (args !== undefined && !isPlainObject(args)) {
      return { ok: false, sequence };
    }
    action = args === undefined ? { name } : { name, args: args as JsonObject };
  }

  return { ok: true, value: { snapshot, updates: updates as JsonObject, action, sequence } };
}

function parseActionArgs(
  definition: ServerComponentAction<any, any>,
  rawArgs: JsonObject | undefined,
): ParseActionResult {
  if (definition.input === undefined) {
    if (rawArgs !== undefined && isPlainObject(rawArgs) && Object.keys(rawArgs).length > 0) {
      return { ok: false, errors: { args: 'This action accepts no arguments' } };
    }
    return { ok: true, value: undefined };
  }
  const parsed = definition.input.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    return { ok: false, errors: zodIssuesToFieldErrors(parsed.error.issues, rawArgs ?? {}) };
  }
  return { ok: true, value: parsed.data };
}

/** Stringify submitted client edits for repopulation (`values` render tool). */
function buildValues(updates: JsonObject): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(updates)) {
    if (value === null || value === undefined) {
      values[key] = '';
    } else if (typeof value === 'string') {
      values[key] = value;
    } else {
      values[key] = JSON.stringify(value);
    }
  }
  return values;
}

// ---------------------------------------------------------------------------
// Runtime factory
// ---------------------------------------------------------------------------

/**
 * Assemble a server-components runtime over a component map and a snapshot
 * signer. The runtime is inert: it opens no listener, holds no store, and runs
 * no component callback until `render` or `update` is invoked.
 */
export function createServerComponentsRuntime(
  options: CreateServerComponentsRuntimeOptions,
): ServerComponentsRuntime {
  if (options === null || typeof options !== 'object') {
    throw new TypeError('createServerComponentsRuntime requires an options object');
  }
  const components = new Map<string, ServerComponentDefinition<any>>();
  const source = options.components;
  if (!isPlainObject(source)) {
    throw new TypeError('components must be a plain object of definitions');
  }
  for (const [name, definition] of Object.entries(source)) {
    if (name.trim() === '' || name in Object.prototype) {
      throw new ServerComponentRuntimeError('invalid component name');
    }
    if (!isPlainObject(definition) || typeof definition.render !== 'function') {
      throw new ServerComponentRuntimeError('invalid component definition');
    }
    components.set(name, definition);
  }
  const signer = options.signer;
  if (
    signer === null ||
    typeof signer !== 'object' ||
    typeof signer.subjectFor !== 'function' ||
    typeof signer.sign !== 'function' ||
    typeof signer.verify !== 'function'
  ) {
    throw new TypeError('signer must expose subjectFor, sign, and verify');
  }

  let closed = false;

  async function render(
    name: string,
    context: RequestContext,
    options: ServerComponentRenderOptions = {},
  ): Promise<string> {
    if (closed) {
      throw new ServerComponentRuntimeError('server components runtime is closed');
    }
    const component = components.get(name);
    if (component === undefined) {
      throw new ServerComponentRuntimeError('unknown server component');
    }
    if (options.staticMode === true) {
      const fallback = component.staticFallback;
      if (fallback === undefined) {
        throw new ServerComponentRuntimeError('component has no static fallback');
      }
      const children = await fallback(context);
      const attrs: Record<string, unknown> = {
        [COMPONENT_ATTRIBUTE]: component.name,
        [COMPONENT_NAME_ATTRIBUTE]: component.name,
      };
      return renderToString(h('div', attrs, h(Fragment, null, children)));
    }
    return mount(component, context, options);
  }

  async function mount(
    component: ServerComponentDefinition<any>,
    context: RequestContext,
    options: ServerComponentRenderOptions,
  ): Promise<string> {
    if (!(await authorizeAllows(component.authorize, context))) {
      throw new ServerComponentRuntimeError('component access denied');
    }

    const initial = await component.initialState(context);
    let state: ServerComponentState;
    try {
      state = component.stateSchema.parse(initial);
    } catch {
      throw new ServerComponentRuntimeError('component produced an invalid initial state');
    }

    const id = generateComponentId();
    const origin = resolveTrustedOrigin(options.origin, context);
    const subject = signer.subjectFor(context.session?.id ?? null);
    const page = { path: context.url.pathname, params: { ...context.params } };
    const token = signer.sign({
      v: 1,
      component: component.name,
      id,
      state,
      page,
      origin,
      subject,
    });
    const csrfToken = context.session?.csrfToken ?? id;
    return renderComponentHtml(component, state, {
      id,
      token,
      csrfToken,
      errors: {},
      values: {},
      context,
    });
  }

  async function update(
    payload: unknown,
    context: RequestContext,
    options: ServerComponentUpdateOptions = {},
  ): Promise<ServerComponentUpdateResult> {
    if (closed) {
      throw new ServerComponentRuntimeError('server components runtime is closed');
    }

    const parsed = parseUpdatePayload(payload);
    if (!parsed.ok) {
      return errorResult(parsed.sequence, 'invalid_request', 'Invalid component update request');
    }
    const { snapshot: token, updates, action, sequence } = parsed.value;

    let trustedOrigin: string;
    try {
      trustedOrigin = resolveTrustedOrigin(options.origin, context);
    } catch {
      return errorResult(sequence, 'internal_error', 'Internal Server Error');
    }
    const originHeader = context.request.headers.get('origin');
    if (typeof originHeader !== 'string' || originHeader !== trustedOrigin) {
      return errorResult(sequence, 'origin_mismatch', 'Cross-origin request rejected');
    }

    // Verify the snapshot (HMAC, expiry, subject, origin) before the component
    // is looked up or any state is hydrated from it.
    let snapshot: SnapshotPayload;
    try {
      const subject = signer.subjectFor(context.session?.id ?? null);
      snapshot = signer.verify(token, { subject, origin: trustedOrigin });
    } catch (error) {
      if (error instanceof SnapshotError) {
        return errorResult(sequence, 'invalid_snapshot', 'Invalid component snapshot');
      }
      return errorResult(sequence, 'internal_error', 'Internal Server Error');
    }

    const component = components.get(snapshot.component);
    if (component === undefined) {
      return errorResult(sequence, 'unknown_component', 'Unknown component');
    }

    // CSRF token is required in all cases. A session binds to its CSRF token;
    // an anonymous public component binds to the verified snapshot id (a
    // possession token, not an authentication identity).
    const expectedCsrf = context.session?.csrfToken ?? snapshot.id;
    const csrfHeader = context.request.headers.get(COMPONENT_CSRF_HEADER);
    if (typeof csrfHeader !== 'string' || !safeEqualStrings(expectedCsrf, csrfHeader)) {
      return errorResult(sequence, 'csrf_mismatch', 'CSRF token missing or mismatch');
    }

    const actionContext = reconstructContext(context, snapshot, trustedOrigin);

    // Re-authorize the component for this request before any client edit.
    if (!(await authorizeAllows(component.authorize, actionContext))) {
      return errorResult(sequence, 'forbidden', 'Forbidden');
    }

    // Apply client edits, restricted to `writableKeys`.
    const writable = new Set(component.writableKeys ?? []);
    for (const key of Object.keys(updates)) {
      if (!writable.has(key)) {
        return await validationResult(
          sequence,
          token,
          snapshot,
          component,
          { [key]: 'Field is read-only' },
          buildValues(updates),
          actionContext,
          expectedCsrf,
        );
      }
    }
    const candidate: Record<string, unknown> = { ...snapshot.state };
    for (const key of Object.keys(updates)) {
      candidate[key] = updates[key];
    }

    // Validate the client-edited candidate against the state schema before any
    // policy or action side effect. Both the action's `authorize` and its `run`
    // must observe the same schema-validated (and normalized) candidate, so an
    // invalid client edit is rejected here (422) before either is invoked.
    let validated: ServerComponentState;
    try {
      validated = component.stateSchema.parse(candidate);
    } catch (error) {
      if (error instanceof ZodError) {
        return await validationResult(
          sequence,
          token,
          snapshot,
          component,
          zodIssuesToFieldErrors(error.issues, candidate),
          buildValues(updates),
          actionContext,
          expectedCsrf,
        );
      }
      return errorResult(sequence, 'internal_error', 'Internal Server Error');
    }

    // A nested forbidden key or non-JSON value can survive the schema (e.g.
    // behind a `z.any` field); the signer's JSON-safety validation catches it,
    // but only at the final sign, after an action has already run. Reject it
    // here (400) before any side effect.
    if (!isJsonSafeState(signer, snapshot, validated)) {
      return errorResult(sequence, 'invalid_request', 'Invalid component update request');
    }

    // Give the action an independent deep JSON clone: a `z.any` field preserves
    // identity, so a run that mutates nested state and then fails must not
    // corrupt the verified snapshot used by the 422 re-render.
    const workingState = deepCloneJson(validated);

    // At most one action per request, dispatched only by allowlisted name.
    if (action !== undefined) {
      const definition = lookupAction(component, action.name);
      if (definition === undefined) {
        return errorResult(sequence, 'invalid_request', 'Unknown action');
      }
      const argsResult = parseActionArgs(definition, action.args);
      if (!argsResult.ok) {
        return await validationResult(
          sequence,
          token,
          snapshot,
          component,
          argsResult.errors,
          buildValues(updates),
          actionContext,
          expectedCsrf,
        );
      }
      if (
        argsResult.value !== undefined &&
        !isJsonSafeState(signer, snapshot, { args: argsResult.value })
      ) {
        return errorResult(sequence, 'invalid_request', 'Invalid component update request');
      }
      if (definition.authorize !== undefined) {
        if (
          !(await actionAuthorizeAllows(
            definition.authorize,
            actionContext,
            workingState,
            argsResult.value,
          ))
        ) {
          return errorResult(sequence, 'forbidden', 'Forbidden');
        }
      }
      try {
        await definition.run(workingState, argsResult.value, actionContext);
      } catch (error) {
        // A domain validation failure raised by the action is a 422 with field
        // errors, not a server fault. Any other throw stays a value-free 500.
        // `snapshot.state` is untouched (the action ran on a deep clone), so the
        // 422 re-render and the original token remain coherent.
        if (error instanceof ZodError) {
          return await validationResult(
            sequence,
            token,
            snapshot,
            component,
            zodIssuesToFieldErrors(error.issues, workingState),
            buildValues(updates),
            actionContext,
            expectedCsrf,
          );
        }
        return errorResult(sequence, 'internal_error', 'Internal Server Error');
      }
    }

    // Re-validate the full state after the action has run: actions may mutate
    // any schema-valid field server-side, so this catches a mutation that
    // produced an invalid state. Then re-sign and re-render so the returned
    // snapshot and HTML are always in sync.
    try {
      const nextState = component.stateSchema.parse(workingState);
      const nextToken = signer.sign({
        v: 1,
        component: component.name,
        id: snapshot.id,
        state: nextState,
        page: snapshot.page,
        origin: snapshot.origin,
        subject: snapshot.subject,
        revision: snapshot.revision,
      });
      const html = await renderComponentHtml(component, nextState, {
        id: snapshot.id,
        token: nextToken,
        csrfToken: expectedCsrf,
        errors: {},
        values: {},
        context: actionContext,
      });
      return { status: 200, body: { sequence, snapshot: nextToken, html } };
    } catch (error) {
      if (error instanceof ZodError) {
        return await validationResult(
          sequence,
          token,
          snapshot,
          component,
          zodIssuesToFieldErrors(error.issues, workingState),
          buildValues(updates),
          actionContext,
          expectedCsrf,
        );
      }
      return errorResult(sequence, 'internal_error', 'Internal Server Error');
    }
  }

  return Object.freeze({
    render,
    update,
    close() {
      closed = true;
    },
  });
}

/** Build a 422 response: re-render with errors and preserved values. */
async function validationResult(
  sequence: number,
  token: string,
  snapshot: SnapshotPayload,
  component: ServerComponentDefinition<any>,
  errors: Readonly<Record<string, string>>,
  values: Readonly<Record<string, string>>,
  context: RequestContext,
  csrfToken: string,
): Promise<ServerComponentUpdateResult> {
  const html = await renderComponentHtml(component, snapshot.state, {
    id: snapshot.id,
    token,
    csrfToken,
    errors,
    values,
    context,
  });
  return { status: 422, body: { sequence, errors, html } };
}

/** Build a non-validation error response with a stable code and value-free message. */
function errorResult(
  sequence: number,
  code: ComponentUpdateErrorCode,
  message: string,
): ServerComponentUpdateResult {
  return { status: statusFor(code), body: { sequence, error: { code, message } } };
}

/** Map an error code to its HTTP status. */
function statusFor(code: ComponentUpdateErrorCode): number {
  switch (code) {
    case 'invalid_request':
      return 400;
    case 'origin_mismatch':
    case 'invalid_snapshot':
    case 'csrf_mismatch':
    case 'forbidden':
      return 403;
    case 'unknown_component':
      return 404;
    case 'internal_error':
      return 500;
  }
}
