/**
 * Mail previews — the Rails ActionMailer `preview` analog.
 *
 * A preview is a named chunk of application code that declares an example
 * mail. {@link renderMailPreview} runs that code against a fresh
 * {@link InMemoryMailTransport}, so the message is validated and captured
 * through the real `send` path, and the caller receives the exact
 * {@link ValidatedMail} a real delivery would have produced — never a
 * re-derived copy.
 *
 * Inbound mail (ActionMailbox) is out of scope: this module only previews.
 */

import { type Mailer, type ValidatedMail } from './mailer.js';
import { InMemoryMailTransport } from './transports.js';

/** Raised for an invalid preview declaration or an unknown preview name. */
export class MailPreviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MailPreviewError';
  }
}

/**
 * A preview function. It declares an example mail by calling
 * `mailer.send(message)` with the {@link MailMessage} to preview. Return or
 * `await` the `send` promise so a validation failure inside `send` propagates
 * to the renderer rather than surfacing as an unhandled rejection.
 */
export type MailPreviewFn = (mailer: Mailer) => void | Promise<void>;

/** A named preview: a stable name plus the function that declares its mail. */
export interface MailPreview {
  readonly name: string;
  readonly fn: MailPreviewFn;
}

/** An immutable registry of named mail previews. */
export interface MailPreviewRegistry {
  /** Preview names, in registration order. */
  readonly names: readonly string[];
  /** The preview function registered under `name`, or `undefined` when absent. */
  get(name: string): MailPreviewFn | undefined;
}

/**
 * Declare a named mail preview. The name must be a non-empty string and `fn` a
 * function; both are validated here so a bad declaration fails at author time
 * rather than at render time.
 */
export function defineMailPreview(name: string, fn: MailPreviewFn): MailPreview {
  const preview = { name, fn };
  assertPreview(preview);
  return Object.freeze(preview);
}

/**
 * Build a registry from preview descriptors, validating each entry and
 * rejecting a duplicate name. The registry is immutable and renders nothing on
 * its own — {@link renderMailPreview} is the only entry point that executes a
 * preview function.
 */
export function createMailPreviewRegistry(previews: readonly MailPreview[]): MailPreviewRegistry {
  if (!Array.isArray(previews)) {
    throw new MailPreviewError('mail previews must be an array');
  }
  const byName = new Map<string, MailPreviewFn>();
  for (const preview of previews) {
    assertPreview(preview);
    if (byName.has(preview.name)) {
      throw new MailPreviewError(`duplicate mail preview "${preview.name}"`);
    }
    byName.set(preview.name, preview.fn);
  }
  const names = Object.freeze([...byName.keys()]);
  return Object.freeze({
    names,
    get(name: string): MailPreviewFn | undefined {
      return byName.get(name);
    },
  });
}

/**
 * Render the named preview: run its function against a fresh in-memory
 * transport and return the single {@link ValidatedMail} it sent. An unknown
 * name raises a value-free {@link MailPreviewError}; a preview that sends
 * anything other than exactly one message is rejected the same way. A preview
 * that sends an invalid message surfaces the underlying value-free
 * {@link MailError} from validation unchanged.
 */
export async function renderMailPreview(
  registry: MailPreviewRegistry,
  name: string,
): Promise<ValidatedMail> {
  const fn = registry.get(name);
  if (fn === undefined) {
    throw new MailPreviewError('unknown mail preview');
  }
  const transport = new InMemoryMailTransport();
  await fn(transport);
  const messages = transport.messages();
  if (messages.length !== 1) {
    throw new MailPreviewError('a mail preview must send exactly one message');
  }
  return messages[0]!;
}

/** The registered preview names, sorted. */
export function listMailPreviews(registry: MailPreviewRegistry): readonly string[] {
  return [...registry.names].sort();
}

/** Validate a preview descriptor's shape: a non-empty name and a function. */
function assertPreview(value: unknown): asserts value is MailPreview {
  if (value === null || typeof value !== 'object') {
    throw new MailPreviewError('each mail preview must be an object');
  }
  const preview = value as { name?: unknown; fn?: unknown };
  if (typeof preview.name !== 'string' || preview.name.trim() === '') {
    throw new MailPreviewError('a mail preview name must be a non-empty string');
  }
  if (typeof preview.fn !== 'function') {
    throw new MailPreviewError('a mail preview must be a function');
  }
}
