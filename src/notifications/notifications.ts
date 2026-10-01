/**
 * Notifications: the narrow multi-channel delivery seam shared by the plugin and
 * every channel.
 *
 * A {@link NotificationMessage} is deliberately smaller than a mail message —
 * `to`, `subject`, and a required plain-text `text` body — so any channel
 * (mail, SMS, push, ...) can consume it. A {@link NotificationChannel} delivers
 * one message to one destination; it is stateless with respect to the plugin and
 * owns no connection, so the plugin never closes it.
 *
 * Two channels ship here:
 *
 * - {@link createMemoryChannel} captures messages in-process — the zero-cost
 *   default for tests and demos. It is explicit, never selected implicitly.
 * - {@link createMailChannel} adapts the first-party mail service's
 *   {@link Mailer} (see `jsails/mail`) into a channel. It depends on the mail
 *   surface through `import type` only, so this module gains no nodemailer or
 *   mail-transport runtime.
 *
 * Delivery is fire-and-forget within the process: {@link createNotificationsService}
 * sends through every selected channel, waits for all of them, and aggregates
 * any failures into a value-free {@link NotificationError} that lists only the
 * failed channel names — never an underlying transport error, address, subject,
 * credential, or payload.
 *
 * There is deliberately no durable queue, retry policy, or database in this
 * slice. An application that needs retries or out-of-process delivery should
 * enqueue the message with the jobs plugin and send from the job handler
 * instead of calling `notify` directly; the channel remains the delivery
 * primitive either way.
 */

import type { Mailer } from '../mail/mailer.js';

/** A message to deliver. Every field is required and non-optional. */
export interface NotificationMessage {
  /** Single recipient address (channel-specific format, e.g. an email address). */
  readonly to: string;
  /** Subject line. */
  readonly subject: string;
  /** Plain-text body. */
  readonly text: string;
}

/** The delivery surface every channel exposes. */
export interface NotificationChannel {
  /** Deliver one message. Rejects on failure; the error is never surfaced verbatim. */
  send(message: NotificationMessage): Promise<void>;
}

/**
 * Raised when one or more channels fail to deliver a message. The message is
 * value-free and lists only the failed channel names (configuration identifiers,
 * never user input or backend detail); the names are also exposed on
 * {@link NotificationError.channels}.
 */
export class NotificationError extends Error {
  /** The failed channel names, in configuration order. */
  readonly channels: readonly string[];

  constructor(channels: readonly string[]) {
    super(`notification delivery failed for channel(s): ${channels.join(', ')}`);
    this.name = 'NotificationError';
    this.channels = Object.freeze([...channels]);
  }
}

/** Options for {@link NotificationsService.notify}. */
export interface NotifyOptions {
  /** The channels to use, in order. Omit to use every configured channel. */
  readonly channels?: readonly string[];
}

/** The service the notifications plugin provides: send through named channels. */
export interface NotificationsService {
  /**
   * Deliver one message through the selected channels (all configured channels
   * when `options.channels` is omitted) in order, waiting for every attempt.
   * Any failures are aggregated into a value-free {@link NotificationError};
   * an unknown channel name rejects before any channel is attempted.
   */
  notify(message: NotificationMessage, options?: NotifyOptions): Promise<void>;
}

/** A channel that captures every message in memory. */
export interface MemoryNotificationChannel extends NotificationChannel {
  /** The messages captured so far, in order (a copy; the store is not mutable). */
  messages(): readonly NotificationMessage[];
}

/**
 * Create an in-memory channel. Messages are captured (copied) and nothing
 * leaves the process. This is the explicit test/demo channel, never chosen
 * implicitly by the plugin.
 */
export function createMemoryChannel(): MemoryNotificationChannel {
  const captured: NotificationMessage[] = [];
  return {
    async send(message) {
      captured.push({ to: message.to, subject: message.subject, text: message.text });
    },
    messages: () => [...captured],
  };
}

/** Options for {@link createMailChannel}. */
export interface CreateMailChannelOptions {
  /** The mailer to deliver through. */
  readonly mailer: Mailer;
}

/**
 * Adapt the mail service's {@link Mailer} into a {@link NotificationChannel}.
 * The `text` body is forwarded as the mail text body; `html`/`from` are left to
 * the mailer's own defaults. Message validation is the mailer's (value-free
 * {@link MailError}), never this adapter's.
 */
export function createMailChannel(options: CreateMailChannelOptions): NotificationChannel {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('createMailChannel requires an options object');
  }
  const mailer = options.mailer;
  if (
    mailer === null ||
    typeof mailer !== 'object' ||
    typeof (mailer as { send?: unknown }).send !== 'function'
  ) {
    throw new TypeError('mailer must implement the Mailer contract');
  }
  return {
    async send(message) {
      await mailer.send({ to: message.to, subject: message.subject, text: message.text });
    },
  };
}

/** An internal pairing of a channel with its configuration name. */
interface NamedChannel {
  readonly name: string;
  readonly channel: NotificationChannel;
}

/**
 * Build a {@link NotificationsService} over a map of named channels. This is the
 * delivery core: it selects channels by name, sends through every selected
 * channel (each attempt normalized into a promise so a synchronous throw is
 * still aggregated), waits for all of them, and collapses failures into a
 * value-free {@link NotificationError}. Exported for the plugin's wiring; not
 * part of the `jsails/notifications` public surface.
 */
export function createNotificationsService(
  channels: Readonly<Record<string, NotificationChannel>>,
): NotificationsService {
  const named: readonly NamedChannel[] = Object.entries(channels).map(([name, channel]) => ({
    name,
    channel,
  }));

  return {
    async notify(message, options) {
      const selected = selectChannels(named, options?.channels);
      if (selected.length === 0) {
        return;
      }

      // Normalize each send into an async boundary so a synchronous throw from
      // a misbehaving channel is captured by `allSettled` like any rejection.
      const deliveries = selected.map(({ name, channel }) => ({
        name,
        promise: (async () => channel.send(message))(),
      }));
      const results = await Promise.allSettled(deliveries.map(({ promise }) => promise));

      const failed: string[] = [];
      results.forEach((result, index) => {
        const delivery = deliveries[index];
        if (result.status === 'rejected' && delivery !== undefined) {
          failed.push(delivery.name);
        }
      });
      if (failed.length > 0) {
        throw new NotificationError(failed);
      }
    },
  };
}

/** Resolve the requested channel subset, rejecting an unknown name first. */
function selectChannels(
  named: readonly NamedChannel[],
  names: readonly string[] | undefined,
): readonly NamedChannel[] {
  if (names === undefined) {
    return named;
  }
  const byName = new Map(named.map((entry) => [entry.name, entry]));
  return names.map((name) => {
    const entry = byName.get(name);
    if (entry === undefined) {
      throw new Error(`notifications has no channel named "${name}"`);
    }
    return entry;
  });
}
