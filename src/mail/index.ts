/**
 * The first-party mail subpath (`jsails/mail`).
 *
 * A minimal, transport-agnostic mail seam: the {@link Mailer} contract, three
 * transports ({@link InMemoryMailTransport} (in-memory capture),
 * {@link SmtpMailTransport} (lazy SMTP over nodemailer), and
 * {@link CallbackMailTransport} (injected callback)), and the
 * {@link mailPlugin} that exposes an application mailer under a typed service
 * token with lazy, fail-closed transport resolution.
 *
 * Importing this barrel pulls in nodemailer's type declarations only at the
 * type level (`transports.ts` loads nodemailer lazily at first send), so the
 * subpath is safe to import in a browser-free server context.
 */

export {
  assertMailAddress,
  MailError,
  validateMessage,
  type Mailer,
  type MailMessage,
  type MailTransport,
  type ValidatedMail,
} from './mailer.js';

export {
  CallbackMailTransport,
  InMemoryMailTransport,
  SmtpMailTransport,
  type MailCallback,
  type MemoryMailTransport,
  type SmtpConnectionConfig,
  type SmtpMailOptions,
  type SmtpTransportDependencies,
  type SmtpTransportOptions,
  type SmtpTransporter,
} from './transports.js';

export { mailPlugin, mailToken, type MailPluginOptions } from './plugin.js';

export {
  createMailPreviewRegistry,
  defineMailPreview,
  listMailPreviews,
  MailPreviewError,
  renderMailPreview,
  type MailPreview,
  type MailPreviewFn,
  type MailPreviewRegistry,
} from './previews.js';

// The declarative loader calls `mod.default(options)`, so every first-party
// subpath barrel must default-export its factory alongside the named export.
export { mailPlugin as default } from './plugin.js';
