/**
 * Filesystem route manifest for compiled page and API workers.
 *
 * Discovery is deliberately lexical: it walks `pages/` and `api/` on disk and
 * maps file paths to route patterns without importing modules or opening a
 * connection. The manifest is the contract the page and API workers consume at
 * startup, so ordering is deterministic (static segments before parameter
 * segments) and an ambiguous parameterized route space is rejected instead of
 * silently resolved to one arbitrary winner.
 *
 * This is a bounded first slice. Catch-all segments (`[...name]`) are detected
 * and rejected explicitly rather than accepted as literal static paths.
 * Output-path mapping is lexical only; callers remain responsible for symlink
 * containment.
 */

import { readdirSync, type Dirent } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';

/** Thrown when route discovery, substitution, or output mapping fails. */
export class RouteManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RouteManifestError';
  }
}

/** A single discovered page or API route. */
export interface RouteManifestEntry {
  kind: 'page' | 'api';
  route: string;
  file: string;
  dynamic: boolean;
  catchAll: false;
  params: string[];
}

/** The full discovered route set plus a route-string lookup. */
export interface RouteManifest {
  entries: RouteManifestEntry[];
  byRoute: ReadonlyMap<string, RouteManifestEntry>;
}

/** Directories scanned by {@link discoverRoutes}, relative to `rootDir`. */
export interface DiscoverRoutesOptions {
  pagesDir?: string;
  apiDir?: string;
}

type RoutePart =
  | { readonly type: 'static'; readonly value: string }
  | { readonly type: 'param'; readonly name: string };

interface BuiltRoute {
  readonly entry: RouteManifestEntry;
  readonly dupKey: string;
  readonly sortKey: string;
}

/** The URL prefix every API route is mounted under. */
const API_PREFIX = 'api';

const ROUTE_EXTENSIONS = new Set(['.js', '.mjs']);
const PARAM_PATTERN = /^\[([A-Za-z0-9_]+)\]$/;
const CATCH_ALL_PATTERN = /^\[\.\.\.([A-Za-z0-9_]+)\]$/;
const MALFORMED_PERCENT = /%(?![0-9A-Fa-f]{2})/;
/**
 * Static segments must round-trip through a URL path: Unicode letters, digits,
 * and combining marks survive percent-encoding/decoding, as do `_` and `-`.
 * Anything else (`%`, `#`, `?`, `\`, whitespace, dots, punctuation) is either
 * unreachable once the manifest is parsed as a URL or unsafe on disk.
 */
const SAFE_STATIC_SEGMENT = /^[\p{L}\p{N}\p{M}_-]+$/u;

/**
 * Scan `rootDir/${pagesDir}` and `rootDir/${apiDir}` recursively for compiled
 * route modules and return the route manifest. Missing directories yield no
 * routes for that kind. Symlinks are never followed.
 */
export function discoverRoutes(
  rootDir: string,
  options: DiscoverRoutesOptions = {},
): RouteManifest {
  const specs: ReadonlyArray<{
    kind: 'page' | 'api';
    dir: string;
    prefix: readonly string[];
  }> = [
    { kind: 'page', dir: options.pagesDir ?? 'pages', prefix: [] },
    { kind: 'api', dir: options.apiDir ?? API_PREFIX, prefix: [API_PREFIX] },
  ];

  const discovered: BuiltRoute[] = [];
  const routesByDupKey = new Map<string, string>();

  for (const spec of specs) {
    const dir = resolve(rootDir, spec.dir);
    for (const relative of collectRouteFiles(dir)) {
      const built = buildRoute(spec.kind, spec.dir, spec.prefix, relative, rootDir);
      const existing = routesByDupKey.get(built.dupKey);
      if (existing !== undefined) {
        throw new RouteManifestError(
          `duplicate route "${built.entry.route}" conflicts with equivalent route "${existing}"`,
        );
      }
      routesByDupKey.set(built.dupKey, built.entry.route);
      discovered.push(built);
    }
  }

  discovered.sort(
    (a, b) => compareStrings(a.sortKey, b.sortKey) || compareStrings(a.entry.route, b.entry.route),
  );

  const entries = discovered.map((item) => item.entry);
  const byRoute = new Map(entries.map((entry) => [entry.route, entry] as const));
  return { entries, byRoute };
}

/** Return the relative module paths (posix-separated) under `dir`, sorted. */
function collectRouteFiles(dir: string): string[] {
  const results: string[] = [];
  walk(dir, '');
  return results;

  function walk(current: string, prefix: string): void {
    let dirents: Dirent[];
    try {
      dirents = readdirSync(current, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    dirents.sort((a, b) => compareStrings(a.name, b.name));
    for (const dirent of dirents) {
      if (dirent.isSymbolicLink()) continue;
      const relative = prefix === '' ? dirent.name : `${prefix}/${dirent.name}`;
      if (dirent.isDirectory()) {
        walk(join(current, dirent.name), relative);
        continue;
      }
      if (!dirent.isFile() || !ROUTE_EXTENSIONS.has(extname(dirent.name))) continue;
      results.push(relative);
    }
  }
}

/** Map one discovered module path to its route pattern and ordering keys. */
function buildRoute(
  kind: 'page' | 'api',
  dir: string,
  prefix: readonly string[],
  relative: string,
  rootDir: string,
): BuiltRoute {
  const rawSegments = relative.split('/');
  const fileName = rawSegments[rawSegments.length - 1]!;
  const base = fileName.slice(0, fileName.length - extname(fileName).length);
  const segments = [...prefix, ...rawSegments.slice(0, -1), base];

  const parts: RoutePart[] = [];
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index]!;
    if (index === segments.length - 1 && segment === 'index') continue;
    parts.push(classifySegment(segment, relative));
  }

  const params: string[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    if (part.type !== 'param') continue;
    if (seen.has(part.name)) {
      throw new RouteManifestError(
        `route "${routeString(parts)}" repeats parameter ":${part.name}" (${relative})`,
      );
    }
    seen.add(part.name);
    params.push(part.name);
  }

  const entry: RouteManifestEntry = {
    kind,
    route: routeString(parts),
    file: resolve(rootDir, dir, relative),
    dynamic: params.length > 0,
    catchAll: false,
    params,
  };

  return {
    entry,
    dupKey: parts.map((part) => (part.type === 'param' ? 'p:' : `s:${part.value}`)).join('\u0000'),
    sortKey: parts
      .map((part) => (part.type === 'param' ? `1${part.name}` : `0${part.value}`))
      .join('\u0000'),
  };
}

/** Classify a path segment, rejecting malformed and catch-all segments. */
function classifySegment(segment: string, relative: string): RoutePart {
  if (CATCH_ALL_PATTERN.test(segment)) {
    throw new RouteManifestError(`catch-all routes are not supported: "${segment}" (${relative})`);
  }
  const param = PARAM_PATTERN.exec(segment);
  if (param) return { type: 'param', name: param[1]! };
  if (segment.includes('[') || segment.includes(']')) {
    throw new RouteManifestError(`malformed route segment "${segment}" (${relative})`);
  }
  if (segment.includes(':')) {
    throw new RouteManifestError(
      `route segment "${segment}" uses the reserved ":" parameter marker (${relative})`,
    );
  }
  assertSafeStaticSegment(segment, relative);
  return { type: 'static', value: segment };
}

/**
 * Enforce the literal static-segment contract. A filename that contains `#`,
 * `?`, `%`, `\`, NUL, or whitespace produces a route the HTTP layer cannot
 * recover, and a segment outside the URL-safe set cannot map to a disk path.
 */
function assertSafeStaticSegment(segment: string, relative: string): void {
  if (segment.includes('\0')) {
    throw new RouteManifestError(`route segment "${segment}" contains a NUL byte (${relative})`);
  }
  if (segment.includes('\\')) {
    throw new RouteManifestError(`route segment "${segment}" contains a backslash (${relative})`);
  }
  if (segment.includes('%')) {
    throw new RouteManifestError(
      `route segment "${segment}" contains a percent escape (${relative})`,
    );
  }
  if (segment.includes('?')) {
    throw new RouteManifestError(
      `route segment "${segment}" contains a query marker (${relative})`,
    );
  }
  if (segment.includes('#')) {
    throw new RouteManifestError(
      `route segment "${segment}" contains a fragment marker (${relative})`,
    );
  }
  if (/\s/.test(segment)) {
    throw new RouteManifestError(`route segment "${segment}" contains whitespace (${relative})`);
  }
  if (!SAFE_STATIC_SEGMENT.test(segment)) {
    throw new RouteManifestError(
      `route segment "${segment}" contains characters outside the safe literal set (${relative})`,
    );
  }
}

/** Render parsed route parts back into a `/foo/:id` pattern. */
function routeString(parts: readonly RoutePart[]): string {
  if (parts.length === 0) return '/';
  return (
    '/' + parts.map((part) => (part.type === 'param' ? `:${part.name}` : part.value)).join('/')
  );
}

/**
 * Map a concrete route pattern to its contained `index.html` output path.
 *
 * Route strings are URL-encoded, so each segment is decoded exactly once before
 * it becomes a filesystem name: `/blog/caf%C3%A9` maps to directory `café`, not
 * the literal `caf%C3%A9`. The decoded value is then re-validated because a
 * single decode can reintroduce a separator (`%2F`, `%5C`), a dot segment, a
 * control/query/fragment character, or a remaining percent escape from a
 * double-encoded input. Traversal, dot-prefixed (hidden) segments, NUL, query,
 * and fragment inputs are rejected, as are unresolved `:param` segments and
 * malformed percent escapes.
 * Callers must still guard against symlinks inside `outDir`.
 */
export function routeToOutputPath(outDir: string, route: string): string {
  if (typeof route !== 'string' || !route.startsWith('/')) {
    throw new RouteManifestError(`route must be an absolute path: ${JSON.stringify(route)}`);
  }
  assertSafeRoute(route, 'route');

  const body = route.slice(1);
  const rawSegments = body === '' ? [] : body.split('/');
  const segments: string[] = [];
  for (const raw of rawSegments) {
    if (raw === '') {
      throw new RouteManifestError(`route "${route}" contains an unsafe segment ""`);
    }
    const segment = decodeRouteSegment(raw, route);
    // Any leading dot is refused, not just `.`/`..`: a decoded `.hidden`
    // segment would map to a hidden directory, which the public-asset policy
    // skips and users never expect a page to shadow.
    if (segment.startsWith('.')) {
      throw new RouteManifestError(`route "${route}" contains an unsafe segment "${segment}"`);
    }
    if (segment.includes(':')) {
      throw new RouteManifestError(
        `route "${route}" contains an unresolved parameter segment "${segment}"`,
      );
    }
    segments.push(segment);
  }

  const base = resolve(outDir);
  const target = resolve(outDir, ...segments, 'index.html');
  if (target !== base && !target.startsWith(base + sep)) {
    throw new RouteManifestError(`route "${route}" escapes output directory "${outDir}"`);
  }
  return join(outDir, ...segments, 'index.html');
}

/**
 * Decode one URL path segment exactly once and reject a decoded value that
 * would escape its segment or smuggle a second encoding layer.
 */
function decodeRouteSegment(raw: string, route: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    throw new RouteManifestError(`route "${route}" contains a malformed percent escape`);
  }
  if (decoded.includes('/') || decoded.includes('\\')) {
    throw new RouteManifestError(`route "${route}" segment "${raw}" decodes to a path separator`);
  }
  if (decoded.includes('\0')) {
    throw new RouteManifestError(`route "${route}" segment "${raw}" decodes to a NUL byte`);
  }
  if (decoded.includes('?')) {
    throw new RouteManifestError(`route "${route}" segment "${raw}" decodes to a query marker`);
  }
  if (decoded.includes('#')) {
    throw new RouteManifestError(`route "${route}" segment "${raw}" decodes to a fragment marker`);
  }
  if (decoded.includes('%')) {
    throw new RouteManifestError(
      `route "${route}" segment "${raw}" decodes to a remaining percent escape`,
    );
  }
  return decoded;
}

/**
 * Substitute concrete parameter values into a manifest route, returning an
 * encoded route. Every declared parameter must be supplied exactly once;
 * values are percent-encoded and may not resolve to a dot-prefixed (hidden)
 * path segment.
 */
export function substituteRouteParams(
  entry: RouteManifestEntry,
  params: Record<string, string>,
): string {
  if (params === null || typeof params !== 'object') {
    throw new RouteManifestError('route parameters must be an object');
  }

  const expected = entry.params;
  for (const name of expected) {
    if (!Object.hasOwn(params, name)) {
      throw new RouteManifestError(`missing route parameter ":${name}" for "${entry.route}"`);
    }
  }
  for (const name of Object.keys(params)) {
    if (!expected.includes(name)) {
      throw new RouteManifestError(`unexpected route parameter ":${name}" for "${entry.route}"`);
    }
  }

  const encoded = new Map<string, string>();
  for (const name of expected) {
    encoded.set(name, encodeParamValue(name, params[name], entry.route));
  }

  const segments = entry.route.slice(1).split('/');
  const replaced = segments.map((segment) => {
    if (!segment.startsWith(':')) return segment;
    const name = segment.slice(1);
    const value = encoded.get(name);
    if (value === undefined) {
      throw new RouteManifestError(`unresolved parameter ":${name}" in route "${entry.route}"`);
    }
    return value;
  });
  return '/' + replaced.join('/');
}

/** Percent-encode one parameter value after validating its raw characters. */
function encodeParamValue(name: string, value: unknown, route: string): string {
  if (typeof value !== 'string') {
    throw new RouteManifestError(`route parameter ":${name}" for "${route}" must be a string`);
  }
  assertSafeRoute(value, `route parameter ":${name}"`);
  // Values are percent-encoded below; a raw `%` can only be an attempt to
  // inject a pre-encoded (double-encoded) separator or dot segment.
  if (value.includes('%')) {
    throw new RouteManifestError(
      `route parameter ":${name}" for "${route}" contains a percent escape`,
    );
  }

  let result: string;
  try {
    result = encodeURIComponent(value);
  } catch {
    throw new RouteManifestError(
      `route parameter ":${name}" for "${route}" contains an unencodable character`,
    );
  }
  // A leading dot covers ``, `.`, and `..` as well as `.hidden`-style values
  // that would otherwise publish a hidden path segment.
  if (result === '' || result.startsWith('.')) {
    throw new RouteManifestError(
      `route parameter ":${name}" for "${route}" resolves to an unsafe path segment`,
    );
  }
  return result;
}

/** Reject characters that make a route or parameter unsafe to embed. */
function assertSafeRoute(value: string, label: string): void {
  if (value.includes('\0')) {
    throw new RouteManifestError(`${label} contains a NUL byte`);
  }
  if (value.includes('\\')) {
    throw new RouteManifestError(`${label} contains a backslash`);
  }
  if (value.includes('?')) {
    throw new RouteManifestError(`${label} contains a query string`);
  }
  if (value.includes('#')) {
    throw new RouteManifestError(`${label} contains a fragment`);
  }
  if (MALFORMED_PERCENT.test(value)) {
    throw new RouteManifestError(`${label} contains a malformed percent escape`);
  }
}

/** Code-unit string comparison; locale-independent for deterministic order. */
function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
