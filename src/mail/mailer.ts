/**
 * Mail: the narrow message contract shared by every transport.
 *
 * A {@link Mailer} sends a single {@link MailMessage}; a {@link MailTransport}
 * is a mailer that also owns resources and can {@link MailTransport.close}.
 * The contract is deliberately small — `to`, `subject`, and an optional
 * `text`/`html` body — and does not model attachments, MIME parts, or full RFC
 * 5322 addressing. Address validation is therefore crude: an address must
 * contain `@` and carry no whitespace or control characters, and any header
 * field (`to`/`from`/`subject`) must not contain a CR/LF that could be used for
 * header injection. Full RFC validation is out of scope; a caller needing it
 * should validate upstream or rely on the transport's own checks.
 *
 * Every failure that reaches a caller is a value-free {@link MailError}: no
 * address, subject, credential, or backend detail is ever embedded, so an error
 * is safe to log or surface verbatim.
 */

/** Matches any ASCII/Unicode whitespace or control character (0x00-0x1F, 0x7F). */
const CONTROL_OR_WHITESPACE = /[\s\u0000-\u001f\u007f]/;

/** Matches a CR or LF, the two bytes that terminate a mail header line. */
const CR_LF = /[\r\n]/;

/**
 * Raised for every mail failure that reaches the caller. Messages are fixed and
 * value-free: no address, subject, credential, or backend detail is embedded.
 */
export class MailError extends Error {
  /** Stable machine code extracted from an underlying transport error, if any. */
  readonly code: string | undefined;

  constructor(message: string, options?: { code?: string }) {
    super(message);
    this.name = 'MailError';
    this.code = options?.code;
  }
}

/**
 * A message to send. `to` and `subject` are required; at least one of `text`
 * or `html` is optional (a subject-only message is technically sendable).
 * `from` overrides the transport's configured default sender, when set.
 */
export interface MailMessage {
  /** Single recipient address (bare `user@example.com`, no display name). */
  readonly to: string;
  /** Subject line; must not contain a line break. */
  readonly subject: string;
  /** Plain-text body. */
  readonly text?: string;
  /** HTML body. */
  readonly html?: string;
  /** Sender address; defaults to the transport's configured `from`. */
  readonly from?: string;
}

/** The send surface every mailer exposes. */
export interface Mailer {
  /** Validate and send one message. Rejects with a value-free {@link MailError}. */
  send(message: MailMessage): Promise<void>;
}

/** A mailer that owns resources; `close` is idempotent. */
export interface MailTransport extends Mailer {
  /** Release owned resources. Idempotent and safe after repeated calls. */
  close(): Promise<void>;
}

/** A message after validation: non-optional fields are strings, optional stay absent. */
export interface ValidatedMail {
  readonly to: string;
  readonly from: string | undefined;
  readonly subject: string;
  readonly text: string | undefined;
  readonly html: string | undefined;
}

/**
 * Crudely validate one address: it must be a non-empty string containing `@`
 * and carrying no whitespace or control characters (which also rules out a CRLF
 * header-injection attempt). Returns the address unchanged. Full RFC 5322
 * validation is deliberately out of scope.
 */
export function assertMailAddress(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new MailError(`mail ${field} must be a non-empty email address`);
  }
  if (!value.includes('@')) {
    throw new MailError(`mail ${field} must be an email address containing "@"`);
  }
  if (CONTROL_OR_WHITESPACE.test(value)) {
    throw new MailError(`mail ${field} must not contain whitespace or control characters`);
  }
  return value;
}

/**
 * Validate a full message against the contract: `to`/`from` as addresses,
 * `subject` as a non-empty header without a line break, and `text`/`html` as
 * strings when present. Returns a normalized copy. Every rejection is a
 * value-free {@link MailError}.
 */
export function validateMessage(message: MailMessage): ValidatedMail {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) {
    throw new MailError('mail message must be an object');
  }
  const to = assertMailAddress(message.to, 'to');
  const subject = message.subject;
  if (typeof subject !== 'string' || subject.trim() === '') {
    throw new MailError('mail subject must be a non-empty string');
  }
  if (CR_LF.test(subject)) {
    throw new MailError('mail subject must not contain a line break');
  }
  const from = message.from === undefined ? undefined : assertMailAddress(message.from, 'from');
  const text = message.text;
  if (text !== undefined && typeof text !== 'string') {
    throw new MailError('mail text must be a string');
  }
  const html = message.html;
  if (html !== undefined && typeof html !== 'string') {
    throw new MailError('mail html must be a string');
  }
  return { to, from, subject, text, html };
}
