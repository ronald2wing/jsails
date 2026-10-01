/**
 * Public snapshot decoding (unverified).
 *
 * Decodes the body of a base64url snapshot token WITHOUT verifying it: the
 * payload half is bounded, decoded as UTF-8 JSON, scanned for portability
 * violations, and shaped into a typed {@link PublicSnapshot}. The signature half
 * is never inspected and no key is read — the result is untrusted display data,
 * never an authority.
 */

import type { JsonObject } from '../../contracts/http.js';
import { isHttpOrigin, isValidRelativePath } from '../../internal/http.js';
import { isPlainObject } from '../../internal/json-safe.js';
import { isForbiddenKey } from './proto-guard.js';
import {
  MAX_JSON_DEPTH,
  MAX_SNAPSHOT_PAYLOAD_BYTES,
  MAX_SNAPSHOT_TOKEN_LENGTH,
  jsonViolationMessage,
  scanJson,
} from './limits.js';

/** base64url alphabet only (no padding, no standard-base64 `+`/`/`). */
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/;

/** Raised when a snapshot token cannot be decoded as public client data. */
export class ComponentSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ComponentSnapshotError';
  }
}

/** The page provenance recorded in a decoded snapshot. */
interface PublicSnapshotPage {
  readonly path: string;
  readonly params: Readonly<Record<string, string>>;
}

/**
 * The decoded, UNVERIFIED body of a component snapshot. Every field is
 * attacker-controllable until the server verifies the signature on update;
 * never trust it as an authorization or integrity signal.
 */
export interface PublicSnapshot {
  readonly component: string;
  readonly id: string;
  readonly state: JsonObject;
  readonly page: PublicSnapshotPage;
  readonly origin: string;
  readonly subject: string | null;
  readonly expiresAt: number;
  readonly revision?: number;
}

/** Reject a JSON string whose pre-parse nesting depth exceeds the bound. */
function assertDepthBounded(text: string): void {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{' || ch === '[') {
      depth += 1;
      if (depth > MAX_JSON_DEPTH) {
        throw new ComponentSnapshotError('invalid snapshot token');
      }
    } else if (ch === '}' || ch === ']') {
      depth -= 1;
    }
  }
}

function base64UrlToBytes(input: string): Uint8Array {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const padding = normalized.length % 4;
  if (padding === 1) {
    throw new ComponentSnapshotError('invalid snapshot token');
  }
  const padded = padding === 0 ? normalized : normalized + '='.repeat(4 - padding);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function validatePublicSnapshot(value: Record<string, unknown>): PublicSnapshot {
  if (value.v !== 1) {
    throw new ComponentSnapshotError('invalid snapshot token');
  }
  const component = value.component;
  if (typeof component !== 'string' || component.trim() === '') {
    throw new ComponentSnapshotError('invalid snapshot token');
  }
  const id = value.id;
  if (typeof id !== 'string' || id.trim() === '') {
    throw new ComponentSnapshotError('invalid snapshot token');
  }
  const state = value.state;
  if (!isPlainObject(state)) {
    throw new ComponentSnapshotError('invalid snapshot token');
  }
  const page = value.page;
  if (!isPlainObject(page)) {
    throw new ComponentSnapshotError('invalid snapshot token');
  }
  const path = page.path;
  if (!isValidRelativePath(path)) {
    throw new ComponentSnapshotError('invalid snapshot token');
  }
  const rawParams = page.params;
  if (!isPlainObject(rawParams)) {
    throw new ComponentSnapshotError('invalid snapshot token');
  }
  const params: Record<string, string> = {};
  for (const [key, paramValue] of Object.entries(rawParams)) {
    if (isForbiddenKey(key) || typeof paramValue !== 'string') {
      throw new ComponentSnapshotError('invalid snapshot token');
    }
    params[key] = paramValue;
  }
  const origin = value.origin;
  if (!isHttpOrigin(origin)) {
    throw new ComponentSnapshotError('invalid snapshot token');
  }
  const subject = value.subject;
  if (subject !== null && (typeof subject !== 'string' || subject.length === 0)) {
    throw new ComponentSnapshotError('invalid snapshot token');
  }
  const expiresAt = value.expiresAt;
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) {
    throw new ComponentSnapshotError('invalid snapshot token');
  }
  const revision = value.revision;
  if (
    revision !== undefined &&
    (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0)
  ) {
    throw new ComponentSnapshotError('invalid snapshot token');
  }

  return {
    component,
    id,
    state: state as JsonObject,
    page: { path, params },
    origin,
    subject,
    expiresAt,
    ...(revision === undefined ? {} : { revision }),
  };
}

/**
 * Decode the public body of a snapshot token WITHOUT verifying it.
 *
 * The token format is `base64url(json).base64url(signature)`; only the payload
 * half is decoded. No key is read and no MAC is checked — the result is
 * untrusted display data. The payload must be bounded, valid UTF-8 JSON, within
 * the depth/size limits, free of prototype-polluting keys, and shaped like a
 * v1 snapshot; otherwise a value-free {@link ComponentSnapshotError} is thrown.
 */
export function decodePublicSnapshot(token: string): PublicSnapshot {
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_SNAPSHOT_TOKEN_LENGTH) {
    throw new ComponentSnapshotError('invalid snapshot token');
  }
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1 || token.indexOf('.', dot + 1) !== -1) {
    throw new ComponentSnapshotError('invalid snapshot token');
  }
  const payloadPart = token.slice(0, dot);
  const signaturePart = token.slice(dot + 1);
  if (!BASE64URL_PATTERN.test(payloadPart) || !BASE64URL_PATTERN.test(signaturePart)) {
    throw new ComponentSnapshotError('invalid snapshot token');
  }

  let bytes: Uint8Array;
  try {
    bytes = base64UrlToBytes(payloadPart);
  } catch {
    throw new ComponentSnapshotError('invalid snapshot token');
  }
  if (bytes.byteLength > MAX_SNAPSHOT_PAYLOAD_BYTES) {
    throw new ComponentSnapshotError('invalid snapshot token');
  }

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new ComponentSnapshotError('invalid snapshot token');
  }

  assertDepthBounded(text);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ComponentSnapshotError('invalid snapshot token');
  }

  if (!isPlainObject(parsed)) {
    throw new ComponentSnapshotError('invalid snapshot token');
  }
  const violation = scanJson(parsed);
  if (violation !== null) {
    throw new ComponentSnapshotError(jsonViolationMessage(violation));
  }
  return validatePublicSnapshot(parsed);
}
