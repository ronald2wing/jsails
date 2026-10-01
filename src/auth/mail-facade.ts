/**
 * Mail facade + auth `sendMail` adapter (server-only).
 *
 * The `Mail` facade resolves the `jsails/mail` `Mailer` through the ambient
 * application scope, so `sendMail` (the `auth` plugin's password-reset /
 * email-verification seam) can hand a real message to whatever transport the
 * mail plugin configured — with no hard dependency: `Mail.send` fails with
 * `FacadeError('no_app_scope')` outside a live scope, which is correct.
 */

import { facade } from '../facades/facade.js';
import type { Mailer } from '../mail/mailer.js';
import { mailToken } from '../mail/plugin.js';
import type { SendMailFn } from './password-reset.js';

/** Ambient mailer facade: `Mail.send({ to, subject, text })`. */
export const Mail: Mailer = facade(mailToken);

/**
 * The `auth` plugin's `sendMail` seam, backed by the ambient `Mail` facade.
 * Sends a plain-text message; a missing mailer (no scope) rejects.
 */
export const sendMail: SendMailFn = (to, subject, text) =>
  Mail.send({ to, subject, text }).then(() => undefined);

/**
 * The `auth` plugin's `sendMagicLink` seam, backed by the ambient `Mail`
 * facade: emits a plain-text message carrying just the link URL.
 */
export const sendMagicLink = (data: { email: string; url: string }): void | Promise<void> =>
  Mail.send({ to: data.email, subject: 'Your sign-in link', text: `Sign in:\n\n${data.url}` }).then(
    () => undefined,
  );
