/**
 * Mail preview tests.
 *
 * Covers the Rails ActionMailer `preview` analog: a named preview declares an
 * example mail, and `renderMailPreview` captures it through the in-memory
 * transport seam so the caller receives the exact `ValidatedMail` a real send
 * would produce. All failures are value-free; no transport, network, or SMTP is
 * ever opened.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createMailPreviewRegistry,
  defineMailPreview,
  listMailPreviews,
  MailError,
  MailPreviewError,
  renderMailPreview,
} from '../../src/mail/index.js';

describe('defineMailPreview', () => {
  it('rejects an empty name or a non-function', () => {
    assert.throws(() => defineMailPreview('', () => {}), MailPreviewError);
    assert.throws(() => defineMailPreview('   ', () => {}), MailPreviewError);
    assert.throws(() => defineMailPreview('welcome', undefined as never), MailPreviewError);
  });
});

describe('createMailPreviewRegistry', () => {
  it('rejects a duplicate name', () => {
    const welcome = defineMailPreview('welcome', (mailer) => {
      mailer.send({ to: 'ada@example.com', subject: 'hi' });
    });
    assert.throws(() => createMailPreviewRegistry([welcome, welcome]), MailPreviewError);
    assert.throws(
      () =>
        createMailPreviewRegistry([
          welcome,
          defineMailPreview('welcome', (mailer) => {
            mailer.send({ to: 'grace@example.com', subject: 'hi' });
          }),
        ]),
      MailPreviewError,
    );
  });

  it('rejects a non-array', () => {
    assert.throws(() => createMailPreviewRegistry(undefined as never), MailPreviewError);
  });
});

describe('renderMailPreview', () => {
  const welcome = defineMailPreview('welcome', (mailer) =>
    mailer.send({
      to: 'ada@example.com',
      subject: 'Welcome',
      text: 'hi ada',
      html: '<p>hi ada</p>',
    }),
  );
  const receipt = defineMailPreview('receipt', async (mailer) => {
    await mailer.send({ to: 'grace@example.com', subject: 'Receipt', text: 'thanks' });
  });

  it('renders a named preview into the ValidatedMail it declares', async () => {
    const registry = createMailPreviewRegistry([welcome]);
    const mail = await renderMailPreview(registry, 'welcome');
    assert.deepEqual(mail, {
      to: 'ada@example.com',
      from: undefined,
      subject: 'Welcome',
      text: 'hi ada',
      html: '<p>hi ada</p>',
    });
  });

  it('supports an async preview function', async () => {
    const registry = createMailPreviewRegistry([receipt]);
    const mail = await renderMailPreview(registry, 'receipt');
    assert.equal(mail.to, 'grace@example.com');
    assert.equal(mail.subject, 'Receipt');
  });

  it('captures a message sent with a block body (synchronous capture)', async () => {
    const plain = defineMailPreview('plain', (mailer) => {
      mailer.send({ to: 'ada@example.com', subject: 'plain', text: 'body' });
    });
    const registry = createMailPreviewRegistry([plain]);
    const mail = await renderMailPreview(registry, 'plain');
    assert.equal(mail.text, 'body');
  });

  it('returns a value-free error for an unknown name', async () => {
    const registry = createMailPreviewRegistry([welcome]);
    await assert.rejects(
      renderMailPreview(registry, 'missing'),
      (error: unknown) =>
        error instanceof MailPreviewError && error.message === 'unknown mail preview',
    );
  });

  it('rejects a preview that sends nothing or multiple messages', async () => {
    const empty = defineMailPreview('empty', () => {});
    const multi = defineMailPreview('multi', (mailer) => {
      mailer.send({ to: 'a@example.com', subject: 'one' });
      mailer.send({ to: 'b@example.com', subject: 'two' });
    });
    const registry = createMailPreviewRegistry([empty, multi]);
    await assert.rejects(renderMailPreview(registry, 'empty'), MailPreviewError);
    await assert.rejects(renderMailPreview(registry, 'multi'), MailPreviewError);
  });

  it('surfaces a validation failure as a MailError', async () => {
    const bad = defineMailPreview('bad', (mailer) =>
      mailer.send({ to: 'not-an-address', subject: 'x' }),
    );
    const registry = createMailPreviewRegistry([bad]);
    await assert.rejects(renderMailPreview(registry, 'bad'), MailError);
  });
});

describe('listMailPreviews', () => {
  it('returns the registered names sorted', () => {
    const registry = createMailPreviewRegistry([
      defineMailPreview('zebra', () => {}),
      defineMailPreview('alpha', () => {}),
      defineMailPreview('mango', () => {}),
    ]);
    assert.deepEqual(listMailPreviews(registry), ['alpha', 'mango', 'zebra']);
  });

  it('returns an empty list for an empty registry', () => {
    const registry = createMailPreviewRegistry([]);
    assert.deepEqual(listMailPreviews(registry), []);
  });
});
