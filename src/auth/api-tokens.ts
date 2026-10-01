/**
 * First-party API tokens for the `auth` plugin.
 *
 * An API token is a long-lived Better Auth session tagged with a sentinel
 * `userAgent` prefix (`jsails/api-token:<name>`), so the token store rides on
 * the existing session table with no new schema: creation mints a session via
 * `internalAdapter.createSession` (returning the raw session token exactly
 * once), resolution reads it back through `internalAdapter.findSession`, and
 * revocation deletes it via `internalAdapter.deleteSession`. Tokens are
 * therefore durable and shared across processes like every session, and are
 * cleanly separable from browser sessions by the sentinel.
 *
 * The surface is deliberately narrow:
 *
 * - {@link ApiTokenStore} — the persistence seam (`create`/`list`/`revoke`/
 *   `resolve`), backed by {@link createApiTokenStore} over the auth instance's
 *   internal adapter.
 * - {@link ApiTokenService} — the per-request API
 *   (`createApiToken`/`listApiTokens`/`revokeApiToken`/
 *   `resolveSessionWithApiToken`), built by {@link createApiTokenManager}.
 * - The {@link apiTokensToken} service token the plugin provides when the
 *   `apiTokens.enabled` option is set, plus the standalone
 *   `createApiToken`/`listApiTokens`/`revokeApiToken` helpers that read it from
 *   a `RequestContext`.
 * - {@link createApiTokenHandlers} — the trusted `/api/tokens` route handlers.
 *
 * The token secret is returned exactly once, from `createApiToken`; the list
 * and resolve paths never expose it. Token management routes require a
 * signed-in *browser* session plus same-origin + CSRF for mutations, while
 * `resolveSessionWithApiToken` accepts a token only as a fallback after the
 * cookie session already failed to resolve — and never when tokens are
 * disabled.
 */

import { createServiceToken, type ServiceToken } from '../extensions/services.js';
import { forbiddenResponse } from '../internal/responses.js';
import type { RequestContext, Session } from '../contracts/http.js';
import { CSRF_HEADER } from '../server/request-pipeline.js';
import { assertCsrfToken, AuthError } from './csrf.js';
import { deriveCsrfToken, type Auth } from './instance.js';
import { isSameOriginRequest } from '../internal/trusted-mutation.js';
import { json } from './routes.js';

/** Sentinel `userAgent` prefix tagging a session as an API token. */
const API_TOKEN_MARKER = 'jsails/api-token:';

/** Default lifetime for a freshly minted token, in days. */
const DEFAULT_EXPIRES_IN_DAYS = 30;

/** Upper bound on a token lifetime, in days (ten years). */
const MAX_EXPIRES_IN_DAYS = 3650;

/** Maximum display-name length, in characters. */
const MAX_NAME_LENGTH = 200;

/** Default header carrying the token credential. */
const DEFAULT_HEADER_NAME = 'authorization';

/** Milliseconds in one day. */
const DAY_MS = 24 * 60 * 60 * 1000;

/** Longest credential accepted from a request header. */
const MAX_CREDENTIAL_LENGTH = 512;

/** Options for the `apiTokens` plugin surface. */
export interface ApiTokensOptions {
  /** Enable the token store, service, and `/api/tokens` routes. Defaults to `false`. */
  readonly enabled?: boolean;
  /** Header carrying the `Bearer <token>` credential. Defaults to `authorization`. */
  readonly headerName?: string;
  /** Default token lifetime in days. Defaults to `30`; bounded `1..3650`. */
  readonly expiresInDays?: number;
  /** Injected token store (tests/custom backends); defaults to the DB-backed store. */
  readonly store?: ApiTokenStore;
}

/** Resolved scalar options for the token surface (the `store` seam is separate). */
export interface ResolvedApiTokensOptions {
  readonly enabled: boolean;
  readonly headerName: string;
  readonly expiresInDays: number;
}

/**
 * Resolve and validate the `apiTokens` option. Invalid values (a header name
 * with control characters, or an out-of-range lifetime) throw a plain `Error`
 * at construction time — they are programmer errors, not request failures.
 */
export function resolveApiTokensOptions(options?: ApiTokensOptions): ResolvedApiTokensOptions {
  const enabled = options?.enabled === true;

  const headerName = options?.headerName ?? DEFAULT_HEADER_NAME;
  if (typeof headerName !== 'string' || headerName.trim() === '' || containsControl(headerName)) {
    throw new Error('apiTokens.headerName must be a non-empty string without control characters');
  }

  const expiresInDays = options?.expiresInDays ?? DEFAULT_EXPIRES_IN_DAYS;
  if (
    typeof expiresInDays !== 'number' ||
    !Number.isInteger(expiresInDays) ||
    expiresInDays < 1 ||
    expiresInDays > MAX_EXPIRES_IN_DAYS
  ) {
    throw new Error(
      `apiTokens.expiresInDays must be an integer between 1 and ${MAX_EXPIRES_IN_DAYS}`,
    );
  }

  return { enabled, headerName: headerName.trim(), expiresInDays };
}

/** A persisted API token as exposed to its owner (never the secret). */
export interface ApiToken {
  /** Stable identifier (the Better Auth session id). */
  readonly id: string;
  /** Display name, trimmed. */
  readonly name: string;
  /** Creation time as a Unix epoch timestamp in milliseconds. */
  readonly createdAt: number;
  /** Expiry as a Unix epoch timestamp in milliseconds. */
  readonly expiresAt: number;
}

/** The result of minting a token: the descriptor plus the one-time secret. */
export interface CreatedApiToken extends ApiToken {
  /** The raw credential. Returned exactly once, here; never persisted elsewhere. */
  readonly token: string;
}

/** A resolved token credential, ready to be mapped to a {@link Session}. */
export interface ResolvedApiToken {
  /** The Better Auth session id backing the token. */
  readonly sessionId: string;
  /** The owning user id. */
  readonly userId: string;
  /** The user's display name. */
  readonly name: string;
  /** The user's primary email. */
  readonly email: string;
  /** Expiry as a Unix epoch timestamp in milliseconds. */
  readonly expiresAt: number;
}

/**
 * Persistence seam for API tokens. The built-in implementation stores tokens
 * as tagged Better Auth sessions; a test or custom backend may supply its own.
 */
export interface ApiTokenStore {
  create(userId: string, name: string, expiresAt: Date): Promise<CreatedApiToken>;
  list(userId: string): Promise<ApiToken[]>;
  revoke(userId: string, tokenId: string): Promise<boolean>;
  resolve(token: string): Promise<ResolvedApiToken | null>;
}

/**
 * Build the database-backed store over a Better Auth instance. The internal
 * adapter is resolved lazily (once), so constructing the store opens no
 * connection.
 */
export function createApiTokenStore(auth: Auth): ApiTokenStore {
  const adapter = auth.$context.then((ctx) => ctx.internalAdapter);

  return {
    async create(userId, name, expiresAt) {
      const session = await (
        await adapter
      ).createSession(
        userId,
        undefined,
        { userAgent: apiTokenUserAgent(name), expiresAt },
        // `overrideAll` lets the caller-supplied `expiresAt`/`userAgent` win
        // over Better Auth's computed defaults (which are derived from the
        // session-expiration config and the current request's headers).
        true,
      );
      return {
        id: session.id,
        name,
        createdAt: new Date(session.createdAt).getTime(),
        expiresAt: new Date(session.expiresAt).getTime(),
        token: session.token,
      };
    },

    async list(userId) {
      const sessions = await (await adapter).listSessions(userId, { onlyActiveSessions: true });
      const tokens: ApiToken[] = [];
      for (const session of sessions) {
        const name = apiTokenName(session);
        if (name === null) continue;
        tokens.push({
          id: session.id,
          name,
          createdAt: new Date(session.createdAt).getTime(),
          expiresAt: new Date(session.expiresAt).getTime(),
        });
      }
      return tokens;
    },

    async revoke(userId, tokenId) {
      const sessions = await (await adapter).listSessions(userId);
      const match = sessions.find((s) => s.id === tokenId && apiTokenName(s) !== null);
      if (match === undefined) return false;
      await (await adapter).deleteSession(match.token);
      return true;
    },

    async resolve(token) {
      const found = await (await adapter).findSession(token);
      if (found === null) return null;
      const { session, user } = found;
      if (apiTokenName(session) === null) return null;
      const expiresAt = new Date(session.expiresAt).getTime();
      if (expiresAt <= Date.now()) return null;
      return {
        sessionId: session.id,
        userId: user.id,
        name: user.name,
        email: user.email,
        expiresAt,
      };
    },
  };
}

/** Input for minting a token. */
export interface CreateApiTokenInput {
  /** Display name; trimmed, non-empty, at most 200 chars, no control chars. */
  readonly name: string;
  /** Lifetime override in days (1..3650); defaults to the configured value. */
  readonly expiresInDays?: number;
}

/**
 * The per-request API-token service the plugin provides under
 * {@link apiTokensToken} when `apiTokens.enabled` is set.
 */
export interface ApiTokenService {
  createApiToken(context: RequestContext, input: CreateApiTokenInput): Promise<CreatedApiToken>;
  listApiTokens(context: RequestContext): Promise<ApiToken[]>;
  revokeApiToken(context: RequestContext, id: string): Promise<boolean>;
  /** Cookie session first, then the `Bearer` token; `null` when neither holds. */
  resolveSessionWithApiToken(request: Request): Promise<Session | null>;
}

/**
 * Build the API-token service. `cookieSession` resolves the browser session
 * (cookie only); the token credential is only consulted after it yields `null`.
 */
export function createApiTokenManager(deps: {
  readonly store: ApiTokenStore;
  readonly cookieSession: (request: Request) => Promise<Session | null>;
  readonly secret?: string;
  readonly headerName: string;
  readonly expiresInDays: number;
}): ApiTokenService {
  return {
    async createApiToken(context, input) {
      const userId = requireUserId(context);
      const name = validateName(input.name);
      const expiresAt = resolveExpiry(input.expiresInDays, deps.expiresInDays);
      return deps.store.create(userId, name, expiresAt);
    },

    async listApiTokens(context) {
      return deps.store.list(requireUserId(context));
    },

    async revokeApiToken(context, id) {
      const userId = requireUserId(context);
      if (typeof id !== 'string' || id === '') return false;
      return deps.store.revoke(userId, id);
    },

    async resolveSessionWithApiToken(request) {
      const cookie = await deps.cookieSession(request);
      if (cookie !== null) return cookie;

      const token = extractToken(request, deps.headerName);
      if (token === null) return null;

      const resolved = await deps.store.resolve(token);
      if (resolved === null) return null;

      return {
        id: resolved.sessionId,
        csrfToken: deriveCsrfToken(resolved.sessionId, deps.secret),
        data: { user: { id: resolved.userId, name: resolved.name, email: resolved.email } },
        expiresAt: resolved.expiresAt,
      };
    },
  };
}

/** Opaque token for the {@link ApiTokenService}, provided when tokens are enabled. */
export const apiTokensToken: ServiceToken<ApiTokenService> =
  createServiceToken<ApiTokenService>('auth.api-tokens');

/** Machine-readable reason for an {@link ApiTokenError}. */
export type ApiTokenErrorCode =
  'unauthorized' | 'invalid_name' | 'invalid_expiry' | 'invalid_body' | 'disabled';

/** A value-free failure from the API-token surface. */
export class ApiTokenError extends Error {
  readonly code: ApiTokenErrorCode;
  /** Suggested HTTP status for the failure. */
  readonly status: number;

  constructor(code: ApiTokenErrorCode, message: string, status: number) {
    super(message);
    this.name = 'ApiTokenError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Mint a token for the session on `context`. Reads the service from
 * `context.services`; throws {@link ApiTokenError} (`disabled`) when the
 * `apiTokens` surface is not enabled.
 */
export function createApiToken(
  context: RequestContext,
  input: CreateApiTokenInput,
): Promise<CreatedApiToken> {
  return requireApiTokenService(context).createApiToken(context, input);
}

/** List the tokens owned by the session on `context` (no secrets). */
export function listApiTokens(context: RequestContext): Promise<ApiToken[]> {
  return requireApiTokenService(context).listApiTokens(context);
}

/** Revoke the token `id` owned by the session on `context`. */
export function revokeApiToken(context: RequestContext, id: string): Promise<boolean> {
  return requireApiTokenService(context).revokeApiToken(context, id);
}

/** The trusted `/api/tokens` handlers, mounted by the plugin when enabled. */
export interface ApiTokenHandlers {
  create(request: Request): Promise<Response>;
  list(request: Request): Promise<Response>;
  remove(request: Request, id: string): Promise<Response>;
}

/**
 * Build the `/api/tokens` route handlers. `resolveSession` must be the
 * cookie-only browser-session resolver (tokens are managed by a signed-in
 * browser, never by another token); `publicOrigin` is the same-origin boundary.
 */
export function createApiTokenHandlers(options: {
  readonly service: ApiTokenService;
  readonly resolveSession: (request: Request) => Promise<Session | null>;
  readonly publicOrigin?: string;
}): ApiTokenHandlers {
  const { service, resolveSession, publicOrigin } = options;

  return {
    async create(request) {
      if (!isSameOriginRequest(request, publicOrigin)) {
        return forbiddenResponse();
      }
      const session = await resolveSession(request);
      if (session === null) {
        return json({ error: 'authentication required' }, 401);
      }
      if (!csrfValid(request, session)) {
        return json({ error: 'CSRF token missing or mismatch', code: 'csrf-mismatch' }, 403);
      }
      try {
        const input = await readCreateInput(request);
        const created = await service.createApiToken(contextFor(request, session), input);
        return json(created, 201);
      } catch (error) {
        return toApiTokenErrorResponse(error);
      }
    },

    async list(request) {
      const session = await resolveSession(request);
      if (session === null) {
        return json({ error: 'authentication required' }, 401);
      }
      try {
        return json(await service.listApiTokens(contextFor(request, session)));
      } catch (error) {
        return toApiTokenErrorResponse(error);
      }
    },

    async remove(request, id) {
      if (!isSameOriginRequest(request, publicOrigin)) {
        return forbiddenResponse();
      }
      const session = await resolveSession(request);
      if (session === null) {
        return json({ error: 'authentication required' }, 401);
      }
      if (!csrfValid(request, session)) {
        return json({ error: 'CSRF token missing or mismatch', code: 'csrf-mismatch' }, 403);
      }
      try {
        const revoked = await service.revokeApiToken(contextFor(request, session), id);
        return revoked
          ? json({ revoked: true })
          : json({ error: 'token not found', code: 'not_found' }, 404);
      } catch (error) {
        return toApiTokenErrorResponse(error);
      }
    },
  };
}

// --- Internal helpers. ---

function requireApiTokenService(context: RequestContext): ApiTokenService {
  const service = context.services?.tryGet(apiTokensToken);
  if (service === undefined) {
    throw new ApiTokenError('disabled', 'API tokens are not enabled', 404);
  }
  return service;
}

/** Read the owning user id from a resolved session, or throw `unauthorized`. */
function requireUserId(context: RequestContext): string {
  const userId = sessionUserId(context.session);
  if (userId === null) {
    throw new ApiTokenError('unauthorized', 'authentication required', 401);
  }
  return userId;
}

/** Extract a non-empty string user id from `session.data.user.id`, or `null`. */
function sessionUserId(session: Session | null): string | null {
  if (session === null) return null;
  const user = session.data.user;
  if (typeof user !== 'object' || user === null || Array.isArray(user)) return null;
  const id = user.id;
  return typeof id === 'string' && id !== '' ? id : null;
}

/** Validate a token display name, returning the trimmed name or throwing. */
function validateName(value: unknown): string {
  if (typeof value !== 'string') {
    throw new ApiTokenError('invalid_name', 'token name is required', 400);
  }
  const name = value.trim();
  if (name === '') {
    throw new ApiTokenError('invalid_name', 'token name is required', 400);
  }
  if (name.length > MAX_NAME_LENGTH) {
    throw new ApiTokenError(
      'invalid_name',
      `token name must be at most ${MAX_NAME_LENGTH} characters`,
      400,
    );
  }
  if (containsControl(name)) {
    throw new ApiTokenError('invalid_name', 'token name must not contain control characters', 400);
  }
  return name;
}

/** Resolve a token expiry date from an optional day count, or throw. */
function resolveExpiry(expiresInDays: unknown, defaultDays: number): Date {
  const days = expiresInDays === undefined ? defaultDays : expiresInDays;
  if (
    typeof days !== 'number' ||
    !Number.isInteger(days) ||
    days < 1 ||
    days > MAX_EXPIRES_IN_DAYS
  ) {
    throw new ApiTokenError(
      'invalid_expiry',
      `expiresInDays must be an integer between 1 and ${MAX_EXPIRES_IN_DAYS}`,
      400,
    );
  }
  return new Date(Date.now() + days * DAY_MS);
}

/** The sentinel-tagged `userAgent` value a token session is minted with. */
function apiTokenUserAgent(name: string): string {
  return `${API_TOKEN_MARKER}${name}`;
}

/** The display name of a token session, or `null` when it is not a token session. */
function apiTokenName(session: { userAgent?: string | null }): string | null {
  const { userAgent } = session;
  if (typeof userAgent !== 'string' || !userAgent.startsWith(API_TOKEN_MARKER)) {
    return null;
  }
  return userAgent.slice(API_TOKEN_MARKER.length);
}

/** Extract a `Bearer <token>` credential from the configured header, or `null`. */
function extractToken(request: Request, headerName: string): string | null {
  const header = request.headers.get(headerName);
  if (header === null) return null;
  const value = header.trim();
  if (value === '' || value.length > MAX_CREDENTIAL_LENGTH) return null;
  const match = /^Bearer[ \t]+(\S+)$/i.exec(value);
  return match?.[1] ?? null;
}

/** Whether `value` contains any ASCII control character. */
function containsControl(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** Verify the session-bound CSRF token, failing closed on any mismatch. */
function csrfValid(request: Request, session: Session): boolean {
  try {
    assertCsrfToken(session, request.headers.get(CSRF_HEADER));
    return true;
  } catch (error) {
    if (error instanceof AuthError) return false;
    throw error;
  }
}

/** A minimal request context carrying only what the service reads. */
function contextFor(request: Request, session: Session): RequestContext {
  return { request, url: new URL(request.url), params: {}, session };
}

/** Parse the JSON `{ name, expiresInDays? }` body, or throw `invalid_body`. */
async function readCreateInput(request: Request): Promise<CreateApiTokenInput> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    throw new ApiTokenError('invalid_body', 'request body must be valid JSON', 400);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ApiTokenError('invalid_body', 'request body must be a JSON object', 400);
  }
  const body = parsed as Record<string, unknown>;
  return {
    name: body.name as string,
    ...(body.expiresInDays === undefined ? {} : { expiresInDays: body.expiresInDays as number }),
  };
}

/** Map a thrown error to a value-free JSON response. */
function toApiTokenErrorResponse(error: unknown): Response {
  if (error instanceof ApiTokenError) {
    return json({ error: error.message, code: error.code }, error.status);
  }
  return json({ error: 'internal error' }, 500);
}
