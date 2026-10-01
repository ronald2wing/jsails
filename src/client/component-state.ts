/**
 * Browser-safe server-component state controller.
 *
 * This is the transport-agnostic half of the interactive component story: it
 * owns the client-side model (canonical server state plus local edits), a
 * serialized one-action-at-a-time update queue, and the same-origin/CSRF POST
 * that drives `/_jsails/components/update`. It touches no DOM and imports no
 * Preact — a later binding worker consumes its `onRender` callback (and
 * `state`/`errors`) to morph the server HTML into place.
 *
 * Security posture:
 * - The snapshot token is UNVERIFIED client data. `decodePublicSnapshot`
 *   decodes the base64url JSON body for display/bootstrap only: it checks no
 *   HMAC, holds no key, and must never be treated as an authority. The server
 *   remains the sole authority; every update is re-authorized there.
 * - An update is always a same-origin, CSRF-headed POST; a cross-origin
 *   `endpoint` is rejected before any request is built.
 * - Errors thrown or reported here are value-free: they never embed the
 *   endpoint URL, the snapshot token, the CSRF token, request/response bodies,
 *   or raw field values.
 * - There are no automatic retries and no replay of unknown mutations. A
 *   network failure or unexpected response permanently blocks the controller
 *   (a refresh is required) instead of re-sending a possibly-applied action.
 */

import type { JsonObject, JsonValue } from '../contracts/http.js';
import {
  COMPONENT_CSRF_HEADER,
  COMPONENT_UPDATE_ENDPOINT,
  type ComponentUpdateRequest,
} from '../server-components/protocol.js';

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/** Maximum accepted snapshot token length (base64url payload + signature). */
const MAX_SNAPSHOT_TOKEN_LENGTH = 512 * 1024;
/** Maximum accepted decoded snapshot payload size, in bytes. */
const MAX_SNAPSHOT_PAYLOAD_BYTES = 384 * 1024;
/** Maximum accepted update response body size, in characters. */
const MAX_RESPONSE_BODY_LENGTH = 2 * 1024 * 1024;
/** Maximum JSON nesting depth accepted from a snapshot or a local edit. */
const MAX_JSON_DEPTH = 64;
/** Maximum number of keys accepted in an action args object. */
const MAX_ARGS_KEYS = 1000;
/** Default bound on the number of queued (not yet dispatched) actions. */
const DEFAULT_MAX_QUEUE = 8;

/** Own object keys that must never appear in client state or args. */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** base64url alphabet only (no padding, no standard-base64 `+`/`/`). */
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Stable machine codes carried by {@link ComponentControllerError}. */
export type ComponentControllerErrorCode =
  | 'invalid_options'
  | 'invalid_action'
  | 'invalid_args'
  | 'queue_full'
  | 'disposed'
  | 'blocked'
  | 'network'
  | 'unexpected_status'
  | 'malformed_response'
  | 'sequence_mismatch';

/** Raised for controller misconfiguration, misuse, or a fatal update outcome. */
export class ComponentControllerError extends Error {
  readonly code: ComponentControllerErrorCode;

  constructor(message: string, code: ComponentControllerErrorCode) {
    super(message);
    this.name = 'ComponentControllerError';
    this.code = code;
  }
}

/** Raised when a snapshot token cannot be decoded as public client data. */
export class ComponentSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ComponentSnapshotError';
  }
}

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

type JsonViolation =
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
function scanJson(root: unknown): JsonViolation | null {
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
        if (FORBIDDEN_KEYS.has(key)) {
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

function jsonViolationMessage(violation: JsonViolation): string {
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
function jsonEqual(a: unknown, b: unknown): boolean {
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

// ---------------------------------------------------------------------------
// Snapshot decoding (unverified)
// ---------------------------------------------------------------------------

/** The page provenance recorded in a decoded snapshot. */
export interface PublicSnapshotPage {
  readonly path: string;
  readonly params: Readonly<Record<string, string>>;
}

/**
 * The decoded, UNVERIFIED body of a component snapshot. Every field is
 * attacker-controllable until the server verifies the signature on update;
 * never trust it as an authorization or integrity signal.
 */
export interface PublicSnapshot {
  readonly component: string;
  readonly id: string;
  readonly state: JsonObject;
  readonly page: PublicSnapshotPage;
  readonly origin: string;
  readonly subject: string | null;
  readonly expiresAt: number;
  readonly revision?: number;
}

/** Reject a JSON string whose pre-parse nesting depth exceeds the bound. */
function assertDepthBounded(text: string): void {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{' || ch === '[') {
      depth += 1;
      if (depth > MAX_JSON_DEPTH) {
        throw new ComponentSnapshotError('invalid snapshot token');
      }
    } else if (ch === '}' || ch === ']') {
      depth -= 1;
    }
  }
}

function base64UrlToBytes(input: string): Uint8Array {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const padding = normalized.length % 4;
  if (padding === 1) {
    throw new ComponentSnapshotError('invalid snapshot token');
  }
  const padded = padding === 0 ? normalized : normalized + '='.repeat(4 - padding);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function isValidRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value[0] !== '/') {
    return false;
  }
  if (value.startsWith('//')) {
    return false;
  }
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code === 0x5c || code === 0x00 || code < 0x20) {
      return false;
    }
  }
  return !value.split('/').some((segment) => segment === '..');
}

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

function validatePublicSnapshot(value: Record<string, unknown>): PublicSnapshot {
  if (value.v !== 1) {
    throw new ComponentSnapshotError('invalid snapshot token');
  }
  const component = value.component;
  if (typeof component !== 'string' || component.trim() === '') {
    throw new ComponentSnapshotError('invalid snapshot token');
  }
  const id = value.id;
  if (typeof id !== 'string' || id.trim() === '') {
    throw new ComponentSnapshotError('invalid snapshot token');
  }
  const state = value.state;
  if (!isPlainObject(state)) {
    throw new ComponentSnapshotError('invalid snapshot token');
  }
  const page = value.page;
  if (!isPlainObject(page)) {
    throw new ComponentSnapshotError('invalid snapshot token');
  }
  const path = page.path;
  if (!isValidRelativePath(path)) {
    throw new ComponentSnapshotError('invalid snapshot token');
  }
  const rawParams = page.params;
  if (!isPlainObject(rawParams)) {
    throw new ComponentSnapshotError('invalid snapshot token');
  }
  const params: Record<string, string> = {};
  for (const [key, paramValue] of Object.entries(rawParams)) {
    if (FORBIDDEN_KEYS.has(key) || typeof paramValue !== 'string') {
      throw new ComponentSnapshotError('invalid snapshot token');
    }
    params[key] = paramValue;
  }
  const origin = value.origin;
  if (!isHttpOrigin(origin)) {
    throw new ComponentSnapshotError('invalid snapshot token');
  }
  const subject = value.subject;
  if (subject !== null && (typeof subject !== 'string' || subject.length === 0)) {
    throw new ComponentSnapshotError('invalid snapshot token');
  }
  const expiresAt = value.expiresAt;
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) {
    throw new ComponentSnapshotError('invalid snapshot token');
  }
  const revision = value.revision;
  if (
    revision !== undefined &&
    (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0)
  ) {
    throw new ComponentSnapshotError('invalid snapshot token');
  }

  return {
    component,
    id,
    state: state as JsonObject,
    page: { path, params },
    origin,
    subject,
    expiresAt,
    ...(revision === undefined ? {} : { revision }),
  };
}

/**
 * Decode the public body of a snapshot token WITHOUT verifying it.
 *
 * The token format is `base64url(json).base64url(signature)`; only the payload
 * half is decoded. No key is read and no MAC is checked — the result is
 * untrusted display data. The payload must be bounded, valid UTF-8 JSON, within
 * the depth/size limits, free of prototype-polluting keys, and shaped like a
 * v1 snapshot; otherwise a value-free {@link ComponentSnapshotError} is thrown.
 */
export function decodePublicSnapshot(token: string): PublicSnapshot {
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_SNAPSHOT_TOKEN_LENGTH) {
    throw new ComponentSnapshotError('invalid snapshot token');
  }
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1 || token.indexOf('.', dot + 1) !== -1) {
    throw new ComponentSnapshotError('invalid snapshot token');
  }
  const payloadPart = token.slice(0, dot);
  const signaturePart = token.slice(dot + 1);
  if (!BASE64URL_PATTERN.test(payloadPart) || !BASE64URL_PATTERN.test(signaturePart)) {
    throw new ComponentSnapshotError('invalid snapshot token');
  }

  let bytes: Uint8Array;
  try {
    bytes = base64UrlToBytes(payloadPart);
  } catch {
    throw new ComponentSnapshotError('invalid snapshot token');
  }
  if (bytes.byteLength > MAX_SNAPSHOT_PAYLOAD_BYTES) {
    throw new ComponentSnapshotError('invalid snapshot token');
  }

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new ComponentSnapshotError('invalid snapshot token');
  }

  assertDepthBounded(text);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ComponentSnapshotError('invalid snapshot token');
  }

  if (!isPlainObject(parsed)) {
    throw new ComponentSnapshotError('invalid snapshot token');
  }
  const violation = scanJson(parsed);
  if (violation !== null) {
    throw new ComponentSnapshotError(jsonViolationMessage(violation));
  }
  return validatePublicSnapshot(parsed);
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

/** A render payload handed to `onRender` for a later DOM/morph adapter. */
export interface ComponentRender {
  /** Signed snapshot token in effect for the rendered HTML. */
  readonly snapshot: string;
  /** Server-rendered component root HTML. */
  readonly html: string;
  /** The controller's working state at render time. */
  readonly state: JsonObject;
}

/** A serializable same-origin POST the controller performs. */
export interface ComponentFetchInit {
  readonly method: 'POST';
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly credentials: 'same-origin';
  readonly signal: AbortSignal;
}

/** Injectable fetch seam (matches `globalThis.fetch` for this call shape). */
export type ComponentFetch = (input: string, init: ComponentFetchInit) => Promise<Response>;

/** Options for {@link createComponentController}. */
export interface CreateComponentControllerOptions {
  /** Initial (unverified) signed snapshot token rendered on the root. */
  readonly snapshot: string;
  /** CSRF token echoed in {@link COMPONENT_CSRF_HEADER} on every update. */
  readonly csrfToken: string;
  /** Same-origin update endpoint. Defaults to `/_jsails/components/update`. */
  readonly endpoint?: string;
  /** Trusted http(s) origin; the endpoint must resolve same-origin. */
  readonly origin: string;
  /** Fetch implementation. Defaults to `globalThis.fetch`. */
  readonly fetch?: ComponentFetch;
  /** Receives each actionable server render; awaited before the next action. */
  readonly onRender?: (render: ComponentRender) => void | Promise<void>;
  /** Receives fatal/network errors (value-free). */
  readonly onError?: (error: ComponentControllerError) => void;
  /** Bound on queued (not yet dispatched) actions. Defaults to 8. */
  readonly maxQueue?: number;
}

/** The outcome of a dispatched action. */
export type ComponentCommitResult =
  | { readonly status: 'applied'; readonly state: JsonObject }
  | {
      readonly status: 'invalid';
      readonly state: JsonObject;
      readonly errors: Readonly<Record<string, string>>;
    };

/** The live controller handle. */
export interface ComponentController {
  /** Current working state (canonical server state plus local edits). Read-only. */
  readonly state: JsonObject;
  /** Last validation errors from a 422, or an empty object. */
  readonly errors: Readonly<Record<string, string>>;
  /** Snapshot token currently believed to be the latest. */
  readonly snapshot: string;
  /** True after a fatal/network failure: a refresh is required. */
  readonly blocked: boolean;
  /** True after {@link ComponentController.dispose}. */
  readonly disposed: boolean;
  /** Set a top-level state field (top-level key only). */
  setField(key: string, value: JsonValue): void;
  /** Diff local edits and dispatch exactly one action; serialized with peers. */
  commit(actionName: string, args?: JsonObject): Promise<ComponentCommitResult>;
  /** Abort in-flight/queued work; no callbacks fire afterwards. Idempotent. */
  dispose(): void;
}

interface QueuedTask {
  readonly actionName: string;
  readonly args: JsonObject;
  readonly resolve: (result: ComponentCommitResult) => void;
  readonly reject: (error: ComponentControllerError) => void;
}

const EMPTY_ERRORS: Readonly<Record<string, string>> = Object.freeze({});

function assertJsonValue(value: unknown, code: ComponentControllerErrorCode): void {
  const violation = scanJson(value);
  if (violation !== null) {
    throw new ComponentControllerError(jsonViolationMessage(violation), code);
  }
}

function assertFieldKey(key: unknown): asserts key is string {
  if (typeof key !== 'string' || key.trim() === '') {
    throw new ComponentControllerError('field key must be a non-empty string', 'invalid_args');
  }
  if (FORBIDDEN_KEYS.has(key) || key in Object.prototype) {
    throw new ComponentControllerError(
      'field key must not shadow an inherited property',
      'invalid_args',
    );
  }
}

function assertActionName(name: unknown): asserts name is string {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new ComponentControllerError('action name must be a non-empty string', 'invalid_action');
  }
  if (name in Object.prototype) {
    throw new ComponentControllerError(
      'action name must not shadow an inherited property',
      'invalid_action',
    );
  }
}

function assertArgs(args: unknown): asserts args is JsonObject {
  if (!isPlainObject(args)) {
    throw new ComponentControllerError('action args must be a plain object', 'invalid_args');
  }
  const keys = Object.keys(args);
  if (keys.length > MAX_ARGS_KEYS) {
    throw new ComponentControllerError('action args carry too many keys', 'invalid_args');
  }
  for (const key of keys) {
    if (FORBIDDEN_KEYS.has(key) || key in Object.prototype) {
      throw new ComponentControllerError(
        'action args must not shadow an inherited property',
        'invalid_args',
      );
    }
  }
  assertJsonValue(args, 'invalid_args');
}

/** Resolve and enforce a same-origin endpoint, returning it unchanged. */
function resolveSameOriginEndpoint(endpoint: unknown, origin: string): string {
  if (typeof endpoint !== 'string' || endpoint.length === 0) {
    throw new ComponentControllerError('endpoint must be a non-empty string', 'invalid_options');
  }
  let resolved: URL;
  try {
    resolved = new URL(endpoint, origin);
  } catch {
    throw new ComponentControllerError('endpoint must be a valid URL', 'invalid_options');
  }
  if (resolved.origin !== origin || resolved.username !== '' || resolved.password !== '') {
    throw new ComponentControllerError('endpoint must be same-origin', 'invalid_options');
  }
  return endpoint;
}

function isRecordOfStrings(value: unknown): value is Record<string, string> {
  if (!isPlainObject(value)) {
    return false;
  }
  for (const key of Object.keys(value)) {
    if (typeof value[key] !== 'string') {
      return false;
    }
  }
  return true;
}

/**
 * Build a controller over an initial snapshot. Throws a value-free
 * {@link ComponentControllerError} synchronously for invalid options, and a
 * {@link ComponentSnapshotError} when the initial snapshot cannot be decoded.
 */
export function createComponentController(
  options: CreateComponentControllerOptions,
): ComponentController {
  if (!isPlainObject(options)) {
    throw new ComponentControllerError('options must be an object', 'invalid_options');
  }

  const decoded = decodePublicSnapshot(options.snapshot);
  const csrfToken = options.csrfToken;
  if (typeof csrfToken !== 'string' || csrfToken.length === 0) {
    throw new ComponentControllerError('csrfToken must be a non-empty string', 'invalid_options');
  }
  const origin = options.origin;
  if (!isHttpOrigin(origin)) {
    throw new ComponentControllerError('origin must be an http(s) origin', 'invalid_options');
  }
  const endpoint = resolveSameOriginEndpoint(options.endpoint ?? COMPONENT_UPDATE_ENDPOINT, origin);

  const candidateFetch = options.fetch ?? globalThis.fetch;
  if (typeof candidateFetch !== 'function') {
    throw new ComponentControllerError('fetch is not available', 'invalid_options');
  }
  const fetchImpl: ComponentFetch = candidateFetch;
  const onRender = options.onRender;
  if (onRender !== undefined && typeof onRender !== 'function') {
    throw new ComponentControllerError('onRender must be a function', 'invalid_options');
  }
  const onError = options.onError;
  if (onError !== undefined && typeof onError !== 'function') {
    throw new ComponentControllerError('onError must be a function', 'invalid_options');
  }
  const maxQueue = options.maxQueue ?? DEFAULT_MAX_QUEUE;
  if (!Number.isSafeInteger(maxQueue) || maxQueue < 1) {
    throw new ComponentControllerError('maxQueue must be a positive integer', 'invalid_options');
  }

  const component = decoded.component;
  let canonical: JsonObject = decoded.state;
  let snapshotToken = options.snapshot;
  let working: JsonObject = { ...decoded.state };
  let currentErrors: Readonly<Record<string, string>> = EMPTY_ERRORS;

  const dirty = new Map<string, { readonly value: JsonValue; readonly revision: number }>();
  let editClock = 0;
  let sequence = 0;

  let disposed = false;
  let blocked = false;
  let pumping = false;
  let abortController: AbortController | null = null;
  const queue: QueuedTask[] = [];

  function notifyError(error: ComponentControllerError): void {
    if (disposed || onError === undefined) {
      return;
    }
    try {
      onError(error);
    } catch {
      // The observer's own failure must not disturb the controller.
    }
  }

  function fail(message: string, code: ComponentControllerErrorCode): ComponentControllerError {
    blocked = true;
    const error = new ComponentControllerError(message, code);
    const pending = queue.splice(0);
    for (const task of pending) {
      task.reject(error);
    }
    notifyError(error);
    return error;
  }

  async function emitRender(snapshot: string, html: string, state: JsonObject): Promise<void> {
    if (disposed || onRender === undefined) {
      return;
    }
    try {
      await onRender({ snapshot, html, state });
    } catch {
      notifyError(new ComponentControllerError('render callback failed', 'invalid_options'));
    }
  }

  async function applySuccess(
    submittedAt: number,
    envelope: Record<string, unknown>,
  ): Promise<ComponentCommitResult> {
    const nextSnapshot = envelope.snapshot;
    const html = envelope.html;
    if (typeof nextSnapshot !== 'string' || nextSnapshot.length === 0 || typeof html !== 'string') {
      fail('component update returned an unexpected response', 'malformed_response');
      throw new ComponentControllerError(
        'component update returned an unexpected response',
        'malformed_response',
      );
    }

    let next: PublicSnapshot;
    try {
      next = decodePublicSnapshot(nextSnapshot);
    } catch {
      fail('component update returned an unexpected response', 'malformed_response');
      throw new ComponentControllerError(
        'component update returned an unexpected response',
        'malformed_response',
      );
    }
    if (next.component !== component || next.origin !== origin) {
      fail('component update returned an unexpected response', 'malformed_response');
      throw new ComponentControllerError(
        'component update returned an unexpected response',
        'malformed_response',
      );
    }

    canonical = next.state;

    // Drop submitted edits (the server incorporated them). Every remaining
    // entry is a newer local edit made after this request was sent; it always
    // survives. The server is authoritative only for the state it actually
    // received, so a field the server changed that was not part of this request
    // must not silently discard the user's later input — that pending edit is
    // sent by the next action.
    for (const [key, entry] of [...dirty]) {
      if (entry.revision <= submittedAt) {
        dirty.delete(key);
      }
    }

    const nextWorking: JsonObject = { ...canonical };
    for (const [key, entry] of dirty) {
      nextWorking[key] = entry.value;
    }
    working = nextWorking;
    snapshotToken = nextSnapshot;
    currentErrors = EMPTY_ERRORS;

    await emitRender(nextSnapshot, html, working);
    return { status: 'applied', state: working };
  }

  async function applyInvalid(
    errors: Readonly<Record<string, string>>,
    html: string,
  ): Promise<ComponentCommitResult> {
    // A 422 keeps canonical state, every submitted value, and newer edits.
    currentErrors = errors;
    await emitRender(snapshotToken, html, working);
    return { status: 'invalid', state: working, errors };
  }

  async function dispatch(task: QueuedTask): Promise<ComponentCommitResult> {
    // Build the explicitly-diffed updates: top-level dirty fields whose value
    // differs from canonical. Action args are carried separately, never folded
    // into the updates diff.
    const updates: JsonObject = {};
    for (const [key, entry] of dirty) {
      if (!jsonEqual(entry.value, canonical[key])) {
        updates[key] = entry.value;
      }
    }
    const submittedAt = editClock;

    sequence += 1;
    const requestSequence = sequence;
    const body: ComponentUpdateRequest = {
      snapshot: snapshotToken,
      updates,
      action: { name: task.actionName, args: task.args },
      sequence: requestSequence,
    };

    abortController = new AbortController();
    let response: Response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          [COMPONENT_CSRF_HEADER]: csrfToken,
        },
        body: JSON.stringify(body),
        credentials: 'same-origin',
        signal: abortController.signal,
      });
    } catch {
      abortController = null;
      if (disposed) {
        task.reject(new ComponentControllerError('controller was disposed', 'disposed'));
        throw new ComponentControllerError('controller was disposed', 'disposed');
      }
      fail('component request failed', 'network');
      throw new ComponentControllerError('component request failed', 'network');
    }
    abortController = null;

    if (disposed) {
      task.reject(new ComponentControllerError('controller was disposed', 'disposed'));
      throw new ComponentControllerError('controller was disposed', 'disposed');
    }

    const envelope = await readEnvelope(response);
    if (envelope === null) {
      fail('component update returned an unexpected response', 'malformed_response');
      throw new ComponentControllerError(
        'component update returned an unexpected response',
        'malformed_response',
      );
    }
    if (envelope.sequence !== requestSequence) {
      fail('component update sequence mismatch', 'sequence_mismatch');
      throw new ComponentControllerError('component update sequence mismatch', 'sequence_mismatch');
    }

    if (response.status === 422) {
      const errorsRaw = envelope.errors;
      const html = envelope.html;
      if (typeof html !== 'string' || !isRecordOfStrings(errorsRaw)) {
        fail('component update returned an unexpected response', 'malformed_response');
        throw new ComponentControllerError(
          'component update returned an unexpected response',
          'malformed_response',
        );
      }
      return await applyInvalid(errorsRaw, html);
    }

    if (!response.ok) {
      fail('component update was rejected', 'unexpected_status');
      throw new ComponentControllerError('component update was rejected', 'unexpected_status');
    }

    return await applySuccess(submittedAt, envelope);
  }

  function pump(): void {
    if (pumping || disposed || blocked) {
      return;
    }
    pumping = true;
    void (async () => {
      try {
        while (!disposed && !blocked && queue.length > 0) {
          const task = queue.shift()!;
          try {
            const result = await dispatch(task);
            task.resolve(result);
          } catch (error) {
            task.reject(
              error instanceof ComponentControllerError
                ? error
                : new ComponentControllerError('component request failed', 'network'),
            );
          }
        }
      } finally {
        pumping = false;
      }
    })();
  }

  return Object.freeze({
    get state(): JsonObject {
      return working;
    },
    get errors(): Readonly<Record<string, string>> {
      return currentErrors;
    },
    get snapshot(): string {
      return snapshotToken;
    },
    get blocked(): boolean {
      return blocked;
    },
    get disposed(): boolean {
      return disposed;
    },

    setField(key: string, value: JsonValue): void {
      if (disposed) {
        throw new ComponentControllerError('controller was disposed', 'disposed');
      }
      assertFieldKey(key);
      assertJsonValue(value, 'invalid_args');
      editClock += 1;
      dirty.set(key, { value, revision: editClock });
      working = { ...working, [key]: value };
    },

    commit(actionName: string, args: JsonObject = {}): Promise<ComponentCommitResult> {
      if (disposed) {
        return Promise.reject(new ComponentControllerError('controller was disposed', 'disposed'));
      }
      try {
        assertActionName(actionName);
        assertArgs(args);
      } catch (error) {
        return Promise.reject(error);
      }
      if (blocked) {
        return Promise.reject(
          new ComponentControllerError('controller requires a refresh', 'blocked'),
        );
      }
      if (queue.length >= maxQueue) {
        return Promise.reject(new ComponentControllerError('action queue is full', 'queue_full'));
      }
      return new Promise<ComponentCommitResult>((resolve, reject) => {
        queue.push({ actionName, args, resolve, reject });
        pump();
      });
    },

    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      abortController?.abort();
      abortController = null;
      const error = new ComponentControllerError('controller was disposed', 'disposed');
      const pending = queue.splice(0);
      for (const task of pending) {
        task.reject(error);
      }
    },
  });
}

/** Parse a bounded JSON response envelope; `null` on any malformed input. */
async function readEnvelope(
  response: Response,
): Promise<(Record<string, unknown> & { sequence: number }) | null> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    return null;
  }
  if (text.length === 0 || text.length > MAX_RESPONSE_BODY_LENGTH) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) {
    return null;
  }
  const sequence = parsed.sequence;
  if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 0) {
    return null;
  }
  return parsed as Record<string, unknown> & { sequence: number };
}
