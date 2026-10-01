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
 * The response to an update. `sequence` always echoes the request. On success
 * `snapshot` and `html` carry the re-signed token and the re-rendered root. On
 * a validation failure `errors` maps field paths to safe messages and `html`
 * carries a re-render that preserves submitted values. On any other failure
 * `error` carries a stable code and a value-free message.
 */
export interface ComponentUpdateResponse {
  readonly sequence: number;
  readonly snapshot?: string;
  readonly html?: string;
  readonly errors?: Readonly<Record<string, string>>;
  readonly error?: ComponentUpdateError;
}
