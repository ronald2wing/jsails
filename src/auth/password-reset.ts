/**
 * Password reset and email verification for the first-party `auth` plugin.
 *
 * Both surfaces delegate to Better Auth: `handleRequestPasswordReset` /
 * `handleResetPassword` call `requestPasswordReset` / `resetPassword`, and
 * `handleSendVerificationEmail` calls `sendVerificationEmail`. The delivery
 * callbacks (`emailAndPassword.sendResetPassword` and
 * `emailVerification.sendVerificationEmail`) are built from an injected
 * {@link SendMailFn} by {@link buildResetPasswordSender} and
 * {@link buildVerificationSender}, so the plugin never hard-depends on any
 * mail transport — the app wires `sendMail` to whatever it uses (for example
 * the `jsails/mail` `Mailer`).
 *
 * Better Auth already answers "user not found" for a reset request and a
 * verification send with the same shape (and a timing floor) as a real send,
 * so these handlers add no enumeration signal of their own; they only
 * validate, rate-limit, and delegate.
 */

import { forbiddenResponse } from '../internal/responses.js';
import { isSameOriginRequest } from '../internal/trusted-mutation.js';
import type { Auth } from './instance.js';
import { isEmail, json, rateLimitAllows, readBody, type RateLimitHook } from './routes.js';

/** Minimal mail delivery seam: recipient address, subject, and plain-text body. */
export type SendMailFn = (to: string, subject: string, text: string) => void | Promise<void>;

/** Options for the password-reset surface. */
export interface PasswordResetOptions {
  /** Mount `POST /api/password-reset` and `POST /api/password-reset/confirm`. Defaults to `false`. */
  readonly enabled?: boolean;
  /** Optional per-email rate-limit gate for the request step. */
  readonly rateLimit?: RateLimitHook;
}

/** Options for the email-verification surface. */
export interface VerificationOptions {
  /** Mount `POST /api/verification/send`. Defaults to `false`. */
  readonly enabled?: boolean;
  /** Optional per-email rate-limit gate. */
  readonly rateLimit?: RateLimitHook;
}

/** The shape Better Auth hands to a send-email callback. */
interface EmailPayload {
  readonly user: { readonly email: string };
  readonly url: string;
  readonly token: string;
}

/** Build Better Auth's `emailAndPassword.sendResetPassword` from a mail seam. */
export function buildResetPasswordSender(sendMail: SendMailFn) {
  return async (data: EmailPayload): Promise<void> => {
    await sendMail(
      data.user.email,
      'Reset your password',
      `A password reset was requested for ${data.user.email}.\n\n` +
        `Reset your password here: ${data.url}\n\n` +
        'If you did not request this, you can ignore this email.',
    );
  };
}

/** Build Better Auth's `emailVerification.sendVerificationEmail` from a mail seam. */
export function buildVerificationSender(sendMail: SendMailFn) {
  return async (data: EmailPayload): Promise<void> => {
    await sendMail(
      data.user.email,
      'Verify your email address',
      `Verify your email address here: ${data.url}\n\n` +
        'If you did not create an account, you can ignore this email.',
    );
  };
}

/** Handle `POST /api/password-reset` (form field `email`). */
export async function handleRequestPasswordReset(
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

  const email = body.email;
  if (!isEmail(email)) {
    return json({ error: 'invalid email address' }, 400);
  }

  if (rateLimit !== undefined && !(await rateLimitAllows(rateLimit, email))) {
    return json({ error: 'too many requests' }, 429);
  }

  try {
    // Better Auth answers unknown emails identically (and with a timing floor),
    // so this yields the same generic result whether or not the account exists.
    await auth.api.requestPasswordReset({ body: { email } });
  } catch {
    // A provider-level failure (e.g. the send callback is not wired) is a
    // server fault, not a user error; report it generically without leaking why.
    return json({ error: 'internal error' }, 500);
  }

  return json({ status: 'ok' });
}

/** Handle `POST /api/password-reset/confirm` (form fields `token`, `newPassword`). */
export async function handleResetPassword(
  request: Request,
  auth: Auth,
  expectedOrigin?: string,
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

  const { token, newPassword } = body;
  if (
    typeof token !== 'string' ||
    token === '' ||
    typeof newPassword !== 'string' ||
    newPassword === ''
  ) {
    return json({ error: 'invalid request' }, 422);
  }

  try {
    // Single-use: Better Auth consumes the token and rejects reuse or expiry.
    await auth.api.resetPassword({ body: { newPassword, token } });
  } catch {
    return json({ error: 'invalid or expired token' }, 422);
  }

  return json({ status: 'ok' });
}

/** Handle `POST /api/verification/send` (form field `email`). */
export async function handleSendVerificationEmail(
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

  const email = body.email;
  if (!isEmail(email)) {
    return json({ error: 'invalid email address' }, 400);
  }

  if (rateLimit !== undefined && !(await rateLimitAllows(rateLimit, email))) {
    return json({ error: 'too many requests' }, 429);
  }

  try {
    await auth.api.sendVerificationEmail({ body: { email } });
  } catch {
    return json({ error: 'verification email could not be sent' }, 400);
  }

  return json({ status: 'ok' });
}
