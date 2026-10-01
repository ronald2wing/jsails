/**
 * Auth session service token and its contract.
 *
 * The first-party `auth` plugin (`authPlugin`) provides an {@link
 * AuthSessionService} under this token during setup; any extension declared
 * later can consume it through `requires: [authSessionToken]` and
 * `services.get(authSessionToken)`. The `admin` plugin uses exactly this seam:
 * instead of being handed a `resolveSession` callback, it can require the auth
 * service and derive its session resolver from it.
 *
 * The module carries only the token (a plain object) and two type-only
 * imports (`Auth`, `Session`), so importing it never pulls Better Auth, Kysely,
 * `mysql2`, or any ORM/HTTP runtime into a consumer — the admin subpath stays
 * free of the auth plugin's runtime dependencies.
 */

import type { Session } from '../contracts/http.js';
import { createServiceToken, type ServiceToken } from '../extensions/services.js';
import type { Auth } from './instance.js';

/**
 * The service the `auth` plugin provides: the lazily-built Better Auth instance
 * plus a trusted session resolver mapping a request to the JSails {@link
 * Session} shape (or `null` when unauthenticated).
 */
export interface AuthSessionService {
  /** The plugin's memoized Better Auth instance. */
  readonly getAuth: () => Auth;
  /** Resolve the JSails session for a request, or `null` when unauthenticated. */
  readonly resolveSession: (request: Request) => Promise<Session | null>;
}

/**
 * Opaque token for the {@link AuthSessionService}. Defined once here and shared
 * by the provider (`authPlugin`) and consumers (the `admin` plugin's `requires`).
 */
export const authSessionToken: ServiceToken<AuthSessionService> =
  createServiceToken<AuthSessionService>('auth.session');
