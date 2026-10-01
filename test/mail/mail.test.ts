/**
 * Mail plugin and transport tests.
 *
 * Everything runs against the in-memory and callback transports plus an
 * injected SMTP factory seam, so no live SMTP server, nodemailer connection, or
 * network is ever opened. Covered:
 *
 * - the memory transport validates and captures each message;
 * - a CR/LF in `subject` (header injection) and an invalid address are rejected
 *   with value-free `MailError`s;
 * - `mailPlugin` provides a `Mailer` under `mailToken`;
 * - transport resolution precedence (explicit transport > smtp > env > memory)
 *   and the fail-closed default;
 * - laziness (no error at import/construction/setup, only on first send) and
 *   idempotent close for the memory, callback, and SMTP transports.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runExtensions } from '../../src/extensions/extension.js';
import {
  MailError,
  createCallbackTransport,
  createMemoryTransport,
  createSmtpTransport,
  mailPlugin,
  mailToken,
  type Mailer,
  type SmtpTransportDependencies,
  type SmtpTransporter,
} from '../../src/mail/index.js';

const MESSAGE = {
  to: 'ada@example.com',
  subject: 'hello',
  text: 'plain body',
  html: '<p>html body</p>',
};

/** Save/restore the two SMTP URL variables around an env-mutating test. */
function withEnv(
  vars: Record<string, string | undefined>,
  run: () => Promise<void>,
): Promise<void> {
  const names = Object.keys(vars);
  const saved = new Map<string, string | undefined>();
  for (const name of names) {
    saved.set(name, process.env[name]);
    const value = vars[name];
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  return run().finally(() => {
    for (const name of names) {
      const value = saved.get(name);
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });
}

describe('createMemoryTransport', () => {
  it('validates and captures each message', async () => {
    const transport = createMemoryTransport();
    await transport.send(MESSAGE);
    await transport.send({ to: 'grace@example.com', subject: 'again', text: 'second' });

    const messages = transport.messages();
    assert.equal(messages.length, 2);
    assert.deepEqual(messages[0], {
      to: 'ada@example.com',
      from: undefined,
      subject: 'hello',
      text: 'plain body',
      html: '<p>html body</p>',
    });
    assert.deepEqual(messages[1], {
      to: 'grace@example.com',
      from: undefined,
      subject: 'again',
      text: 'second',
      html: undefined,
    });

    await transport.close();
  });

  it('rejects a CR/LF in the subject (header injection)', async () => {
    const transport = createMemoryTransport();
    for (const subject of ['evil\r\nBcc: victim@example.com', 'evil\nBcc: victim@example.com']) {
      await assert.rejects(
        transport.send({ to: 'ada@example.com', subject, text: 'x' }),
        MailError,
      );
    }
    assert.equal(transport.messages().length, 0);
    await transport.close();
  });

  it('rejects a CR/LF in the recipient (header injection)', async () => {
    const transport = createMemoryTransport();
    await assert.rejects(
      transport.send({ to: 'ada@example.com\r\nBcc: victim@example.com', subject: 'x', text: 'y' }),
      MailError,
    );
    assert.equal(transport.messages().length, 0);
    await transport.close();
  });

  it('rejects an invalid address', async () => {
    const transport = createMemoryTransport();
    for (const to of ['no-at-sign', 'with space@example.com', 'tab\t@example.com', '']) {
      await assert.rejects(transport.send({ to, subject: 'x', text: 'y' }), MailError);
    }
    assert.equal(transport.messages().length, 0);
    await transport.close();
  });

  it('rejects sending after close and closes idempotently', async () => {
    const transport = createMemoryTransport();
    await transport.send(MESSAGE);
    await transport.close();
    await transport.close();
    assert.equal(transport.messages().length, 0, 'close drops captured messages');
    await assert.rejects(transport.send(MESSAGE), MailError);
  });
});

describe('createCallbackTransport', () => {
  it('forwards each validated message to the callback and closes idempotently', async () => {
    const received: string[] = [];
    const transport = createCallbackTransport((message) => {
      received.push(message.to);
    });
    await transport.send(MESSAGE);
    await transport.send({ to: 'grace@example.com', subject: 'again' });
    assert.deepEqual(received, ['ada@example.com', 'grace@example.com']);

    await transport.close();
    await transport.close();
    await assert.rejects(transport.send(MESSAGE), MailError);
  });

  it('rejects a non-function callback at construction', () => {
    assert.throws(() => createCallbackTransport(undefined as never), TypeError);
  });
});

describe('createSmtpTransport', () => {
  it('rejects a missing url and host at construction', () => {
    assert.throws(() => createSmtpTransport({}), MailError);
  });

  it('rejects a non-SMTP URL scheme at construction', () => {
    assert.throws(() => createSmtpTransport({ url: 'http://example.com' }), MailError);
  });

  it('rejects an invalid default from address at construction', () => {
    assert.throws(
      () => createSmtpTransport({ host: 'smtp.example.com', from: 'not-an-address' }),
      MailError,
    );
  });

  it('constructs no transporter until the first send (lazy)', async () => {
    const { dependencies, state } = fakeSmtpDependencies();
    const transport = createSmtpTransport({ url: 'smtp://smtp.example.com' }, dependencies);
    assert.equal(state.creates, 0, 'construction loads no nodemailer');

    await transport.send(MESSAGE);
    assert.equal(state.creates, 1);

    await transport.send({ to: 'grace@example.com', subject: 'again' });
    assert.equal(state.creates, 1, 'the transporter is reused');
    await transport.close();
  });

  it('applies the configured from default when the message omits it', async () => {
    const { dependencies, state } = fakeSmtpDependencies();
    const transport = createSmtpTransport(
      { url: 'smtp://smtp.example.com', from: 'noreply@example.com' },
      dependencies,
    );
    await transport.send({ to: 'ada@example.com', subject: 'hi', text: 'x' });
    assert.equal(state.sent[0]?.from, 'noreply@example.com');

    await transport.send({
      to: 'ada@example.com',
      subject: 'hi',
      text: 'x',
      from: 'me@example.com',
    });
    assert.equal(state.sent[1]?.from, 'me@example.com', 'a message from overrides the default');
    await transport.close();
  });

  it('sanitizes a send failure into a value-free MailError', async () => {
    const { dependencies } = fakeSmtpDependencies({ failSendWith: { code: 'EAUTH' } });
    const transport = createSmtpTransport(
      { url: 'smtps://user:pass@smtp.example.com' },
      dependencies,
    );
    await assert.rejects(
      transport.send(MESSAGE),
      (error: unknown) =>
        error instanceof MailError &&
        error.message.includes('mail transport error') &&
        !error.message.includes('smtp.example.com') &&
        !error.message.includes('ada@example.com'),
    );
    await transport.close();
  });

  it('closes the underlying transporter exactly once', async () => {
    const { dependencies, state } = fakeSmtpDependencies();
    const transport = createSmtpTransport({ url: 'smtp://smtp.example.com' }, dependencies);
    await transport.send(MESSAGE);
    await transport.close();
    await transport.close();
    assert.equal(state.closes, 1);
  });

  it('close is a no-op when no transporter was ever created', async () => {
    const { dependencies, state } = fakeSmtpDependencies();
    const transport = createSmtpTransport({ url: 'smtp://smtp.example.com' }, dependencies);
    await transport.close();
    assert.equal(state.creates, 0);
    assert.equal(state.closes, 0);
  });
});

describe('mailPlugin', () => {
  it('provides a Mailer under mailToken without connecting', async () => {
    const runtime = await runExtensions([mailPlugin({ allowMemory: true })]);
    try {
      const mailer = runtime.services.get(mailToken);
      assert.equal(typeof mailer.send, 'function');
    } finally {
      await runtime.close();
    }
  });

  it('exposes a stable mailToken singleton', () => {
    assert.equal(mailToken.name, 'mail');
  });

  it('uses an explicit transport verbatim and never closes it', async () => {
    const explicit = createMemoryTransport();
    const runtime = await runExtensions([mailPlugin({ transport: explicit })]);
    try {
      await runtime.services.get(mailToken).send(MESSAGE);
      assert.equal(explicit.messages().length, 1);
    } finally {
      await runtime.close();
    }
    // The plugin does not own the explicit transport: it is still usable.
    assert.equal(explicit.messages().length, 1);
    await explicit.close();
  });

  it('resolves the explicit transport ahead of smtp, env, and memory', async () => {
    const explicit = createMemoryTransport();
    await withEnv(
      { MAIL_URL: 'smtp://smtp.example.com', SMTP_URL: 'smtp://smtp.example.com' },
      async () => {
        const runtime = await runExtensions([
          mailPlugin({
            transport: explicit,
            smtp: { url: 'smtp://smtp.example.com' },
            allowMemory: true,
          }),
        ]);
        try {
          await runtime.services.get(mailToken).send(MESSAGE);
          assert.equal(explicit.messages().length, 1);
        } finally {
          await runtime.close();
        }
      },
    );
    await explicit.close();
  });

  it('resolves the smtp option ahead of env and memory', async () => {
    await withEnv(
      { MAIL_URL: 'smtp://smtp.example.com', SMTP_URL: 'smtp://smtp.example.com' },
      async () => {
        // `http://` is rejected by the SMTP transport at construction: reaching
        // that error proves the `smtp` option won over both env and memory.
        const runtime = await runExtensions([
          mailPlugin({ smtp: { url: 'http://example.com' }, allowMemory: true }),
        ]);
        try {
          await assert.rejects(runtime.services.get(mailToken).send(MESSAGE), MailError);
        } finally {
          await runtime.close();
        }
      },
    );
  });

  it('resolves MAIL_URL ahead of the in-memory fallback', async () => {
    await withEnv({ MAIL_URL: 'http://example.com', SMTP_URL: undefined }, async () => {
      const runtime = await runExtensions([mailPlugin({ allowMemory: true })]);
      try {
        // The env SMTP URL is chosen (and rejected as non-SMTP), proving env
        // won over `allowMemory: true`, which would otherwise have succeeded.
        await assert.rejects(runtime.services.get(mailToken).send(MESSAGE), MailError);
      } finally {
        await runtime.close();
      }
    });
  });

  it('falls back to the in-memory transport only when allowMemory is true', async () => {
    await withEnv({ MAIL_URL: undefined, SMTP_URL: undefined }, async () => {
      const runtime = await runExtensions([mailPlugin({ allowMemory: true })]);
      try {
        await runtime.services.get(mailToken).send(MESSAGE);
      } finally {
        await runtime.close();
      }
    });
  });

  it('fails closed on the first send, not at import or setup', async () => {
    await withEnv({ MAIL_URL: undefined, SMTP_URL: undefined }, async () => {
      // Construction and setup succeed: nothing is resolved eagerly.
      const runtime = await runExtensions([mailPlugin()]);
      try {
        const mailer: Mailer = runtime.services.get(mailToken);
        await assert.rejects(
          mailer.send(MESSAGE),
          (error: unknown) =>
            error instanceof MailError && !error.message.includes('ada@example.com'),
        );
      } finally {
        await runtime.close();
      }
    });
  });

  it('closes an owned memory transport and is idempotent', async () => {
    await withEnv({ MAIL_URL: undefined, SMTP_URL: undefined }, async () => {
      const runtime = await runExtensions([mailPlugin({ allowMemory: true })]);
      const mailer = runtime.services.get(mailToken);
      await mailer.send(MESSAGE);
      await runtime.close();
      await runtime.close();
      await assert.rejects(mailer.send(MESSAGE), MailError);
    });
  });

  it('rejects a non-boolean allowMemory at construction', () => {
    assert.throws(() => mailPlugin({ allowMemory: 'yes' } as never), TypeError);
    assert.throws(() => mailPlugin({ transport: {} } as never), TypeError);
    assert.throws(() => mailPlugin({ smtp: 'not-an-object' } as never), TypeError);
  });
});

/** Shared SMTP factory seam: records creates/sends/closes, optionally failing. */
interface FakeSmtpState {
  creates: number;
  closes: number;
  sent: Array<{ from?: string; to: string; subject: string }>;
}

function fakeSmtpDependencies(options?: { failSendWith?: { code: string } }): {
  dependencies: SmtpTransportDependencies;
  state: FakeSmtpState;
} {
  const state: FakeSmtpState = { creates: 0, closes: 0, sent: [] };
  const dependencies: SmtpTransportDependencies = {
    createTransport() {
      state.creates += 1;
      const transporter: SmtpTransporter = {
        async sendMail(mail) {
          if (options?.failSendWith !== undefined) {
            const error = new Error('backend auth failed') as Error & { code: string };
            error.code = options.failSendWith.code;
            throw error;
          }
          state.sent.push({ from: mail.from, to: mail.to, subject: mail.subject });
        },
        close() {
          state.closes += 1;
        },
      };
      return transporter;
    },
  };
  return { dependencies, state };
}
