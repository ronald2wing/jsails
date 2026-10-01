/**
 * First-party `auth` subpath (`jsails/auth`): Better Auth (email/password +
 * device authorization) over MariaDB, packaged as a framework plugin.
 *
 * `authPlugin` is the extension seam — it provides an {@link AuthSessionService}
 * under {@link authSessionToken} (which the `admin` plugin can require) and
 * mounts the trusted `/api/auth/*`, `/api/login`, `/api/logout`,
 * `/api/device/approve|deny`, `/api/register`, `/api/password-reset`,
 * `/api/password-reset/confirm`, and `/api/verification/send` routes, plus
 * `/api/tokens` when `apiTokens.enabled`.
 * `createAuth` is the lazy Better Auth construction helper for scripts and
 * custom mountings; `getAuthMigrations` builds Better
 * Auth's schema-migration plan without importing its transitive
 * `better-auth/db/migration` subpath at the call site; `resolveSessionFromRequest`
 * maps a Better Auth session to the JSails {@link Session} shape; `deviceApi`
 * exposes the RFC 8628 endpoints with checked types; the registration,
 * password-reset, and verification handlers (plus their mail-sender builders)
 * complete the account lifecycle; the API-token surface
 * (`createApiToken`/`listApiTokens`/`revokeApiToken`/`resolveSessionWithApiToken`
 * behind the `apiTokens` plugin option) mints long-lived, revocable tokens over
 * tagged sessions; `sessionRole`/`requireRole`/`adminOnly` read
 * a session's `role`; and the CLI client (`login`/`whoami`/`logout`) implements
 * the device flow for `jsails login`.
 *
 * Importing this barrel pulls in Better Auth, Kysely, and `mysql2` (the plugin
 * is server-only), so it is a separate subpath rather than part of the root
 * entry.
 */

export { authPlugin, type AuthPluginOptions } from './plugin.js';

// The declarative loader calls `mod.default(options)`, so every first-party
// subpath barrel must default-export its factory alongside the named export.
export { authPlugin as default } from './plugin.js';

export { authSessionToken, type AuthSessionService } from './token.js';

export {
  createAuth,
  deviceApi,
  resolveSessionFromRequest,
  type Auth,
  type AuthBuildOptions,
  type DeviceApi,
} from './instance.js';

export { getAuthMigrations, type AuthMigrations } from './migrations.js';

export { handleDeviceAction, handleLogin, handleLogout, type RateLimitHook } from './routes.js';

export { handleRegister, type RegistrationOptions } from './registration.js';

export {
  buildResetPasswordSender,
  buildVerificationSender,
  handleRequestPasswordReset,
  handleResetPassword,
  handleSendVerificationEmail,
  type PasswordResetOptions,
  type SendMailFn,
  type VerificationOptions,
} from './password-reset.js';

export { adminOnly, requireRole, sessionRole, type RoleCheck } from './roles.js';

export {
  CliAuthError,
  login,
  logout,
  whoami,
  type Credentials,
  type LoginOptions,
} from './cli-client.js';

export {
  apiTokensToken,
  createApiToken,
  createApiTokenHandlers,
  createApiTokenManager,
  createApiTokenStore,
  listApiTokens,
  resolveApiTokensOptions,
  revokeApiToken,
  ApiTokenError,
  type ApiToken,
  type ApiTokenErrorCode,
  type ApiTokenHandlers,
  type ApiTokenService,
  type ApiTokenStore,
  type ApiTokensOptions,
  type CreateApiTokenInput,
  type CreatedApiToken,
  type ResolvedApiToken,
  type ResolvedApiTokensOptions,
} from './api-tokens.js';
