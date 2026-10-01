/**
 * Filesystem page route registration.
 *
 * Serves pages through either the injected `renderPage` callback (module-free)
 * or the structured {@link PageRenderer}. The structured renderer imports the
 * page module lazily so its optional `middleware` export (inline handlers or
 * registered-name strings) is resolved against the named middleware registry at
 * registration time — an unknown name fails at assembly. The resolved per-route
 * chain runs after the global chain and before the renderer, so a global
 * middleware may short-circuit with a `Response` (used as-is; trusted producer
 * HTML or a redirect) or await `next()` to proceed. The renderer's HTML string
 * is wrapped in a `text/html; charset=utf-8` response. A non-string renderer
 * result is a contract violation reduced to the generic 500 envelope; the raw
 * value is never echoed. A throwing or rejecting middleware propagates to the
 * HTTP layer's sanitized 500. Page rendering is public: the loader (or the page
 * module) owns its authorization decision.
 */

import type { Hono } from 'hono';

import type { ServiceRegistry } from '../extensions/services.js';
import type { AssetUrlResolver, RequestContext as PageRequestContext } from '../contracts/http.js';
import type { PageRenderer, PageStream } from '../contracts/render.js';
import { renderStreamResponse } from '../pages/page.js';
import {
  runMiddleware,
  validateMiddlewareList,
  resolveMiddlewareRefs,
  type MiddlewareRegistry,
  type RouteMiddleware,
} from '../routing/middleware.js';
import type { RouteManifestEntry } from '../routing/routes.js';
import { createRequestContext, jsonError, resolveSessionOrNull } from './request-pipeline.js';
import type { RenderPage, ResolveSession } from '../contracts/http.js';

/** Register a page route, delegating rendering to the injected callback. */
export function registerPageRoute(
  app: Hono,
  entry: RouteManifestEntry,
  renderPage: RenderPage,
  resolveSession: ResolveSession | undefined,
  services: ServiceRegistry | undefined,
  publicOrigin: string | undefined,
  assetUrl: AssetUrlResolver | undefined,
  storagePath: string | undefined,
  globalMiddleware: readonly RouteMiddleware[],
): void {
  app.on('GET', entry.route, async (c) => {
    const request = c.req.raw;
    const url = new URL(c.req.url);
    const params = { ...c.req.param() };
    const session = await resolveSessionOrNull(resolveSession, request);
    const context = createRequestContext({
      request,
      url,
      params,
      session,
      publicOrigin,
      services,
      assetUrl,
      storagePath,
    });

    const render = (): Response | Promise<Response> => renderPage(entry, context);

    if (globalMiddleware.length === 0) {
      return render();
    }
    // Global chain runs first; no per-route module exists in the callback path.
    return runMiddleware(globalMiddleware, context, render);
  });
}

/**
 * Register a page route backed by a structured {@link PageRenderer}. The page
 * module is imported lazily so its optional `middleware` export (inline handlers
 * or registered-name strings) is resolved against the named middleware registry
 * at registration time — an unknown name fails at assembly. The resolved
 * per-route chain runs after the global chain and before the renderer, so a
 * global middleware may short-circuit with a `Response` (used as-is; trusted
 * producer HTML or a redirect) or await `next()` to proceed. The renderer's
 * HTML string is wrapped in a `text/html; charset=utf-8` response. A non-string
 * renderer result is a contract violation reduced to the generic 500 envelope;
 * the raw value is never echoed. A throwing or rejecting middleware propagates
 * to the HTTP layer's sanitized 500.
 */
export async function registerRendererPageRoute(
  app: Hono,
  entry: RouteManifestEntry,
  renderer: PageRenderer,
  resolveSession: ResolveSession | undefined,
  services: ServiceRegistry | undefined,
  publicOrigin: string | undefined,
  assetUrl: AssetUrlResolver | undefined,
  storagePath: string | undefined,
  globalMiddleware: readonly RouteMiddleware[],
  middlewareRegistry: MiddlewareRegistry,
): Promise<void> {
  // Resolve the page module's middleware refs at registration time so an unknown
  // named ref fails at assembly (not at request time) with a value-free error.
  // The module import is lazy for the rest of its exports, but middleware
  // resolution happens eagerly so the error propagates during createApp.
  const module = (await import(entry.file)) as Record<string, unknown>;
  const refs = validateMiddlewareList(module.middleware, (message) => {
    return new Error(`page route "${entry.route}" ${message}`);
  });

  const resolvedPageMiddleware: readonly RouteMiddleware[] | undefined =
    refs === undefined
      ? undefined
      : resolveMiddlewareRefs(refs, middlewareRegistry, (message) => {
          return new Error(`page route "${entry.route}" ${message}`);
        });

  app.on('GET', entry.route, async (c) => {
    const request = c.req.raw;
    const url = new URL(c.req.url);
    const params = { ...c.req.param() };
    const session = await resolveSessionOrNull(resolveSession, request);
    const context = createRequestContext({
      request,
      url,
      params,
      session,
      publicOrigin,
      services,
      assetUrl,
      storagePath,
    });

    const render = async (): Promise<Response> => {
      // When the page module exports `stream`, live serving calls it directly
      // instead of the string renderer (`default` + `load`). A module may
      // export both; `stream` wins during live serving, while static export
      // ignores it and renders the string path as usual.
      if (typeof module.stream === 'function') {
        const stream = await (
          module.stream as (ctx: PageRequestContext) => PageStream | Promise<PageStream>
        )(context);
        return renderStreamResponse(stream);
      }
      const html = await renderer.render(entry, context, { staticMode: false });
      if (typeof html !== 'string') {
        return jsonError(500, 'internal_error', 'Internal Server Error');
      }
      return new Response(html, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    };

    // Build the per-route chain as a closure so TypeScript narrows the nullable
    // `resolvedPageMiddleware` inside it (same pattern as api-routes.ts).
    // The closure is only called when the global chain calls `next()`, so it
    // never double-wraps.
    const perRouteChain = (): Promise<Response> => {
      const pageMw = resolvedPageMiddleware;
      // pageMw is narrowed inside this closure: the caller only invokes this
      // after checking the combined conditions below, which guarantee that
      // pageMw is defined when the global chain is empty and render is reached.
      if (pageMw === undefined) {
        return render();
      }
      return runMiddleware(pageMw, context, render);
    };

    if (globalMiddleware.length === 0) {
      return perRouteChain();
    }
    return runMiddleware(globalMiddleware, context, perRouteChain);
  });
}
