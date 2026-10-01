/**
 * Login/logout and device-approval handlers for the first-party `auth` plugin.
 *
 * These are NOT filesystem API routes. They are mounted as trusted extension
 * hook routes by {@link authPlugin}, which bypasses the filesystem API
 * default-deny `authorize` pipeline and its session CSRF middleware. A plain
 * form POST therefore works even while a session cookie is present (the
 * framework would otherwise demand a matching `X-CSRF-Token` for a
 * cookie-authenticated mutation). Each handler owns its own same-origin check
 * instead.
 *
 * The Better Auth instance is passed in by the caller (the plugin owns the
 * memoized construction), so these handlers open no connection and create no
 * state of their own.
 */

import { forbiddenResponse } from '../internal/responses.js';
import { isSameOriginRequest } from '../internal/trusted-mutation.js';
import { deviceApi, type Auth } from './instance.js';

/** 303 redirect with the given `Set-Cookie` values forwarded individually. */
function redirect(location: string, cookies: readonly string[] = []): Response {
  const headers = new Headers({ location });
  for (const cookie of cookies) {
    headers.append('set-cookie', cookie);
  }
  return new Response(null, { status: 303, headers });
}

/**
 * Validate a post-login redirect target. Only a local, root-relative path is
 * accepted (no absolute URL and no protocol-relative `//` trick); anything else
 * — including an absent value — falls back to `/dashboard`, so a hostile `next`
 * can never redirect off-origin.
 */
function safeNextPath(value: string): string {
  if (value.startsWith('/') && !value.startsWith('//')) {
    return value;
  }
  return '/dashboard';
}

/**
 * Email/password login: parse the `application/x-www-form-urlencoded` form,
 * delegate to Better Auth's `signInEmail`, forward the `Set-Cookie` header, and
 * redirect. On any failure it redirects back to `/login?error=1` without
 * echoing the credentials or the underlying error.
 *
 * `expectedOrigin` is the same-origin boundary. Prefer the configured
 * `publicOrigin`; pass `undefined` to fall back to the request URL origin. A
 * request whose `Origin` header does not match is rejected with `403`.
 */
export async function handleLogin(
  request: Request,
  auth: Auth,
  expectedOrigin?: string,
): Promise<Response> {
  if (!isSameOriginRequest(request, expectedOrigin)) {
    return forbiddenResponse();
  }

  let email: unknown;
  let password: unknown;
  let next: string;
  try {
    const form = await request.formData();
    email = form.get('email');
    password = form.get('password');
    const nextValue = form.get('next');
    next = safeNextPath(typeof nextValue === 'string' ? nextValue : '');
  } catch {
    return redirect('/login?error=1');
  }

  if (
    typeof email !== 'string' ||
    email === '' ||
    typeof password !== 'string' ||
    password === ''
  ) {
    return redirect(errorRedirect(next));
  }

  try {
    const result = await auth.api.signInEmail({
      body: { email, password },
      returnHeaders: true,
    });
    return redirect(next, result.headers.getSetCookie());
  } catch {
    // Never echo the credentials or the raw error back to the client.
    return redirect(errorRedirect(next));
  }
}

/** Login failure redirect, preserving a non-default `next` for the retry. */
function errorRedirect(next: string): string {
  if (next === '/dashboard') {
    return '/login?error=1';
  }
  return `/login?error=1&next=${encodeURIComponent(next)}`;
}

/**
 * Logout: call Better Auth's `signOut` with the request headers (the session
 * cookie identifies the session), forward the cleared-cookie headers, and
 * redirect to `/login`. Signing out a stale or absent session is a no-op that
 * still redirects.
 *
 * `expectedOrigin` is the same-origin boundary, exactly as in {@link
 * handleLogin}.
 */
export async function handleLogout(
  request: Request,
  auth: Auth,
  expectedOrigin?: string,
): Promise<Response> {
  if (!isSameOriginRequest(request, expectedOrigin)) {
    return forbiddenResponse();
  }

  try {
    const result = await auth.api.signOut({
      headers: request.headers,
      returnHeaders: true,
    });
    return redirect('/login', result.headers.getSetCookie());
  } catch {
    // The session could not be cleared (no cookie, already expired, or a
    // transport failure); redirecting is still the right outcome.
    return redirect('/login');
  }
}

/**
 * Approve or deny a pending device authorization (RFC 8628).
 *
 * Mounted as trusted hook routes at `/api/device/approve` and
 * `/api/device/deny`, so it bypasses the filesystem default-deny `authorize`
 * and the session CSRF middleware — the `/device` page's form POST must work
 * even while the session cookie is present. It owns its own same-origin check.
 *
 * The `action` form field (`approve` | `deny`) is authoritative; the two mount
 * points are aliases. The handler delegates to Better Auth's `deviceApprove` /
 * `deviceDeny` endpoints with the request headers (the session cookie
 * identifies the caller), which enforce the claim/ownership/expiry state
 * machine server-side. It always redirects back to `/device?user_code=...`,
 * where the page's `load` re-reads the code through `deviceVerify` to show the
 * resulting state; a failure (stale, already processed, wrong user) is
 * swallowed rather than echoed because the re-read is authoritative.
 */
export async function handleDeviceAction(
  request: Request,
  auth: Auth,
  expectedOrigin?: string,
): Promise<Response> {
  if (!isSameOriginRequest(request, expectedOrigin)) {
    return forbiddenResponse();
  }

  let userCode: unknown;
  let action: unknown;
  try {
    const form = await request.formData();
    userCode = form.get('user_code');
    action = form.get('action');
  } catch {
    return redirect('/device');
  }

  if (typeof userCode !== 'string' || userCode === '') {
    return redirect('/device');
  }

  const back = `/device?user_code=${encodeURIComponent(userCode)}`;
  const deny = action === 'deny';

  try {
    if (deny) {
      await deviceApi(auth).deviceDeny({ body: { userCode }, headers: request.headers });
    } else {
      await deviceApi(auth).deviceApprove({ body: { userCode }, headers: request.headers });
    }
  } catch {
    // Stale, already-processed, or claimed by another session. Never echo the
    // underlying error; the review page re-reads the code and shows the state.
  }
  return redirect(back);
}

// --- Shared helpers for the registration/reset/verification handlers. ---

/** A JSON response body with the given status (default 200). */
export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/**
 * Parse a form body into flat string fields. Non-string entries (file uploads)
 * are skipped; a body that is not `application/x-www-form-urlencoded` or
 * `multipart/form-data` throws, which callers map to a generic 400.
 */
export async function readBody(request: Request): Promise<Record<string, string>> {
  const form = await request.formData();
  const body: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    if (typeof value === 'string') {
      body[key] = value;
    }
  }
  return body;
}

/** Whether `value` is a non-empty, plausibly well-formed email address. */
export function isEmail(value: unknown): value is string {
  return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

/** A per-email rate-limit gate: an exact `true` allows, anything else (or a throw) denies. */
export type RateLimitHook = (email: string) => boolean | Promise<boolean>;

/**
 * Evaluate a rate-limit hook. Returns `true` only for an exact `true` result;
 * `false`, a truthy non-boolean, or a throw all deny (fail closed).
 */
export async function rateLimitAllows(hook: RateLimitHook, email: string): Promise<boolean> {
  try {
    return (await hook(email)) === true;
  } catch {
    return false;
  }
}
