/**
 * Notifications plugin and channel tests.
 *
 * Everything runs against the in-memory channel plus an injected fake mailer
 * (provided under the real `mailToken` by a stub extension), so no SMTP server,
 * nodemailer connection, network, or database is ever opened. Covered:
 *
 * - the memory channel captures and copies each message;
 * - the mail channel adapts a `Mailer` (forwarding `to`/`subject`/`text`);
 * - `notify` delivers to every configured channel and to a requested subset;
 * - per-channel failures are aggregated into a value-free `NotificationError`
 *   that lists channel names only, and every channel is still attempted;
 * - an unknown channel name is rejected before any channel runs;
 * - `notificationsPlugin({ mail: true })` fails clearly when the mail service is
 *   absent (the framework's missing-requirement error), declares `requires`, and
 *   resolves the mailer lazily at send time;
 * - the plugin provides the service under `notificationsToken` with no
 *   connection or delivery at import/construction/setup.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runExtensions, type JsailsExtension } from '../../src/extensions/extension.js';
import { mailToken, type Mailer, type MailMessage } from '../../src/mail/index.js';
import {
  NotificationError,
  createMailChannel,
  createMemoryChannel,
  notificationsPlugin,
  notificationsToken,
  type NotificationChannel,
  type NotificationMessage,
  type NotificationsService,
} from '../../src/notifications/index.js';

const MESSAGE: NotificationMessage = {
  to: 'ada@example.com',
  subject: 'hello',
  text: 'plain body',
};

/** A fake `Mailer` recording sent messages, optionally failing on send. */
function createFakeMailer(options?: { failWith?: Error }): {
  mailer: Mailer;
  sent: MailMessage[];
} {
  const sent: MailMessage[] = [];
  const mailer: Mailer = {
    async send(message) {
      if (options?.failWith !== undefined) {
        throw options.failWith;
      }
      sent.push(message);
    },
  };
  return { mailer, sent };
}

/** A stub extension that provides `mailer` under the real `mailToken`. */
function mailExtension(mailer: Mailer): JsailsExtension {
  return {
    name: 'mail',
    setup({ services }) {
      services.provide(mailToken, mailer);
    },
  };
}

/** A channel that always rejects with a payload the error must never echo. */
const failingChannel: NotificationChannel = {
  async send() {
    throw new Error('SECRET_BACKEND_CREDENTIAL');
  },
};

describe('createMemoryChannel', () => {
  it('captures each message in order, copied', async () => {
    const channel = createMemoryChannel();
    await channel.send(MESSAGE);
    await channel.send({ to: 'grace@example.com', subject: 'again', text: 'second' });

    const messages = channel.messages();
    assert.equal(messages.length, 2);
    assert.deepEqual(messages[0], MESSAGE);
    assert.deepEqual(messages[1], {
      to: 'grace@example.com',
      subject: 'again',
      text: 'second',
    });

    const snapshot = channel.messages();
    await channel.send({ to: 'linus@example.com', subject: 'third', text: 'more' });
    assert.equal(snapshot.length, 2, 'a previously returned snapshot is unchanged');
  });
});

describe('createMailChannel', () => {
  it('forwards to/subject/text to the mailer', async () => {
    const { mailer, sent } = createFakeMailer();
    const channel = createMailChannel({ mailer });
    await channel.send(MESSAGE);

    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0], { to: 'ada@example.com', subject: 'hello', text: 'plain body' });
  });

  it('propagates a mailer failure', async () => {
    const { mailer } = createFakeMailer({ failWith: new Error('backend down') });
    const channel = createMailChannel({ mailer });
    await assert.rejects(channel.send(MESSAGE), /backend down/);
  });

  it('rejects a non-mailer at construction', () => {
    assert.throws(() => createMailChannel({} as never), TypeError);
    assert.throws(() => createMailChannel({ mailer: {} } as never), TypeError);
    assert.throws(() => createMailChannel(null as never), TypeError);
  });
});

describe('notificationsPlugin', () => {
  it('has name "notifications" and a stable token', () => {
    assert.equal(notificationsToken.name, 'notifications');
    assert.equal(
      notificationsPlugin({ channels: { memory: createMemoryChannel() } }).name,
      'notifications',
    );
  });

  it('declares requires: [mailToken] only when mail is true', () => {
    const memory = createMemoryChannel();
    assert.equal(notificationsPlugin({ channels: { memory } }).requires?.length, 0);
    assert.equal(
      notificationsPlugin({ channels: { memory }, mail: true }).requires?.[0],
      mailToken,
    );
  });

  it('provides a NotificationsService under the token without delivering', async () => {
    const runtime = await runExtensions([
      notificationsPlugin({ channels: { memory: createMemoryChannel() } }),
    ]);
    try {
      const service: NotificationsService = runtime.services.get(notificationsToken);
      assert.equal(typeof service.notify, 'function');
    } finally {
      await runtime.close();
    }
  });

  it('delivers to every configured channel', async () => {
    const a = createMemoryChannel();
    const b = createMemoryChannel();
    const runtime = await runExtensions([notificationsPlugin({ channels: { a, b } })]);
    try {
      await runtime.services.get(notificationsToken).notify(MESSAGE);
      assert.deepEqual(a.messages(), [MESSAGE]);
      assert.deepEqual(b.messages(), [MESSAGE]);
    } finally {
      await runtime.close();
    }
  });

  it('delivers to a requested subset, in the requested order', async () => {
    const order: string[] = [];
    const record = (name: string): NotificationChannel => ({
      async send() {
        order.push(name);
      },
    });
    const runtime = await runExtensions([
      notificationsPlugin({ channels: { a: record('a'), b: record('b'), c: record('c') } }),
    ]);
    try {
      await runtime.services.get(notificationsToken).notify(MESSAGE, { channels: ['c', 'a'] });
      assert.deepEqual(order, ['c', 'a']);
    } finally {
      await runtime.close();
    }
  });

  it('aggregates per-channel failures into a value-free NotificationError and still sends to all', async () => {
    const delivered = createMemoryChannel();
    const runtime = await runExtensions([
      notificationsPlugin({ channels: { failing: failingChannel, delivered } }),
    ]);
    try {
      await assert.rejects(
        runtime.services.get(notificationsToken).notify(MESSAGE),
        (error: unknown) => {
          assert.ok(
            error instanceof NotificationError,
            `expected NotificationError, got ${String(error)}`,
          );
          assert.deepEqual(error.channels, ['failing'], 'failed channels in configuration order');
          assert.ok(!error.message.includes('SECRET_BACKEND_CREDENTIAL'), 'value-free');
          assert.ok(!error.message.includes('ada@example.com'), 'no recipient in the error');
          return true;
        },
      );
      assert.deepEqual(
        delivered.messages(),
        [MESSAGE],
        'the healthy channel still received the message',
      );
    } finally {
      await runtime.close();
    }
  });

  it('aggregates a synchronous channel throw like a rejection', async () => {
    const syncThrow: NotificationChannel = {
      send() {
        throw new Error('sync boom');
      },
    };
    const runtime = await runExtensions([notificationsPlugin({ channels: { syncThrow } })]);
    try {
      await assert.rejects(
        runtime.services.get(notificationsToken).notify(MESSAGE),
        (error: unknown) => {
          assert.ok(error instanceof NotificationError);
          assert.deepEqual(error.channels, ['syncThrow']);
          assert.ok(!error.message.includes('sync boom'));
          return true;
        },
      );
    } finally {
      await runtime.close();
    }
  });

  it('rejects an unknown channel name before any channel runs', async () => {
    const memory = createMemoryChannel();
    const runtime = await runExtensions([notificationsPlugin({ channels: { memory } })]);
    try {
      await assert.rejects(
        runtime.services.get(notificationsToken).notify(MESSAGE, { channels: ['missing'] }),
        /no channel named "missing"/,
      );
      assert.deepEqual(memory.messages(), [], 'no channel was attempted');
    } finally {
      await runtime.close();
    }
  });

  it('fails clearly when mail: true but the mail service is absent', async () => {
    await assert.rejects(
      runExtensions([notificationsPlugin({ mail: true })]),
      /requires service "mail"/,
    );
  });

  it('resolves the mailer lazily at send time and delivers through it', async () => {
    const { mailer, sent } = createFakeMailer();
    const runtime = await runExtensions([
      mailExtension(mailer),
      notificationsPlugin({ mail: true }),
    ]);
    try {
      assert.equal(sent.length, 0, 'no delivery happens at setup');
      await runtime.services.get(notificationsToken).notify(MESSAGE);
      assert.equal(sent.length, 1);
      assert.deepEqual(sent[0], { to: 'ada@example.com', subject: 'hello', text: 'plain body' });
    } finally {
      await runtime.close();
    }
  });

  it('combines an explicit channel with the mail channel', async () => {
    const { mailer, sent } = createFakeMailer();
    const memory = createMemoryChannel();
    const runtime = await runExtensions([
      mailExtension(mailer),
      notificationsPlugin({ channels: { memory }, mail: true }),
    ]);
    try {
      await runtime.services.get(notificationsToken).notify(MESSAGE);
      assert.deepEqual(memory.messages(), [MESSAGE]);
      assert.equal(sent.length, 1);
    } finally {
      await runtime.close();
    }
  });

  it('aggregates a failing mailer into a value-free NotificationError', async () => {
    const { mailer } = createFakeMailer({ failWith: new Error('SMTP_PASSWORD_LEAK') });
    const runtime = await runExtensions([
      mailExtension(mailer),
      notificationsPlugin({ mail: true }),
    ]);
    try {
      await assert.rejects(
        runtime.services.get(notificationsToken).notify(MESSAGE),
        (error: unknown) => {
          assert.ok(error instanceof NotificationError);
          assert.deepEqual(error.channels, ['mail']);
          assert.ok(!error.message.includes('SMTP_PASSWORD_LEAK'));
          return true;
        },
      );
    } finally {
      await runtime.close();
    }
  });

  it('validates malformed options eagerly', () => {
    assert.throws(() => notificationsPlugin(null as never), TypeError);
    assert.throws(() => notificationsPlugin([] as never), TypeError);
    assert.throws(() => notificationsPlugin({ mail: 'yes' } as never), TypeError);
    assert.throws(() => notificationsPlugin({ channels: 'not-a-map' } as never), TypeError);
    assert.throws(
      () => notificationsPlugin({ channels: { bad: {} as unknown as NotificationChannel } }),
      TypeError,
    );
    assert.throws(() => notificationsPlugin({}), TypeError, 'no channels and mail unset');
    assert.throws(
      () => notificationsPlugin({ channels: { mail: createMemoryChannel() }, mail: true }),
      TypeError,
      'reserved mail channel name',
    );
  });

  it('closes idempotently with no handles held', async () => {
    const runtime = await runExtensions([
      notificationsPlugin({ channels: { memory: createMemoryChannel() } }),
    ]);
    await runtime.close();
    await runtime.close();
  });
});
