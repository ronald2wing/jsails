/**
 * HMAC-SHA256 signed component snapshots.
 *
 * A snapshot token is a self-contained, integrity-protected record of a server
 * component's current state, bound to its component name, origin, and (through
 * a purpose-separated subject tag) the session or scope that owns it. It is
 * signed with a key the application supplies: there is no key generation, no
 * state store, no cookie, and no transport here — the caller owns key
 * management and wherever the token is carried.
 *
 * Security posture:
 * - Integrity only, never confidentiality. The MAC proves the snapshot was
 *   produced by a holder of the key; it does not encrypt. State, subject, and
 *   page are readable by anyone who holds the token, so secrets must never be
 *   placed in state.
 * - No replay guarantee. A valid token can be replayed until it expires. Keep
 *   `ttlMs` short and rely on server-side mutation state where non-replay is
 *   required.
 * - The raw session/scope id is never serialized. `subjectFor` derives a
 *   purpose-separated HMAC tag from it; only that tag appears in the token.
 * - The subject tag and the snapshot signature use different HMAC keys derived
 *   from the master key, so a tag can never be forged from a snapshot
 *   signature (or vice versa) without the master key.
 * - The MAC is verified before the payload is parsed or trusted, and the
 *   comparison is constant-time (`timingSafeEqual`).
 * - Token size, payload size, JSON nesting depth, object shape (plain objects,
 *   no `__proto__`/`constructor`/`prototype` keys), and number finiteness are
 *   all bounded and validated, so a crafted token can never force unbounded
 *   work or pollute a prototype.
 * - Errors are generic and value-free: they never echo the key, state, token,
 *   or an underlying cause.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

import { safeEqualStrings } from '../internal/crypto.js';
import { isHttpOrigin, isValidRelativePath } from '../internal/http.js';
import { isForbiddenKey, isPlainObject } from '../internal/json-safe.js';
import type { JsonObject } from '../contracts/http.js';

/** Snapshot payload format version carried in the serialized JSON. */
const VERSION = 1;

/** HMAC key-derivation context for snapshot signatures. */
const SIGN_KEY_CONTEXT = 'jsails.snapshot.sign.v1';
/** HMAC key-derivation context for subject tags. */
const SUBJECT_KEY_CONTEXT = 'jsails.snapshot.subject.v1';

/** Signature length in bytes (HMAC-SHA256). */
const SIGNATURE_BYTES = 32;

/** Maximum nesting depth of the serialized payload. */
const MAX_JSON_DEPTH = 64;

/** Default snapshot lifetime. */
const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour
/** Default cap on the serialized payload, in bytes. */
const DEFAULT_MAX_BYTES = 64 * 1024; // 64 KiB
/** Cap on the raw subject id fed to `subjectFor`, in UTF-8 bytes. */
const MAX_SUBJECT_ID_BYTES = 4096;

/** Minimum master-key length in bytes (256 bits). */
const MIN_KEY_BYTES = 32;

/** base64url alphabet only (no `=`, no `.`), so tokens never contain a stray separator. */
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/;

/** The page provenance a snapshot is bound to. */
export interface SnapshotPage {
  /** URL path relative to the origin; must start with `/` and carry no traversal. */
  readonly path: string;
  /** Route parameters, all string values. */
  readonly params: Readonly<Record<string, string>>;
}

/**
 * A verified snapshot record. `expiresAt` is assigned at sign time; `revision`
 * is optional author metadata and is preserved verbatim.
 */
export interface SnapshotPayload {
  readonly v: 1;
  readonly component: string;
  readonly id: string;
  readonly state: JsonObject;
  readonly page: SnapshotPage;
  readonly origin: string;
  readonly subject: string | null;
  readonly expiresAt: number;
  readonly revision?: number;
}

/** Everything a caller supplies to `sign`; `expiresAt` is computed by the signer. */
export type SnapshotPayloadWithoutExpiry = Omit<SnapshotPayload, 'expiresAt'>;

/** Optional expected-scope constraints handed to `verify`. */
export interface SnapshotVerifyOptions {
  readonly component?: string;
  readonly origin?: string;
  readonly subject?: string | null;
}

/** Options for {@link createComponentSigner}. */
export interface SnapshotSignerOptions {
  /**
   * The signing key. A string is interpreted as UTF-8. Must be at least 32
   * bytes (256 bits). Never generated or defaulted — the caller supplies it.
   */
  readonly key: string | Uint8Array;
  /** Monotonic-ish time source returning epoch milliseconds. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Snapshot lifetime in milliseconds. Must be a positive finite number. */
  readonly ttlMs?: number;
  /** Cap on the serialized payload in bytes. Must be a positive integer. */
  readonly maxBytes?: number;
}

/**
 * A configured snapshot signer: binds a subject, signs a payload, and verifies
 * a token against expected scope. All methods are pure relative to the key and
 * options captured at construction; nothing here touches a network or a store.
 */
export interface ComponentSigner {
  /**
   * Derive the subject tag for a raw session/scope id. The raw id is never
   * serialized — only the derived tag should be placed in a payload's
   * `subject`. Returns `null` for a `null` id (anonymous scope).
   */
  subjectFor(sessionOrScopeId: string | null): string | null;
  /** Sign a snapshot payload (without `expiresAt`), returning the token. */
  sign(payload: SnapshotPayloadWithoutExpiry): string;
  /** Verify a token, returning the trusted snapshot record. Throws on any failure. */
  verify(token: string, options?: SnapshotVerifyOptions): SnapshotPayload;
}

/** Raised for any invalid signer configuration, payload, or token. Value-free. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

type JsonViolation =
  'depth' | 'non-finite' | 'non-plain' | 'forbidden-key' | 'non-json' | 'circular';

type Fail = (violation: JsonViolation) => never;

/** A traversal stack frame for the iterative JSON validator. */
type Frame =
  | { readonly kind: 'enter'; readonly value: unknown; readonly depth: number }
  | { readonly kind: 'exit'; readonly value: object };

/**
 * Validate that `root` is a finite, acyclic, plain-JSON value with no dangerous
 * own keys and bounded depth. Iterative (explicit stack) so a deeply nested
 * input cannot overflow the call stack; cycle detection uses an ancestor set so
 * shared-but-acyclic references are still accepted. `fail` reports the first
 * violation with a caller-chosen, value-free error.
 */
function assertJsonValue(root: unknown, fail: Fail): void {
  const stack: Frame[] = [{ kind: 'enter', value: root, depth: 0 }];
  const ancestors = new Set<object>();

  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (frame.kind === 'exit') {
      ancestors.delete(frame.value);
      continue;
    }

    const { value, depth } = frame;
    if (depth > MAX_JSON_DEPTH) {
      fail('depth');
    }
    if (value === null) {
      continue;
    }

    const type = typeof value;
    if (type === 'string' || type === 'boolean') {
      continue;
    }
    if (type === 'number') {
      if (!Number.isFinite(value)) {
        fail('non-finite');
      }
      continue;
    }
    if (Array.isArray(value)) {
      if (ancestors.has(value)) {
        fail('circular');
      }
      ancestors.add(value);
      stack.push({ kind: 'exit', value });
      for (const item of value) {
        stack.push({ kind: 'enter', value: item, depth: depth + 1 });
      }
      continue;
    }
    if (type === 'object') {
      if (!isPlainObject(value)) {
        fail('non-plain');
      }
      if (ancestors.has(value)) {
        fail('circular');
      }
      ancestors.add(value);
      stack.push({ kind: 'exit', value });
      const record = value;
      for (const key of Object.keys(record)) {
        if (isForbiddenKey(key)) {
          fail('forbidden-key');
        }
        stack.push({ kind: 'enter', value: record[key], depth: depth + 1 });
      }
      continue;
    }
    fail('non-json');
  }
}

/** Reject a JSON string whose nesting depth exceeds the bound, before parsing. */
function assertJsonDepthBounded(text: string): void {
  let depth = 0;
  let maxDepth = 0;
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
      if (depth > maxDepth) {
        maxDepth = depth;
        if (maxDepth > MAX_JSON_DEPTH) {
          throw new SnapshotError('invalid snapshot token');
        }
      }
    } else if (ch === '}' || ch === ']') {
      depth -= 1;
    }
  }
}

/** The sign-side `fail`: value-free, field-naming messages (no values echoed). */
function signFail(violation: JsonViolation): never {
  const messages: Record<JsonViolation, string> = {
    depth: 'snapshot state exceeds the maximum nesting depth',
    'non-finite': 'snapshot state contains a non-finite number',
    'non-plain': 'snapshot state must contain only plain JSON values',
    'forbidden-key': 'snapshot state contains a forbidden key',
    circular: 'snapshot state must not contain circular references',
    'non-json': 'snapshot state must contain only JSON values',
  };
  throw new SnapshotError(messages[violation]);
}

/** The verify-side `fail`: a single generic message, so failures are indistinguishable. */
function invalidToken(): never {
  throw new SnapshotError('invalid snapshot token');
}

function validateComponent(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new SnapshotError('component must be a non-empty string');
  }
  return value;
}

function validateId(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new SnapshotError('id must be a non-empty string');
  }
  return value;
}

function validateState(value: unknown): JsonObject {
  if (!isPlainObject(value)) {
    throw new SnapshotError('state must be a plain JSON object');
  }
  assertJsonValue(value, signFail);
  return value as unknown as JsonObject;
}

function validatePage(value: unknown): SnapshotPage {
  if (!isPlainObject(value)) {
    throw new SnapshotError('page must be a plain object');
  }
  const { path, params: rawParams } = value;
  if (!isValidRelativePath(path)) {
    throw new SnapshotError('page.path must be a relative URL path');
  }
  if (!isPlainObject(rawParams)) {
    throw new SnapshotError('page.params must be a plain object');
  }
  const params: Record<string, string> = {};
  for (const [key, paramValue] of Object.entries(rawParams)) {
    if (isForbiddenKey(key)) {
      throw new SnapshotError('page.params contains a forbidden key');
    }
    if (typeof paramValue !== 'string') {
      throw new SnapshotError('page.params values must be strings');
    }
    params[key] = paramValue;
  }
  return { path, params };
}

function validateOrigin(value: unknown): string {
  if (!isHttpOrigin(value)) {
    throw new SnapshotError('origin must be an http(s) origin');
  }
  return value;
}

function validateSubject(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string' || value.length === 0) {
    throw new SnapshotError('subject must be a string or null');
  }
  return value;
}

function validateRevision(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new SnapshotError('revision must be a non-negative integer when present');
  }
  return value;
}

interface NormalizedPayload {
  readonly component: string;
  readonly id: string;
  readonly state: JsonObject;
  readonly page: SnapshotPage;
  readonly origin: string;
  readonly subject: string | null;
  readonly expiresAt: number;
  readonly revision?: number;
}

function serializePayload(payload: NormalizedPayload): string {
  const json: Record<string, unknown> = {
    v: VERSION,
    component: payload.component,
    id: payload.id,
    state: payload.state,
    page: { path: payload.page.path, params: payload.page.params },
    origin: payload.origin,
    subject: payload.subject,
    expiresAt: payload.expiresAt,
  };
  if (payload.revision !== undefined) {
    json.revision = payload.revision;
  }
  return JSON.stringify(json);
}

function normalizeKey(key: string | Uint8Array): Buffer {
  if (typeof key === 'string') {
    return Buffer.from(key, 'utf8');
  }
  if (key instanceof Uint8Array) {
    return Buffer.from(key);
  }
  throw new SnapshotError('snapshot key must be a string or Uint8Array');
}

/** Build a verified snapshot record from an already-MAC-verified, parsed payload. */
function parseVerifiedPayload(parsed: unknown): SnapshotPayload {
  if (!isPlainObject(parsed)) {
    invalidToken();
  }
  if (parsed.v !== VERSION) {
    invalidToken();
  }

  const component = parsed.component;
  if (typeof component !== 'string' || component.trim() === '') {
    invalidToken();
  }
  const id = parsed.id;
  if (typeof id !== 'string' || id.trim() === '') {
    invalidToken();
  }
  const state = parsed.state;
  if (!isPlainObject(state)) {
    invalidToken();
  }

  const page = parsed.page;
  if (!isPlainObject(page)) {
    invalidToken();
  }
  const path = page.path;
  if (!isValidRelativePath(path)) {
    invalidToken();
  }
  const rawParams = page.params;
  if (!isPlainObject(rawParams)) {
    invalidToken();
  }
  const params: Record<string, string> = {};
  for (const [key, paramValue] of Object.entries(rawParams)) {
    if (isForbiddenKey(key)) {
      invalidToken();
    }
    if (typeof paramValue !== 'string') {
      invalidToken();
    }
    params[key] = paramValue;
  }

  const origin = parsed.origin;
  if (!isHttpOrigin(origin)) {
    invalidToken();
  }
  const subject = parsed.subject;
  if (subject !== null && (typeof subject !== 'string' || subject.length === 0)) {
    invalidToken();
  }
  const expiresAt = parsed.expiresAt;
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) {
    invalidToken();
  }
  const revision = parsed.revision;
  if (
    revision !== undefined &&
    (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0)
  ) {
    invalidToken();
  }

  return {
    v: VERSION,
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
 * Create a snapshot signer over the given key. The key is required (never
 * generated) and must be at least 32 bytes; `ttlMs` and `maxBytes` bound the
 * snapshot's lifetime and size. Returns a frozen handle exposing
 * {@link ComponentSigner.subjectFor}, `sign`, and `verify`.
 */
export function createComponentSigner(options: SnapshotSignerOptions): ComponentSigner {
  const key = normalizeKey(options.key);
  if (key.byteLength < MIN_KEY_BYTES) {
    throw new SnapshotError('snapshot key must be at least 32 bytes');
  }

  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new SnapshotError('ttlMs must be a positive finite number');
  }

  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new SnapshotError('maxBytes must be a positive integer');
  }

  // Purpose-separated keys: the subject tag and the snapshot signature are
  // HMACs under different derived keys, so one can never stand in for the other.
  const signKey = createHmac('sha256', key).update(SIGN_KEY_CONTEXT).digest();
  const subjectKey = createHmac('sha256', key).update(SUBJECT_KEY_CONTEXT).digest();

  // Upper bound on the token string: base64url payload + separator + signature.
  const maxTokenLength = Math.ceil((maxBytes * 4) / 3) + 1 + 43;

  return Object.freeze({
    subjectFor(sessionOrScopeId: string | null): string | null {
      if (sessionOrScopeId === null) {
        return null;
      }
      if (typeof sessionOrScopeId !== 'string' || sessionOrScopeId.length === 0) {
        throw new SnapshotError('subject id must be a non-empty string or null');
      }
      const idBuffer = Buffer.from(sessionOrScopeId, 'utf8');
      if (idBuffer.byteLength > MAX_SUBJECT_ID_BYTES) {
        throw new SnapshotError('subject id exceeds the maximum length');
      }
      // The raw id never leaves this function; only the derived tag is returned.
      return createHmac('sha256', subjectKey).update(idBuffer).digest('base64url');
    },

    sign(payload: SnapshotPayloadWithoutExpiry): string {
      if (!isPlainObject(payload)) {
        throw new SnapshotError('snapshot payload must be an object');
      }
      if (payload.v !== VERSION) {
        throw new SnapshotError('unsupported snapshot version');
      }
      const normalized: NormalizedPayload = {
        component: validateComponent(payload.component),
        id: validateId(payload.id),
        state: validateState(payload.state),
        page: validatePage(payload.page),
        origin: validateOrigin(payload.origin),
        subject: validateSubject(payload.subject),
        expiresAt: now() + ttlMs,
        revision: validateRevision(payload.revision),
      };
      if (!Number.isFinite(normalized.expiresAt)) {
        throw new SnapshotError('signer clock produced a non-finite time');
      }

      const jsonBytes = Buffer.from(serializePayload(normalized), 'utf8');
      if (jsonBytes.byteLength > maxBytes) {
        throw new SnapshotError('snapshot payload exceeds the maximum byte size');
      }
      const signature = createHmac('sha256', signKey).update(jsonBytes).digest('base64url');
      return `${jsonBytes.toString('base64url')}.${signature}`;
    },

    verify(token: string, options?: SnapshotVerifyOptions): SnapshotPayload {
      if (typeof token !== 'string') {
        invalidToken();
      }
      if (token.length > maxTokenLength) {
        invalidToken();
      }
      const dot = token.indexOf('.');
      if (dot <= 0 || dot === token.length - 1 || token.indexOf('.', dot + 1) !== -1) {
        invalidToken();
      }
      const payloadPart = token.slice(0, dot);
      const signaturePart = token.slice(dot + 1);
      if (!BASE64URL_PATTERN.test(payloadPart) || !BASE64URL_PATTERN.test(signaturePart)) {
        invalidToken();
      }
      if (payloadPart.length % 4 === 1 || signaturePart.length % 4 === 1) {
        invalidToken();
      }

      const payloadBytes = Buffer.from(payloadPart, 'base64url');
      const signatureBytes = Buffer.from(signaturePart, 'base64url');
      if (payloadBytes.byteLength > maxBytes || signatureBytes.byteLength !== SIGNATURE_BYTES) {
        invalidToken();
      }

      // MAC first: the payload is untrusted until the signature matches.
      const expected = createHmac('sha256', signKey).update(payloadBytes).digest();
      // Raw 32-byte HMAC digests (arbitrary bytes), not text: `safeEqualStrings`
      // is utf8-only and would be lossy, so compare the fixed-length buffers directly.
      if (!timingSafeEqual(expected, signatureBytes)) {
        invalidToken();
      }

      const text = payloadBytes.toString('utf8');
      assertJsonDepthBounded(text);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        invalidToken();
      }
      assertJsonValue(parsed, () => invalidToken());
      const snapshot = parseVerifiedPayload(parsed);

      if (snapshot.expiresAt <= now()) {
        invalidToken();
      }
      if (options?.component !== undefined && options.component !== snapshot.component) {
        invalidToken();
      }
      if (options?.origin !== undefined && options.origin !== snapshot.origin) {
        invalidToken();
      }
      if (options?.subject !== undefined) {
        const expectedSubject = options.subject;
        if (snapshot.subject === null || expectedSubject === null) {
          if (snapshot.subject !== expectedSubject) {
            invalidToken();
          }
        } else if (!safeEqualStrings(snapshot.subject, expectedSubject)) {
          invalidToken();
        }
      }

      return snapshot;
    },
  });
}
