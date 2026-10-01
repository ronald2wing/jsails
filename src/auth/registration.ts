/**
 * Self-registration for the first-party `auth` plugin.
 *
 * `handleRegister` is mounted at `POST /api/register` by `authPlugin` only when
 * `registration.enabled` is `true`. It is a trusted hook route (not a
 * filesystem API route) that owns its same-origin check. It delegates to Better
 * Auth's `signUpEmail` with `autoSignIn` disabled, so a successful registration
 * creates the account without a session, and a duplicate email is answered
 * identically to a fresh one — the response never leaks which addresses exist.
 */

import { forbiddenResponse } from '../internal/responses.js';
import { isSameOriginRequest } from '../internal/trusted-mutation.js';
import type { Auth } from './instance.js';
import { isEmail, json, rateLimitAllows, readBody, type RateLimitHook } from './routes.js';

/** Options for the self-registration surface. */
export interface RegistrationOptions {
  /** Mount `POST /api/register` and allow self sign-up. Defaults to `false` (fail closed). */
  readonly enabled?: boolean;
  /** Optional per-email rate-limit gate; a non-`true` (or throwing) result yields a generic 429. */
  readonly rateLimit?: RateLimitHook;
}

/**
 * Handle a `POST /api/register` form (`name`, `email`, `password`). On success
 * it returns `200 { status: 'ok' }` with no session cookie; every failure — an
 * invalid email/password, a duplicate account, or a provider error — collapses
 * to a value-free `422` so the response never distinguishes a new account from
 * an existing one.
 */
export async function handleRegister(
  request: Request,
  auth: Auth,
  expectedOrigin?: string,
  rateLimit?: RateLimitHook,
): Promise<Response> {
  if (!isSameOriginRequest(request, expectedOrigin)) {
    return forbiddenResponse();
  }

  let body: Record<string, string>;
  try {
    body = await readBody(request);
  } catch {
    return json({ error: 'invalid request' }, 400);
  }

  const { name, email, password } = body;
  if (
    typeof name !== 'string' ||
    name.trim() === '' ||
    !isEmail(email) ||
    typeof password !== 'string' ||
    password === ''
  ) {
    return json({ error: 'invalid registration details' }, 422);
  }

  if (rateLimit !== undefined && !(await rateLimitAllows(rateLimit, email))) {
    return json({ error: 'too many requests' }, 429);
  }

  try {
    await auth.api.signUpEmail({ body: { name, email, password } });
    return json({ status: 'ok' });
  } catch {
    // Never distinguish a duplicate email from a provider failure.
    return json({ error: 'registration failed' }, 422);
  }
}
