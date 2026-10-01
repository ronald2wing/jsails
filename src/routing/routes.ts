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
 * Trailing catch-all segments (`[...name]`) are accepted and map to Hono's
 * `*name` syntax so multi-segment URLs (e.g. `/docs/api/auth`) are served by
 * a single page and the full tail is available as one decoded param.
 * Output-path mapping is lexical only; callers remain responsible for symlink
 * containment.
 */

import { readdirSync, type Dirent } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';

import { isErrno } from '../internal/errors.js';

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
  catchAll: boolean;
  /** True when the catch-all is optional (`[[...slug]]`) and may match the base path. */
  optionalCatchAll?: boolean;
  params: string[];
  /**
   * Absolute paths of layout modules from the root pages directory down to the
   * page's own directory, outermost first. API entries always carry an empty
   * array. Optional for callers that construct entries directly; always set by
   * {@link discoverRoutes}.
   */
  layouts?: readonly string[];
  /**
   * Absolute path of the nearest-ancestor `error` boundary module (the page's
   * own directory first, then outward to the pages root). Absent means no
   * boundary — a thrown page/layout/load error becomes the sanitized 500.
   */
  errorBoundary?: string;
  /**
   * Absolute path of the nearest-ancestor `loading` placeholder module. Absent
   * means no loading placeholder is declared for the route.
   */
  loading?: string;
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
  | { readonly type: 'param'; readonly name: string }
  | { readonly type: 'catchAll'; readonly name: string; readonly optional: boolean };

interface BuiltRoute {
  readonly entry: RouteManifestEntry;
  readonly dupKey: string;
  readonly sortKey: string;
}

/** The URL prefix every API route is mounted under. */
const API_PREFIX = 'api';

const ROUTE_EXTENSIONS = new Set(['.js', '.mjs']);
const PARAM_PATTERN = /^\[([A-Za-z0-9_]+)\]$/;
const CATCH_ALL_PATTERN = /^\[\.\.\.([A-Za-z0-9_]*)\]$/;
const OPTIONAL_CATCH_ALL_PATTERN = /^\[\[\.\.\.([A-Za-z0-9_]*)\]\]$/;
const MALFORMED_PERCENT = /%(?![0-9A-Fa-f]{2})/;
/**
 * Static segments must round-trip through a URL path: Unicode letters, digits,
 * and combining marks survive percent-encoding/decoding, as do `_` and `-`.
 * Anything else (`%`, `#`, `?`, `\`, whitespace, dots, punctuation) is either
 * unreachable once the manifest is parsed as a URL or unsafe on disk.
 */
const SAFE_STATIC_SEGMENT = /^[\p{L}\p{N}\p{M}_-]+$/u;

/**
 * A directory whose name matches this pattern is a route group. It contributes
 * no URL segment but does contribute a layout scope. Groups are pages-only;
 * in `api/` the parens are not in {@link SAFE_STATIC_SEGMENT} and the segment
 * fails the existing literal check.
 */
const GROUP_PATTERN = /^\([A-Za-z0-9_-]+\)$/;

/** The base name of a layout module (extension stripped for matching). */
const LAYOUT_BASENAME = 'layout';
/** The base name of a per-route error boundary module. */
const ERROR_BASENAME = 'error';
/** The base name of a per-route loading placeholder module. */
const LOADING_BASENAME = 'loading';

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
    const collected = collectRouteFiles(dir);
    for (const relative of collected.files) {
      const built = buildRoute(
        spec.kind,
        spec.dir,
        spec.prefix,
        relative,
        rootDir,
        collected.layoutsByDir,
        collected.errorsByDir,
        collected.loadingsByDir,
      );
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

/** Result of a single-pass directory walk for route and layout files. */
interface CollectedFiles {
  /** Relative module paths for page/API routes, excluding layout modules. */
  files: string[];
  /** Dir relative path -> absolute layout file path. */
  layoutsByDir: Map<string, string>;
  /** Dir relative path -> absolute error-boundary file path. */
  errorsByDir: Map<string, string>;
  /** Dir relative path -> absolute loading-placeholder file path. */
  loadingsByDir: Map<string, string>;
}

/** Walk `dir` and return route modules and per-directory layout paths. */
function collectRouteFiles(dir: string): CollectedFiles {
  const files: string[] = [];
  const layoutsByDir = new Map<string, string>();
  const errorsByDir = new Map<string, string>();
  const loadingsByDir = new Map<string, string>();
  walk(dir, '');
  return { files, layoutsByDir, errorsByDir, loadingsByDir };

  function walk(current: string, prefix: string): void {
    let dirents: Dirent[];
    try {
      dirents = readdirSync(current, { withFileTypes: true });
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return;
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

      // Layout modules configure the layout chain; never emitted as routes.
      const nameWithoutExt = dirent.name.slice(0, dirent.name.length - extname(dirent.name).length);
      if (nameWithoutExt === LAYOUT_BASENAME) {
        layoutsByDir.set(prefix, join(current, dirent.name));
        continue;
      }
      if (nameWithoutExt === ERROR_BASENAME) {
        errorsByDir.set(prefix, join(current, dirent.name));
        continue;
      }
      if (nameWithoutExt === LOADING_BASENAME) {
        loadingsByDir.set(prefix, join(current, dirent.name));
        continue;
      }

      files.push(relative);
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
  layoutsByDir: ReadonlyMap<string, string>,
  errorsByDir: ReadonlyMap<string, string>,
  loadingsByDir: ReadonlyMap<string, string>,
): BuiltRoute {
  const rawSegments = relative.split('/');
  const fileName = rawSegments[rawSegments.length - 1]!;
  const base = fileName.slice(0, fileName.length - extname(fileName).length);
  const segments = [...prefix, ...rawSegments.slice(0, -1), base];

  // Route groups contribute no URL segment for pages; for API the parens
  // fail the SAFE_STATIC_SEGMENT check later in classifySegment.
  const routeSegments = kind === 'page' ? segments.filter((s) => !GROUP_PATTERN.test(s)) : segments;

  const parts: RoutePart[] = [];
  for (let index = 0; index < routeSegments.length; index++) {
    const segment = routeSegments[index]!;
    if (index === routeSegments.length - 1 && segment === 'index') continue;
    parts.push(classifySegment(segment, relative, index === routeSegments.length - 1));
  }

  const catchAll = parts.some((p) => p.type === 'catchAll');
  // Defensive: more than one catch-all is impossible because the final-segment
  // rule rejects a non-last `[...]`, and there is exactly one last segment.
  // Still assert so a future refactor that relaxes the rule cannot silently
  // produce two catch-all parts.
  if (parts.filter((p) => p.type === 'catchAll').length > 1) {
    throw new RouteManifestError(
      `route "${routeString(parts)}" has multiple catch-all segments (${relative})`,
    );
  }

  const params: string[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    if (part.type !== 'param' && part.type !== 'catchAll') continue;
    const name = part.name;
    if (seen.has(name)) {
      throw new RouteManifestError(
        `route "${routeString(parts)}" repeats parameter ":${name}" (${relative})`,
      );
    }
    seen.add(name);
    params.push(name);
  }

  // Build the ancestor layout chain: root pages dir first, then each
  // ancestor directory in order down to the page's parent directory.
  // The chain includes groups — they contribute layout scope even though
  // they contribute no URL segment.
  const ancestorLayouts: string[] = [];
  if (kind === 'page') {
    const rootLayout = layoutsByDir.get('');
    if (rootLayout) ancestorLayouts.push(rootLayout);

    let ancestorKey = '';
    for (const seg of rawSegments.slice(0, -1)) {
      ancestorKey = ancestorKey === '' ? seg : `${ancestorKey}/${seg}`;
      const layoutFile = layoutsByDir.get(ancestorKey);
      if (layoutFile) ancestorLayouts.push(layoutFile);
    }
  }

  // Nearest-ancestor error boundary / loading placeholder: the page's own
  // directory first, then walk OUT to the pages root. The closest one wins.
  const ancestorDirs: string[] = [];
  let dirKey = '';
  for (const seg of rawSegments.slice(0, -1)) {
    dirKey = dirKey === '' ? seg : `${dirKey}/${seg}`;
    ancestorDirs.push(dirKey);
  }
  const errorBoundary = kind === 'page' ? nearestSpecial(errorsByDir, ancestorDirs) : undefined;
  const loading = kind === 'page' ? nearestSpecial(loadingsByDir, ancestorDirs) : undefined;

  const entry: RouteManifestEntry = {
    kind,
    route: routeString(parts),
    file: resolve(rootDir, dir, relative),
    dynamic: params.length > 0,
    catchAll,
    optionalCatchAll: parts.some((part) => part.type === 'catchAll' && part.optional),
    params,
    layouts: ancestorLayouts,
    ...(errorBoundary !== undefined ? { errorBoundary } : {}),
    ...(loading !== undefined ? { loading } : {}),
  };

  return {
    entry,
    // Treat catch-all parts like params for duplicate detection: two
    // `[...slug]` files at the same path shadow each other.
    dupKey: parts
      .map((part) => {
        if (part.type === 'param' || part.type === 'catchAll') return 'p:';
        return `s:${part.value}`;
      })
      .join('\u0000'),
    // Sort catch-all segments LAST — after static and after named params.
    sortKey: parts
      .map((part) => {
        if (part.type === 'static') return `0${part.value}`;
        if (part.type === 'param') return `1${part.name}`;
        return `2${part.name}`;
      })
      .join('\u0000'),
  };
}

/** Classify a path segment, rejecting malformed and non-final catch-all segments. */
function classifySegment(segment: string, relative: string, isLast: boolean): RoutePart {
  const optionalCatchAll = OPTIONAL_CATCH_ALL_PATTERN.exec(segment);
  if (optionalCatchAll) {
    if (!isLast) {
      throw new RouteManifestError(
        `catch-all route segments must be the final segment: "${segment}" (${relative})`,
      );
    }
    const name = optionalCatchAll[1]!;
    if (name.length === 0) {
      throw new RouteManifestError(`catch-all segment name must not be empty (${relative})`);
    }
    return { type: 'catchAll', name, optional: true };
  }
  const catchAll = CATCH_ALL_PATTERN.exec(segment);
  if (catchAll) {
    // Catch-all segments must be the final segment; a catch-all followed by
    // any additional segment (including index) is rejected.
    if (!isLast) {
      throw new RouteManifestError(
        `catch-all route segments must be the final segment: "${segment}" (${relative})`,
      );
    }
    const name = catchAll[1]!;
    // An empty catch-all name (`[...]`) is ambiguous and rejected at discovery
    // time rather than producing a route that can never be substituted.
    if (name.length === 0) {
      throw new RouteManifestError(`catch-all segment name must not be empty (${relative})`);
    }
    return { type: 'catchAll', name, optional: false };
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

/**
 * Resolve a "special" (error/loading) module for a route: the page's own
 * directory first, then each ancestor directory outward to the pages root.
 * Returns the nearest declared module, or `undefined`.
 */
function nearestSpecial(
  byDir: ReadonlyMap<string, string>,
  ancestorDirs: readonly string[],
): string | undefined {
  for (let i = ancestorDirs.length - 1; i >= 0; i--) {
    const found = byDir.get(ancestorDirs[i]!);
    if (found !== undefined) return found;
  }
  return byDir.get('');
}

/** Render parsed route parts back into a `/foo/:id` or `/docs/*slug` pattern. */
function routeString(parts: readonly RoutePart[]): string {
  if (parts.length === 0) return '/';
  return (
    '/' +
    parts
      .map((part) => {
        if (part.type === 'param') return `:${part.name}`;
        if (part.type === 'catchAll') return `*${part.name}`;
        return part.value;
      })
      .join('/')
  );
}

/**
 * Translate a JSails manifest route into the Hono runtime path(s) to register.
 *
 * Hono's router does not support the `*slug` tail-wildcard syntax JSails uses in
 * the manifest: a named multi-segment tail is `:slug{.+}`. An **optional**
 * catch-all (`[[...slug]]`) has no single Hono pattern (the tail is
 * zero-or-more segments), so it registers **two** paths — the base (no tail) and
 * `:slug{.+}` (tail present) — both pointing at the same handler.
 *
 * Returns one Hono path (required catch-all, or any non-catch-all route) or two
 * (optional catch-all). The returned paths carry the same param names, so a
 * handler reading `c.req.param('slug')` sees the tail (or `undefined` for the
 * base path of an optional catch-all).
 */
export function routeToHonoPaths(entry: RouteManifestEntry): readonly string[] {
  if (!entry.catchAll) return [entry.route];
  const segments = entry.route.slice(1).split('/');
  const last = segments[segments.length - 1];
  if (last === undefined || !last.startsWith('*')) return [entry.route];
  const paramName = last.slice(1);
  const base = segments.slice(0, -1);
  const required = `/${[...base, `:${paramName}{.+}`].join('/')}`;
  if (entry.optionalCatchAll) {
    const basePath = base.length === 0 ? '/' : `/${base.join('/')}`;
    return [required, basePath];
  }
  return [required];
}

/**
 * The locale-prefixed Hono paths for a route, given the configured locales.
 *
 * Locale-prefixed routing (`i18n.locales`) registers each route under
 * `/{locale}/<route>` for every locale except the default (whose URLs stay
 * bare). The prefix is a literal path segment, so a page/API handler reading
 * `c.req.param()` sees the same params as the bare route; the i18n middleware
 * reads the leading segment and sets the ambient locale.
 *
 * Returns an empty list when `locales` is empty/absent (prefix routing off).
 */
export function localePrefixPaths(
  entry: RouteManifestEntry,
  locales: readonly string[],
  defaultLocale: string | undefined,
): readonly string[] {
  if (locales.length === 0) return [];
  const bare = entry.route === '/' ? '' : entry.route;
  return locales.filter((locale) => locale !== defaultLocale).map((locale) => `/${locale}${bare}`);
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
    const raw = params[name];
    if (typeof raw !== 'string') {
      throw new RouteManifestError(
        `route parameter ":${name}" for "${entry.route}" must be a string`,
      );
    }
    // Catch-all parameters store the raw value — the replacement loop below
    // splits on `/` and encodes each piece individually. Non-catch-all params
    // are fully encoded by encodeParamValue.
    if (entry.catchAll && name === expected[expected.length - 1]) {
      // Run essential safety checks (backslash, NUL, query, fragment, malformed
      // percent) without percent-encoding the separator.
      assertSafeRoute(raw, `route parameter ":${name}"`);
      if (raw.includes('%')) {
        throw new RouteManifestError(
          `route parameter ":${name}" for "${entry.route}" contains a percent escape`,
        );
      }
      encoded.set(name, raw);
    } else {
      encoded.set(name, encodeParamValue(name, raw, entry.route));
    }
  }

  const segments = entry.route.slice(1).split('/');
  const replaced = segments.map((segment) => {
    if (segment.startsWith('*')) {
      // Catch-all parameter: the value is a slash-joined path. Split on `/`,
      // percent-encode EACH piece via the existing single-segment encoder
      // (which already rejects `..`, `.hidden`, `%`, backslash, empty), then
      // re-join with literal `/` separators.
      const name = segment.slice(1);
      const raw = encoded.get(name);
      if (raw === undefined) {
        throw new RouteManifestError(`unresolved parameter "*${name}" in route "${entry.route}"`);
      }
      // encoded.get returns the raw value that passed encodeParamValue for a
      // single segment. But for catch-all the raw value may contain `/`
      // separators. We must split on `/`, validate and encode EACH piece, then
      // rejoin. An empty string or piece that fails per-segment validation is
      // rejected value-free.
      if (raw === '') {
        throw new RouteManifestError(
          `catch-all parameter "*${name}" for "${entry.route}" must not be empty`,
        );
      }
      const pieces = raw.split('/');
      for (const piece of pieces) {
        // Per-segment validation — reuse the same encoding logic that rejects
        // `..`, `.hidden`, `%`, backslash, empty, etc.
        encodeParamValue(name, piece, entry.route);
      }
      return pieces.map((piece) => encodeParamValue(name, piece, entry.route)).join('/');
    }
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
