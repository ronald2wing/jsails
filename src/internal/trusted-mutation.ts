/**
 * Trusted-mutation guard: same-origin + CSRF checks shared by the admin panel,
 * filesystem API routes, server-component runtime, and the auth/plugin hooks.
 *
 * The same-origin check is a pure string comparison of the request's `Origin`
 * header against a trusted origin; forwarded headers (X-Forwarded-Host, etc.)
 * are never consulted. The CSRF check is constant-time via `safeEqualStrings`.
 *
 * This module is **server-only** (it imports `node:crypto` through
 * `../internal/crypto.js`). It must never be re-exported from
 * `jsails/extensions`.
 */

import type { Session } from '../contracts/http.js';
import { safeEqualStrings } from './crypto.js';

// ---------------------------------------------------------------------------
// Discriminated result types (value-free — never echo the request or token)
// ---------------------------------------------------------------------------

/** Reason codes a trusted-mutation guard can return on denial. */
export type DenyCode = 'origin_mismatch' | 'csrf_mismatch';

/** A denied guard result: the caller renders its own response from these fields. */
export interface GuardDenied {
  readonly allowed: false;
  readonly code: DenyCode;
  readonly status: number;
  readonly message: string;
}

/** An allowed guard result. */
export interface GuardAllowed {
  readonly allowed: true;
}

/** Discriminated union: exactly one branch is present. */
export type GuardResult = GuardAllowed | GuardDenied;

// ---------------------------------------------------------------------------
// Same-origin check
// ---------------------------------------------------------------------------

/**
 * True when the request's `Origin` header exactly equals the expected origin.
 *
 * When `expectedOrigin` is provided it is compared verbatim; when absent the
 * comparison falls back to the request URL's own origin. Forwarded headers are
 * never consulted — the caller supplies the trusted origin (typically the
 * configured `publicOrigin`) after resolving it against any reverse-proxy
 * rewriting it owns.
 */
export function isSameOriginRequest(request: Request, expectedOrigin?: string): boolean {
  const origin = request.headers.get('origin');
  if (typeof origin !== 'string' || origin === '') {
    return false;
  }
  const trusted = expectedOrigin ?? new URL(request.url).origin;
  return origin === trusted;
}

// ---------------------------------------------------------------------------
// CSRF token check
// ---------------------------------------------------------------------------

/**
 * Constant-time CSRF comparison. Returns `true` only when the supplied value
 * is a non-empty string that exactly matches the session token.
 *
 * Unlike `assertCsrfToken` (which throws), this returns a boolean so callers
 * can build discriminated results without a try/catch in the expected-deny path.
 */
export function csrfTokenValid(session: Session, supplied: unknown): boolean {
  if (typeof supplied !== 'string' || supplied === '') {
    return false;
  }
  return safeEqualStrings(session.csrfToken, supplied);
}

// ---------------------------------------------------------------------------
// Combined trusted-mutation guard
// ---------------------------------------------------------------------------

/** Options for {@link checkTrustedMutation}. */
export interface TrustedMutationOptions {
  /** The trusted origin to compare the `Origin` header against. */
  readonly expectedOrigin?: string;
  /** The CSRF token value (typically from the `X-CSRF-Token` header or form body). */
  readonly csrfValue?: unknown;
}

/** Stable, value-free rejection messages. */
const DENY_MESSAGES: Record<DenyCode, string> = {
  origin_mismatch: 'Cross-origin request rejected',
  csrf_mismatch: 'CSRF token missing or mismatch',
};

/**
 * Guard a mutation request: check same-origin first, then CSRF. Returns a
 * discriminated result — `{ allowed: true }` or a value-free
 * `{ allowed: false, code, status, message }`. Never throws for the expected
 * deny path (a mismatched origin or CSRF token).
 *
 * Both checks are skipped when the request has no session (the caller should
 * already have resolved the session to `null` before invoking this guard), so
 * a session-less request always passes. The caller is responsible for
 * resolving the session and deciding whether an anonymous mutation is allowed.
 */
export function checkTrustedMutation(
  request: Request,
  session: Session | null,
  options: TrustedMutationOptions = {},
): GuardResult {
  if (session === null) {
    return { allowed: true };
  }

  if (!isSameOriginRequest(request, options.expectedOrigin)) {
    return {
      allowed: false,
      code: 'origin_mismatch',
      status: 403,
      message: DENY_MESSAGES.origin_mismatch,
    };
  }

  if (!csrfTokenValid(session, options.csrfValue)) {
    return {
      allowed: false,
      code: 'csrf_mismatch',
      status: 403,
      message: DENY_MESSAGES.csrf_mismatch,
    };
  }

  return { allowed: true };
}
