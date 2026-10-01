/**
 * Shared wire-format constants for the server-component reference tokens.
 *
 * Upload references, download references, and signed snapshots all encode
 * base64url payloads and validate the same path-segment/content-type charsets.
 * The patterns live here so the three surfaces cannot drift apart.
 */

/** base64url alphabet only, so a token never contains a stray separator. */
export const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/;

/** Safe path-segment charset: base64url and hex only, bounded length. */
export const SAFE_SEGMENT_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** A content type is a non-empty `type/subtype` string without control characters. */
export const CONTENT_TYPE_PATTERN = /^[A-Za-z0-9!#$&^_.+-]{1,127}\/[A-Za-z0-9!#$&^_.+-]{1,127}$/;

/** Minimum signing-key length in bytes (the HMAC-SHA256 key floor). */
export const MIN_KEY_BYTES = 32;

/** HMAC-SHA256 signature length in bytes. */
export const SIGNATURE_BYTES = 32;
