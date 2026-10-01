/**
 * Better Auth wiring for the first-party `auth` plugin.
 *
 * `createAuth()` is the single construction entry point. Called with no
 * arguments it lazily builds (once) and returns the shared memoized Better Auth
 * instance backed by MariaDB through a Kysely `MysqlDialect` over a `mysql2`
 * connection pool; called with {@link AuthBuildOptions} it builds a fresh
 * instance with those overrides (the `auth` plugin uses this to configure
 * sign-up/reset behavior per mount). Importing this module reads no environment
 * variable, creates no pool, and does no database work — construction happens
 * on the first call.
 *
 * Every instance is disposable: it carries an idempotent `dispose()` that
 * releases the Kysely connection pool (`disposeCachedAuth` disposes the
 * memoized instance; the `auth` plugin disposes its own on shutdown). Without
 * this, the open mysql2 socket keeps the event loop alive after `close()`.
 *
 * JSails never auto-loads a `.env` file. The variables below are read directly
 * from `process.env`; export them in the process environment (shell, ONCE,
 * systemd) before starting the app.
 */

import { createHmac } from 'node:crypto';

import { betterAuth } from 'better-auth';
import { bearer } from 'better-auth/plugins/bearer';
import { deviceAuthorization } from 'better-auth/plugins/device-authorization';
import { magicLink } from 'better-auth/plugins/magic-link';
import { twoFactor } from 'better-auth/plugins/two-factor';
import type { SocialProviders } from 'better-auth/social-providers';
import { Kysely, MysqlDialect } from 'kysely';
import { createPool } from 'mysql2';

import type { BetterAuthOptions } from 'better-auth';

import type { Session } from '../contracts/http.js';

/** The Better Auth instance type. */
export type Auth = ReturnType<typeof betterAuth>;

/** An {@link Auth} instance whose connection pool can be explicitly released. */
export type DisposableAuth = Auth & { dispose(): Promise<void> };

/**
 * Raised when a disposable auth instance cannot release its connection pool.
 * Value-free: the message never echoes the DSN, host, user, or password, and
 * there is no `cause` chain that could carry a credential through it.
 */
export class AuthDisposeError extends Error {
  constructor() {
    super('Failed to release the auth database connection pool');
    this.name = 'AuthDisposeError';
  }
}

/** Default MariaDB port when `DATABASE_PORT` is unset. */
const DEFAULT_DATABASE_PORT = 3306;

/** Default public base URL Better Auth uses to build callback URLs. */
const DEFAULT_BASE_URL = 'http://localhost:3000';

/**
 * RFC 8628 client id the CLI uses. The device authorization plugin's
 * `validateClient` allowlists only this id, so no other client can request
 * device codes or redeem device tokens.
 */
const CLI_CLIENT_ID = 'jsails-cli';

/** Overridable construction inputs for {@link createAuth}. */
export interface AuthBuildOptions {
  /** The Better Auth signing secret; falls back to the environment when unset. */
  readonly secret?: string;
  /** Public base URL; falls back to `BETTER_AUTH_URL` then localhost. */
  readonly baseUrl?: string;
  /** RFC 8628 client id allowed to use the device flow. */
  readonly deviceClientId?: string;
  /**
   * Enable two-factor authentication (TOTP + backup codes). `true` mounts the
   * `two-factor` plugin with default settings; an object tunes the `issuer`
   * (the authenticator app label). The `twoFactor` table is added to
   * `getAuthMigrations()` automatically via the plugin tree.
   */
  readonly twoFactor?: boolean | { readonly issuer?: string };
  /**
   * Social (OAuth) provider configs, keyed by provider id (`google`, `github`,
   * …). Each entry is the provider's client credentials config; callbacks and
   * the account-link surface ride the existing `ALL /api/auth/*` handler.
   */
  readonly socialProviders?: SocialProviders;
  /**
   * Enable magic-link sign-in. `true` mounts the `magic-link` plugin with
   * default settings; `sendMagicLink` must deliver the link (e.g. adapt the
   * app's `sendMail` seam into `(email, url) => void`). The `magicLink` table
   * is added to `getAuthMigrations()` automatically.
   */
  readonly magicLink?: boolean | { readonly expiresIn?: number };
  /** Callback delivering a magic link: receives the target email and the URL. */
  readonly sendMagicLink?: (data: { email: string; url: string }) => void | Promise<void>;
}

/** The Better Auth signing secret, or `undefined` when unset. */
function authSecret(): string | undefined {
  return process.env.BETTER_AUTH_SECRET ?? process.env.AUTH_SECRET;
}

/**
 * Read a required MariaDB connection variable from `process.env`. A missing or
 * empty value throws a value-free error that names only the variable, never its
 * value.
 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/**
 * Read `DATABASE_PORT`, defaulting to 3306. A present but non-integer value is
 * rejected without echoing the value.
 */
function readDatabasePort(): number {
  const raw = process.env.DATABASE_PORT;
  if (raw === undefined || raw === '') {
    return DEFAULT_DATABASE_PORT;
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('DATABASE_PORT must be an integer between 1 and 65535');
  }
  return port;
}

/**
 * Build a Better Auth instance from the environment plus any overrides. The
 * required MariaDB connection variables are read individually; `secret`,
 * `baseUrl`, and `deviceClientId` fall back to their environment or default
 * values. This performs all construction eagerly; {@link createAuth} wraps it
 * with memoization for the no-options case.
 *
 * The returned instance is disposable: {@link attachDispose} attaches an
 * idempotent `dispose()` that releases the underlying Kysely pool, running
 * `onDisposed` (the no-options path clears the memo) after a successful
 * destroy.
 */
function buildAuthInstance(options: AuthBuildOptions, onDisposed?: () => void): DisposableAuth {
  const pool = createPool({
    host: requireEnv('DATABASE_HOST'),
    user: requireEnv('DATABASE_USER'),
    password: requireEnv('DATABASE_PASSWORD'),
    database: requireEnv('DATABASE_NAME'),
    port: readDatabasePort(),
  });

  const db = new Kysely({ dialect: new MysqlDialect({ pool }) });

  // Annotate with the library's options type instead of letting the options be
  // inferred as a narrowed literal. `betterAuth` is generic in its options and
  // `Auth<O>` is invariant in `O`, so an inferred literal yields
  // `Auth<{ ...narrowed... }>`, which does not assign to the
  // `ReturnType<typeof betterAuth>` (i.e. `Auth<BetterAuthOptions>`) declared
  // for the memoized instance.
  const betterAuthOptions: BetterAuthOptions = {
    // The database option MUST wrap the Kysely instance with `type: 'mysql'`;
    // a bare Kysely instance is rejected by Better Auth.
    database: { db, type: 'mysql' },
    // Runtime schema validation is disabled. JSails owns the auth schema through
    // its migration seam (`auth:migrate` / `getAuthMigrations`), so a per-instance
    // runtime check is redundant — and it is a teardown hazard: Better Auth runs
    // it as a detached fire-and-forget promise (`void pendingSchemaCheck.catch(...)`)
    // that checks out a Kysely pool connection. When `dispose()` destroys the pool
    // before that check settles, `pool.end()` waits on the in-use connection
    // forever and the process never exits. `validateSchema: false` makes the
    // adapter register its check with `runtimeEnabled: false`, so `checkSchema`
    // is `undefined` and the detached check is never created.
    advanced: {
      database: { validateSchema: false },
    },
    emailAndPassword: { enabled: true },
    secret: options.secret ?? authSecret(),
    baseURL: options.baseUrl ?? process.env.BETTER_AUTH_URL ?? DEFAULT_BASE_URL,
    ...(options.socialProviders !== undefined ? { socialProviders: options.socialProviders } : {}),
    plugins: [
      // Device authorization (RFC 8628) powers `jsails login`: the CLI requests
      // a device/user code, the user approves it on `/device`, and the CLI polls
      // `/api/auth/device/token` for a session token. `validateClient` restricts
      // both endpoints to the known CLI client id.
      deviceAuthorization({
        validateClient: (clientId) => clientId === (options.deviceClientId ?? CLI_CLIENT_ID),
      }),
      // `bearer` maps an `Authorization: Bearer <session-token>` header onto the
      // session cookie, so CLI requests (`jsails whoami` → `/api/me`) reach
      // `resolveSessionFromRequest` through the same seam as browser cookies.
      bearer(),
      // Two-factor authentication (TOTP + backup codes). Opt-in; `false`/absent
      // leaves the plugin unmounted. The `two-factor` endpoints ride the
      // existing `ALL /api/auth/*` handler, so no extra route wiring is needed.
      ...(options.twoFactor !== undefined
        ? [
            twoFactor(
              typeof options.twoFactor === 'object' ? { issuer: options.twoFactor.issuer } : {},
            ),
          ]
        : []),
      // Magic-link sign-in. Opt-in; `sendMagicLink` is required to deliver the
      // link (the plugin's `sendMagicLink` callback). The endpoint rides the
      // existing `ALL /api/auth/*` handler.
      ...(options.magicLink !== undefined
        ? [
            magicLink({
              ...(typeof options.magicLink === 'object' && options.magicLink.expiresIn !== undefined
                ? { expiresIn: options.magicLink.expiresIn }
                : {}),
              sendMagicLink: async (data) => {
                if (options.sendMagicLink !== undefined) {
                  await options.sendMagicLink({ email: data.email, url: data.url });
                } else {
                  throw new Error('magic link requires sendMagicLink');
                }
              },
            }),
          ]
        : []),
    ],
  };

  const auth = betterAuth(betterAuthOptions);

  return attachDispose(auth, () => destroyDatabase(db), onDisposed);
}

/**
 * Attach a non-enumerable, idempotent `dispose()` to an auth instance.
 *
 * The first call runs `onDispose` (releasing the underlying connection pool)
 * and then `clearMemo` (when given); every later call — including concurrent
 * calls that begin before the first resolves — returns the same promise, so the
 * pool is destroyed at most once. A rejecting `onDispose` is surfaced as a
 * value-free {@link AuthDisposeError}.
 *
 * Exported from this module (not the `jsails/auth` barrel) so tests can drive
 * disposal with a fake destroy function and no live database.
 */
export function attachDispose(
  auth: Auth,
  onDispose: () => Promise<void>,
  clearMemo?: () => void,
): DisposableAuth {
  let pending: Promise<void> | undefined;
  Object.defineProperty(auth, 'dispose', {
    configurable: true,
    enumerable: false,
    value: (): Promise<void> => {
      pending ??= (async () => {
        try {
          await onDispose();
        } catch {
          throw new AuthDisposeError();
        }
        clearMemo?.();
      })();
      return pending;
    },
    writable: true,
  });
  return auth as DisposableAuth;
}

/**
 * Release a Kysely instance's underlying connection pool. The structural guard
 * makes disposal a no-op for a value without `destroy` — always a Kysely here,
 * but kept honest so disposal can be attached to any instance safely.
 */
async function destroyDatabase(db: { destroy?: () => Promise<void> }): Promise<void> {
  if (db.destroy !== undefined) {
    await db.destroy();
  }
}

let cachedAuth: DisposableAuth | undefined;

/**
 * Build (once, lazily) and return the shared Better Auth instance.
 *
 * Importing this module reads no environment variable, creates no pool, and
 * does no database work; construction happens on the first `createAuth()` call
 * without options. This keeps the app config importable (and therefore
 * `jsails build` / static export working) without a database, while a live
 * request or an auth script still resolves the same memoized instance on
 * demand.
 *
 * With explicit {@link AuthBuildOptions}, a fresh instance is built instead
 * (never memoized), so the `auth` plugin can configure sign-up/reset behavior
 * per mount without mutating the shared instance.
 *
 * - `DATABASE_HOST` / `DATABASE_USER` / `DATABASE_PASSWORD` / `DATABASE_NAME` —
 *   required MariaDB connection variables (JSails reads them individually; there
 *   is no `DATABASE_URL`). A missing variable throws a value-free error naming
 *   only that variable. `DATABASE_PORT` defaults to 3306.
 * - `BETTER_AUTH_SECRET` / `AUTH_SECRET` — passed straight through. Better Auth
 *   itself fails in production without a secret; JSails does not invent a
 *   fallback.
 * - `BETTER_AUTH_URL` — public base URL, default `http://localhost:3000`.
 */
export function createAuth(options?: AuthBuildOptions): Auth {
  if (options !== undefined) {
    return buildAuthInstance(options);
  }
  cachedAuth ??= buildAuthInstance({}, () => {
    cachedAuth = undefined;
  });
  return cachedAuth;
}

/**
 * Release the shared memoized auth instance's connection pool, if one was
 * built. A no-op when the memo has never been built (there is no instance to
 * release).
 *
 * This is the seam the starter app config calls on shutdown: it takes no
 * arguments and cannot reach the service registry, so it can be wired into any
 * cleanup path. Disposal goes through the instance's own idempotent `dispose`,
 * and a successful disposal clears the memo so a later {@link createAuth}
 * builds a fresh instance.
 */
export async function disposeCachedAuth(): Promise<void> {
  const instance = cachedAuth;
  if (instance === undefined) {
    return;
  }
  await instance.dispose();
}

/**
 * Typed view of the device-flow endpoints registered by the device
 * authorization plugin.
 *
 * `betterAuth` is annotated with `BetterAuthOptions` (see `createAuth`), so
 * `auth.api` types only the built-in endpoints; the plugin registers its
 * endpoints at runtime but they are not reflected in `Auth<BetterAuthOptions>`.
 * {@link deviceApi} restores the checked types for the three endpoints the
 * auth plugin calls, in one place rather than a cast at each call site.
 */
export interface DeviceApi {
  deviceVerify(input: {
    query: { user_code: string };
    headers: HeadersInit;
  }): Promise<{ user_code: string; status: string; client_id?: string; scope?: string }>;
  deviceApprove(input: { body: { userCode: string }; headers: HeadersInit }): Promise<{
    success: boolean;
  }>;
  deviceDeny(input: { body: { userCode: string }; headers: HeadersInit }): Promise<{
    success: boolean;
  }>;
}

/** Access the device-flow endpoints with checked types (see {@link DeviceApi}). */
export function deviceApi(auth: Auth): DeviceApi {
  return auth.api as unknown as DeviceApi;
}

/** Purpose-separated message for the per-session CSRF token. */
const SESSION_CSRF_MESSAGE_PREFIX = 'jsails.session.csrf:';

/**
 * Derive the JSails CSRF token for a Better Auth session id.
 *
 * Keyed by the signing secret when one is configured. Without a secret the token
 * is a stable, deterministic value with no cryptographic binding: it keeps a
 * session consistent across requests within a process but offers no CSRF
 * protection. That is acceptable because there are no authenticated filesystem
 * mutations (`/api/me` is a GET; login and logout are trusted hook routes that
 * own their own origin checks).
 */
export function deriveCsrfToken(sessionId: string, secret: string | undefined): string {
  if (secret === undefined || secret === '') {
    return `csrf:${sessionId}`;
  }
  return createHmac('sha256', secret)
    .update(`${SESSION_CSRF_MESSAGE_PREFIX}${sessionId}`)
    .digest('base64url');
}

/**
 * Map a Better Auth session (read from the request cookie) to the JSails
 * {@link Session} shape, or `null` when the request is unauthenticated.
 *
 * `secret` keys the per-session CSRF token; it defaults to the configured
 * `BETTER_AUTH_SECRET` / `AUTH_SECRET` so the plugin can pass its own explicit
 * secret through for parity with Better Auth's signing key.
 */
export async function resolveSessionFromRequest(
  auth: Auth,
  request: Request,
  secret: string | undefined = authSecret(),
): Promise<Session | null> {
  const result = await auth.api.getSession({ headers: request.headers });
  if (result === null) {
    return null;
  }

  const { session, user } = result;
  return {
    id: session.id,
    csrfToken: deriveCsrfToken(session.id, secret),
    data: {
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
      },
    },
    // Better Auth types this field as `Date`, but the API serializes it as an
    // ISO string; `new Date(...)` normalizes both to an epoch-millisecond number.
    expiresAt: new Date(session.expiresAt).getTime(),
  };
}
