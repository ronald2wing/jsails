/**
 * Introspection route registration.
 *
 * `registerIntrospectRoute(app, opts, providers)` registers a single `GET`
 * handler under `/_jsails/introspect` that produces a JSON envelope of runtime
 * state, grouped into independently requestable sections. It uses the same
 * session-resolution and authorization pipeline the server-component transport
 * does, so the route is framework-owned and never passes through the filesystem
 * default-deny layer.
 *
 * Every other HTTP method maps to a shared 405; the path is registered before
 * any filesystem route so `assertNoIntrospectRouteCollision` rejects a page or
 * API module that would shadow it.
 */

import { Hono } from 'hono';

import { INTROSPECT_SECTIONS, type IntrospectProvider } from './sections.js';
import {
  createRequestContext,
  jsonError,
  methodNotAllowedResponse,
  resolveSessionOrNull,
  toAuthErrorResponse,
} from '../server/request-pipeline.js';
import type { ResolvedOptions } from '../server/request-pipeline.js';
import type { Authorize } from '../contracts/http.js';
import type { RequestContext } from '../contracts/http.js';
import type { ServiceRegistry } from '../extensions/services.js';
import type { RouteManifest } from '../routing/routes.js';

/** Endpoint path for the introspection route. */
export const INTROSPECT_ENDPOINT = '/_jsails/introspect';

/** Resolved config shape the route needs from the caller. */
export interface IntrospectRouteConfig {
  readonly enabled: boolean;
  readonly authorize: Authorize;
  readonly sections: readonly string[];
  /** Registered introspection providers, resolved before route registration. */
  readonly providers: readonly IntrospectProvider[];
}

/** The body of a `GET /_jsails/introspect` response. */
interface IntrospectResponse {
  readonly generatedAt: number;
  readonly sections: Record<string, unknown>;
}

/**
 * Register the introspection route on the Hono app. The route is mounted after
 * the body-limit/405 middleware and before the filesystem routes, the same way
 * the server-component transport is, so the runtime owns every auth check.
 *
 * Other HTTP methods produce a 405; the `introspect` config is assumed already
 * resolved and validated by the application config loader.
 */
export function registerIntrospectRoute(
  app: Hono,
  opts: ResolvedOptions,
  introspect: IntrospectRouteConfig,
): void {
  const providers = introspect.providers;
  // `introspect.sections` is the DEFAULT set returned when no `?section=` is
  // given; an explicit request may name any valid section, so validation uses
  // the full section list rather than the configured default.
  const defaultSections = new Set(introspect.sections);
  const validSections = new Set<string>(INTROSPECT_SECTIONS);

  // Register the 405 response for every method registered on this path.
  app.on(['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'], INTROSPECT_ENDPOINT, () =>
    methodNotAllowedResponse('GET'),
  );

  app.on('GET', INTROSPECT_ENDPOINT, async (c) => {
    const request = c.req.raw;
    const url = new URL(c.req.url);
    const session = await resolveSessionOrNull(opts.resolveSession, request);
    const context = createRequestContext({
      request,
      url,
      params: {},
      session,
      publicOrigin: opts.publicOrigin,
      services: opts.services,
      assetUrl: opts.assetUrl,
      storagePath: opts.storagePath,
    });

    // Authorize (default-deny): exact `true` allows; anything else → 403.
    try {
      const allowed = await introspect.authorize(context);
      if (allowed !== true) {
        return noStore(toAuthErrorResponse(new Error('Forbidden')));
      }
    } catch {
      return noStore(toAuthErrorResponse(new Error('Forbidden')));
    }

    const generatedAt = Date.now();

    // Parse requested sections: `?section=` comma-separated, repeatable.
    // Omitted means every section the config allows.
    const requestedSections = parseRequestedSections(
      url.searchParams,
      validSections,
      defaultSections,
    );
    if (requestedSections === undefined) {
      return noStore(
        jsonError(400, 'invalid_section', 'One or more requested sections are not recognised', {
          valid: [...INTROSPECT_SECTIONS],
        }),
      );
    }

    // Collect each requested section independently — one provider failing never
    // fails the rest of the response.
    const sections: Record<string, unknown> = Object.create(null);
    for (const sectionName of requestedSections) {
      sections[sectionName] = await collectSection(sectionName, providers, context, opts.services);
    }

    const body: IntrospectResponse = { generatedAt, sections };
    return noStore(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      }),
    );
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Attach `Cache-Control: no-store` to the response. */
function noStore(response: Response): Response {
  return new Response(response.body, {
    status: response.status,
    headers: {
      ...Object.fromEntries(response.headers.entries()),
      'cache-control': 'no-store',
    },
  });
}

/**
 * Parse `?section=` parameters into a deduplicated list. A parameter value may
 * be comma-separated and the key may repeat. Returns `undefined` when any
 * single section name is not a valid section (unknown sections are rejected
 * explicitly); when absent, returns the configured default set.
 */
function parseRequestedSections(
  params: URLSearchParams,
  valid: ReadonlySet<string>,
  defaults: ReadonlySet<string>,
): string[] | undefined {
  const names: string[] = [];
  for (const raw of searchParamValues(params, 'section')) {
    for (const name of raw.split(',')) {
      const trimmed = name.trim();
      if (trimmed === '') continue;
      if (!valid.has(trimmed)) return undefined;
      names.push(trimmed);
    }
  }
  if (names.length === 0) return [...defaults].sort();
  // Deduplicate, preserving first-occurrence order.
  const seen = new Set<string>();
  const result: string[] = [];
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    result.push(name);
  }
  return result;
}

/** Collect the values for one `section` query with repeatable key support. */
function searchParamValues(params: URLSearchParams, key: string): string[] {
  const values: string[] = [];
  for (const [k, v] of params.entries()) {
    if (k === key) values.push(v);
  }
  return values;
}

/**
 * Collect one section from the registered providers. When no provider handles
 * the section, the result is `unavailable`. A thrown exception is caught and
 * serialized as a value-free `error` entry, isolating the failure.
 */
async function collectSection(
  sectionName: string,
  providers: readonly IntrospectProvider[],
  context: RequestContext,
  services: ServiceRegistry | undefined,
): Promise<unknown> {
  try {
    const provider = providers.find((p) => p.section === sectionName);
    if (provider === undefined) {
      return { status: 'unavailable' };
    }
    const data = await provider.collect(context, services);
    // When `collect` already returned a status object, pass it through. This is
    // the normal path for built-in providers that decide their own availability.
    if (isSectionResult(data)) return data;
    return { status: 'ok', data };
  } catch {
    return {
      status: 'error',
      error: { code: 'section_error', message: 'Failed to collect section data' },
    };
  }
}

/** Whether a value is already a shaped section result with a `status` field. */
function isSectionResult(value: unknown): value is { status: string } {
  return value !== null && typeof value === 'object' && 'status' in value;
}

/**
 * Reject a filesystem route that would shadow the introspection endpoint. The
 * guard runs against the manifest (post-discovery), so it reports the colliding
 * file — an intentional exception to the value-free convention because the file
 * is the actionable fix and is never attacker-controlled input.
 */
export function assertNoIntrospectRouteCollision(manifest: RouteManifest): void {
  const entry = manifest.byRoute.get(INTROSPECT_ENDPOINT);
  if (entry === undefined) return;
  throw new Error(
    `route "${entry.route}" collides with the reserved introspection endpoint (${entry.file})`,
  );
}
