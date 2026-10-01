/**
 * Hono environment types for the JSails HTTP pipeline.
 *
 * `HttpVariables` holds per-request values set by pipeline middleware via
 * `c.set(...)`. The terminal handler maps `c.var` plus `c.req.*` to the
 * sovereign {@link RequestContext} — a single adapter that lives in
 * `request-pipeline.ts` so Hono's `Context` never leaks into the authoring
 * surface.
 *
 * This module has zero runtime deps — only `import type` from Hono and the
 * JSails contracts — so `routing/middleware.ts` can import from it with no
 * cycle risk.
 */

import type { Context, MiddlewareHandler } from 'hono';

import type { ServiceRegistry } from '../extensions/services.js';
import type { AssetUrlResolver, Session } from '../contracts/http.js';
import type { SeoRuntimeOptions } from '../seo/metadata.js';

/**
 * Per-request values stored on `c.var` by pipeline middleware stages.
 * `request`, `url`, and `params` come from `c.req.*` and are deliberately
 * NOT stored here — they are already available through Hono's API.
 */
export interface HttpVariables {
  /** Resolved session (or null when unauthenticated / no resolver). */
  session: Session | null;
  /** Read-only service registry, when the host wired one in. */
  services?: ServiceRegistry;
  /** Public origin, when configured. */
  publicOrigin?: string;
  /** Asset-URL resolver, when the host wired one in. */
  assetUrl?: AssetUrlResolver;
  /** Persistent-storage directory, when the host wired one in. */
  storagePath?: string;
  /** SEO runtime options, when the host wired them in. */
  seo?: SeoRuntimeOptions;
  /** Resolved request locale, when the i18n plugin is active. */
  locale?: string;
}

/** Hono env for the JSails pipeline. */
export type AppEnv = { Variables: HttpVariables };

/** Hono `Context` typed for the JSails pipeline. */
export type AppContext = Context<AppEnv>;

/** Hono `MiddlewareHandler` typed for the JSails pipeline. */
export type AppMiddlewareHandler = MiddlewareHandler<AppEnv>;
