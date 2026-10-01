/**
 * HTTP-facing contracts: JSON value types, sessions, and the per-request
 * context threaded through routing and middleware. Uses Node's built-in web
 * types (`Request`, `URL`) from `@types/node`; no DOM lib is required.
 *
 * `ServiceRegistry` is referenced through `import type` only: the contract
 * carries no runtime dependency on the extension system (and therefore no ORM
 * or HTTP runtime) and does not require a registry to exist.
 */

import type { ServiceRegistry } from '../extensions/services.js';

/** A JSON-compatible value. */
export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** A string-keyed JSON object. */
export type JsonObject = { [key: string]: JsonValue };

/** A server-side session. */
export interface Session {
  /** Opaque, stable session identifier (the cookie value). */
  readonly id: string;
  /** Per-session CSRF token required by mutating requests. */
  readonly csrfToken: string;
  /** Serialized session data. */
  readonly data: JsonObject;
  /** Expiry as a Unix epoch timestamp in milliseconds. */
  readonly expiresAt: number;
}

/** Storage backend for sessions; all operations are async. */
export interface SessionStore {
  get(id: string): Promise<Session | null>;
  set(session: Session): Promise<void>;
  delete(id: string): Promise<void>;
}

/**
 * Resolves a public asset path (e.g. `/assets/app.js`) to a versioned URL
 * (`/assets/app.js?v=<content hash>`). When the asset cannot be safely resolved
 * (missing, traversing, symlinked, or otherwise invalid) the resolver returns
 * the path unchanged rather than throwing, so browser-free SSR never breaks on
 * a content hash it cannot compute.
 */
export type AssetUrlResolver = (path: string) => string | Promise<string>;

/** Per-request context handed to middleware, pages, and actions. */
export interface RequestContext {
  /** The incoming HTTP request. */
  readonly request: Request;
  /** The parsed request URL. */
  readonly url: URL;
  /** Route parameters extracted from the path (e.g. `{ id: "42" }`). */
  readonly params: Record<string, string>;
  /** The active session, or `null` when absent or unauthenticated. */
  readonly session: Session | null;
  /**
   * The canonical public origin of the app (config `publicOrigin`), when
   * configured. Carried so server-component rendering can bind snapshots to the
   * public origin rather than a proxy's plain-HTTP request URL.
   */
  readonly publicOrigin?: string;
  /**
   * Whether the page is being rendered live (interactive, signable) or
   * statically (SSG/static export, where server components render only their
   * declared fallback). Absent means live.
   */
  readonly renderMode?: 'live' | 'static';
  /**
   * Services provided by applied extensions, when the host wired them in.
   * Optional because not every request runs behind the extension runner.
   */
  readonly services?: ServiceRegistry;
  /**
   * Resolver for public asset URLs, when the host wired one in (the HTTP layer
   * and static site generation both attach it). Absent means callers use
   * unversioned paths. Carried so server components, pages, and templates can
   * emit cache-busted asset URLs without knowing the hashing policy.
   */
  readonly assetUrl?: AssetUrlResolver;
  /**
   * Absolute persistent-storage directory (resolved config `storageDir`), when
   * the host wired one in. Absent means no storage directory is configured for
   * this request path (e.g. browser-free SSR). The directory's existence is not
   * guaranteed here; `Application.serve` creates it before listening.
   */
  readonly storagePath?: string;
}
