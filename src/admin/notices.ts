/**
 * Admin notices: a small registry of server-rendered flash messages keyed by a
 * stable code.
 *
 * `defineNotice(code, { level, message })` validates a notice — a code (a bare
 * identifier with no slashes), a severity `level`, and a non-empty `message` —
 * and returns a frozen {@link Notice} descriptor. A panel declares notices via
 * `defineAdminPanel({ notices })`; the admin plugin maps a `?_notice=<code>`
 * query parameter onto the registered message and renders it with level styling.
 * An unknown code is dropped (no message, no error), so a stale or forged
 * notice never surfaces arbitrary text.
 *
 * The module is ORM-free and performs no I/O.
 */

/** Notice severity levels. */
export type NoticeLevel = 'success' | 'info' | 'warning' | 'error';

/** A frozen, validated notice descriptor. */
export interface Notice {
  /** Stable code referenced by `?_notice=` query parameters. */
  readonly code: string;
  /** Severity level rendered as a styling hook. */
  readonly level: NoticeLevel;
  /** Human message text (escaped by the renderer). */
  readonly message: string;
}

/** The message body of a notice, keyed by code at `defineNotice`. */
export interface NoticeDefinition {
  /** Severity level. */
  readonly level: NoticeLevel;
  /** Human message text. */
  readonly message: string;
}

/** Raised for invalid notice definitions. Messages never embed input values. */
export class NoticeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoticeError';
  }
}

/** A code identifier: letters, digits, dots, underscores, and hyphens. */
const CODE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

const LEVELS: ReadonlySet<string> = new Set(['success', 'info', 'warning', 'error']);

/** The built-in success notice used when an action declares no `notice` code. */
export const ADMIN_ACTION_SUCCESS_CODE = 'admin-action-success';

/** The built-in success notice descriptor (always available to the panel). */
export const ADMIN_ACTION_SUCCESS_NOTICE: Notice = Object.freeze({
  code: ADMIN_ACTION_SUCCESS_CODE,
  level: 'success',
  message: 'Action completed.',
});

/** Validate a code + message body and return a frozen {@link Notice}. */
export function defineNotice(code: string, spec: NoticeDefinition): Notice {
  if (typeof code !== 'string' || !CODE_PATTERN.test(code)) {
    throw new NoticeError('notice code must be an identifier with no slashes');
  }
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new NoticeError('defineNotice requires a spec object');
  }
  if (typeof spec.level !== 'string' || !LEVELS.has(spec.level)) {
    throw new NoticeError('notice level is not supported');
  }
  if (typeof spec.message !== 'string' || spec.message.trim() === '') {
    throw new NoticeError('notice message must be a non-empty string');
  }
  return Object.freeze({ code, level: spec.level, message: spec.message });
}
