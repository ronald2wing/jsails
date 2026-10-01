/**
 * First-party `auth` plugin: Better Auth (email/password + device
 * authorization) over MariaDB, exposed as a {@link JsailsPlugin} named `auth`.
 *
 * `authPlugin(options)` returns a plugin whose `setup` (deferred until the
 * application assembles its extensions) lazily builds the Better Auth instance,
 * registers an {@link AuthSessionService} under {@link authSessionToken}, and
 * mounts the trusted HTTP surface:
 *
 * - `ALL /api/auth/*` — the Better Auth handler (its own origin/CSRF checks);
 * - `POST /api/login` / `POST /api/logout` — email/password sign-in/out;
 * - `POST /api/device/approve` / `POST /api/device/deny` — RFC 8628 approval;
 * - `POST /api/register` — self-registration (only when `registration.enabled`);
 * - `POST /api/password-reset` / `POST /api/password-reset/confirm` — password
 *   reset (only when `passwordReset.enabled`, which requires `sendMail`);
 * - `POST /api/verification/send` — email verification (only when
 *   `verification.enabled`, which requires `sendMail`).
 * - `POST /api/tokens` / `GET /api/tokens` / `DELETE /api/tokens/:id` — the API
 *   token surface (only when `apiTokens.enabled`).
 *
 * Those are trusted hook routes, not filesystem API routes: they bypass the
 * filesystem default-deny `authorize` and the session CSRF middleware so a
 * plain form POST works while a session cookie is present; each handler owns
 * its same-origin check (see {@link AuthPluginOptions.publicOrigin}).
 *
 * Importing the module (and even calling `authPlugin(...)`) reads no
 * environment variable and opens no connection — construction is deferred to
 * `setup` and performed through {@link createAuth}. Two options support testing
 * without a database: `createAuth` replaces the whole instance, and
 * `sessionResolver` replaces session resolution.
 */

import type { Session } from '../contracts/http.js';
import { definePlugin, type JsailsPlugin } from '../extensions/plugin-contract.js';
import { createAuth, resolveSessionFromRequest, type Auth } from './instance.js';
import {
  buildResetPasswordSender,
  buildVerificationSender,
  handleRequestPasswordReset,
  handleResetPassword,
  handleSendVerificationEmail,
  type PasswordResetOptions,
  type SendMailFn,
  type VerificationOptions,
} from './password-reset.js';
import { handleRegister, type RegistrationOptions } from './registration.js';
import { handleDeviceAction, handleLogin, handleLogout } from './routes.js';
import {
  apiTokensToken,
  createApiTokenHandlers,
  createApiTokenManager,
  createApiTokenStore,
  resolveApiTokensOptions,
  type ApiTokenService,
  type ApiTokensOptions,
} from './api-tokens.js';
import { authSessionToken, type AuthSessionService } from './token.js';

/** Options for {@link authPlugin}. */
export interface AuthPluginOptions {
  /** Same-origin boundary for the login/logout/device handlers; `undefined` falls back to each request's own origin. */
  readonly publicOrigin?: string;
  /** Better Auth public base URL; falls back to `BETTER_AUTH_URL` then localhost. */
  readonly baseUrl?: string;
  /** Better Auth signing secret (also keys the per-session CSRF token); falls back to `BETTER_AUTH_SECRET` / `AUTH_SECRET`. */
  readonly secret?: string;
  /** RFC 8628 client id allowed to use the device flow; defaults to `jsails-cli`. */
  readonly deviceClientId?: string;
  /** Replace the whole Better Auth construction (tests, custom backends). */
  readonly createAuth?: () => Auth;
  /** Replace session resolution; receives the plugin's instance and the request. */
  readonly sessionResolver?: (auth: Auth, request: Request) => Promise<Session | null>;
  /** Mail delivery seam for password reset and verification emails. */
  readonly sendMail?: SendMailFn;
  /** Self-registration surface. */
  readonly registration?: RegistrationOptions;
  /** Password-reset surface. */
  readonly passwordReset?: PasswordResetOptions;
  /** Email-verification surface. */
  readonly verification?: VerificationOptions;
  /** API-token surface (store + service + `/api/tokens` routes). Disabled by default. */
  readonly apiTokens?: ApiTokensOptions;
}

/** Return the configured mail seam, or throw a value-free error when absent. */
function requiredSendMail(options: AuthPluginOptions): SendMailFn {
  if (options.sendMail === undefined) {
    throw new Error('password reset and email verification require a sendMail callback');
  }
  return options.sendMail;
}

/**
 * Build the first-party `auth` plugin. The returned plugin is inert: nothing is
 * constructed or connected until its `setup` runs during application assembly.
 */
export function authPlugin(options: AuthPluginOptions = {}): JsailsPlugin {
  const registrationEnabled = options.registration?.enabled === true;
  const passwordResetEnabled = options.passwordReset?.enabled === true;
  const verificationEnabled = options.verification?.enabled === true;
  const apiTokensOptions = resolveApiTokensOptions(options.apiTokens);

  // Fail closed at construction: reset/verification cannot deliver mail without
  // a send seam, so refuse the config rather than mounting a broken surface.
  if (passwordResetEnabled || verificationEnabled) {
    requiredSendMail(options);
  }

  const defaultCreateAuth = (): Auth => {
    const auth = createAuth({
      secret: options.secret,
      baseUrl: options.baseUrl,
      deviceClientId: options.deviceClientId,
    });

    // `emailAndPassword` is the nested object Better Auth's resolved context
    // shares with `auth.options`, so mutating it in place is visible to the
    // sign-up/reset endpoints (reassigning it would detach it from the
    // context's shallow clone).
    const emailAndPassword = auth.options.emailAndPassword;
    if (emailAndPassword !== undefined) {
      if (registrationEnabled) {
        // No session on sign-up, and duplicate emails are answered generically
        // rather than leaking which addresses exist.
        emailAndPassword.autoSignIn = false;
      } else {
        // Self-sign-up is off by default (the starter is login-only): disable
        // the Better Auth sign-up endpoint too.
        emailAndPassword.disableSignUp = true;
      }
      if (passwordResetEnabled) {
        emailAndPassword.sendResetPassword = buildResetPasswordSender(requiredSendMail(options));
      }
    }

    return auth;
  };

  return definePlugin({
    name: 'auth',
    async setup({ services, configureHttp }) {
      // The Better Auth instance is built lazily, on the first `getAuth()` call
      // (the first live request or the first consumer to resolve a session), so
      // a static export — and any app that never serves auth traffic — builds
      // with no database. `options.createAuth` (the test seam) is deferred the
      // same way; nothing here reads an environment variable or opens a pool
      // until `getAuth()` runs.
      let authInstance: Auth | undefined;
      const getAuth = (): Auth => {
        authInstance ??= (options.createAuth ?? defaultCreateAuth)();
        return authInstance;
      };

      if (verificationEnabled) {
        // `emailVerification` is not present on the options Better Auth was
        // built with, so it must be attached to the resolved context's options
        // (a shallow clone) rather than `auth.options`, which the endpoints do
        // not read. This branch needs the instance at setup; verification also
        // requires mail, so a database is expected to be configured anyway.
        const context = await getAuth().$context;
        context.options.emailVerification = {
          sendVerificationEmail: buildVerificationSender(requiredSendMail(options)),
        };
      }

      const resolveCookieSession: AuthSessionService['resolveSession'] = (request) =>
        options.sessionResolver !== undefined
          ? options.sessionResolver(getAuth(), request)
          : resolveSessionFromRequest(getAuth(), request, options.secret);

      let apiTokenService: ApiTokenService | undefined;
      if (apiTokensOptions.enabled) {
        const store = options.apiTokens?.store ?? createApiTokenStore(getAuth());
        apiTokenService = createApiTokenManager({
          store,
          cookieSession: resolveCookieSession,
          secret: options.secret,
          headerName: apiTokensOptions.headerName,
          expiresInDays: apiTokensOptions.expiresInDays,
        });
        services.provide(apiTokensToken, apiTokenService);
      }

      // When tokens are enabled the session resolver also accepts a valid token
      // as a fallback after the cookie session fails to resolve; otherwise it is
      // cookie-only.
      const resolveSession: AuthSessionService['resolveSession'] = (request) =>
        apiTokenService !== undefined
          ? apiTokenService.resolveSessionWithApiToken(request)
          : resolveCookieSession(request);

      services.provide(authSessionToken, { getAuth, resolveSession });

      configureHttp((app) => {
        app.all('/api/auth/*', (c) => getAuth().handler(c.req.raw));
        app.post('/api/login', (c) => handleLogin(c.req.raw, getAuth(), options.publicOrigin));
        app.post('/api/logout', (c) => handleLogout(c.req.raw, getAuth(), options.publicOrigin));
        app.post('/api/device/approve', (c) =>
          handleDeviceAction(c.req.raw, getAuth(), options.publicOrigin),
        );
        app.post('/api/device/deny', (c) =>
          handleDeviceAction(c.req.raw, getAuth(), options.publicOrigin),
        );
        if (apiTokenService !== undefined) {
          const tokenHandlers = createApiTokenHandlers({
            service: apiTokenService,
            resolveSession: resolveCookieSession,
            publicOrigin: options.publicOrigin,
          });
          app.post('/api/tokens', (c) => tokenHandlers.create(c.req.raw));
          app.get('/api/tokens', (c) => tokenHandlers.list(c.req.raw));
          app.delete('/api/tokens/:id', (c) => tokenHandlers.remove(c.req.raw, c.req.param('id')));
        }
        if (registrationEnabled) {
          app.post('/api/register', (c) =>
            handleRegister(
              c.req.raw,
              getAuth(),
              options.publicOrigin,
              options.registration?.rateLimit,
            ),
          );
        }
        if (passwordResetEnabled) {
          app.post('/api/password-reset', (c) =>
            handleRequestPasswordReset(
              c.req.raw,
              getAuth(),
              options.publicOrigin,
              options.passwordReset?.rateLimit,
            ),
          );
          app.post('/api/password-reset/confirm', (c) =>
            handleResetPassword(c.req.raw, getAuth(), options.publicOrigin),
          );
        }
        if (verificationEnabled) {
          app.post('/api/verification/send', (c) =>
            handleSendVerificationEmail(
              c.req.raw,
              getAuth(),
              options.publicOrigin,
              options.verification?.rateLimit,
            ),
          );
        }
      });
    },
  });
}
