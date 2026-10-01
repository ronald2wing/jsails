/**
 * Signed URL generation and verification (`jsails/routing`).
 *
 * `new HmacUrlSigner({ key })` creates a signer with `sign(path, params?,
 * expiresInMs?)` and `verify(url)`. Signing produces an HMAC-SHA256 token
 * over a domain-separated, normalized payload; `verify` returns the
 * original path on a valid, unexpired signature, or `null` on tampering
 * or expiry.
 *
 * The key is never echoed in error messages. Signatures are
 * integrity-protected, **not encrypted** — the payload is recoverable.
 */

import { createHmac } from 'node:crypto';

import { safeEqualStrings } from '../internal/crypto.js';

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

/** A value-free signed-URL error. Never echoes the key, path, or signature. */
export class SignedUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SignedUrlError';
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for {@link HmacUrlSigner}. */
export interface UrlSignerOptions {
  /**
   * Symmetric signing key. Must be at least 32 bytes. This is a secret,
   * never echoed in errors or embedded in produced URLs.
   */
  readonly key: string;
  /**
   * Injectible clock for tests. Defaults to `Date.now()`.
   */
  readonly now?: () => number;
}

/** A URL signer returned by {@link HmacUrlSigner}. */
export interface UrlSigner {
  /**
   * Sign a path, returning a full URL with a `?signature=<token>` query
   * parameter appended. The token is an HMAC-SHA256 over the normalized
   * payload (path + serialized params + expiry).
   *
   * @param path - The path to sign (e.g. `/reset/1`).
   * @param params - Optional query parameters to include in the signature and
   *   the URL. Values are serialized as strings.
   * @param expiresInMs - Signature lifetime in milliseconds. Defaults to
   *   `900_000` (15 minutes). When `0` the signature never expires.
   */
  sign(
    path: string,
    params?: Record<string, string | number | boolean>,
    expiresInMs?: number,
  ): string;

  /**
   * Verify a signed URL. Returns the path portion of the URL when the
   * signature is valid and unexpired; returns `null` on tampering or
   * expiry. The returned path is stripped of the signature and any
   * caller-supplied query parameters.
   *
   * @param url - The full signed URL to verify.
   */
  verify(url: string): string | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Domain-separation prefix prepended to the HMAC payload. */
const DOMAIN_PREFIX = 'jsails-signed-url:v1';

/** Default signature lifetime: 15 minutes. */
const DEFAULT_EXPIRY_MS = 900_000;

/** Minimum key length in bytes. */
const MIN_KEY_LENGTH = 32;

// ---------------------------------------------------------------------------
// HmacUrlSigner
// ---------------------------------------------------------------------------

/**
 * HMAC-SHA256 URL signer for generating and verifying signed URLs.
 *
 * ```ts
 * const signer = new HmacUrlSigner({ key: '...' });
 * const url = signer.sign('/reset/1', { token: 'abc' });
 * const path = signer.verify(url); // '/reset/1' or null
 * ```
 */
export class HmacUrlSigner implements UrlSigner {
  #key: Buffer;
  #clock: () => number;

  constructor(options: UrlSignerOptions) {
    if (typeof options.key !== 'string' || options.key.length < MIN_KEY_LENGTH) {
      throw new SignedUrlError('Signing key must be a string of at least 32 bytes.');
    }
    this.#key = Buffer.from(options.key, 'utf-8');
    this.#clock = options.now ?? (() => Date.now());
  }

  /**
   * Build the HMAC payload: `<prefix>\n<path>\n<serialized params>\n<expiry>`.
   * The expiry is an epoch-ms string (`0` means no expiry).
   */
  #buildPayload(
    path: string,
    params: Record<string, string> | undefined,
    expiryMs: number,
  ): string {
    const serializedParams = serializeParams(params);
    return [DOMAIN_PREFIX, path, serializedParams, String(expiryMs)].join('\n');
  }

  sign(
    path: string,
    params?: Record<string, string | number | boolean>,
    expiresInMs: number = DEFAULT_EXPIRY_MS,
  ): string {
    const expiryMs = expiresInMs === 0 ? 0 : this.#clock() + expiresInMs;

    // Coerce param values to strings.
    const stringParams: Record<string, string> | undefined = params
      ? Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)]))
      : undefined;

    const payload = this.#buildPayload(path, stringParams, expiryMs);
    const signature = createHmac('sha256', this.#key).update(payload).digest('base64url');

    const parts: string[] = [path];
    if (stringParams) {
      parts.push(serializeParamsToQuery(stringParams));
    }

    const queryParts: string[] = parts.length > 1 ? [parts.slice(1).join('&')] : [];

    // Append signature and expiry to the query string.
    queryParts.push(`signature=${signature}`);
    queryParts.push(`expires=${String(expiryMs)}`);

    return parts[0] + '?' + queryParts.join('&');
  }

  verify(url: string): string | null {
    if (typeof url !== 'string' || url.length === 0) {
      return null;
    }

    const queryIndex = url.indexOf('?');
    if (queryIndex === -1) {
      return null;
    }

    const path = url.slice(0, queryIndex);
    const queryString = url.slice(queryIndex + 1);

    const params = parseQueryParams(queryString);

    const signature = params.signature;
    if (typeof signature !== 'string' || signature.length === 0) {
      return null;
    }

    const expiresStr = params.expires;
    if (expiresStr === undefined) {
      return null;
    }
    const expiresMs = Number(expiresStr);
    if (!Number.isSafeInteger(expiresMs) || expiresMs < 0) {
      return null;
    }

    // Collect caller-supplied params (everything except signature/expires).
    const callerParams: Record<string, string> = {};
    for (const k of Object.keys(params)) {
      if (k !== 'signature' && k !== 'expires') {
        callerParams[k] = params[k]!;
      }
    }
    const callerParamsObj = Object.keys(callerParams).length > 0 ? callerParams : undefined;

    // Check expiry.
    if (expiresMs !== 0 && this.#clock() > expiresMs) {
      return null;
    }

    // Rebuild the payload and verify the signature.
    const expectedPayload = this.#buildPayload(path, callerParamsObj, expiresMs);
    const expectedSignature = createHmac('sha256', this.#key)
      .update(expectedPayload)
      .digest('base64url');

    // Both sides are base64url strings; `safeEqualStrings` compares them
    // constant-time and hashes unequal lengths instead of short-circuiting.
    if (!safeEqualStrings(expectedSignature, signature)) {
      return null;
    }

    return path;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Serialize a params object into a deterministic query-string fragment.
 * Keys are sorted for deterministic output.
 */
function serializeParams(params: Record<string, string> | undefined): string {
  if (!params || Object.keys(params).length === 0) {
    return '';
  }
  const sorted = Object.keys(params).sort();
  return sorted.map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k]!)}`).join('&');
}

/** Serialize params into a query string (no leading `?`). */
function serializeParamsToQuery(params: Record<string, string>): string {
  return serializeParams(params);
}

/** Parse a query string into a plain object (no array support). */
function parseQueryParams(query: string): Record<string, string> {
  if (query.length === 0) {
    return {};
  }
  const result: Record<string, string> = {};
  for (const part of query.split('&')) {
    const eq = part.indexOf('=');
    if (eq === -1) {
      result[decodeURIComponent(part)] = '';
    } else {
      result[decodeURIComponent(part.slice(0, eq))] = decodeURIComponent(part.slice(eq + 1));
    }
  }
  return result;
}
