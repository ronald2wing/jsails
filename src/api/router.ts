/**
 * DRF-style API router: produces a deterministic route manifest from a prefix
 * and named resource handlers. The manifest is a flat array of `{ method, path,
 * resource, handlerKey }` entries suitable for mounting on a Hono router or
 * inspecting programmatically.
 *
 * Every detail route appends `/:id` (the same single-segment parameter the
 * existing handler set expects), and idParam is forwarded from the handler
 * options so a resource with a custom param name still matches.
 *
 * ## Deterministic output
 *
 * Resources are iterated in sorted name order; routes within each resource
 * follow a fixed method-then-path order. The final array is sorted by path then
 * method, so the same input always produces the same output.
 *
 * ## Duplicate rejection
 *
 * A duplicate `{method, path}` combination — across or within resources — is
 * rejected with a value-free `ValidationError` before any entry is emitted.
 * Equality is checked on the canonical `METHOD /path` key.
 */

import { ValidationError } from './validation.js';
import type { ResourceAction, ResourceHandlers } from './resource.js';

/** A single route in the manifest. */
export interface RouteEntry {
  /** HTTP method (GET, POST, PATCH, DELETE). */
  readonly method: string;
  /** Absolute path, e.g. `/api/users/:id`. */
  readonly path: string;
  /** The resource name key the handler belongs to. */
  readonly resource: string;
  /** Which handler to dispatch: list, create, retrieve, update, or delete. */
  readonly handlerKey: ResourceAction;
}

/** Options for {@link createResourceRouter}. */
export interface RouterOptions {
  /**
   * URL prefix for every route. Must start with `/`, must not contain `..`,
   * and must not have a trailing slash (except for the root `"/"` itself).
   */
  readonly prefix: string;
  /**
   * Named resource handlers produced by {@link createResourceHandlers}. Every
   * key contributes collection (`GET`/`POST`) and detail (`GET /:id` /
   * `PATCH /:id` / `DELETE /:id`) routes under the prefix.
   */
  readonly resources: Record<string, ResourceHandlers>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const COLLECTION_ROUTES: ReadonlyArray<{ method: string; handlerKey: ResourceAction }> = [
  { method: 'GET', handlerKey: 'list' },
  { method: 'POST', handlerKey: 'create' },
];

const DETAIL_ROUTES: ReadonlyArray<{ method: string; handlerKey: ResourceAction }> = [
  { method: 'GET', handlerKey: 'retrieve' },
  { method: 'PATCH', handlerKey: 'update' },
  { method: 'DELETE', handlerKey: 'delete' },
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Produces a deterministic, sorted route manifest from a prefix and named
 * resource handlers. Every resource contributes five routes: two collection
 * (`GET`, `POST`) and three detail (`GET`, `PATCH`, `DELETE` with `/:id`).
 *
 * A duplicate `{method, path}` combination is rejected with a value-free
 * `ValidationError`.
 */
export function createResourceRouter(options: RouterOptions): RouteEntry[] {
  assertValidPrefix(options.prefix);

  const entries: RouteEntry[] = [];
  const seen = new Set<string>();
  const resourceNames = Object.keys(options.resources).sort();

  for (const resource of resourceNames) {
    const basePath = options.prefix === '/' ? `/${resource}` : `${options.prefix}/${resource}`;

    for (const route of COLLECTION_ROUTES) {
      addEntry(entries, seen, {
        method: route.method,
        path: basePath,
        resource,
        handlerKey: route.handlerKey,
      });
    }

    const detailPath = `${basePath}/:id`;
    for (const route of DETAIL_ROUTES) {
      addEntry(entries, seen, {
        method: route.method,
        path: detailPath,
        resource,
        handlerKey: route.handlerKey,
      });
    }
  }

  // Deterministic sort: path first, then method.
  entries.sort((a, b) => {
    const pathCmp = a.path.localeCompare(b.path);
    if (pathCmp !== 0) return pathCmp;
    return a.method.localeCompare(b.method);
  });

  return Object.freeze(entries) as RouteEntry[];
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function assertValidPrefix(prefix: string): void {
  if (typeof prefix !== 'string' || !prefix.startsWith('/')) {
    throw new ValidationError([
      { path: ['prefix'], code: 'invalid_prefix', message: 'prefix must start with /' },
    ]);
  }
  if (prefix !== '/' && prefix.endsWith('/')) {
    throw new ValidationError([
      {
        path: ['prefix'],
        code: 'invalid_prefix',
        message: 'prefix must not have a trailing slash',
      },
    ]);
  }
  if (prefix.includes('..')) {
    throw new ValidationError([
      { path: ['prefix'], code: 'invalid_prefix', message: 'prefix must not contain ..' },
    ]);
  }
}

function addEntry(entries: RouteEntry[], seen: Set<string>, entry: RouteEntry): void {
  const key = `${entry.method} ${entry.path}`;
  if (seen.has(key)) {
    throw new ValidationError([
      {
        path: ['router', entry.resource],
        code: 'duplicate_route',
        message: `Duplicate route: ${key}`,
      },
    ]);
  }
  seen.add(key);
  entries.push(entry);
}
