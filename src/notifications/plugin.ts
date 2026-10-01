/**
 * First-party `notifications` plugin: exposes a multi-channel
 * {@link NotificationsService} under a typed service token.
 *
 * `notificationsPlugin({ channels? | mail? })` builds a {@link JsailsPlugin}
 * named `notifications` whose `setup` provides the service under
 * {@link notificationsToken}:
 *
 * - `channels` is a map of named {@link NotificationChannel}s, keyed by
 *   non-empty, unique names and used verbatim (identity preserved, never
 *   closed);
 * - `mail: true` adds a channel named `mail` that adapts the first-party mail
 *   service, and declares `requires: [mailToken]` so the mail plugin must be
 *   declared earlier or assembly fails with a value-free missing-requirement
 *   error. The mailer is resolved from the registry lazily at send time, so no
 *   mail transport or connection is touched at import, construction, or setup.
 *
 * Channel names are validated eagerly at plugin construction; a name of `mail`
 * alongside `mail: true` is a conflict. The plugin is otherwise inert: nothing
 * connects and no delivery happens until `notify` is called. Cleanup is a no-op
 * — a channel holds no open handles the plugin owns.
 */

import { definePlugin, type JsailsPlugin } from '../extensions/plugin-contract.js';
import { createServiceToken, type ServiceToken } from '../extensions/services.js';
import { mailToken } from '../mail/index.js';
import {
  createMailChannel,
  createNotificationsService,
  type NotificationChannel,
  type NotificationsService,
} from './notifications.js';

/** The reserved channel name the `mail: true` option installs. */
const MAIL_CHANNEL_NAME = 'mail';

/**
 * Opaque token for the application {@link NotificationsService}. Defined once
 * here and shared by the provider (`notificationsPlugin`) and any consumer.
 */
export const notificationsToken: ServiceToken<NotificationsService> =
  createServiceToken<NotificationsService>('notifications');

/** Options accepted by {@link notificationsPlugin}. */
export interface NotificationsPluginOptions {
  /** Named channels, keyed by non-empty, unique names. */
  readonly channels?: Readonly<Record<string, NotificationChannel>>;
  /** When `true`, add a `mail` channel adapting the first-party mail service. */
  readonly mail?: boolean;
}

/** True when `value` implements the {@link NotificationChannel} contract. */
function isChannel(value: unknown): value is NotificationChannel {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { send?: unknown }).send === 'function'
  );
}

/**
 * Build the first-party `notifications` plugin. Validation is eager and throws
 * `TypeError` for malformed options; the returned plugin is otherwise inert.
 */
export function notificationsPlugin(options: NotificationsPluginOptions = {}): JsailsPlugin {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('notificationsPlugin requires an options object');
  }
  if (options.mail !== undefined && typeof options.mail !== 'boolean') {
    throw new TypeError('mail must be a boolean');
  }
  if (
    options.channels !== undefined &&
    (options.channels === null ||
      typeof options.channels !== 'object' ||
      Array.isArray(options.channels))
  ) {
    throw new TypeError('channels must be a map of named channels');
  }

  const channelNames = options.channels === undefined ? [] : Object.keys(options.channels);
  for (const name of channelNames) {
    if (name.trim() === '') {
      throw new TypeError('channel names must be non-empty strings');
    }
    if (!isChannel(options.channels![name])) {
      throw new TypeError(`channel "${name}" must implement the NotificationChannel contract`);
    }
  }
  if (options.mail === true && channelNames.includes(MAIL_CHANNEL_NAME)) {
    throw new TypeError(`channel name "${MAIL_CHANNEL_NAME}" is reserved when mail is true`);
  }
  if (options.mail !== true && channelNames.length === 0) {
    throw new TypeError('notificationsPlugin requires at least one channel or mail: true');
  }

  return definePlugin({
    name: 'notifications',
    requires: options.mail === true ? [mailToken] : [],
    setup({ services }) {
      const channels: Record<string, NotificationChannel> = {};
      for (const name of channelNames) {
        const channel = options.channels![name];
        if (channel !== undefined) {
          channels[name] = channel;
        }
      }

      if (options.mail === true) {
        channels[MAIL_CHANNEL_NAME] = createMailChannel({
          // Resolve the mailer lazily at send time. `requires` guarantees the
          // mail service is registered before this setup runs, but its
          // transport (and any connection) stays deferred until a message is
          // actually delivered.
          mailer: {
            send(message) {
              return services.get(mailToken).send(message);
            },
          },
        });
      }

      services.provide(notificationsToken, createNotificationsService(channels));
    },
  });
}
