/**
 * The first-party notifications subpath (`jsails/notifications`).
 *
 * A narrow, multi-channel delivery seam: the {@link NotificationMessage} and
 * {@link NotificationChannel} contracts, the value-free {@link NotificationError}
 * for aggregated delivery failures, an in-memory channel for tests and demos, a
 * mail adapter over the `jsails/mail` {@link Mailer}, and the
 * {@link notificationsPlugin} that exposes a {@link NotificationsService} under
 * a typed service token.
 *
 * Importing this barrel depends on the mail surface only through the
 * `mailToken` identity (plus the {@link Mailer} type) and never opens a
 * connection, enqueues work, or touches a database — nodemailer stays a lazy
 * `await import` inside the mail transports. Delivery is in-process and
 * synchronous-per-send. Apps needing retries or out-of-process delivery should
 * enqueue through the jobs plugin and send from the job handler.
 */

export {
  NotificationError,
  createMailChannel,
  createMemoryChannel,
  type CreateMailChannelOptions,
  type MemoryNotificationChannel,
  type NotificationChannel,
  type NotificationMessage,
  type NotificationsService,
  type NotifyOptions,
} from './notifications.js';

export {
  notificationsPlugin,
  notificationsToken,
  type NotificationsPluginOptions,
} from './plugin.js';

// The `notifications` factory is the subpath's default export, matching every
// other first-party plugin subpath: `plugins.use` resolves a specifier by
// importing the default export and calling it with the options tuple.
export { notificationsPlugin as default } from './plugin.js';
