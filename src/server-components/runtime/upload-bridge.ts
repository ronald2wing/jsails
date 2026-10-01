/**
 * Upload transport glue for the server-component runtime.
 *
 * `createUploadBridge` wires the runtime's `handleUpload` and `resolveUpload`
 * operations over the shared runtime state (the component map, snapshot signer,
 * and the origin/CSRF/authorization helpers). The bridge is inert: it opens no
 * connection and reads nothing until one of the two operations is invoked, and
 * both fail closed (value-free) when no upload transport was configured.
 *
 * The upload boundary mirrors the update boundary exactly: the snapshot is
 * verified (HMAC, expiry, subject, origin) before anything is stored, the same
 * origin/CSRF checks gate the request, and a component callback never runs on
 * an unverified reference.
 */

import type { Readable } from 'node:stream';

import type { RequestContext } from '../../contracts/http.js';
import { isSameOriginRequest } from '../../internal/trusted-mutation.js';
import type { ServerComponentDefinition } from '../component.js';
import { COMPONENT_CSRF_HEADER } from '../protocol.js';
import { SnapshotError } from '../snapshot.js';
import type { ComponentSigner, SnapshotPayload } from '../snapshot.js';
import { UploadError, readUploadBody } from '../uploads.js';
import type {
  UploadRequestBody,
  UploadReferenceClaims,
  UploadReferenceSigner,
  UploadStore,
} from '../uploads.js';
import {
  ServerComponentRuntimeError,
  uploadErrorFromStoreError,
  uploadErrorResult,
  type ServerComponentUploadResult,
} from './value-errors.js';

/** Options controlling a single `handleUpload`. */
export interface ServerComponentUploadOptions {
  /**
   * Trusted origin the request `Origin` header and snapshot scope must match.
   * Defaults to `context.url.origin`.
   */
  readonly origin?: string;
}

/** Options controlling a single `resolveUpload`. */
export interface ResolveUploadOptions {
  /** Component the reference must have been minted for. */
  readonly expectedComponent: string;
  /** Subject tag the reference must match (`undefined` skips the check). */
  readonly expectedSubject?: string | null;
  /** Storage path used to resolve a lazy store factory. */
  readonly storagePath?: string;
}

/** A verified, opened-for-use upload reference. */
export interface ResolvedUpload {
  readonly id: string;
  readonly component: string;
  readonly subject: string | null;
  readonly size: number;
  readonly contentType: string;
  /** Open a read stream over the stored upload, or `null` when absent. */
  open(): Promise<Readable | null>;
  /** Delete the stored upload; absent is a no-op. */
  delete(): Promise<void>;
}

/** The configured upload transport: a store (or factory) plus a reference signer. */
interface UploadsConfig {
  readonly store: UploadStore | ((storagePath: string) => UploadStore);
  readonly signer: UploadReferenceSigner;
}

/**
 * Shared runtime state the bridge reads. The bridge never mutates any of it;
 * the `closed` guard is owned by the runtime and exposed through `isClosed`.
 */
interface UploadBridgeDeps {
  readonly isClosed: () => boolean;
  readonly uploads: UploadsConfig | undefined;
  readonly components: ReadonlyMap<string, ServerComponentDefinition<any>>;
  readonly signer: ComponentSigner;
  readonly maxUploadBytes: number;
  readonly uploadContentTypes: ReadonlySet<string>;
  readonly generateId: () => string;
  readonly resolveTrustedOrigin: (origin: string | undefined, context: RequestContext) => string;
  readonly safeEqualStrings: (a: string, b: string) => boolean;
  readonly reconstructContext: (
    context: RequestContext,
    snapshot: SnapshotPayload,
    origin: string,
  ) => RequestContext;
  readonly authorizeAllows: (
    authorize: (context: RequestContext) => boolean | Promise<boolean>,
    context: RequestContext,
  ) => Promise<boolean>;
}

/** The upload half of the assembled runtime handle. */
interface UploadBridge {
  handleUpload(
    request: Request,
    context: RequestContext,
    options?: ServerComponentUploadOptions,
  ): Promise<ServerComponentUploadResult>;
  resolveUpload(reference: unknown, options: ResolveUploadOptions): ResolvedUpload;
}

/**
 * Slack added to the upload `Content-Length` pre-check to account for multipart
 * framing, boundaries, headers, and the snapshot field. The store still enforces
 * the exact byte cap during streaming; this only rejects obviously-oversize
 * bodies before the multipart parser buffers them.
 */
const UPLOAD_OVERHEAD_SLACK_BYTES = 64 * 1024;

export function createUploadBridge(deps: UploadBridgeDeps): UploadBridge {
  function resolveStore(storagePath: string | undefined): UploadStore {
    if (deps.uploads === undefined) {
      throw new ServerComponentRuntimeError('uploads are not configured');
    }
    if (typeof deps.uploads.store === 'function') {
      if (typeof storagePath !== 'string' || storagePath === '') {
        throw new ServerComponentRuntimeError('upload storage path is unavailable');
      }
      return deps.uploads.store(storagePath);
    }
    return deps.uploads.store;
  }

  async function handleUpload(
    request: Request,
    context: RequestContext,
    options: ServerComponentUploadOptions = {},
  ): Promise<ServerComponentUploadResult> {
    if (deps.isClosed()) {
      throw new ServerComponentRuntimeError('server components runtime is closed');
    }
    if (deps.uploads === undefined) {
      return uploadErrorResult('storage_unavailable', 'Uploads are not configured');
    }

    let trustedOrigin: string;
    try {
      trustedOrigin = deps.resolveTrustedOrigin(options.origin, context);
    } catch {
      return uploadErrorResult('internal_error', 'Internal Server Error');
    }
    if (!isSameOriginRequest(request, trustedOrigin)) {
      return uploadErrorResult('origin_mismatch', 'Cross-origin request rejected');
    }

    // Reject obviously-oversize bodies before the multipart parser buffers them;
    // the store still enforces the exact cap while streaming.
    const contentLength = request.headers.get('content-length');
    if (contentLength !== null) {
      const parsedLength = Number(contentLength);
      if (
        Number.isFinite(parsedLength) &&
        parsedLength > deps.maxUploadBytes + UPLOAD_OVERHEAD_SLACK_BYTES
      ) {
        return uploadErrorResult('oversize', 'Upload exceeds the maximum size');
      }
    }

    let body: UploadRequestBody;
    try {
      body = await readUploadBody(request);
    } catch (error) {
      if (error instanceof UploadError) {
        return uploadErrorFromStoreError(error);
      }
      return uploadErrorResult('internal_error', 'Internal Server Error');
    }
    if (body.file === undefined) {
      return uploadErrorResult('invalid_request', 'Upload is missing a file');
    }

    // Verify the snapshot (HMAC, expiry, subject, origin) before anything is
    // stored or any component callback runs.
    let snapshot: SnapshotPayload;
    try {
      const subject = deps.signer.subjectFor(context.session?.id ?? null);
      snapshot = deps.signer.verify(body.snapshot, { subject, origin: trustedOrigin });
    } catch (error) {
      if (error instanceof SnapshotError) {
        return uploadErrorResult('invalid_snapshot', 'Invalid component snapshot');
      }
      return uploadErrorResult('internal_error', 'Internal Server Error');
    }

    const component = deps.components.get(snapshot.component);
    if (component === undefined) {
      return uploadErrorResult('unknown_component', 'Unknown component');
    }

    // CSRF token is required in all cases; identical to the update boundary.
    const expectedCsrf = context.session?.csrfToken ?? snapshot.id;
    const csrfHeader = request.headers.get(COMPONENT_CSRF_HEADER);
    if (typeof csrfHeader !== 'string' || !deps.safeEqualStrings(expectedCsrf, csrfHeader)) {
      return uploadErrorResult('csrf_mismatch', 'CSRF token missing or mismatch');
    }

    const actionContext = deps.reconstructContext(context, snapshot, trustedOrigin);
    if (!(await deps.authorizeAllows(component.authorize, actionContext))) {
      return uploadErrorResult('forbidden', 'Forbidden');
    }

    const contentType = body.file.contentType.toLowerCase();
    if (!deps.uploadContentTypes.has(contentType)) {
      return uploadErrorResult('unsupported_content_type', 'Unsupported content type');
    }

    let store: UploadStore;
    try {
      store = resolveStore(context.storagePath);
    } catch {
      return uploadErrorResult('storage_unavailable', 'Upload storage is unavailable');
    }

    const id = deps.generateId();
    let size: number;
    try {
      ({ size } = await store.put({
        id,
        subject: snapshot.subject,
        contentType,
        stream: body.file.stream,
      }));
    } catch (error) {
      if (error instanceof UploadError) {
        return uploadErrorFromStoreError(error);
      }
      return uploadErrorResult('internal_error', 'Internal Server Error');
    }

    try {
      const reference = deps.uploads.signer.sign({
        uploadId: id,
        component: snapshot.component,
        subject: snapshot.subject,
        size,
        contentType,
      });
      return { status: 201, body: { reference } };
    } catch {
      return uploadErrorResult('internal_error', 'Internal Server Error');
    }
  }

  function resolveUpload(reference: unknown, options: ResolveUploadOptions): ResolvedUpload {
    if (deps.isClosed()) {
      throw new ServerComponentRuntimeError('server components runtime is closed');
    }
    if (deps.uploads === undefined) {
      throw new ServerComponentRuntimeError('uploads are not configured');
    }
    if (typeof reference !== 'string') {
      throw new UploadError('invalid_reference', 'Invalid upload reference');
    }
    let claims: UploadReferenceClaims;
    try {
      claims = deps.uploads.signer.verify(reference);
    } catch (error) {
      if (error instanceof UploadError) throw error;
      throw new UploadError('invalid_reference', 'Invalid upload reference');
    }
    if (claims.component !== options.expectedComponent) {
      throw new UploadError(
        'invalid_reference',
        'Upload reference does not match the expected component',
      );
    }
    if (options.expectedSubject !== undefined && options.expectedSubject !== claims.subject) {
      throw new UploadError(
        'invalid_reference',
        'Upload reference does not match the expected subject',
      );
    }
    const store = resolveStore(options.storagePath);
    return {
      id: claims.uploadId,
      component: claims.component,
      subject: claims.subject,
      size: claims.size,
      contentType: claims.contentType,
      open: () => store.open(claims.uploadId, claims.subject),
      delete: () => store.delete(claims.uploadId, claims.subject),
    };
  }

  return { handleUpload, resolveUpload };
}
