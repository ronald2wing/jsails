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
 *
 * This module is the assembly seam: it keeps the public surface (the runtime
 * factory and its option/result types) and re-exports the value-free error and
 * upload-reference types from the `runtime/` modules, which own request payload
 * parsing, render-tool construction, value-free error/response builders, and
 * upload transport glue respectively.
 */

import { randomBytes } from 'node:crypto';
import type { Readable } from 'node:stream';

import { Fragment, h } from 'preact';
import { z, ZodError } from 'zod';

import { safeEqualStrings } from '../internal/crypto.js';
import { isHttpOrigin } from '../internal/http.js';
import { isSameOriginRequest } from '../internal/trusted-mutation.js';
import { deepCloneJson, isPlainObject } from '../internal/json-safe.js';
import type { JsonObject, RequestContext } from '../contracts/http.js';
import { renderToString } from '../jsx/render-to-string.js';
import {
  DEFAULT_UPLOAD_CONTENT_TYPES,
  DEFAULT_UPLOAD_MAX_BYTES,
  type UploadReferenceSigner,
  type UploadStore,
} from './uploads.js';
import {
  isRedirect,
  type ServerComponentDefinition,
  type ServerComponentState,
} from './component.js';
import { isDownload, type DownloadReferenceSigner } from './downloads.js';
import { seedFromUrl } from './url-binding.js';
import {
  COMPONENT_ATTRIBUTE,
  COMPONENT_CSRF_HEADER,
  COMPONENT_DOWNLOAD_ENDPOINT,
  COMPONENT_NAME_ATTRIBUTE,
  REFRESH_ACTION,
} from './protocol.js';
import { SnapshotError, type ComponentSigner, type SnapshotPayload } from './snapshot.js';
import { buildValues, parseActionArgs, parseUpdatePayload } from './runtime/payload.js';
import { lookupAction, renderComponentHtml } from './runtime/render-tools.js';
import {
  ServerComponentRuntimeError,
  errorResult,
  zodIssuesToFieldErrors,
  type ServerComponentUpdateResult,
  type ServerComponentUploadResult,
} from './runtime/value-errors.js';
import {
  createUploadBridge,
  type ResolveUploadOptions,
  type ResolvedUpload,
  type ServerComponentUploadOptions,
} from './runtime/upload-bridge.js';

export {
  ServerComponentRuntimeError,
  type ResolveUploadOptions,
  type ResolvedUpload,
  type ServerComponentUpdateResult,
  type ServerComponentUploadOptions,
  type ServerComponentUploadResult,
};

/** Options for {@link createServerComponentsRuntime}. */
export interface ServerComponentsRuntimeOptions {
  /** Registered components keyed by name. The runtime reads, never mutates, them. */
  readonly components: Readonly<Record<string, ServerComponentDefinition<any>>>;
  /** The signer used to mint and verify snapshot tokens. */
  readonly signer: ComponentSigner;
  /**
   * Optional upload transport. When present the runtime exposes
   * {@link ServerComponentsRuntime.handleUpload} and `resolveUpload`. `store` is
   * either an {@link UploadStore} directly, or a factory resolving one from the
   * request's `storagePath` (the disk store must be rooted per application, and
   * the path is only known at request time). `signer` mints/verifies signed
   * upload references. `maxBytes`/`contentTypes` bound uploads independent of
   * the store implementation.
   */
  readonly uploads?: {
    readonly store: UploadStore | ((storagePath: string) => UploadStore);
    readonly signer: UploadReferenceSigner;
    readonly downloadSigner?: DownloadReferenceSigner;
    readonly maxBytes?: number;
    readonly contentTypes?: readonly string[];
  };
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
  handleUpload(
    request: Request,
    context: RequestContext,
    options?: ServerComponentUploadOptions,
  ): Promise<ServerComponentUploadResult>;
  handleDownload(
    request: Request,
    context: RequestContext,
    options?: ServerComponentUpdateOptions,
  ): Promise<ServerComponentDownloadResult>;
  resolveUpload(reference: unknown, options: ResolveUploadOptions): ResolvedUpload;
  /**
   * Derive the subject tag for a raw session/scope id (delegates to the snapshot
   * signer). Exposed so callers can derive an `expectedSubject` for
   * {@link resolveUpload} without re-implementing the tag derivation.
   */
  subjectFor(sessionOrScopeId: string | null): string | null;
  /**
   * Read-only summary of registered components for introspection. Returns
   * component names, action names, and writable keys only — no state, schemas,
   * or signing details.
   */
  describe(): {
    readonly components: ReadonlyArray<{
      readonly name: string;
      readonly actions: readonly string[];
      readonly writableKeys: readonly string[];
    }>;
  };
  close(): void;
}

/** Random bytes minted for a new component instance id. */
const ID_BYTES = 16;

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

/** Await the optional `mount` hook, sanitizing a throw into a value-free error. */
async function runMountHook(
  component: ServerComponentDefinition<any>,
  context: RequestContext,
): Promise<void> {
  if (component.mount === undefined) {
    return;
  }
  try {
    await component.mount(context);
  } catch {
    throw new ServerComponentRuntimeError('component mount hook failed');
  }
}

/**
 * Await an optional state lifecycle hook (`hydrate`/`updating`/`updated`),
 * converting a throw into a value-free update result. When `allowValidationReject`
 * is set, a `ZodError` becomes a 422 with field errors (the author's way to
 * reject the update before any side effect); any other throw — and every throw
 * when `allowValidationReject` is false — is a value-free 500. Returns `null`
 * when the hook is absent or ran cleanly.
 */
async function runStateHook(
  hook:
    ((state: ServerComponentState, context: RequestContext) => void | Promise<void>) | undefined,
  state: ServerComponentState,
  args: {
    sequence: number;
    token: string;
    snapshot: SnapshotPayload;
    component: ServerComponentDefinition<any>;
    context: RequestContext;
    csrfToken: string;
    values: Readonly<Record<string, string>>;
  },
  allowValidationReject: boolean,
): Promise<ServerComponentUpdateResult | null> {
  if (hook === undefined) {
    return null;
  }
  try {
    await hook(state, args.context);
    return null;
  } catch (error) {
    if (allowValidationReject && error instanceof ZodError) {
      return await validationResult(
        args.sequence,
        args.token,
        args.snapshot,
        args.component,
        zodIssuesToFieldErrors(error.issues, state),
        args.values,
        args.context,
        args.csrfToken,
      );
    }
    return errorResult(args.sequence, 'internal_error', 'Internal Server Error');
  }
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
// Runtime factory
// ---------------------------------------------------------------------------

/**
 * Assemble a server-components runtime over a component map and a snapshot
 * signer. The runtime is inert: it opens no listener, holds no store, and runs
 * no component callback until `render` or `update` is invoked.
 */
export function createServerComponentsRuntime(
  options: ServerComponentsRuntimeOptions,
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

  const uploads = options.uploads;
  if (uploads !== undefined) {
    if (
      uploads === null ||
      typeof uploads !== 'object' ||
      (typeof uploads.store !== 'function' &&
        (uploads.store === null ||
          typeof uploads.store !== 'object' ||
          typeof uploads.store.put !== 'function' ||
          typeof uploads.store.open !== 'function' ||
          typeof uploads.store.delete !== 'function')) ||
      uploads.signer === null ||
      typeof uploads.signer !== 'object' ||
      typeof uploads.signer.sign !== 'function' ||
      typeof uploads.signer.verify !== 'function'
    ) {
      throw new TypeError('uploads must provide a store (or factory) and a reference signer');
    }
    // downloadSigner is optional: when absent, download() actions are not supported
    // (the update path skips download detection when no signer is available).
    if (uploads.downloadSigner !== undefined) {
      if (
        uploads.downloadSigner === null ||
        typeof uploads.downloadSigner !== 'object' ||
        typeof uploads.downloadSigner.sign !== 'function' ||
        typeof uploads.downloadSigner.verify !== 'function'
      ) {
        throw new TypeError('uploads.downloadSigner must expose sign and verify');
      }
    }
  }
  const maxUploadBytes = uploads?.maxBytes ?? DEFAULT_UPLOAD_MAX_BYTES;
  const uploadContentTypes = new Set(
    (uploads?.contentTypes ?? DEFAULT_UPLOAD_CONTENT_TYPES).map((t) => t.toLowerCase()),
  );

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

    let initial = await component.initialState(context);

    // Seed declared state fields from the request URL's query string before the
    // schema parse — exactly once, at mount. This is a graceful hint: uncoercible
    // or missing values leave initialState alone, and the schema parse is the
    // canonical validation. Subsequent updates (snapshot-wins-after-first-render)
    // reconstruct state only from the signed snapshot; the URL is never re-read.
    const urlFields = component.urlBinding;
    if (urlFields !== undefined && urlFields.length > 0) {
      // stateSchema is validated to be a ZodObject at definition time; casting
      // is safe and matches the existing parse call below.
      initial = seedFromUrl(
        initial,
        component.stateSchema as unknown as z.ZodObject<any>,
        context.url,
        new Set(urlFields),
      );
    }

    let state: ServerComponentState;
    try {
      state = component.stateSchema.parse(initial);
    } catch {
      throw new ServerComponentRuntimeError('component produced an invalid initial state');
    }

    // Lifecycle: `mount` runs once on the first (live) server render, before
    // the snapshot is signed and the component is rendered.
    await runMountHook(component, context);

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
    if (!isSameOriginRequest(context.request, trustedOrigin)) {
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

    // Lifecycle: hydrate the state reconstructed from the verified snapshot
    // (server-side rehydration) before any client edit or action.
    const baseState: ServerComponentState = { ...snapshot.state };
    const hookArgs = {
      sequence,
      token,
      snapshot,
      component,
      context: actionContext,
      csrfToken: expectedCsrf,
      values: buildValues(updates),
    };
    const hydrateResult = await runStateHook(component.hydrate, baseState, hookArgs, true);
    if (hydrateResult !== null) {
      return hydrateResult;
    }

    // Lifecycle: `updating` runs before client edits are applied and may throw
    // a value-free error to reject the update (nothing has been applied yet).
    const updateKeys = Object.keys(updates);
    if (updateKeys.length > 0) {
      const updatingResult = await runStateHook(component.updating, baseState, hookArgs, true);
      if (updatingResult !== null) {
        return updatingResult;
      }
    }

    // Apply client edits, restricted to `writableKeys`.
    const writable = new Set(component.writableKeys ?? []);
    for (const key of updateKeys) {
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
    for (const [key, value] of Object.entries(updates)) {
      baseState[key] = value;
    }

    // Validate the client-edited candidate against the state schema before any
    // policy or action side effect. Both the action's `authorize` and its `run`
    // must observe the same schema-validated (and normalized) candidate, so an
    // invalid client edit is rejected here (422) before either is invoked.
    let validated: ServerComponentState;
    try {
      validated = component.stateSchema.parse(baseState);
    } catch (error) {
      if (error instanceof ZodError) {
        return await validationResult(
          sequence,
          token,
          snapshot,
          component,
          zodIssuesToFieldErrors(error.issues, baseState),
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

    // The action's return value (only a {@link ServerComponentRedirect} carries
    // meaning); `undefined` both when no action ran (`$refresh`) and when an
    // action returned `void`. Declared here so the success response below can
    // read it regardless of which branch produced the re-render.
    let actionResult: unknown;

    // At most one action per request, dispatched only by allowlisted name. The
    // built-in `$refresh` no-op is skipped here: it carries no user action, so
    // it never looks up an action, runs authorize, or invokes `run` — it only
    // applies client edits, re-validates, re-signs, and re-renders (still
    // behind the same origin/CSRF/authorization boundary).
    if (action !== undefined && action.name !== REFRESH_ACTION) {
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
        actionResult = await definition.run(workingState, argsResult.value, actionContext);
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
      // Lifecycle: `updated` runs after a successful update/action, before the
      // re-render. The action has already taken effect, so a throw here cannot
      // be a 422 rejection — it is sanitized to a value-free 500.
      const updatedResult = await runStateHook(
        component.updated,
        nextState,
        { ...hookArgs, values: {} },
        false,
      );
      if (updatedResult !== null) {
        return updatedResult;
      }
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
      // When the action signals a redirect, carry it alongside the re-signed
      // snapshot and re-rendered HTML so the client applies the render, then
      // navigates to the target URL. The URL was validated when `redirect()`
      // constructed the signal; a non-redirect action produces `undefined`.
      const redirectUrl = isRedirect(actionResult) ? actionResult.url : undefined;

      // When the action signals a download, mint a signed download reference
      // bound to the component, subject, and stored file id. The client
      // navigates to the signed GET endpoint; the browser's Content-Disposition
      // handling turns it into a file download without leaving the page.
      // downloadSigner is optional (present only when the extension built one)
      // — when absent a download() action result is silently ignored (the
      // download signer is always present when uploads are configured, since
      // the extension constructs one from the same key).
      let downloadResult: { readonly url: string; readonly filename: string } | undefined;
      if (isDownload(actionResult)) {
        const dlSigner = uploads?.downloadSigner;
        if (dlSigner !== undefined) {
          const subject = signer.subjectFor(actionContext.session?.id ?? null);
          const token = dlSigner.sign({
            downloadId: actionResult.id,
            component: component.name,
            subject,
            filename: actionResult.filename,
            contentType: actionResult.contentType,
          });
          downloadResult = {
            url: `${COMPONENT_DOWNLOAD_ENDPOINT}?ref=${encodeURIComponent(token)}`,
            filename: actionResult.filename,
          };
        }
      }
      return {
        status: 200,
        body: {
          sequence,
          snapshot: nextToken,
          html,
          ...(redirectUrl === undefined ? {} : { redirect: redirectUrl }),
          ...(downloadResult === undefined ? {} : { download: downloadResult }),
        },
      };
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

  const uploadBridge = createUploadBridge({
    isClosed: () => closed,
    uploads: uploads === undefined ? undefined : { store: uploads.store, signer: uploads.signer },
    components,
    signer,
    maxUploadBytes,
    uploadContentTypes,
    generateId: generateComponentId,
    resolveTrustedOrigin,
    safeEqualStrings,
    reconstructContext,
    authorizeAllows,
  });

  const handleDownload = async (
    _request: Request,
    context: RequestContext,
  ): Promise<ServerComponentDownloadResult> => {
    if (closed) {
      return { status: 500, body: { error: { code: 'internal_error', message: 'Server error' } } };
    }
    // A download signer is required; it is present only when downloads are
    // configured (uploads enabled). Absent means downloads are unsupported here.
    const downloadSigner = uploads?.downloadSigner;
    if (downloadSigner === undefined || uploads === undefined) {
      return { status: 400, body: { error: { code: 'bad_request', message: 'Bad request' } } };
    }
    const ref = context.url.searchParams.get('ref');
    if (ref === null || ref === '') {
      return { status: 400, body: { error: { code: 'bad_request', message: 'Bad request' } } };
    }

    let claims;
    try {
      claims = downloadSigner.verify(ref);
    } catch {
      return { status: 403, body: { error: { code: 'forbidden', message: 'Forbidden' } } };
    }

    // The token is bound to the derived subject tag at sign time; re-derive it
    // from the current session so a token minted for another subject (or a
    // session that has since changed) fails closed.
    const expectedSubject = signer.subjectFor(context.session?.id ?? null);
    if (!safeEqualStrings(claims.subject ?? '', expectedSubject ?? '')) {
      return { status: 403, body: { error: { code: 'forbidden', message: 'Forbidden' } } };
    }

    const store =
      typeof uploads.store === 'function'
        ? uploads.store(context.storagePath ?? '')
        : uploads.store;
    let fileStream;
    try {
      // `claims.subject` is the same derived tag the upload path wrote into
      // storage — never the raw session id — so the store resolves the same
      // subject directory at read time as at put time.
      const file = await store.open(claims.downloadId, claims.subject);
      if (file === null) {
        return { status: 404, body: { error: { code: 'not_found', message: 'Not found' } } };
      }
      fileStream = file;
    } catch {
      return { status: 500, body: { error: { code: 'internal_error', message: 'Server error' } } };
    }

    return {
      status: 200,
      stream: fileStream,
      contentType: claims.contentType,
      filename: claims.filename,
    };
  };

  const describe = () => {
    const described: Array<{
      name: string;
      actions: readonly string[];
      writableKeys: readonly string[];
    }> = [];
    for (const [name, component] of components) {
      described.push({
        name,
        actions: Object.keys(component.actions ?? {}),
        writableKeys: component.writableKeys ?? [],
      });
    }
    return Object.freeze({ components: Object.freeze(described) });
  };

  return Object.freeze({
    render,
    update,
    handleUpload: uploadBridge.handleUpload,
    handleDownload,
    resolveUpload: uploadBridge.resolveUpload,
    subjectFor: signer.subjectFor,
    describe,
    close() {
      closed = true;
    },
  });
}

/**
 * A download result from {@link ServerComponentsRuntime.handleDownload}
 * that may carry a readable file stream or an error body.
 */
export interface ServerComponentDownloadResult {
  readonly status: number;
  readonly stream?: Readable;
  readonly contentType?: string;
  readonly filename?: string;
  readonly body?: JsonObject;
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
