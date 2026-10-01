/**
 * Server-side file downloads for server components (server-only).
 *
 * This module mirrors the upload-reference pattern: an action returns a
 * `download(id, opts)` declaration; the runtime mints a signed, subject-scoped,
 * expiring reference; the client navigates to a GET endpoint that streams the
 * stored file back with `Content-Disposition: attachment`.
 *
 * The signer is purpose-separated from the upload/snapshot signers via a
 * distinct HMAC domain (`'jsails/download-reference'`), so a upload or snapshot
 * token can never be replayed as a download.
 *
 * The read half reuses `UploadStore.open` — no new store type.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

import { isForbiddenKey, isPlainObject } from '../internal/json-safe.js';

/** Raised for every download failure. `code` is a stable machine value; messages are value-free. */
export class DownloadError extends Error {
  readonly code: DownloadErrorCode;

  constructor(code: DownloadErrorCode, message: string) {
    super(message);
    this.name = 'DownloadError';
    this.code = code;
  }
}

/** Stable machine codes carried on a {@link DownloadError}. */
export type DownloadErrorCode = 'invalid_input' | 'invalid_reference' | 'not_found' | 'io_error';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum master-key length in bytes (256 bits), mirrored from the snapshot signer. */
const MIN_KEY_BYTES = 32;

/** HMAC signature length in bytes. */
const SIGNATURE_BYTES = 32;

/** HMAC key-derivation domain separating download references from uploads/snapshots. */
const REFERENCE_KEY_CONTEXT = 'jsails/download-reference';

/** Reference format version. */
const REFERENCE_VERSION = 1;

/** Default lifetime of a signed download reference (5 minutes). */
const DEFAULT_DOWNLOAD_REFERENCE_TTL_MS = 300_000;

/** Upper bound on a serialized reference token, in bytes (claims are tiny). */
const MAX_REFERENCE_BYTES = 4 * 1024;

/** base64url alphabet only, so a token never contains a stray separator. */
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/;

/** Safe path-segment charset: base64url and hex only, bounded length. */
const SAFE_SEGMENT_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** A filename is a non-empty string with no control chars, whitespace, or quotes. */
const SAFE_FILENAME_PATTERN = /^[^\x00-\x1f\x7f"'\s]+$/;

/** A content type is a non-empty `type/subtype` string without control characters. */
const CONTENT_TYPE_PATTERN = /^[A-Za-z0-9!#$&^_.+-]{1,127}\/[A-Za-z0-9!#$&^_.+-]{1,127}$/;

// ---------------------------------------------------------------------------
// Download declaration
// ---------------------------------------------------------------------------

/**
 * The value a server-component action returns to signal a file download.
 * A structural discriminator (`__jsailsDownload === true`) matches the pattern
 * of `isRedirect` and the other reserved-key guards in this framework.
 */
export interface ServerComponentDownload {
  readonly __jsailsDownload: true;
  /** The stored file id to stream back to the client. */
  readonly id: string;
  /** The filename presented to the client via `Content-Disposition`. */
  readonly filename: string;
  /** The content type sent in the `Content-Type` response header. */
  readonly contentType: string;
}

/**
 * Structural guard: the value is a {@link ServerComponentDownload} produced by
 * {@link download}. Read-only detection, never a spoofing boundary — the
 * runtime's input is the action's own return value (trusted producer code).
 */
export function isDownload(value: unknown): value is ServerComponentDownload {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  return (value as { __jsailsDownload?: unknown }).__jsailsDownload === true;
}

/** Options for {@link download}. */
export interface DownloadOptions {
  /** Display filename in the `Content-Disposition` header. Defaults to `id`. */
  readonly filename?: string;
  /** Media type in the `Content-Type` header. Defaults to `application/octet-stream`. */
  readonly contentType?: string;
}

function assertSafeSegment(value: string, what: string): void {
  if (!SAFE_SEGMENT_PATTERN.test(value)) {
    throw new DownloadError('invalid_input', `Invalid download ${what}`);
  }
}

function assertSafeFilename(value: string): void {
  if (typeof value !== 'string' || !SAFE_FILENAME_PATTERN.test(value)) {
    throw new DownloadError('invalid_input', 'Invalid download filename');
  }
}

function assertSafeContentType(value: string): void {
  if (typeof value !== 'string' || !CONTENT_TYPE_PATTERN.test(value)) {
    throw new DownloadError('invalid_input', 'Invalid download content type');
  }
}

/**
 * Signal a file download from a server-component action.
 *
 * `id` is the stored file identifier (the same id used with {@link UploadStore.put}).
 * `filename` is the display name sent via `Content-Disposition`; it must be a
 * non-empty string with no control characters, whitespace, or quotes (CR/LF are
 * injection vectors in header values). `contentType` must match a safe media-type
 * pattern.
 *
 * Throws a value-free {@link DownloadError} (`invalid_input`) on bad input.
 */
export function download(id: string, options: DownloadOptions = {}): ServerComponentDownload {
  assertSafeSegment(id, 'id');
  const filename = options.filename ?? id;
  assertSafeFilename(filename);
  const contentType = options.contentType ?? 'application/octet-stream';
  assertSafeContentType(contentType);
  return { __jsailsDownload: true, id, filename, contentType };
}

// ---------------------------------------------------------------------------
// Signed download references
// ---------------------------------------------------------------------------

/** Verified claims carried in a signed download reference. */
export interface DownloadReferenceClaims {
  readonly v: 1;
  readonly downloadId: string;
  readonly component: string;
  readonly subject: string | null;
  readonly expiresAt: number;
  readonly filename: string;
  readonly contentType: string;
}

/** Everything a caller supplies to `sign`; `v` and `expiresAt` are computed. */
type DownloadReferenceClaimsInput = Omit<DownloadReferenceClaims, 'v' | 'expiresAt'>;

/** A configured download-reference signer: signs and verifies reference tokens. */
export interface DownloadReferenceSigner {
  sign(claims: DownloadReferenceClaimsInput): string;
  verify(token: string): DownloadReferenceClaims;
}

/** Options for {@link createDownloadReferenceSigner}. */
interface DownloadReferenceSignerOptions {
  /** Master signing key (>= 32 bytes). Shared with the snapshot/upload signers. */
  readonly key: string | Uint8Array;
  /** Time source returning epoch milliseconds. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Reference lifetime in milliseconds. Must be a positive finite number. */
  readonly ttlMs?: number;
}

function invalidReference(): never {
  throw new DownloadError('invalid_reference', 'Invalid download reference');
}

function normalizeKey(key: string | Uint8Array): Buffer {
  if (typeof key === 'string') return Buffer.from(key, 'utf8');
  if (key instanceof Uint8Array) return Buffer.from(key);
  throw new DownloadError('invalid_input', 'Download reference key must be a string or Uint8Array');
}

function validateDownloadId(value: unknown): string {
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

function validateFilename(value: unknown): string {
  if (typeof value !== 'string' || !SAFE_FILENAME_PATTERN.test(value)) {
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

function validateExpiresAt(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    invalidReference();
  }
  return value;
}

/**
 * Create a download-reference signer over a master key. The key is required and
 * must be at least 32 bytes; `ttlMs` bounds the reference lifetime. Returns a
 * frozen handle exposing {@link DownloadReferenceSigner.sign} and `verify`.
 *
 * The HMAC domain is separated from the snapshot and upload signers via a
 * distinct context string (`'jsails/download-reference'`), so a snapshot or
 * upload token can never be replayed as a download reference without the master
 * key.
 */
export function createDownloadReferenceSigner(
  options: DownloadReferenceSignerOptions,
): DownloadReferenceSigner {
  if (options === null || typeof options !== 'object') {
    throw new TypeError('createDownloadReferenceSigner requires an options object');
  }
  const key = normalizeKey(options.key);
  if (key.byteLength < MIN_KEY_BYTES) {
    throw new DownloadError('invalid_input', 'Download reference key must be at least 32 bytes');
  }
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? DEFAULT_DOWNLOAD_REFERENCE_TTL_MS;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new DownloadError('invalid_input', 'ttlMs must be a positive finite number');
  }

  const signKey = createHmac('sha256', key).update(REFERENCE_KEY_CONTEXT).digest();
  const maxTokenLength = Math.ceil((MAX_REFERENCE_BYTES * 4) / 3) + 1 + 43;

  return Object.freeze({
    sign(claims: DownloadReferenceClaimsInput): string {
      if (!isPlainObject(claims)) {
        throw new DownloadError('invalid_input', 'Download reference claims must be an object');
      }
      const normalized = {
        v: REFERENCE_VERSION,
        downloadId: validateDownloadId(claims.downloadId),
        component: validateComponent(claims.component),
        subject: validateSubject(claims.subject),
        expiresAt: now() + ttlMs,
        filename: validateFilename(claims.filename),
        contentType: validateContentType(claims.contentType),
      };
      if (!Number.isFinite(normalized.expiresAt)) {
        throw new DownloadError(
          'invalid_input',
          'Download signer clock produced a non-finite time',
        );
      }
      const jsonBytes = Buffer.from(JSON.stringify(normalized), 'utf8');
      const signature = createHmac('sha256', signKey).update(jsonBytes).digest('base64url');
      return `${jsonBytes.toString('base64url')}.${signature}`;
    },

    verify(token: string): DownloadReferenceClaims {
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

      const claims: DownloadReferenceClaims = {
        v: REFERENCE_VERSION,
        downloadId: validateDownloadId(parsed.downloadId),
        component: validateComponent(parsed.component),
        subject: validateSubject(parsed.subject),
        expiresAt: validateExpiresAt(parsed.expiresAt),
        filename: validateFilename(parsed.filename),
        contentType: validateContentType(parsed.contentType),
      };
      if (claims.expiresAt <= now()) {
        invalidReference();
      }
      return claims;
    },
  });
}

/**
 * Narrow reader contract for the download endpoint: only `open` is needed to
 * stream a stored file back. Reuses the existing {@link import('./uploads.js').UploadStore.open}
 * signature; no new store type is required.
 */
export type DownloadReader = {
  readonly open: (
    id: string,
    subject: string | null,
  ) => Promise<import('node:stream').Readable | null>;
};

/** Exported for use by the runtime and HTTP layer. */
export const DOWNLOAD_REFERENCE_TTL_MS = DEFAULT_DOWNLOAD_REFERENCE_TTL_MS;
