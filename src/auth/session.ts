/**
 * Session primitives: a session manager layered over an injected
 * {@link SessionStore}, a dev/test-only in-memory store, cookie (de)serialization,
 * and CSRF token verification.
 *
 * Security posture:
 * - Session ids and CSRF tokens are cryptographically random (base64url).
 * - Login regenerates the session id and CSRF token (the old id is deleted) to
 *   prevent session fixation.
 * - Cookies are `HttpOnly`, `SameSite=Lax`, `Path=/`, and `Secure` by default;
 *   local dev over HTTP opts out of `Secure` explicitly, never silently.
 * - Cookie values are validated strictly and never treated as user data.
 * - Same-origin enforcement (Origin/Referer) is intentionally NOT done here: the
 *   router/handler that sees the request URL and proxy configuration owns that
 *   check.
 *
 * Passwords and session ids must never be logged; nothing in this module logs.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import type { JsonObject, Session, SessionStore } from '../contracts/http.js';

/** Bytes of entropy for a session id. 32 bytes -> 43 base64url characters. */
const SESSION_ID_BYTES = 32;
/** Bytes of entropy for a CSRF token. */
const CSRF_TOKEN_BYTES = 32;

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DEFAULT_COOKIE_NAME = 'session';
const DEFAULT_CAPACITY = 1000;

/** base64url alphabet only (no `=`, no `;`), so ids can never break a cookie header. */
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const SESSION_ID_LENGTH = Math.ceil((SESSION_ID_BYTES * 8) / 6); // 43

/** RFC 6265 token characters; used to reject cookie-name header injection. */
const COOKIE_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export type AuthErrorCode = 'csrf-mismatch';

/** Structured error for authentication/authorization failures. */
export class AuthError extends Error {
  readonly code: AuthErrorCode;
  /** Suggested HTTP status for the failure (defaults to 403 Forbidden). */
  readonly status: number;

  constructor(code: AuthErrorCode, message: string, status = 403) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
    this.status = status;
  }
}

/** Deep-clone a JSON snapshot so callers can never mutate live shared state. */
function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Strictly validate a session id: exact length and base64url-only characters. */
function isValidSessionId(value: string): boolean {
  return value.length === SESSION_ID_LENGTH && BASE64URL_PATTERN.test(value);
}

function assertCookieName(name: string): void {
  if (typeof name !== 'string' || !COOKIE_NAME_PATTERN.test(name)) {
    throw new Error(`invalid cookie name: ${JSON.stringify(name)}`);
  }
}

/**
 * Constant-time string comparison that also handles differing lengths without
 * short-circuiting: unequal-length inputs are hashed to a fixed width and then
 * compared, so the length difference is not observable through timing.
 */
function safeEqualStrings(a: string, b: string): boolean {
  const aBuffer = Buffer.from(a, 'utf8');
  const bBuffer = Buffer.from(b, 'utf8');
  if (aBuffer.length === bBuffer.length) {
    return timingSafeEqual(aBuffer, bBuffer);
  }
  const aDigest = createHash('sha256').update(aBuffer).digest();
  const bDigest = createHash('sha256').update(bBuffer).digest();
  return timingSafeEqual(aDigest, bDigest);
}

/**
 * Verify that `supplied` (from a request header/body) matches the CSRF token
 * bound to `session`. Throws {@link AuthError} on a missing, malformed, or
 * mismatched token. The comparison is constant-time, including length.
 *
 * Same-origin checks are deliberately deferred to the router/handler, which is
 * the only layer that knows the request URL and any reverse-proxy rewriting.
 */
export function assertCsrfToken(session: Session, supplied: unknown): void {
  if (typeof supplied !== 'string') {
    throw new AuthError('csrf-mismatch', 'CSRF token missing or malformed');
  }
  if (!safeEqualStrings(session.csrfToken, supplied)) {
    throw new AuthError('csrf-mismatch', 'CSRF token mismatch');
  }
}

export interface SessionManagerOptions {
  /** Monotonic-ish time source returning epoch milliseconds. Defaults to `Date.now`. */
  clock?: () => number;
  /** Session lifetime in milliseconds. Must be a positive finite number. */
  ttlMs?: number;
  /** Cookie name. Defaults to `"session"`. */
  cookieName?: string;
  /**
   * Set the cookie `Secure` attribute. Defaults to `true`; set `false` only for
   * local development served over plain HTTP.
   */
  cookieSecure?: boolean;
}

/**
 * Orchestrates session lifecycle over an injected {@link SessionStore}:
 * create, load (with expiry check), regenerate-on-login, and logout.
 */
export class SessionManager {
  private readonly store: SessionStore;
  private readonly clock: () => number;
  private readonly ttlMs: number;
  private readonly cookieName: string;
  private readonly cookieSecure: boolean;

  constructor(store: SessionStore, options: SessionManagerOptions = {}) {
    this.store = store;
    this.clock = options.clock ?? Date.now;
    const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new RangeError(`ttlMs must be a positive finite number; got ${ttlMs}`);
    }
    this.ttlMs = ttlMs;
    this.cookieName = options.cookieName ?? DEFAULT_COOKIE_NAME;
    assertCookieName(this.cookieName);
    this.cookieSecure = options.cookieSecure ?? true;
  }

  /** Create a new session, snapshotting `data` so the caller's object is never aliased. */
  async create(data: JsonObject = {}): Promise<Session> {
    const session: Session = {
      id: randomBytes(SESSION_ID_BYTES).toString('base64url'),
      csrfToken: randomBytes(CSRF_TOKEN_BYTES).toString('base64url'),
      data: cloneJson(data),
      expiresAt: this.clock() + this.ttlMs,
    };
    await this.store.set(session);
    return session;
  }

  /**
   * Load a session by id, returning `null` when absent, expired, or when the id
   * does not have the shape of a session id. Expired sessions are deleted.
   */
  async get(id: string): Promise<Session | null> {
    if (!isValidSessionId(id)) {
      return null;
    }
    const session = await this.store.get(id);
    if (session === null) {
      return null;
    }
    if (session.expiresAt <= this.clock()) {
      await this.store.delete(id);
      return null;
    }
    return session;
  }

  /**
   * Rotate a session: delete the prior id and issue a fresh id and CSRF token,
   * preserving existing data unless `data` is supplied. Prevents session
   * fixation on login. Returns the new session.
   */
  async regenerate(id: string, data?: JsonObject): Promise<Session> {
    const previous = await this.store.get(id);
    await this.store.delete(id);
    const nextData = data ?? previous?.data ?? {};
    return this.create(nextData);
  }

  /** Destroy a session (logout). */
  async logout(id: string): Promise<void> {
    await this.store.delete(id);
  }

  /** Serialize the `Set-Cookie` value for a session id, honoring manager options. */
  serializeCookie(id: string): string {
    return serializeSessionCookie(id, {
      name: this.cookieName,
      secure: this.cookieSecure,
      maxAgeSeconds: Math.floor(this.ttlMs / 1000),
    });
  }

  /** Extract the session id from a `Cookie` header, validating it strictly. */
  parseCookie(header: string | null | undefined): string | null {
    return parseSessionCookie(header, this.cookieName);
  }
}

export interface SessionCookieOptions {
  /** Cookie name. Defaults to `"session"`. */
  name?: string;
  /** `Secure` attribute; defaults to `true`. Set `false` only for dev over HTTP. */
  secure?: boolean;
  /** `Max-Age` in seconds; omitted when undefined. */
  maxAgeSeconds?: number;
}

/**
 * Serialize a session id as a `Set-Cookie` value. Always `HttpOnly`,
 * `SameSite=Lax`, `Path=/`; `Secure` unless explicitly disabled for dev.
 * Rejects ids or names that could break or inject into the header.
 */
export function serializeSessionCookie(id: string, options: SessionCookieOptions = {}): string {
  if (!isValidSessionId(id)) {
    throw new Error('cannot serialize cookie: not a valid session id');
  }
  const name = options.name ?? DEFAULT_COOKIE_NAME;
  assertCookieName(name);

  const parts = [`${name}=${id}`, 'HttpOnly', 'SameSite=Lax', 'Path=/'];
  if (options.secure ?? true) {
    parts.push('Secure');
  }
  if (options.maxAgeSeconds !== undefined) {
    parts.push(`Max-Age=${options.maxAgeSeconds}`);
  }
  return parts.join('; ');
}

/**
 * Parse a `Cookie` header and return the session id for `name`, or `null` when
 * absent or malformed. A present-but-malformed value is rejected (returns
 * `null`) rather than passed through to the store, so user data can never reach
 * session lookup.
 */
export function parseSessionCookie(
  header: string | null | undefined,
  name = DEFAULT_COOKIE_NAME,
): string | null {
  if (typeof header !== 'string') {
    return null;
  }
  if (!COOKIE_NAME_PATTERN.test(name)) {
    return null;
  }
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) {
      continue;
    }
    if (part.slice(0, eq).trim() !== name) {
      continue;
    }
    const value = part.slice(eq + 1).trim();
    return isValidSessionId(value) ? value : null;
  }
  return null;
}

export interface InMemorySessionStoreOptions {
  /** Time source for expiry eviction. Defaults to `Date.now`. */
  clock?: () => number;
  /** Hard cap on stored sessions; oldest (soonest-expiring) entries are evicted. */
  capacity?: number;
}

/**
 * In-memory {@link SessionStore} for development and tests only. It is NOT
 * durable (lost on restart) and does not share state across processes, so it
 * must never back production or distributed sessions. Entries are deep-cloned
 * on both `set` and `get` so callers cannot mutate live shared state, expired
 * entries are evicted on access, and a hard capacity cap bounds memory.
 */
export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, Session>();
  private readonly clock: () => number;
  private readonly capacity: number;

  constructor(options: InMemorySessionStoreOptions = {}) {
    this.clock = options.clock ?? Date.now;
    const capacity = options.capacity ?? DEFAULT_CAPACITY;
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError(`capacity must be a positive integer; got ${capacity}`);
    }
    this.capacity = capacity;
  }

  async get(id: string): Promise<Session | null> {
    this.evictExpired();
    const session = this.sessions.get(id);
    if (session === undefined) {
      return null;
    }
    if (session.expiresAt <= this.clock()) {
      this.sessions.delete(id);
      return null;
    }
    return cloneJson(session);
  }

  async set(session: Session): Promise<void> {
    this.sessions.set(session.id, cloneJson(session));
    this.evictExpired();
    this.enforceCapacity();
  }

  async delete(id: string): Promise<void> {
    this.sessions.delete(id);
  }

  private evictExpired(): void {
    const now = this.clock();
    for (const [id, session] of this.sessions) {
      if (session.expiresAt <= now) {
        this.sessions.delete(id);
      }
    }
  }

  private enforceCapacity(): void {
    while (this.sessions.size > this.capacity) {
      const oldestId = this.oldestSessionId();
      if (oldestId === null) {
        break;
      }
      this.sessions.delete(oldestId);
    }
  }

  private oldestSessionId(): string | null {
    let oldestId: string | null = null;
    let oldestExpiry = Infinity;
    for (const [id, session] of this.sessions) {
      if (session.expiresAt < oldestExpiry) {
        oldestExpiry = session.expiresAt;
        oldestId = id;
      }
    }
    return oldestId;
  }
}
