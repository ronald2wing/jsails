/**
 * Browser-safe server-component state controller.
 *
 * This is the transport-agnostic half of the interactive component story: it
 * owns the client-side model (canonical server state plus local edits), a
 * serialized one-action-at-a-time update queue, and the same-origin/CSRF POST
 * that drives `/_jsails/components/update`, plus an XHR-driven upload path to
 * `/_jsails/components/upload` for `type=file` bound inputs. It touches no DOM
 * and imports no Preact — a later binding worker consumes its `onRender`
 * callback (and `state`/`errors`) to morph the server HTML into place.
 *
 * The decoding concerns are split into sibling modules, re-exported here so
 * this file's public surface is unchanged:
 *
 * - `./decoding/limits.js` — numeric bounds and the bounded-JSON scanner.
 * - `./decoding/proto-guard.js` — prototype-pollution key rejection.
 * - `./decoding/props.js` — unverified snapshot-token decoding.
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
import { isHttpOrigin } from '../internal/http.js';
import { isPlainObject } from '../internal/json-safe.js';
import {
  COMPONENT_CSRF_HEADER,
  COMPONENT_UPDATE_ENDPOINT,
  COMPONENT_UPLOAD_ENDPOINT,
  COMPONENT_UPLOAD_FILE_FIELD,
  COMPONENT_UPLOAD_SNAPSHOT_FIELD,
  REFRESH_ACTION,
  UPLOAD_REFERENCE_KEY,
  type ComponentUpdateRequest,
} from '../server-components/protocol.js';
import {
  DEFAULT_MAX_QUEUE,
  MAX_ARGS_KEYS,
  MAX_RESPONSE_BODY_LENGTH,
  MAX_UPLOAD_RESPONSE_BODY_LENGTH,
  jsonEqual,
  jsonViolationMessage,
  scanJson,
} from './decoding/limits.js';
import { isForbiddenKey, shadowsObjectPrototype } from './decoding/proto-guard.js';
import {
  ComponentSnapshotError,
  decodePublicSnapshot,
  type PublicSnapshot,
} from './decoding/props.js';

// Re-export the snapshot-decoding surface so this barrel keeps its public API
// unchanged (decodePublicSnapshot / ComponentSnapshotError).
export { ComponentSnapshotError, decodePublicSnapshot };

/** Stable machine codes carried by {@link ComponentControllerError}. */
type ComponentControllerErrorCode =
  | 'invalid_options'
  | 'invalid_action'
  | 'invalid_args'
  | 'queue_full'
  | 'disposed'
  | 'blocked'
  | 'network'
  | 'unexpected_status'
  | 'malformed_response'
  | 'sequence_mismatch'
  | 'upload_failed';

/** Raised for controller misconfiguration, misuse, or a fatal update outcome. */
export class ComponentControllerError extends Error {
  readonly code: ComponentControllerErrorCode;

  constructor(message: string, code: ComponentControllerErrorCode) {
    super(message);
    this.name = 'ComponentControllerError';
    this.code = code;
  }
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
  /**
   * Navigation target signaled by the action that produced this render.
   * Present only when the action returned a redirect; absent means no redirect.
   * The URL is validated server-side and is trusted producer output.
   */
  readonly redirect?: string;
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

/** A file the client can upload: a Blob carrying a readable name. */
export type ComponentUploadFile = Blob & { readonly name: string };

/** Progress on an in-flight upload. */
export interface ComponentUploadProgress {
  readonly lengthComputable: boolean;
  readonly loaded: number;
  readonly total: number;
}

/**
 * The slice of `XMLHttpRequest` the upload transport touches, declared
 * structurally (no DOM lib) so the module stays Node-importable. A real
 * `XMLHttpRequest` satisfies every member; `upload.onprogress` carries the
 * upload progress events.
 */
export interface ComponentUploadXhr {
  readonly upload: {
    onprogress: ((event: ComponentUploadProgress) => void) | null;
  };
  onload: (() => void) | null;
  onerror: (() => void) | null;
  onabort: (() => void) | null;
  readonly status: number;
  readonly responseText: string;
  open(method: string, url: string): void;
  setRequestHeader(name: string, value: string): void;
  send(body: FormData): void;
  abort(): void;
}

/** Injectable XHR factory; defaults to the platform `XMLHttpRequest`. */
export type ComponentUploadXhrFactory = () => ComponentUploadXhr;

/** The outcome of a successful upload. */
type ComponentUploadResult = { readonly status: 'uploaded'; readonly reference: string };

/** Options for {@link createComponentController}. */
interface ComponentControllerOptions {
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
  /** Receives the in-flight request count whenever it changes (0 → 1 → 0). */
  readonly onInflightChange?: (inflight: number) => void;
  /** Bound on queued (not yet dispatched) actions. Defaults to 8. */
  readonly maxQueue?: number;
  /** Same-origin upload endpoint. Defaults to `/_jsails/components/upload`. */
  readonly uploadEndpoint?: string;
  /** XHR factory used for uploads. Defaults to the platform `XMLHttpRequest`. */
  readonly uploadRequest?: ComponentUploadXhrFactory;
  /** Receives upload progress (value-free), keyed by the bound field name. */
  readonly onUploadProgress?: (field: string, progress: ComponentUploadProgress) => void;
}

/** The outcome of a dispatched action. */
type ComponentCommitResult =
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
  /** Number of updates currently in flight (never negative). */
  readonly inflight: number;
  /** Set a top-level state field (top-level key only). */
  setField(key: string, value: JsonValue): void;
  /** Diff local edits and dispatch exactly one action; serialized with peers. */
  commit(actionName: string, args?: JsonObject): Promise<ComponentCommitResult>;
  /** True when `field` (or any field, when omitted) has an unsent local edit. */
  isDirty(field?: string): boolean;
  /** Re-render with no client edits or user action; serialized with peers. */
  refresh(): Promise<ComponentCommitResult>;
  /** Re-render, carrying the current dirty diff but no user action. */
  sync(): Promise<ComponentCommitResult>;
  /** Upload a file for a bound field; resolves to its signed reference. */
  uploadField(field: string, file: ComponentUploadFile): Promise<ComponentUploadResult>;
  /** Abort in-flight/queued work; no callbacks fire afterwards. Idempotent. */
  dispose(): void;
}

interface ActionTask {
  readonly kind: 'action';
  readonly actionName: string;
  readonly args: JsonObject;
  readonly resolve: (result: ComponentCommitResult) => void;
  readonly reject: (error: ComponentControllerError) => void;
}

interface UploadTask {
  readonly kind: 'upload';
  readonly field: string;
  readonly file: ComponentUploadFile;
  readonly resolve: (result: ComponentUploadResult) => void;
  readonly reject: (error: ComponentControllerError) => void;
}

interface RefreshTask {
  /** `refresh` sends no dirty diff; `sync` sends the current dirty diff. */
  readonly kind: 'refresh' | 'sync';
  readonly resolve: (result: ComponentCommitResult) => void;
  readonly reject: (error: ComponentControllerError) => void;
}

type QueuedTask = ActionTask | UploadTask | RefreshTask;

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
  if (isForbiddenKey(key) || shadowsObjectPrototype(key)) {
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
  if (shadowsObjectPrototype(name)) {
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
    if (isForbiddenKey(key) || shadowsObjectPrototype(key)) {
      throw new ComponentControllerError(
        'action args must not shadow an inherited property',
        'invalid_args',
      );
    }
  }
  assertJsonValue(args, 'invalid_args');
}

function assertUploadFile(file: unknown): asserts file is ComponentUploadFile {
  if (typeof file !== 'object' || file === null) {
    throw new ComponentControllerError('upload file must be a File or Blob', 'invalid_args');
  }
  const name = (file as { name?: unknown }).name;
  if (typeof name !== 'string' || name.length === 0) {
    throw new ComponentControllerError('upload file must have a name', 'invalid_args');
  }
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
  options: ComponentControllerOptions,
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
  const uploadEndpoint = resolveSameOriginEndpoint(
    options.uploadEndpoint ?? COMPONENT_UPLOAD_ENDPOINT,
    origin,
  );

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
  const onInflightChange = options.onInflightChange;
  if (onInflightChange !== undefined && typeof onInflightChange !== 'function') {
    throw new ComponentControllerError('onInflightChange must be a function', 'invalid_options');
  }
  const maxQueue = options.maxQueue ?? DEFAULT_MAX_QUEUE;
  if (!Number.isSafeInteger(maxQueue) || maxQueue < 1) {
    throw new ComponentControllerError('maxQueue must be a positive integer', 'invalid_options');
  }

  const providedUploadRequest = options.uploadRequest;
  if (providedUploadRequest !== undefined && typeof providedUploadRequest !== 'function') {
    throw new ComponentControllerError('uploadRequest must be a function', 'invalid_options');
  }
  // Resolved lazily so a controller that never uploads still constructs (and
  // stays import-safe) in an environment without `XMLHttpRequest`.
  const uploadRequest: ComponentUploadXhrFactory =
    providedUploadRequest ??
    (() => {
      const ctor = (globalThis as { XMLHttpRequest?: new () => ComponentUploadXhr }).XMLHttpRequest;
      if (typeof ctor !== 'function') {
        throw new ComponentControllerError('XMLHttpRequest is not available', 'upload_failed');
      }
      return new ctor();
    });
  const onUploadProgress = options.onUploadProgress;
  if (onUploadProgress !== undefined && typeof onUploadProgress !== 'function') {
    throw new ComponentControllerError('onUploadProgress must be a function', 'invalid_options');
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
  let inflight = 0;
  let abortController: AbortController | null = null;
  let activeUploadXhr: ComponentUploadXhr | null = null;
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

  function notifyInflight(): void {
    if (disposed || onInflightChange === undefined) {
      return;
    }
    try {
      onInflightChange(inflight);
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

  async function emitRender(
    snapshot: string,
    html: string,
    state: JsonObject,
    redirect?: string,
  ): Promise<void> {
    if (disposed || onRender === undefined) {
      return;
    }
    try {
      const render: ComponentRender =
        redirect === undefined ? { snapshot, html, state } : { snapshot, html, state, redirect };
      await onRender(render);
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

    // Extract a redirect or download signaled by the action, when present.
    // The URL was validated/signed server-side; the client trusts it as
    // producer output. A download URL navigates the browser to the signed
    // GET endpoint; the browser handles Content-Disposition itself.
    const redirect =
      typeof envelope.redirect === 'string' && envelope.redirect !== ''
        ? envelope.redirect
        : envelope.download !== undefined &&
            typeof envelope.download === 'object' &&
            envelope.download !== null &&
            typeof (envelope.download as { url: string }).url === 'string' &&
            (envelope.download as { url: string }).url !== ''
          ? (envelope.download as { url: string }).url
          : undefined;

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

    await emitRender(nextSnapshot, html, working, redirect);
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

  async function dispatchAction(task: ActionTask | RefreshTask): Promise<ComponentCommitResult> {
    // `refresh` sends no dirty diff; `action` and `sync` send the current diff.
    // Action args are carried separately, never folded into the updates diff.
    const submitDirty = task.kind !== 'refresh';
    const updates: JsonObject = {};
    if (submitDirty) {
      for (const [key, entry] of dirty) {
        if (!jsonEqual(entry.value, canonical[key])) {
          updates[key] = entry.value;
        }
      }
    }
    const submittedAt = submitDirty ? editClock : 0;
    const actionName = task.kind === 'action' ? task.actionName : REFRESH_ACTION;
    const args = task.kind === 'action' ? task.args : {};

    sequence += 1;
    const requestSequence = sequence;
    const body: ComponentUpdateRequest = {
      snapshot: snapshotToken,
      updates,
      action: { name: actionName, args },
      sequence: requestSequence,
    };

    inflight += 1;
    notifyInflight();
    try {
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
        throw new ComponentControllerError(
          'component update sequence mismatch',
          'sequence_mismatch',
        );
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
    } finally {
      inflight -= 1;
      notifyInflight();
    }
  }

  /** Record a validated local edit (shared by `setField` and upload apply). */
  function recordFieldEdit(key: string, value: JsonValue): void {
    editClock += 1;
    dirty.set(key, { value, revision: editClock });
    working = { ...working, [key]: value };
  }

  /**
   * Drive one upload over XHR (chosen for upload-progress events). Resolves to
   * the signed reference token on a 201; rejects with a value-free
   * {@link ComponentControllerError} (`upload_failed`/`disposed`) otherwise.
   * Never marks the controller blocked — an upload failure is non-fatal.
   */
  function uploadOnce(field: string, file: ComponentUploadFile): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let xhr: ComponentUploadXhr;
      try {
        xhr = uploadRequest();
      } catch {
        reject(new ComponentControllerError('upload request is not available', 'upload_failed'));
        return;
      }

      activeUploadXhr = xhr;
      let settled = false;
      const resolveOnce = (reference: string): void => {
        if (settled) {
          return;
        }
        settled = true;
        activeUploadXhr = null;
        resolve(reference);
      };
      const rejectOnce = (error: ComponentControllerError): void => {
        if (settled) {
          return;
        }
        settled = true;
        activeUploadXhr = null;
        reject(error);
      };

      xhr.upload.onprogress = (progress) => {
        if (onUploadProgress === undefined || disposed) {
          return;
        }
        try {
          onUploadProgress(field, progress);
        } catch {
          // The observer's own failure must not disturb the upload.
        }
      };

      xhr.onload = () => {
        if (xhr.responseText.length > MAX_UPLOAD_RESPONSE_BODY_LENGTH) {
          rejectOnce(
            new ComponentControllerError('upload returned an unexpected response', 'upload_failed'),
          );
          return;
        }
        let envelope: unknown;
        try {
          envelope = JSON.parse(xhr.responseText);
        } catch {
          rejectOnce(
            new ComponentControllerError('upload returned an unexpected response', 'upload_failed'),
          );
          return;
        }
        if (xhr.status === 201) {
          const reference = isPlainObject(envelope) ? envelope.reference : undefined;
          if (typeof reference !== 'string' || reference.length === 0) {
            rejectOnce(
              new ComponentControllerError(
                'upload returned an unexpected response',
                'upload_failed',
              ),
            );
            return;
          }
          resolveOnce(reference);
          return;
        }
        rejectOnce(new ComponentControllerError('upload failed', 'upload_failed'));
      };

      xhr.onerror = () => {
        rejectOnce(new ComponentControllerError('upload failed', 'upload_failed'));
      };

      xhr.onabort = () => {
        rejectOnce(
          new ComponentControllerError(
            disposed ? 'controller was disposed' : 'upload failed',
            disposed ? 'disposed' : 'upload_failed',
          ),
        );
      };

      const formData = new FormData();
      formData.append(COMPONENT_UPLOAD_SNAPSHOT_FIELD, snapshotToken);
      formData.append(COMPONENT_UPLOAD_FILE_FIELD, file, file.name);
      try {
        xhr.open('POST', uploadEndpoint);
        xhr.setRequestHeader(COMPONENT_CSRF_HEADER, csrfToken);
        xhr.send(formData);
      } catch {
        rejectOnce(new ComponentControllerError('upload failed', 'upload_failed'));
      }
    });
  }

  async function dispatchUpload(task: UploadTask): Promise<ComponentUploadResult> {
    const reference = await uploadOnce(task.field, task.file);
    if (disposed) {
      throw new ComponentControllerError('controller was disposed', 'disposed');
    }
    // The uploaded reference is a local edit: it enters working state and the
    // dirty diff so the next action serializes it back to the server.
    recordFieldEdit(task.field, { [UPLOAD_REFERENCE_KEY]: reference });
    return { status: 'uploaded', reference };
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
            if (task.kind === 'upload') {
              task.resolve(await dispatchUpload(task));
            } else {
              task.resolve(await dispatchAction(task));
            }
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
    get inflight(): number {
      return inflight;
    },

    setField(key: string, value: JsonValue): void {
      if (disposed) {
        throw new ComponentControllerError('controller was disposed', 'disposed');
      }
      assertFieldKey(key);
      assertJsonValue(value, 'invalid_args');
      recordFieldEdit(key, value);
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
        queue.push({ kind: 'action', actionName, args, resolve, reject });
        pump();
      });
    },

    isDirty(field?: string): boolean {
      if (field !== undefined) {
        if (!Object.prototype.hasOwnProperty.call(working, field)) {
          return false;
        }
        return !jsonEqual(working[field], canonical[field]);
      }
      for (const key of Object.keys(working)) {
        if (!jsonEqual(working[key], canonical[key])) {
          return true;
        }
      }
      return false;
    },

    refresh(): Promise<ComponentCommitResult> {
      if (disposed) {
        return Promise.reject(new ComponentControllerError('controller was disposed', 'disposed'));
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
        queue.push({ kind: 'refresh', resolve, reject });
        pump();
      });
    },

    sync(): Promise<ComponentCommitResult> {
      if (disposed) {
        return Promise.reject(new ComponentControllerError('controller was disposed', 'disposed'));
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
        queue.push({ kind: 'sync', resolve, reject });
        pump();
      });
    },

    uploadField(field: string, file: ComponentUploadFile): Promise<ComponentUploadResult> {
      if (disposed) {
        return Promise.reject(new ComponentControllerError('controller was disposed', 'disposed'));
      }
      try {
        assertFieldKey(field);
        assertUploadFile(file);
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
      return new Promise<ComponentUploadResult>((resolve, reject) => {
        queue.push({ kind: 'upload', field, file, resolve, reject });
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
      activeUploadXhr?.abort();
      activeUploadXhr = null;
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
