import { fromByteArray, toByteArray } from 'base64-js';

import { SupportError } from './errors.js';

// ---------------------------------------------------------------------------
// Domain error
// ---------------------------------------------------------------------------

export class EncodingError extends SupportError {
  readonly code: 'encode_failed' | 'decode_failed';

  constructor(message: string, code: 'encode_failed' | 'decode_failed') {
    super(message);
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Validation helpers (value-free — never echo the offending value)
// ---------------------------------------------------------------------------

function assertString(value: unknown, operation: string): asserts value is string {
  if (typeof value !== 'string') {
    throw new EncodingError(`Encoding.${operation}: expected a string`, 'encode_failed');
  }
}

function assertUint8Array(value: unknown, operation: string): asserts value is Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new EncodingError(`Encoding.${operation}: expected a Uint8Array`, 'encode_failed');
  }
}

function assertUint8ArrayOrString(
  value: unknown,
  operation: string,
): asserts value is string | Uint8Array {
  if (typeof value !== 'string' && !(value instanceof Uint8Array)) {
    throw new EncodingError(
      `Encoding.${operation}: expected a string or Uint8Array`,
      'encode_failed',
    );
  }
}

function assertPositiveInteger(value: unknown, operation: string): asserts value is number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 1 ||
    !Number.isInteger(value)
  ) {
    throw new EncodingError(`Encoding.${operation}: expected a positive integer`, 'encode_failed');
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Standard base64 alphabet (RFC 4648 section 4). */
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** URL-safe base64url alphabet — no padding after normalization. */
const BASE64URL_RE = /^[A-Za-z0-9_-]*$/;

/**
 * Convert a string to a binary string (each char holds one byte, charCode 0-255)
 * by UTF-8 encoding the text first. This produces a string safe for btoa.
 */
function textToBinaryString(input: string): string {
  const bytes = new TextEncoder().encode(input);
  return Array.from(bytes, (b) => String.fromCharCode(b)).join('');
}

/**
 * Encode a string or Uint8Array to a base64 string.
 */
function encodeBase64(input: string | Uint8Array): string {
  if (typeof input === 'string') {
    const binStr = textToBinaryString(input);
    try {
      return btoa(binStr);
    } catch {
      throw new EncodingError('Encoding.base64: encoding failed', 'encode_failed');
    }
  }
  return fromByteArray(input);
}

/**
 * Decode a standard-base64 string to a Uint8Array.
 * Validates the alphabet before delegating to base64-js, which silently skips
 * invalid characters.
 */
function decodeBase64(input: string): Uint8Array {
  if (!BASE64_RE.test(input)) {
    throw new EncodingError('Encoding.base64Decode: decoding failed', 'decode_failed');
  }
  try {
    return toByteArray(input);
  } catch {
    throw new EncodingError('Encoding.base64Decode: decoding failed', 'decode_failed');
  }
}

// ---------------------------------------------------------------------------
// Wraps: base64-js (binary path)
// Native: btoa / atob (text path via UTF-8 encoding)
// ---------------------------------------------------------------------------

export function base64(input: string | Uint8Array): string {
  assertUint8ArrayOrString(input, 'base64');
  return encodeBase64(input);
}

export function base64Decode(input: string): Uint8Array {
  assertString(input, 'base64Decode');
  return decodeBase64(input);
}

// ---------------------------------------------------------------------------
// Own: base64url (RFC 4648 section 5)
// ---------------------------------------------------------------------------

export function base64url(input: string | Uint8Array): string {
  assertUint8ArrayOrString(input, 'base64url');
  return encodeBase64(input).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64urlDecode(input: string): Uint8Array {
  assertString(input, 'base64urlDecode');
  // Validate the base64url alphabet before normalizing — base64-js silently skips
  // invalid characters, so a string like "~~~" would decode to [0,0] instead of
  // failing.
  if (input.length > 0 && !BASE64URL_RE.test(input)) {
    throw new EncodingError('Encoding.base64urlDecode: decoding failed', 'decode_failed');
  }
  // Re-pad and restore standard alphabet.
  let normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const remainder = normalized.length % 4;
  if (remainder) {
    normalized += '='.repeat(4 - remainder);
  }
  return decodeBase64(normalized);
}

// ---------------------------------------------------------------------------
// Own: hex
// ---------------------------------------------------------------------------

function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]!.toString(16).padStart(2, '0');
  }
  return hex;
}

export function hex(input: string | Uint8Array): string {
  assertUint8ArrayOrString(input, 'hex');
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  return bytesToHex(bytes);
}

export function hexDecode(input: string): Uint8Array {
  assertString(input, 'hexDecode');

  if (input.length % 2 !== 0) {
    throw new EncodingError('Encoding.hexDecode: decoding failed', 'decode_failed');
  }

  const bytes = new Uint8Array(input.length / 2);
  for (let i = 0; i < input.length; i += 2) {
    const pair = input.slice(i, i + 2);
    const byte = parseInt(pair, 16);
    if (Number.isNaN(byte)) {
      throw new EncodingError('Encoding.hexDecode: decoding failed', 'decode_failed');
    }
    bytes[i / 2] = byte;
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Own: data URLs
// ---------------------------------------------------------------------------

export function toDataUrl(mime: string, data: Uint8Array): string {
  assertUint8Array(data, 'toDataUrl');
  assertString(mime, 'toDataUrl');
  return `data:${mime};base64,${fromByteArray(data)}`;
}

const DATA_URL_RE = /^data:([^;]*);base64,(.*)$/;

export interface DataUrlParts {
  mime: string;
  bytes: Uint8Array;
}

export function parseDataUrl(input: string): DataUrlParts | null {
  if (typeof input !== 'string') return null;

  const match = DATA_URL_RE.exec(input);
  if (!match) return null;

  const mime = match[1]!;
  const payload = match[2]!;

  try {
    const bytes = toByteArray(payload);
    return { mime, bytes };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Own: nanoid (URL-safe random id, default size 21)
// ---------------------------------------------------------------------------

const NANOID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
const NANOID_DEFAULT_SIZE = 21;

export function nanoid(size?: number): string {
  const n = size ?? NANOID_DEFAULT_SIZE;
  assertPositiveInteger(n, 'nanoid');

  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);

  let id = '';
  for (let i = 0; i < n; i++) {
    id += NANOID_ALPHABET[bytes[i]! % NANOID_ALPHABET.length]!;
  }
  return id;
}

// ---------------------------------------------------------------------------
// Native: crypto.randomUUID
// ---------------------------------------------------------------------------

export function uuid(): string {
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// Native: crypto.getRandomValues
// ---------------------------------------------------------------------------

export function randomBytes(size: number): Uint8Array {
  assertPositiveInteger(size, 'randomBytes');
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return bytes;
}

// ---------------------------------------------------------------------------
// Frozen namespace
// ---------------------------------------------------------------------------

export const Encoding = Object.freeze({
  base64,
  base64Decode,
  base64url,
  base64urlDecode,
  hex,
  hexDecode,
  toDataUrl,
  parseDataUrl,
  nanoid,
  uuid,
  randomBytes,
});
