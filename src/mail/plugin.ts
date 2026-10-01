/**
 * First-party `mail` plugin: exposes an application {@link Mailer} under a typed
 * service token, owned and torn down by the plugin.
 *
 * `mailPlugin({ transport? | smtp? | allowMemory? })` builds a {@link JsailsPlugin}
 * named `mail` whose `setup` provides the mailer under {@link mailToken}. The
 * transport is resolved lazily on the first `send` with this precedence:
 *
 * 1. an explicit `transport` — used verbatim (identity preserved) and never
 *    closed by the plugin;
 * 2. an explicit `smtp` configuration (`url`, or `host`/`port`/`user`/`pass`);
 * 3. an SMTP URL from the environment (`MAIL_URL`, then `SMTP_URL`);
 * 4. an in-memory transport, only when `allowMemory: true`;
 * 5. otherwise a value-free {@link MailError} — production fails closed rather
 *    than silently dropping mail.
 *
 * Construction is lazy: nothing is imported, connected, or validated against
 * the environment at import, plugin construction, or `setup`. The transport
 * (and, for SMTP, nodemailer and its connection) is created on the first `send`
 * and reused thereafter. The cleanup closes only a plugin-owned transport, and
 * is a no-op when an explicit transport was provided or none was ever created.
 */

import { definePlugin, type JsailsPlugin } from '../extensions/plugin-contract.js';
import { createServiceToken, type ServiceToken } from '../extensions/services.js';
import { MailError, type Mailer, type MailTransport } from './mailer.js';
import {
  createMemoryTransport,
  createSmtpTransport,
  type SmtpTransportOptions,
} from './transports.js';

/**
 * Opaque token for the application {@link Mailer}. Defined once here and shared
 * by the provider (`mailPlugin`) and any consumer (e.g. an extension's
 * `requires`).
 */
export const mailToken: ServiceToken<Mailer> = createServiceToken<Mailer>('mail');

/** Options accepted by {@link mailPlugin}. */
export interface MailPluginOptions {
  /** Caller-provided transport; used verbatim and never closed by the plugin. */
  readonly transport?: MailTransport;
  /** Explicit SMTP configuration (`url`, or `host`/`port`/`user`/`pass`). */
  readonly smtp?: SmtpTransportOptions;
  /**
   * When `true` and no other transport is configured, fall back to an in-memory
   * transport (tests/dev). Defaults to `false` so production fails closed with
   * a value-free error instead of silently capturing mail.
   */
  readonly allowMemory?: boolean;
}

/** A resolved transport plus whether the plugin owns (and must close) it. */
interface ResolvedTransport {
  readonly transport: MailTransport;
  readonly owned: boolean;
}

/**
 * Build the first-party `mail` plugin. The returned plugin is inert: nothing is
 * imported, connected, or environment-resolved until the first `send` through
 * the service.
 */
export function mailPlugin(options: MailPluginOptions = {}): JsailsPlugin {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('mailPlugin requires an options object');
  }
  if (options.allowMemory !== undefined && typeof options.allowMemory !== 'boolean') {
    throw new TypeError('allowMemory must be a boolean');
  }
  if (options.transport !== undefined && !isTransport(options.transport)) {
    throw new TypeError('transport must be a mail transport');
  }
  if (
    options.smtp !== undefined &&
    (options.smtp === null || typeof options.smtp !== 'object' || Array.isArray(options.smtp))
  ) {
    throw new TypeError('smtp must be an SMTP transport options object');
  }

  return definePlugin({
    name: 'mail',
    setup({ services }) {
      let resolved: ResolvedTransport | undefined;
      let closed = false;

      function ensureTransport(): MailTransport {
        if (closed) {
          throw new MailError('the mail transport is closed');
        }
        // A failed resolution is not memoized, so a later send can retry.
        resolved ??= resolveTransport(options);
        return resolved.transport;
      }

      services.provide(mailToken, {
        // `async` so a synchronous resolution failure (e.g. the fail-closed
        // "no transport configured" error) surfaces as a rejection, never a
        // synchronous throw, keeping the `Promise<void>` contract of `send`.
        async send(message) {
          return ensureTransport().send(message);
        },
      });

      return async () => {
        closed = true;
        if (resolved?.owned === true) {
          await resolved.transport.close();
        }
      };
    },
  });
}

/** Resolve the transport per the documented precedence, reading env lazily. */
function resolveTransport(options: MailPluginOptions): ResolvedTransport {
  if (options.transport !== undefined) {
    return { transport: options.transport, owned: false };
  }
  if (options.smtp !== undefined) {
    return { transport: createSmtpTransport(options.smtp), owned: true };
  }
  const url = firstConfigured(process.env.MAIL_URL, process.env.SMTP_URL);
  if (url !== undefined) {
    return { transport: createSmtpTransport({ url }), owned: true };
  }
  if (options.allowMemory === true) {
    return { transport: createMemoryTransport(), owned: true };
  }
  throw new MailError(
    'no mail transport configured: provide a transport or smtp option, or set MAIL_URL/SMTP_URL',
  );
}

/** Whether `value` has the {@link MailTransport} surface (send + close). */
function isTransport(value: unknown): value is MailTransport {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { send?: unknown }).send === 'function' &&
    typeof (value as { close?: unknown }).close === 'function'
  );
}

/** First non-empty value across the environment variables (`MAIL_URL` first). */
function firstConfigured(...values: (string | undefined)[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') {
      return value;
    }
  }
  return undefined;
}
