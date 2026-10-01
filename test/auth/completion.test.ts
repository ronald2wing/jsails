/**
 * Auth completion tests: registration, password reset, email verification, and
 * role helpers for the first-party `auth` plugin.
 *
 * These exercise the handlers and mail-sender builders directly against a
 * stubbed Better Auth instance (no database, no network), plus the plugin's
 * eager validation and one route-mounting assertion through `createTestApp`.
 * The shared helpers live in `auth-plugin.test.ts`; this file covers only the
 * completion surface added by `registration.ts`, `password-reset.ts`, and
 * `roles.ts`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  adminOnly,
  authPlugin,
  buildResetPasswordSender,
  buildVerificationSender,
  handleRegister,
  handleRequestPasswordReset,
  handleResetPassword,
  handleSendVerificationEmail,
  requireRole,
  sessionRole,
  type Auth,
  type SendMailFn,
} from '../../src/auth/index.js';
import type { JsonObject, Session } from '../../src/contracts/http.js';
import { createTestApp } from '../../src/testing/app.js';

const ORIGIN = 'http://localhost';

/** Build a form-encoded POST request against the given origin. */
function formRequest(path: string, fields: Record<string, string>, origin = ORIGIN): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });
}

/** A session with the given `data` payload. */
function session(data: JsonObject): Session {
  return { id: 's1', csrfToken: 'csrf', data, expiresAt: 2_000_000_000_000 };
}

describe('role helpers', () => {
  it('sessionRole reads the role field and falls back to null', () => {
    assert.equal(sessionRole(session({ role: 'admin' })), 'admin');
    assert.equal(sessionRole(session({})), null);
    assert.equal(sessionRole(session({ role: 42 })), null);
    assert.equal(sessionRole(null), null);
  });

  it('requireRole allows only the named roles and never throws', () => {
    const gate = requireRole('admin', 'editor');
    assert.equal(gate(session({ role: 'admin' })), true);
    assert.equal(gate(session({ role: 'editor' })), true);
    assert.equal(gate(session({ role: 'viewer' })), false);
    assert.equal(gate(session({})), false);
    assert.equal(gate(null), false);
  });

  it('adminOnly allows only the admin role', () => {
    assert.equal(adminOnly(session({ role: 'admin' })), true);
    assert.equal(adminOnly(session({ role: 'viewer' })), false);
    assert.equal(adminOnly(null), false);
  });
});

describe('mail sender builders', () => {
  it('buildResetPasswordSender forwards the recipient and reset URL to sendMail', async () => {
    const sent: Array<{ to: string; subject: string; text: string }> = [];
    const sendMail: SendMailFn = async (to, subject, text) => {
      sent.push({ to, subject, text });
    };
    const sender = buildResetPasswordSender(sendMail);

    await sender({
      user: { email: 'ada@example.com' },
      url: 'https://example.com/reset?token=abc',
      token: 'abc',
    });

    assert.equal(sent.length, 1);
    const first = sent[0];
    assert.ok(first);
    assert.equal(first.to, 'ada@example.com');
    assert.equal(first.subject, 'Reset your password');
    assert.match(first.text, /https:\/\/example\.com\/reset\?token=abc/);
  });

  it('buildVerificationSender forwards the recipient and verify URL to sendMail', async () => {
    const sent: Array<{ to: string; text: string }> = [];
    const sendMail: SendMailFn = async (to, _subject, text) => {
      sent.push({ to, text });
    };
    const sender = buildVerificationSender(sendMail);

    await sender({
      user: { email: 'ada@example.com' },
      url: 'https://example.com/verify-email?token=xyz',
      token: 'xyz',
    });

    assert.equal(sent.length, 1);
    const first = sent[0];
    assert.ok(first);
    assert.equal(first.to, 'ada@example.com');
    assert.match(first.text, /verify-email\?token=xyz/);
  });
});

describe('handleRegister', () => {
  const signUpEmail = async () => ({ token: null, user: {} });
  const auth = { api: { signUpEmail } } as unknown as Auth;

  it('rejects a cross-origin request', async () => {
    const response = await handleRegister(
      formRequest(
        '/api/register',
        { name: 'Ada', email: 'a@b.co', password: 'pw12345678' },
        'http://evil.example',
      ),
      auth,
      ORIGIN,
    );
    assert.equal(response.status, 403);
  });

  it('rejects a malformed email or missing password with 422', async () => {
    const badEmail = await handleRegister(
      formRequest('/api/register', { name: 'Ada', email: 'not-an-email', password: 'pw12345678' }),
      auth,
      ORIGIN,
    );
    assert.equal(badEmail.status, 422);

    const badPassword = await handleRegister(
      formRequest('/api/register', { name: 'Ada', email: 'a@b.co', password: '' }),
      auth,
      ORIGIN,
    );
    assert.equal(badPassword.status, 422);
  });

  it('applies the rate-limit hook and returns a generic 429', async () => {
    const response = await handleRegister(
      formRequest('/api/register', { name: 'Ada', email: 'a@b.co', password: 'pw12345678' }),
      auth,
      ORIGIN,
      () => false,
    );
    assert.equal(response.status, 429);
  });

  it('delegates to signUpEmail and returns an opaque 200 on success', async () => {
    let received: unknown;
    const recording = {
      api: {
        signUpEmail: async (input: unknown) => ((received = input), { token: null, user: {} }),
      },
    } as unknown as Auth;

    const response = await handleRegister(
      formRequest('/api/register', {
        name: 'Ada',
        email: 'ada@example.com',
        password: 'pw12345678',
      }),
      recording,
      ORIGIN,
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok' });
    assert.deepEqual(received, {
      body: { name: 'Ada', email: 'ada@example.com', password: 'pw12345678' },
    });
  });

  it('collapses a provider failure into a generic 422', async () => {
    const failing = {
      api: {
        signUpEmail: async () => {
          throw new Error('boom');
        },
      },
    } as unknown as Auth;
    const response = await handleRegister(
      formRequest('/api/register', {
        name: 'Ada',
        email: 'ada@example.com',
        password: 'pw12345678',
      }),
      failing,
      ORIGIN,
    );
    assert.equal(response.status, 422);
    assert.deepEqual(await response.json(), { error: 'registration failed' });
  });
});

describe('handleRequestPasswordReset', () => {
  const requestPasswordReset = async () => ({ status: true, message: 'sent' });

  it('rejects a malformed email with 400', async () => {
    const auth = { api: { requestPasswordReset } } as unknown as Auth;
    const response = await handleRequestPasswordReset(
      formRequest('/api/password-reset', { email: 'nope' }),
      auth,
      ORIGIN,
    );
    assert.equal(response.status, 400);
  });

  it('delegates and returns an opaque 200 on success', async () => {
    let received: unknown;
    const auth = {
      api: {
        requestPasswordReset: async (input: unknown) => ((received = input), { status: true }),
      },
    } as unknown as Auth;

    const response = await handleRequestPasswordReset(
      formRequest('/api/password-reset', { email: 'ada@example.com' }),
      auth,
      ORIGIN,
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok' });
    assert.deepEqual(received, { body: { email: 'ada@example.com' } });
  });

  it('maps a provider failure to a generic 500', async () => {
    const auth = {
      api: {
        requestPasswordReset: async () => {
          throw new Error('boom');
        },
      },
    } as unknown as Auth;
    const response = await handleRequestPasswordReset(
      formRequest('/api/password-reset', { email: 'ada@example.com' }),
      auth,
      ORIGIN,
    );
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: 'internal error' });
  });
});

describe('handleResetPassword', () => {
  it('rejects a missing token with 422', async () => {
    const auth = { api: { resetPassword: async () => ({ status: true }) } } as unknown as Auth;
    const response = await handleResetPassword(
      formRequest('/api/password-reset/confirm', { newPassword: 'pw12345678' }),
      auth,
      ORIGIN,
    );
    assert.equal(response.status, 422);
  });

  it('delegates the token and new password and returns 200', async () => {
    let received: unknown;
    const auth = {
      api: { resetPassword: async (input: unknown) => ((received = input), { status: true }) },
    } as unknown as Auth;

    const response = await handleResetPassword(
      formRequest('/api/password-reset/confirm', { token: 'tok-1', newPassword: 'pw12345678' }),
      auth,
      ORIGIN,
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok' });
    assert.deepEqual(received, { body: { newPassword: 'pw12345678', token: 'tok-1' } });
  });

  it('maps an invalid/expired token to a generic 422', async () => {
    const auth = {
      api: {
        resetPassword: async () => {
          throw new Error('invalid');
        },
      },
    } as unknown as Auth;
    const response = await handleResetPassword(
      formRequest('/api/password-reset/confirm', { token: 'tok-1', newPassword: 'pw12345678' }),
      auth,
      ORIGIN,
    );
    assert.equal(response.status, 422);
    assert.deepEqual(await response.json(), { error: 'invalid or expired token' });
  });
});

describe('handleSendVerificationEmail', () => {
  it('rejects a malformed email with 400', async () => {
    const auth = {
      api: { sendVerificationEmail: async () => ({ status: true }) },
    } as unknown as Auth;
    const response = await handleSendVerificationEmail(
      formRequest('/api/verification/send', { email: 'nope' }),
      auth,
      ORIGIN,
    );
    assert.equal(response.status, 400);
  });

  it('delegates and returns an opaque 200 on success', async () => {
    let received: unknown;
    const auth = {
      api: {
        sendVerificationEmail: async (input: unknown) => ((received = input), { status: true }),
      },
    } as unknown as Auth;

    const response = await handleSendVerificationEmail(
      formRequest('/api/verification/send', { email: 'ada@example.com' }),
      auth,
      ORIGIN,
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok' });
    assert.deepEqual(received, { body: { email: 'ada@example.com' } });
  });

  it('maps a provider failure to a generic 400', async () => {
    const auth = {
      api: {
        sendVerificationEmail: async () => {
          throw new Error('boom');
        },
      },
    } as unknown as Auth;
    const response = await handleSendVerificationEmail(
      formRequest('/api/verification/send', { email: 'ada@example.com' }),
      auth,
      ORIGIN,
    );
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'verification email could not be sent' });
  });
});

describe('authPlugin completion wiring', () => {
  it('fails closed at construction when passwordReset is enabled without sendMail', () => {
    assert.throws(() => authPlugin({ passwordReset: { enabled: true } }), /sendMail/);
  });

  it('fails closed at construction when verification is enabled without sendMail', () => {
    assert.throws(() => authPlugin({ verification: { enabled: true } }), /sendMail/);
  });

  it('accepts reset/verification when a sendMail callback is supplied', () => {
    assert.doesNotThrow(() =>
      authPlugin({
        sendMail: async () => {},
        passwordReset: { enabled: true },
        verification: { enabled: true },
      }),
    );
  });

  it('mounts POST /api/register when registration is enabled', async () => {
    const app = await createTestApp({
      config: {
        port: 0,
        extensions: [
          authPlugin({
            registration: { enabled: true },
            createAuth: () =>
              ({
                api: { signUpEmail: async () => ({ token: null, user: {} }) },
              }) as unknown as Auth,
          }),
        ],
      },
    });

    const response = await app.request('/api/register', {
      method: 'POST',
      headers: { origin: 'http://localhost', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        name: 'Ada',
        email: 'ada@example.com',
        password: 'pw12345678',
      }).toString(),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok' });
    await app.close();
  });
});
