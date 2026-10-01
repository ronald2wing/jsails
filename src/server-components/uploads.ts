/**
 * Server-side uploads for stateful server components (server-only).
 *
 * This module is the storage-and-reference half of the Livewire-style file
 * upload gap. It provides three pieces, all server-only (it imports
 * `node:crypto`, `node:fs`, and `node:stream`):
 *
 * - {@link UploadStore} + {@link createDiskUploadStore}: a subject-scoped,
 *   disk-backed store. Files are laid out under
 *   `<rootDir>/<sha256(subject)>/<id>` and written atomically (temp file then
 *   rename). Every write is streamed through a size limiter, and every path
 *   segment is validated, so a hostile id/subject can never traverse the
 *   filesystem or force unbounded disk use.
 * - {@link UploadReferenceSigner} + {@link createUploadReferenceSigner}: a
 *   signed reference token (`base64url(json).sig`) binding an upload id to its
 *   component, subject tag, expiry, measured size, and content type. It is
 *   integrity protection, not encryption; the same master key as the snapshot
 *   signer is reused with a distinct HMAC domain, so a reference can never be
 *   forged from a snapshot signature (or vice versa).
 * - {@link uploadRefSchema}: the Zod shape an upload reference occupies in a
 *   component's `stateSchema` (`{ __upload: string }`), plus
 *   {@link readUploadBody} to parse the `multipart/form-data` upload body into
 *   a snapshot string and an optional file stream.
 *
 * Nothing here trusts client-claimed metadata: the size in a reference is the
 * number of bytes actually written to disk, the content type is validated
 * against an allowlist, and the subject tag is derived from the verified
 * snapshot (never the client). Errors are value-free and never echo a path,
 * key, id, or underlying filesystem cause.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { z } from 'zod';

import { isErrno } from '../internal/errors.js';
import { isForbiddenKey, isPlainObject } from '../internal/json-safe.js';
import {
  COMPONENT_UPLOAD_FILE_FIELD,
  COMPONENT_UPLOAD_SNAPSHOT_FIELD,
  UPLOAD_REFERENCE_KEY,
  type UploadReference,
} from './protocol.js';

/** Raised for every upload failure. `code` is a stable machine value; messages are value-free. */
export class UploadError extends Error {
  readonly code: UploadErrorCode;

  constructor(code: UploadErrorCode, message: string) {
    super(message);
    this.name = 'UploadError';
    this.code = code;
  }
}

/** Stable machine codes carried on an {@link UploadError}. */
export type UploadErrorCode =
  | 'invalid_reference'
  | 'oversize'
  | 'unsupported_content_type'
  | 'not_found'
  | 'invalid_input'
  | 'io_error'
  | 'storage_unavailable';

/** Default per-upload byte cap (10 MiB). */
export const DEFAULT_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

/** Default content-type allowlist: raster images plus PDF (SVG is deliberately excluded). */
export const DEFAULT_UPLOAD_CONTENT_TYPES: readonly string[] = Object.freeze([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'application/pdf',
]);

/** Default lifetime of a signed upload reference. */
const DEFAULT_UPLOAD_REFERENCE_TTL_MS = 60 * 60 * 1000; // 1 hour

/** Upper bound on a serialized reference token, in bytes (claims are tiny). */
const MAX_REFERENCE_BYTES = 8 * 1024;

/** Upper bound on the snapshot field read from an upload body. */
const MAX_UPLOAD_SNAPSHOT_BYTES = 64 * 1024;

/** Upper bound on a reference token string length accepted by {@link uploadRefSchema}. */
const MAX_UPLOAD_REFERENCE_LENGTH = 4096;

/** Minimum master-key length in bytes (256 bits), mirrored from the snapshot signer. */
const MIN_KEY_BYTES = 32;

/** HMAC signature length in bytes. */
const SIGNATURE_BYTES = 32;

/** HMAC key-derivation domain separating upload references from snapshots. */
const REFERENCE_KEY_CONTEXT = 'jsails.upload.reference.v1';

/** Reference format version. */
const REFERENCE_VERSION = 1;

/** Safe path-segment charset: base64url and hex only, bounded length. */
const SAFE_SEGMENT_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** base64url alphabet only, so a token never contains a stray separator. */
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/;

/** A content type is a non-empty `type/subtype` string without control characters. */
const CONTENT_TYPE_PATTERN = /^[A-Za-z0-9!#$&^_.+-]{1,127}\/[A-Za-z0-9!#$&^_.+-]{1,127}$/;

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/** Input to {@link UploadStore.put}. */
interface UploadStorePutInput {
  readonly id: string;
  readonly subject: string | null;
  readonly contentType: string;
  readonly stream: Readable;
}

/**
 * A subject-scoped upload store. Opaque ids are server-generated; every method
 * is scoped by the derived subject tag so one subject can never read another's
 * uploads. Implementations own their persistence and path safety.
 */
export interface UploadStore {
  /** Stream an upload to storage, returning its measured size. */
  put(input: UploadStorePutInput): Promise<{ size: number }>;
  /** Open a read stream over a stored upload, or `null` when absent. */
  open(id: string, subject: string | null): Promise<Readable | null>;
  /** Delete a stored upload. Absent is a no-op. */
  delete(id: string, subject: string | null): Promise<void>;
}

/** Options for {@link createDiskUploadStore}. */
interface DiskUploadStoreOptions {
  /** Absolute directory under which uploads are stored. Created lazily. */
  readonly rootDir: string;
  /** Hard byte cap enforced during streaming. Defaults to {@link DEFAULT_UPLOAD_MAX_BYTES}. */
  readonly maxBytes?: number;
  /** Content-type allowlist. Defaults to {@link DEFAULT_UPLOAD_CONTENT_TYPES}. */
  readonly contentTypes?: readonly string[];
}

function assertSafeSegment(value: string, what: string): void {
  if (!SAFE_SEGMENT_PATTERN.test(value)) {
    throw new UploadError('invalid_input', `Invalid upload ${what}`);
  }
}

function subjectDirFor(subject: string | null): string {
  if (subject === null) return 'anonymous';
  assertSafeSegment(subject, 'subject');
  return createHash('sha256').update(subject).digest('hex');
}

/**
 * Create a disk-backed upload store. `rootDir` holds one directory per subject
 * (named by `sha256(subject)`); each upload is written to a sibling temp file
 * then renamed into place atomically, so a failed or aborted write never leaves
 * a partial file visible. The byte cap is enforced during streaming, and every
 * id/subject is validated against a safe charset before it touches a path.
 */
export function createDiskUploadStore(options: DiskUploadStoreOptions): UploadStore {
  if (options === null || typeof options !== 'object') {
    throw new TypeError('createDiskUploadStore requires an options object');
  }
  const rootDir = options.rootDir;
  if (typeof rootDir !== 'string' || rootDir === '') {
    throw new TypeError('rootDir must be a non-empty string');
  }
  const maxBytes = options.maxBytes ?? DEFAULT_UPLOAD_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError('maxBytes must be a positive integer');
  }
  const contentTypes = normalizeContentTypes(options.contentTypes ?? DEFAULT_UPLOAD_CONTENT_TYPES);

  const assertContentType = (contentType: string): void => {
    if (typeof contentType !== 'string' || !CONTENT_TYPE_PATTERN.test(contentType)) {
      throw new UploadError('unsupported_content_type', 'Unsupported content type');
    }
    if (!contentTypes.has(contentType.toLowerCase())) {
      throw new UploadError('unsupported_content_type', 'Unsupported content type');
    }
  };

  return Object.freeze({
    async put(input: UploadStorePutInput): Promise<{ size: number }> {
      assertSafeSegment(input.id, 'id');
      const subjectDir = subjectDirFor(input.subject);
      assertContentType(input.contentType);

      const dir = join(rootDir, subjectDir);
      await mkdir(dir, { recursive: true });
      const target = join(dir, input.id);
      const temp = join(dir, `.${input.id}.${randomBytes(8).toString('hex')}.tmp`);

      let bytes = 0;
      const limiter = new Transform({
        transform(chunk: Buffer, _encoding, callback): void {
          bytes += chunk.length;
          if (bytes > maxBytes) {
            callback(new UploadError('oversize', 'Upload exceeds the maximum size'));
            return;
          }
          callback(null, chunk);
        },
      });

      try {
        await pipeline(input.stream, limiter, createWriteStream(temp, { flags: 'wx' }));
        await rename(temp, target);
        return { size: bytes };
      } catch (error) {
        await unlink(temp).catch(() => undefined);
        if (error instanceof UploadError) throw error;
        throw new UploadError('io_error', 'Failed to store the upload');
      }
    },

    async open(id: string, subject: string | null): Promise<Readable | null> {
      assertSafeSegment(id, 'id');
      const file = join(rootDir, subjectDirFor(subject), id);
      // `createReadStream` emits ENOENT asynchronously, so stat first to resolve
      // absence synchronously; any other stat error is a value-free io_error.
      try {
        await stat(file);
      } catch (error) {
        if (isErrno(error, 'ENOENT')) return null;
        throw new UploadError('io_error', 'Failed to open the upload');
      }
      return createReadStream(file);
    },

    async delete(id: string, subject: string | null): Promise<void> {
      assertSafeSegment(id, 'id');
      const file = join(rootDir, subjectDirFor(subject), id);
      try {
        await unlink(file);
      } catch (error) {
        if (isErrno(error, 'ENOENT')) return;
        throw new UploadError('io_error', 'Failed to delete the upload');
      }
    },
  });
}

/** Normalize an allowlist to a set of lowercase media types, rejecting empties. */
function normalizeContentTypes(contentTypes: readonly string[]): Set<string> {
  if (!Array.isArray(contentTypes) || contentTypes.length === 0) {
    throw new TypeError('contentTypes must be a non-empty array of media types');
  }
  const normalized = new Set<string>();
  for (const contentType of contentTypes) {
    if (typeof contentType !== 'string' || !CONTENT_TYPE_PATTERN.test(contentType)) {
      throw new TypeError('contentTypes entries must be valid media types');
    }
    normalized.add(contentType.toLowerCase());
  }
  return normalized;
}

// ---------------------------------------------------------------------------
// Signed upload references
// ---------------------------------------------------------------------------

/** Verified claims carried in a signed upload reference. */
export interface UploadReferenceClaims {
  readonly v: 1;
  readonly uploadId: string;
  readonly component: string;
  readonly subject: string | null;
  readonly expiresAt: number;
  readonly size: number;
  readonly contentType: string;
}

/** Everything a caller supplies to `sign`; `v` and `expiresAt` are computed. */
type UploadReferenceClaimsInput = Omit<UploadReferenceClaims, 'v' | 'expiresAt'>;

/** A configured upload-reference signer: signs and verifies reference tokens. */
export interface UploadReferenceSigner {
  sign(claims: UploadReferenceClaimsInput): string;
  verify(token: string): UploadReferenceClaims;
}

/** Options for {@link createUploadReferenceSigner}. */
interface UploadReferenceSignerOptions {
  /** Master signing key (>= 32 bytes). Shared with the snapshot signer. */
  readonly key: string | Uint8Array;
  /** Time source returning epoch milliseconds. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Reference lifetime in milliseconds. Must be a positive finite number. */
  readonly ttlMs?: number;
}

function invalidReference(): never {
  throw new UploadError('invalid_reference', 'Invalid upload reference');
}

function normalizeKey(key: string | Uint8Array): Buffer {
  if (typeof key === 'string') return Buffer.from(key, 'utf8');
  if (key instanceof Uint8Array) return Buffer.from(key);
  throw new UploadError('invalid_input', 'Upload reference key must be a string or Uint8Array');
}

function validateUploadId(value: unknown): string {
  if (typeof value !== 'string' || !SAFE_SEGMENT_PATTERN.test(value)) {
    invalidReference();
  }
  return value;
}

function validateComponent(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 255) {
    invalidReference();
  }
  return value;
}

function validateSubject(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !SAFE_SEGMENT_PATTERN.test(value)) {
    invalidReference();
  }
  return value;
}

function validateSize(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    invalidReference();
  }
  return value;
}

function validateContentType(value: unknown): string {
  if (typeof value !== 'string' || !CONTENT_TYPE_PATTERN.test(value)) {
    invalidReference();
  }
  return value;
}

/**
 * Create an upload-reference signer over a master key. The key is required and
 * must be at least 32 bytes; `ttlMs` bounds the reference lifetime. Returns a
 * frozen handle exposing {@link UploadReferenceSigner.sign} and `verify`. The
 * HMAC domain is separated from the snapshot signer's, so a reference can never
 * be forged from a snapshot signature (or vice versa) without the master key.
 */
export function createUploadReferenceSigner(
  options: UploadReferenceSignerOptions,
): UploadReferenceSigner {
  if (options === null || typeof options !== 'object') {
    throw new TypeError('createUploadReferenceSigner requires an options object');
  }
  const key = normalizeKey(options.key);
  if (key.byteLength < MIN_KEY_BYTES) {
    throw new UploadError('invalid_input', 'Upload reference key must be at least 32 bytes');
  }
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? DEFAULT_UPLOAD_REFERENCE_TTL_MS;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new UploadError('invalid_input', 'ttlMs must be a positive finite number');
  }

  const signKey = createHmac('sha256', key).update(REFERENCE_KEY_CONTEXT).digest();
  const maxTokenLength = Math.ceil((MAX_REFERENCE_BYTES * 4) / 3) + 1 + 43;

  return Object.freeze({
    sign(claims: UploadReferenceClaimsInput): string {
      if (!isPlainObject(claims)) {
        throw new UploadError('invalid_input', 'Upload reference claims must be an object');
      }
      const normalized = {
        v: REFERENCE_VERSION,
        uploadId: validateUploadId(claims.uploadId),
        component: validateComponent(claims.component),
        subject: validateSubject(claims.subject),
        expiresAt: now() + ttlMs,
        size: validateSize(claims.size),
        contentType: validateContentType(claims.contentType),
      };
      if (!Number.isFinite(normalized.expiresAt)) {
        throw new UploadError('invalid_input', 'Upload signer clock produced a non-finite time');
      }
      const jsonBytes = Buffer.from(JSON.stringify(normalized), 'utf8');
      const signature = createHmac('sha256', signKey).update(jsonBytes).digest('base64url');
      return `${jsonBytes.toString('base64url')}.${signature}`;
    },

    verify(token: string): UploadReferenceClaims {
      if (typeof token !== 'string' || token.length > maxTokenLength) {
        invalidReference();
      }
      const dot = token.indexOf('.');
      if (dot <= 0 || dot === token.length - 1 || token.indexOf('.', dot + 1) !== -1) {
        invalidReference();
      }
      const payloadPart = token.slice(0, dot);
      const signaturePart = token.slice(dot + 1);
      if (!BASE64URL_PATTERN.test(payloadPart) || !BASE64URL_PATTERN.test(signaturePart)) {
        invalidReference();
      }
      if (payloadPart.length % 4 === 1 || signaturePart.length % 4 === 1) {
        invalidReference();
      }

      const payloadBytes = Buffer.from(payloadPart, 'base64url');
      const signatureBytes = Buffer.from(signaturePart, 'base64url');
      if (
        payloadBytes.byteLength > MAX_REFERENCE_BYTES ||
        signatureBytes.byteLength !== SIGNATURE_BYTES
      ) {
        invalidReference();
      }

      // MAC first: the payload is untrusted until the signature matches.
      const expected = createHmac('sha256', signKey).update(payloadBytes).digest();
      // Raw 32-byte HMAC digests (arbitrary bytes), not text: `safeEqualStrings`
      // is utf8-only and would be lossy, so compare the fixed-length buffers directly.
      if (!timingSafeEqual(expected, signatureBytes)) {
        invalidReference();
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(payloadBytes.toString('utf8'));
      } catch {
        invalidReference();
      }
      if (!isPlainObject(parsed) || parsed.v !== REFERENCE_VERSION) {
        invalidReference();
      }
      for (const key of Object.keys(parsed)) {
        if (isForbiddenKey(key)) invalidReference();
      }

      const claims: UploadReferenceClaims = {
        v: REFERENCE_VERSION,
        uploadId: validateUploadId(parsed.uploadId),
        component: validateComponent(parsed.component),
        subject: validateSubject(parsed.subject),
        expiresAt: validateExpiresAt(parsed.expiresAt),
        size: validateSize(parsed.size),
        contentType: validateContentType(parsed.contentType),
      };
      if (claims.expiresAt <= now()) {
        invalidReference();
      }
      return claims;
    },
  });
}

function validateExpiresAt(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    invalidReference();
  }
  return value;
}

// ---------------------------------------------------------------------------
// Reference schema (the state shape an upload field occupies)
// ---------------------------------------------------------------------------

/**
 * The Zod schema an upload reference occupies in a component `stateSchema`:
 * `{ __upload: string }`, `.strict()`. Use it on a field that holds a signed
 * upload reference (e.g. `avatar: uploadRefSchema()`); the runtime never parses
 * this schema itself — it is the author's declaration of the state shape.
 */
export function uploadRefSchema(): z.ZodType<UploadReference> {
  return z
    .object({ [UPLOAD_REFERENCE_KEY]: z.string().min(1).max(MAX_UPLOAD_REFERENCE_LENGTH) })
    .strict();
}

// ---------------------------------------------------------------------------
// Upload request body parsing
// ---------------------------------------------------------------------------

/** A parsed file part from an upload body. */
interface UploadFilePart {
  readonly contentType: string;
  readonly filename: string;
  readonly stream: Readable;
}

/** The parsed upload body: a snapshot string plus an optional file stream. */
export interface UploadRequestBody {
  readonly snapshot: string;
  readonly file: UploadFilePart | undefined;
}

function isFileLike(
  value: unknown,
): value is { type: string; name: string; stream(): ReadableStream } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { stream?: unknown }).stream === 'function'
  );
}

/**
 * Parse a `multipart/form-data` upload body into a snapshot string and an
 * optional file stream. Uses the platform `Request.formData()` parser (the same
 * one the auth/admin seams rely on) and converts the file part to a Node
 * {@link Readable} for the store; the byte bound is enforced by the store, with
 * a `Content-Length` pre-check in the runtime before this is ever called. Any
 * malformed body, missing snapshot, or non-file `file` field raises a value-free
 * {@link UploadError}.
 */
export async function readUploadBody(request: Request): Promise<UploadRequestBody> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
    throw new UploadError('invalid_input', 'Upload must be multipart/form-data');
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw new UploadError('invalid_input', 'Upload body could not be parsed');
  }

  const snapshotValue = form.get(COMPONENT_UPLOAD_SNAPSHOT_FIELD);
  if (typeof snapshotValue !== 'string' || snapshotValue === '') {
    throw new UploadError('invalid_input', 'Upload is missing a snapshot');
  }
  if (snapshotValue.length > MAX_UPLOAD_SNAPSHOT_BYTES) {
    throw new UploadError('invalid_input', 'Upload snapshot is too large');
  }

  let file: UploadFilePart | undefined;
  const fileValue = form.get(COMPONENT_UPLOAD_FILE_FIELD);
  if (fileValue !== null && fileValue !== undefined) {
    if (!isFileLike(fileValue)) {
      throw new UploadError('invalid_input', 'Upload file field is invalid');
    }
    file = {
      contentType:
        typeof fileValue.type === 'string' && fileValue.type !== ''
          ? fileValue.type
          : 'application/octet-stream',
      filename:
        typeof fileValue.name === 'string' && fileValue.name !== '' ? fileValue.name : 'upload',
      stream: Readable.fromWeb(
        fileValue.stream() as unknown as import('node:stream/web').ReadableStream,
      ),
    };
  }

  return { snapshot: snapshotValue, file };
}
