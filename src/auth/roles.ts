/**
 * Role helpers for the first-party `auth` plugin.
 *
 * Better Auth's user table has no built-in role column; an application that
 * wants role-based access carries the role in the session's `data` (e.g. a
 * `role` field populated by a custom `sessionResolver`). These helpers read
 * that field and produce the default-deny predicates the admin panel and API
 * resources expect: a session with no string role is treated as having no role
 * at all, and never throws on a malformed session.
 */

import type { Session } from '../contracts/http.js';

/** A role gate usable anywhere an `AdminPanelAuthorize`/`authorize` predicate is accepted. */
export type RoleCheck = (session: Session | null) => boolean | Promise<boolean>;

/**
 * Read the `role` from a session's data, or `null` when absent or not a string.
 */
export function sessionRole(session: Session | null): string | null {
  const role = session?.data.role;
  return typeof role === 'string' ? role : null;
}

/**
 * Build a predicate that allows exactly the named roles. A session with no (or
 * a non-string) role is denied; the result is `false`, never an exception.
 */
export function requireRole(...roles: readonly string[]): RoleCheck {
  return (session) => {
    const role = sessionRole(session);
    return role !== null && roles.includes(role);
  };
}

/** Predicate allowing only sessions whose role is exactly `admin`. */
export const adminOnly: RoleCheck = (session) => sessionRole(session) === 'admin';
