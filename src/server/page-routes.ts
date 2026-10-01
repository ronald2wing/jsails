/**
 * Filesystem page route registration.
 *
 * Serves pages through either the injected `renderPage` callback (module-free)
 * or the structured {@link PageRenderer}. The structured renderer imports the
 * page module lazily so its optional `middleware` export (inline handlers or
 * registered-name strings) is resolved against the named middleware map at
 * registration time — an unknown name fails at assembly. The resolved
 * per-route chain runs after the global chain and before the renderer, so a
 * global middleware may short-circuit with a `Response` (trusted producer) or
 * await `next()`.
 */

import type { Hono } from 'hono';

import type { ServiceRegistry } from '../extensions/services.js';
import type { AssetUrlResolver, RequestContext as PageRequestContext } from '../contracts/http.js';
import type { PageRenderer, PageStream } from '../contracts/render.js';
import { renderStreamResponse } from '../pages/page.js';
import { validateMiddlewareList, type RouteMiddlewareRef } from '../routing/middleware.js';
import { localePrefixPaths, routeToHonoPaths, type RouteManifestEntry } from '../routing/routes.js';
import { createRequestContextFromStore, jsonError } from './request-pipeline.js';
import type { RenderPage, ResolveSession } from '../contracts/http.js';
import type { SeoRuntimeOptions } from '../seo/metadata.js';
import { extractCacheControlDeclaration, wrapPublicResponse } from './cache-control.js';
import type { AppEnv, AppMiddlewareHandler } from './env.js';

/** The typed Hono app used throughout the server assembly. */
type App = Hono<AppEnv>;

/** Register a page route, delegating rendering to the injected callback. */
export function registerPageRoute(
  app: App,
  entry: RouteManifestEntry,
  renderPage: RenderPage,
  resolveSession: ResolveSession | undefined,
  services: ServiceRegistry | undefined,
  publicOrigin: string | undefined,
  assetUrl: AssetUrlResolver | undefined,
  storagePath: string | undefined,
  seo: SeoRuntimeOptions | undefined,
  globalMiddleware: readonly AppMiddlewareHandler[],
  localeOptions?: { readonly locales: readonly string[]; readonly defaultLocale?: string },
): void {
  // Build the per-route chain as Hono handlers.
  const chain: AppMiddlewareHandler[] = [];
  for (const mw of globalMiddleware) chain.push(mw);
  // Terminal adapter: render the page via the `renderPage` callback.
  chain.push(async (c, _next) => {
    const ctx = createRequestContextFromStore(c, c.var);
    return renderPage(entry, ctx);
  });

  // `chain` is always non-empty (terminal adapter at minimum). Optional
  // catch-alls register two Hono paths; the same chain runs for both.
  for (const path of resolveRoutePaths(entry, localeOptions)) {
    app.on('GET', path, ...(chain as [AppMiddlewareHandler, ...AppMiddlewareHandler[]]));
  }
}

/**
 * Register a page route backed by a structured {@link PageRenderer}. The page
 * module is imported lazily so its optional `middleware` export is resolved
 * against the named middleware map at registration time.
 */
export async function registerRendererPageRoute(
  app: App,
  entry: RouteManifestEntry,
  renderer: PageRenderer,
  resolveSession: ResolveSession | undefined,
  services: ServiceRegistry | undefined,
  publicOrigin: string | undefined,
  assetUrl: AssetUrlResolver | undefined,
  storagePath: string | undefined,
  seo: SeoRuntimeOptions | undefined,
  globalMiddleware: readonly AppMiddlewareHandler[],
  middlewareMap: Readonly<Record<string, AppMiddlewareHandler>> | undefined,
  localeOptions?: { readonly locales: readonly string[]; readonly defaultLocale?: string },
): Promise<void> {
  // Resolve the page module's middleware refs at registration time so an unknown
  // named ref fails at assembly (not at request time) with a value-free error.
  const module = (await import(entry.file)) as Record<string, unknown>;
  const refs = validateMiddlewareList(module.middleware, (message) => {
    return new Error(`page route "${entry.route}" ${message}`);
  });

  const cacheControl = extractCacheControlDeclaration(entry.route, module);

  const perRouteMiddleware = resolveStringRefs(refs, middlewareMap, (message) => {
    throw new Error(`page route "${entry.route}" ${message}`);
  });

  // Build the per-route chain as Hono middleware handlers.
  const chain: AppMiddlewareHandler[] = [];
  for (const mw of globalMiddleware) chain.push(mw);
  for (const mw of perRouteMiddleware) chain.push(mw);

  // Terminal adapter: render the page via the structured renderer.
  chain.push(async (c, _next) => {
    const ctx = createRequestContextFromStore(c, c.var);
    try {
      // Streaming precedence: the module's `stream` export wins for live serving.
      if (typeof module.stream === 'function') {
        const stream = await (
          module.stream as (ctx: PageRequestContext) => PageStream | Promise<PageStream>
        )(ctx);
        return renderStreamResponse(stream);
      }
      const html = await renderer.render(entry, ctx, { staticMode: false });
      if (typeof html !== 'string') {
        return jsonError(500, 'internal_error', 'Internal Server Error');
      }
      const response = new Response(html, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
      return cacheControl !== undefined
        ? wrapPublicResponse(response, cacheControl, 'GET')
        : response;
    } catch {
      return jsonError(500, 'internal_error', 'Internal Server Error');
    }
  });

  for (const path of resolveRoutePaths(entry, localeOptions)) {
    app.on('GET', path, ...(chain as [AppMiddlewareHandler, ...AppMiddlewareHandler[]]));
  }
}

/**
 * Every Hono path a route answers: bare/manifest path(s) + locale-prefixed
 * aliases when prefix routing is configured.
 */
function resolveRoutePaths(
  entry: RouteManifestEntry,
  localeOptions?: { readonly locales: readonly string[]; readonly defaultLocale?: string },
): readonly string[] {
  const bare = routeToHonoPaths(entry);
  if (localeOptions === undefined || localeOptions.locales.length === 0) return bare;
  return [...bare, ...localePrefixPaths(entry, localeOptions.locales, localeOptions.defaultLocale)];
}

/** Resolve string refs in a raw middleware list against the named map. */
function resolveStringRefs(
  refs: readonly RouteMiddlewareRef[] | undefined,
  map: Readonly<Record<string, AppMiddlewareHandler>> | undefined,
  onError: (message: string) => Error,
): readonly AppMiddlewareHandler[] {
  if (refs === undefined || refs.length === 0) return [];
  const result: AppMiddlewareHandler[] = [];
  for (let index = 0; index < refs.length; index += 1) {
    const ref = refs[index];
    if (typeof ref === 'function') {
      result.push(ref);
      continue;
    }
    if (typeof ref === 'string') {
      const resolved = map === undefined ? undefined : map[ref];
      if (resolved === undefined) {
        // Value-free: report the position, never the name or handler.
        throw onError(`references an unregistered middleware at index ${index}`);
      }
      result.push(resolved);
    }
  }
  return result;
}
