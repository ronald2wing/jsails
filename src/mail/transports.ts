/**
 * Mail transports: three ways to deliver a validated {@link MailMessage}.
 *
 * - {@link createMemoryTransport} captures messages in-process — the zero-cost
 *   default for tests, demos, and development. It is explicit, never selected
 *   implicitly by the plugin.
 * - {@link createSmtpTransport} delivers over SMTP through nodemailer. It is
 *   fully lazy: importing this module loads no nodemailer, and constructing a
 *   transport neither connects nor resolves a URL — the nodemailer module and
 *   the connection are created on the first `send` only. Errors are sanitized
 *   into a value-free {@link MailError} (a connection URL may embed credentials
 *   and is never echoed), and `close` is idempotent.
 * - {@link createCallbackTransport} forwards each validated message to an
 *   injected callback — a seam for tests, logging, and custom delivery.
 *
 * Every transport validates its input through the shared
 * {@link validateMessage}, so a bad address or a header-injection attempt fails
 * the same way regardless of the backend.
 */

import {
  assertMailAddress,
  MailError,
  validateMessage,
  type MailTransport,
  type ValidatedMail,
} from './mailer.js';
import { errnoCode } from '../internal/errors.js';
import { createCleanup } from '../internal/cleanup.js';

/** A transport that captures every validated message in memory. */
export interface MemoryMailTransport extends MailTransport {
  /** The messages sent so far, in order (a copy; the store is not mutable). */
  messages(): readonly ValidatedMail[];
}

/**
 * Create an in-memory transport. Messages are validated then captured; nothing
 * leaves the process. `close` drops the captured messages and is idempotent.
 * This is the explicit test/dev default, never chosen implicitly by the plugin.
 */
export function createMemoryTransport(): MemoryMailTransport {
  const captured: ValidatedMail[] = [];
  let closed = false;

  return {
    async send(message) {
      if (closed) {
        throw new MailError('the mail transport is closed');
      }
      captured.push(validateMessage(message));
    },
    messages: () => [...captured],
    async close() {
      closed = true;
      captured.length = 0;
    },
  };
}

/** The minimal surface a callback transport forwards each message to. */
export type MailCallback = (message: ValidatedMail) => void | Promise<void>;

/**
 * Create a transport that forwards every validated message to `fn`. Useful for
 * tests and for routing mail to a custom sink. The callback is trusted
 * application code and owns any persistence or delivery it performs.
 */
export function createCallbackTransport(fn: MailCallback): MailTransport {
  if (typeof fn !== 'function') {
    throw new TypeError('createCallbackTransport requires a callback function');
  }
  let closed = false;

  return {
    async send(message) {
      if (closed) {
        throw new MailError('the mail transport is closed');
      }
      await fn(validateMessage(message));
    },
    async close() {
      closed = true;
    },
  };
}

/** Options for {@link createSmtpTransport}. Exactly one of `url` or `host`. */
export interface SmtpTransportOptions {
  /** A full connection URL (e.g. `smtps://user:pass@host:465`). */
  readonly url?: string;
  /** SMTP host. */
  readonly host?: string;
  /** SMTP port. Defaults to the transport's own default for `secure`. */
  readonly port?: number;
  /** SMTP username. */
  readonly user?: string;
  /** SMTP password. */
  readonly pass?: string;
  /** Default sender address used when a message omits `from`. */
  readonly from?: string;
  /** `true` for implicit TLS (port 465), `false` for STARTTLS. */
  readonly secure?: boolean;
}

/** The connection descriptor handed to the nodemailer (or injected) factory. */
export interface SmtpConnectionConfig {
  readonly host?: string;
  readonly port?: number;
  readonly secure?: boolean;
  readonly auth?: { readonly user?: string; readonly pass?: string };
}

/** The underlying transporter surface the SMTP transport depends on. */
export interface SmtpTransporter {
  sendMail(mail: SmtpMailOptions): Promise<unknown>;
  close(): void;
}

/** The send options the SMTP transport forwards to the underlying transporter. */
export interface SmtpMailOptions {
  readonly from?: string;
  readonly to: string;
  readonly subject: string;
  readonly text?: string;
  readonly html?: string;
}

/**
 * Test seam: replace the underlying transporter factory. Defaults to loading
 * nodemailer lazily and calling its `createTransport`. Exported so tests can
 * exercise laziness, sanitized errors, and close idempotency without a live
 * SMTP server. Not re-exported from the `jsails/mail` entry.
 */
export interface SmtpTransportDependencies {
  readonly createTransport: (
    config: SmtpConnectionConfig | string,
  ) => SmtpTransporter | Promise<SmtpTransporter>;
}

/**
 * Create an SMTP transport over nodemailer.
 *
 * Construction is fully lazy: no nodemailer is loaded and no connection is
 * opened until the first `send`. The connection descriptor is either the
 * supplied `url` (a string, used verbatim) or an object built from
 * `host`/`port`/`secure`/`user`/`pass`. Requiring neither throws a value-free
 * {@link MailError} at construction. A failed send is surfaced as a sanitized,
 * value-free {@link MailError}; `close` closes the underlying transporter
 * exactly once and is a no-op when nothing was ever created.
 */
export function createSmtpTransport(
  options: SmtpTransportOptions,
  dependencies?: SmtpTransportDependencies,
): MailTransport {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('createSmtpTransport requires an options object');
  }
  const from = options.from === undefined ? undefined : assertMailAddress(options.from, 'from');
  if (options.url === undefined && options.host === undefined) {
    throw new MailError('no SMTP configuration: provide a url or a host');
  }

  const url = options.url === undefined ? undefined : assertSmtpUrl(options.url);
  const connection: SmtpConnectionConfig | string =
    url !== undefined
      ? url
      : {
          host: options.host,
          port: options.port,
          secure: options.secure,
          auth:
            options.user !== undefined || options.pass !== undefined
              ? { user: options.user, pass: options.pass }
              : undefined,
        };

  let transporterPromise: Promise<SmtpTransporter> | undefined;
  let closed = false;

  function ensureTransporter(): Promise<SmtpTransporter> {
    if (closed) {
      throw new MailError('the mail transport is closed');
    }
    if (transporterPromise === undefined) {
      const pending = createTransporter(connection, dependencies);
      transporterPromise = pending;
      // A failed construction is not memoized: the next send retries.
      void pending.catch(() => {
        if (transporterPromise === pending) {
          transporterPromise = undefined;
        }
      });
    }
    return transporterPromise;
  }

  // Concurrent-safe teardown: two simultaneous `close()` calls share one
  // transporter shutdown. `closed` is still set synchronously by `close()` so a
  // racing send is rejected before the transporter is torn down.
  const closeOnce = createCleanup(async () => {
    const pending = transporterPromise;
    transporterPromise = undefined;
    if (pending === undefined) {
      return;
    }
    const transporter = await pending.catch(() => undefined);
    if (transporter === undefined) {
      return;
    }
    try {
      transporter.close();
    } catch {
      // Teardown errors are ignored: shutdown must complete.
    }
  });

  return {
    async send(message) {
      const validated = validateMessage(message);
      const transporter = await ensureTransporter();
      try {
        await transporter.sendMail({
          from: validated.from ?? from,
          to: validated.to,
          subject: validated.subject,
          text: validated.text,
          html: validated.html,
        });
      } catch (error) {
        throw sanitizeMailError(error);
      }
    },
    async close() {
      closed = true;
      await closeOnce();
    },
  };
}

/** Resolve the transporter factory and construct the underlying transporter. */
async function createTransporter(
  connection: SmtpConnectionConfig | string,
  dependencies: SmtpTransportDependencies | undefined,
): Promise<SmtpTransporter> {
  try {
    const createTransport =
      dependencies?.createTransport ?? (await loadNodemailerCreateTransport());
    return await createTransport(connection);
  } catch (error) {
    throw sanitizeMailError(error);
  }
}

/** Load nodemailer's `createTransport` lazily, only when no seam is present. */
async function loadNodemailerCreateTransport(): Promise<
  (config: SmtpConnectionConfig | string) => SmtpTransporter
> {
  const nodemailer = await import('nodemailer');
  return (config) => nodemailer.createTransport(config);
}

/** Reduce a backend error to a payload-free {@link MailError}. */
function sanitizeMailError(error: unknown): MailError {
  const code = errnoCode(error);
  return new MailError(
    code === undefined ? 'mail transport error' : `mail transport error (${code})`,
    { code },
  );
}

/**
 * Validate a connection URL as an explicit `smtp://`/`smtps://` URL, returning
 * it unchanged. Rejects anything else with a value-free {@link MailError}; the
 * value (which may embed credentials) is never echoed.
 */
function assertSmtpUrl(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new MailError('the SMTP connection URL must be a non-empty smtp:// or smtps:// URL');
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new MailError('the SMTP connection URL must be a valid smtp:// or smtps:// URL');
  }
  if (parsed.protocol !== 'smtp:' && parsed.protocol !== 'smtps:') {
    throw new MailError('the SMTP connection URL must use the smtp:// or smtps:// scheme');
  }
  return value;
}
