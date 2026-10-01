/**
 * Browser-safe wire protocol for stateful server components.
 *
 * This module defines the constants and types shared between the server
 * runtime (`runtime.ts`) and any browser client that drives component updates:
 * the update endpoint, the marker attributes the server renders onto a
 * component root, the CSRF header, and the request/response shapes.
 *
 * It imports only type-only JSON contracts, so it is safe to bundle into a
 * browser client: no Node, Preact, or DOM dependency is pulled in at runtime.
 *
 * Security posture (enforced by the runtime, declared here for the client):
 * - A component update is a state change, so it is always a same-origin POST
 *   carrying an `Origin` header that the runtime checks against the trusted
 *   origin, plus a CSRF token header (the session CSRF token for a session,
 *   or the signed snapshot id for an anonymous public component).
 * - The snapshot token is a signed record (HMAC-SHA256); it is integrity
 *   protection, not encryption, and is replayed until it expires.
 */

import type { JsonObject } from '../contracts/http.js';

// ---------------------------------------------------------------------------
// Transport endpoint
// ---------------------------------------------------------------------------

/** Path the runtime mounts the component-update surface under. */
export const COMPONENT_UPDATE_ENDPOINT = '/_jsails/components/update';

/** Path the runtime mounts the component-upload surface under. */
export const COMPONENT_UPLOAD_ENDPOINT = '/_jsails/components/upload';

/** Path the runtime mounts the component-download GET surface under. */
export const COMPONENT_DOWNLOAD_ENDPOINT = '/_jsails/components/download';

/** Multipart field carrying the signed snapshot on an upload. */
export const COMPONENT_UPLOAD_SNAPSHOT_FIELD = 'snapshot';

/** Multipart field carrying the uploaded file on an upload. */
export const COMPONENT_UPLOAD_FILE_FIELD = 'file';

/**
 * Object key a signed upload reference occupies in component state. The value
 * is the reference token itself (`{ __upload: string }`), declared in a
 * component's `stateSchema` via `uploadRefSchema()`.
 */
export const UPLOAD_REFERENCE_KEY = '__upload';

/** A signed upload reference as stored in component state. */
export interface UploadReference {
  readonly __upload: string;
}

// ---------------------------------------------------------------------------
// Marker attributes (the SSR/author contract)
// ---------------------------------------------------------------------------

/**
 * Root marker present on every server-component root; its value is the
 * registered component name, so a client can find roots and resolve their
 * action surface with a single attribute selector.
 */
export const COMPONENT_ATTRIBUTE = 'data-jsails-component';

/** Explicit component-name marker (value equals {@link COMPONENT_ATTRIBUTE}). */
export const COMPONENT_NAME_ATTRIBUTE = 'data-jsails-component-name';

/** Signed snapshot token carried on the root; echoed back verbatim on update. */
export const COMPONENT_SNAPSHOT_ATTRIBUTE = 'data-jsails-component-snapshot';

/** CSRF token carried on the root; echoed back in {@link COMPONENT_CSRF_HEADER}. */
export const COMPONENT_CSRF_ATTRIBUTE = 'data-jsails-component-csrf';

/** Prefix of the root element id, followed by the signed snapshot id. */
export const COMPONENT_ROOT_ID_PREFIX = 'jsails-component-';

/** Model-binding marker spread onto an element by `bind(name)`. */
export const MODEL_ATTRIBUTE = 'data-jsails-model';

/** Action-trigger marker spread onto an element by `call(action, args?)`. */
export const CALL_ATTRIBUTE = 'data-jsails-call';

/** Form-submit marker spread onto an element by `submit(action, args?)`. */
export const SUBMIT_ATTRIBUTE = 'data-jsails-submit';

/** Serialized (JSON) action arguments, carried alongside call/submit markers. */
export const ARGS_ATTRIBUTE = 'data-jsails-args';

/** Turbo attribute a submit helper pins to `false` so a submit is a plain POST. */
export const TURBO_ATTRIBUTE = 'data-turbo';

/** Marker set on a file input while its upload is in flight. */
export const COMPONENT_UPLOADING_ATTRIBUTE = 'data-jsails-uploading';

/**
 * Component-root attribute carrying the maximum accepted upload size in bytes,
 * as a decimal string. A client may read it to reject an oversized file before
 * uploading; absence or an unparseable value means "no client-side bound".
 */
export const COMPONENT_UPLOAD_MAX_BYTES_ATTRIBUTE = 'data-jsails-upload-max-bytes';

/** Polling-marker spread onto a component root by `poll(options)`. */
export const POLL_ATTRIBUTE = 'data-jsails-poll';

// ---------------------------------------------------------------------------
// Livewire-style directive markers (server-emitted, client-consumed)
// ---------------------------------------------------------------------------

/** Confirmation-guard marker spread onto an action trigger. */
export const CONFIRM_ATTRIBUTE = 'data-jsails-confirm';

/** Loading target ref marker spread onto a loading-spinner container. */
export const LOADING_TARGET_ATTRIBUTE = 'data-jsails-loading-target';

/** Conditional-visibility marker keyed to a state field name. */
export const SHOW_ATTRIBUTE = 'data-jsails-show';

/** Text-replacement marker keyed to a state field name. */
export const TEXT_ATTRIBUTE = 'data-jsails-text';

/** Sort-trigger marker keyed to a state field name. */
export const SORT_ATTRIBUTE = 'data-jsails-sort';

/** Intersection-observer marker whose value is the action name to call. */
export const INTERSECT_ATTRIBUTE = 'data-jsails-intersect';

/** Element-reference marker keyed to an element id for client lookups. */
export const REF_ATTRIBUTE = 'data-jsails-ref';

/** Ignore marker that excludes an element from client-side DOM diffing. */
export const IGNORE_ATTRIBUTE = 'data-jsails-ignore';

/** Debounce-marker spread onto a model-bound control by `bind(name, { debounceMs })`. */
export const DEBOUNCE_ATTRIBUTE = 'data-jsails-debounce';

/** Loading marker the client sets on a root while an update is in flight. */
export const LOADING_ATTRIBUTE = 'data-jsails-loading';

/** Dirty marker the client sets on a root (and per-field) while local edits differ. */
export const DIRTY_ATTRIBUTE = 'data-jsails-dirty';

/** Built-in no-op action name the runtime accepts for poll/debounce re-renders. */
export const REFRESH_ACTION = '$refresh';

/** Minimum poll interval the runtime accepts, in milliseconds. */
export const MIN_POLL_INTERVAL_MS = 250;

/** Maximum debounce duration the runtime accepts, in milliseconds. */
export const MAX_DEBOUNCE_MS = 60_000;

/** Maximum length of a serialized `data-jsails-poll` marker, in characters. */
export const MAX_POLL_MARKER_LENGTH = 512;

/**
 * Author-facing poll options spread onto a root via `poll(options)`. `intervalMs`
 * is the minimum gap between updates; `pauseWhenHidden`/`pauseWhenOffline` opt
 * into pausing the client poll while the tab is hidden or the browser is
 * offline. All three are advisory to the client, which the server stays
 * authoritative over.
 */
export interface ComponentPollOptions {
  readonly intervalMs: number;
  readonly pauseWhenHidden?: boolean;
  readonly pauseWhenOffline?: boolean;
}

// ---------------------------------------------------------------------------
// Validation metadata (server-derived constraints, client-consumed hints)
// ---------------------------------------------------------------------------

/**
 * Marker spread onto a model-bound control by `bind(name)` when the field's
 * schema yields client-side validation rules. The value is a bounded JSON
 * {@link FieldValidationRules} object; absence means "no client-side rules".
 */
export const RULES_ATTRIBUTE = 'data-jsails-rules';

/**
 * Marker an author places on the element that displays a bound field's error
 * message. Its value names the field; the client sets `textContent` to the
 * current validation message (and clears it when valid) but never creates the
 * element — the author owns its markup and placement.
 */
export const ERROR_FOR_ATTRIBUTE = 'data-jsails-error-for';

/** The kind of native control a bound field should render as. */
export type FieldRuleTypeHint = 'string' | 'number' | 'boolean' | 'email' | 'date';

/**
 * Client-side validation rules derived from a field's Zod schema.
 *
 * These are advisory hints for instant feedback only: the server schema stays
 * the sole authority, and a client-side mismatch is always resolved by the
 * server. `required` means the schema rejects an absent value (the field is not
 * optional/nullable/defaulted) and maps to an "empty value" check on the client;
 * the remaining fields mirror the schema's declared bounds.
 */
export interface FieldValidationRules {
  readonly required: boolean;
  readonly type?: FieldRuleTypeHint;
  readonly minLength?: number;
  readonly maxLength?: number;
  /** JavaScript regex source (no flags) from a `z.string().regex(...)`. */
  readonly pattern?: string;
  readonly min?: number;
  readonly max?: number;
  /** Step increment from a `z.number().multipleOf(...)`. */
  readonly step?: number;
  /** Allowed values from a `z.enum([...])`. */
  readonly options?: readonly string[];
}

/** Maximum length of a serialized `data-jsails-rules` pattern, in characters. */
export const MAX_PATTERN_LENGTH = 256;

/** Maximum number of enum options a field may serialize into its rules. */
export const MAX_OPTIONS = 50;

/** Maximum length of a single enum option value, in characters. */
export const MAX_OPTION_LENGTH = 64;

/** Maximum length of a serialized `data-jsails-rules` marker, in characters. */
export const MAX_RULES_JSON_LENGTH = 4096;

// ---------------------------------------------------------------------------
// CSRF header
// ---------------------------------------------------------------------------

/**
 * Header carrying the component CSRF token on every update. For a session the
 * value is `session.csrfToken`; for an anonymous public component it is the
 * verified snapshot id (a possession token, not an authentication identity).
 */
export const COMPONENT_CSRF_HEADER = 'X-CSRF-Token';

// ---------------------------------------------------------------------------
// Update request / response shapes
// ---------------------------------------------------------------------------

/** A single action in an update request: a name plus optional explicit args. */
export interface ComponentUpdateAction {
  /** Registered action name. */
  readonly name: string;
  /** Explicit action args (a JSON object). Never derived from FormData. */
  readonly args?: JsonObject;
}

/**
 * The body of an update POST. `snapshot` is the signed token the server rendered
 * on the root; `updates` holds only the top-level fields the client may set
 * (`writableKeys`); `action` carries at most one action; `sequence` is a
 * client monotonic counter echoed back for ordering.
 */
export interface ComponentUpdateRequest {
  readonly snapshot: string;
  readonly updates: JsonObject;
  readonly action?: ComponentUpdateAction;
  readonly sequence: number;
}

/** Stable machine codes carried in a failed update's `error` field. */
export type ComponentUpdateErrorCode =
  | 'invalid_request'
  | 'origin_mismatch'
  | 'invalid_snapshot'
  | 'csrf_mismatch'
  | 'forbidden'
  | 'unknown_component'
  | 'internal_error';

/** A top-level update failure descriptor. Value-free; never echoes raw input. */
export interface ComponentUpdateError {
  readonly code: ComponentUpdateErrorCode;
  readonly message: string;
}

/**
 * A download descriptor in an update response. `url` is the signed GET endpoint
 * to stream the stored file; `filename` is the display name. Present only when
 * an action returned a {@link ServerComponentDownload}.
 */
export interface ComponentUpdateDownload {
  /** Signed GET URL for the stored file. Server-crafted, never client-supplied. */
  readonly url: string;
  /** Display filename, matching the action's download filename option. */
  readonly filename: string;
}

/**
 * The response to an update. `sequence` always echoes the request. On success
 * `snapshot` and `html` carry the re-signed token and the re-rendered root. On
 * a validation failure `errors` maps field paths to safe messages and `html`
 * carries a re-render that preserves submitted values. On any other failure
 * `error` carries a stable code and a value-free message.
 *
 * `redirect` is an optional same-origin-or-absolute URL the client should
 * navigate to after applying the render. It is present only when an action
 * returned a {@link ServerComponentRedirect}; the URL is validated server-side
 * and is trusted producer output. Absent means no redirect.
 *
 * `download` is an optional signed download reference; the client navigates to
 * its `url`, and the browser's `Content-Disposition` handling turns it into a
 * file download without leaving the page. Present only when an action returned
 * a {@link ServerComponentDownload}.
 */
export interface ComponentUpdateResponse {
  readonly sequence: number;
  readonly snapshot?: string;
  readonly html?: string;
  readonly errors?: Readonly<Record<string, string>>;
  readonly error?: ComponentUpdateError;
  /** Navigation target signaled by an action. Validated server-side; absent by default. */
  readonly redirect?: string;
  /** Download reference signaled by an action. Validated server-side; absent by default. */
  readonly download?: ComponentUpdateDownload;
}

/** Stable machine codes carried in a failed upload's `error` field. */
export type ComponentUploadErrorCode =
  | 'invalid_request'
  | 'origin_mismatch'
  | 'invalid_snapshot'
  | 'csrf_mismatch'
  | 'forbidden'
  | 'unknown_component'
  | 'unsupported_content_type'
  | 'oversize'
  | 'storage_unavailable'
  | 'internal_error';

/** A top-level upload failure descriptor. Value-free; never echoes raw input. */
export interface ComponentUploadError {
  readonly code: ComponentUploadErrorCode;
  readonly message: string;
}

/**
 * The response to an upload. On success `reference` carries the signed token to
 * store in component state (wrapped as `{ __upload: reference }`); on failure
 * `error` carries a stable code and a value-free message.
 */
export interface ComponentUploadResponse {
  readonly reference?: string;
  readonly error?: ComponentUploadError;
}
