/**
 * Compiled filesystem page loading and synchronous server-side rendering.
 *
 * This is the runtime half of the page route story: the manifest supplies a
 * `RouteManifestEntry`, {@link loadPageModule} imports the already-compiled
 * `.js`/`.mjs` module (never TypeScript, never a transformer), and
 * {@link renderRoute} resolves `load`, invokes the default component, and
 * renders through the thin Preact wrapper.
 *
 * Boundaries:
 * - No bespoke HTML escaping or JSX parsing: rendering and escaping are
 *   Preact's. Only a doctype and, when the root is not `<html>`, a minimal
 *   document shell are prepended by hand.
 * - Normal ESM import semantics apply: modules are cached process-globally by
 *   Node, so there is no hot-reload or per-request module re-evaluation.
 * - `staticMode` rejects a default component annotated `SERVER_ONLY`. It does
 *   NOT enforce annotations on nested components or elements — the server
 *   component runtime does not exist yet.
 *
 * Setup-time failures surface as {@link PageRenderError}; the HTTP layer turns
 * any non-validation error into a generic 500, so these messages are for logs
 * and build tooling, not for response bodies.
 */

import { createHash } from 'node:crypto';
import { extname, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { Fragment, h } from 'preact';

import { cacheToken } from '../cache/plugin.js';
import type { CacheStore } from '../cache/store.js';
import { formatError } from '../internal/errors.js';
import { isPlainObject } from '../internal/json-safe.js';
import { SERVER_ONLY, type Component } from '../contracts/component.js';
import type { RequestContext } from '../contracts/http.js';
import type {
  LayoutModule,
  PageModule,
  PageProps,
  PageRenderer,
  PageRenderOptions,
  PageStream,
} from '../contracts/render.js';
import { renderToString } from '../jsx/render-to-string.js';
import { validateMiddlewareList } from '../routing/middleware.js';
import type { RouteManifestEntry } from '../routing/routes.js';

/** Raised for malformed page modules and unrenderable page routes. */
export class PageRenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PageRenderError';
  }
}

/** Extensions accepted by {@link loadPageModule}; TypeScript is rejected. */
const PAGE_EXTENSIONS = new Set(['.js', '.mjs']);

const DOCTYPE = '<!DOCTYPE html>';

/**
 * Import and validate a compiled page module.
 *
 * Rejects non-`.js`/`.mjs` paths (in particular `.ts`) before touching the
 * filesystem, then requires a function default export, function-valued
 * `load`/`getStaticPaths` exports when present, and a structurally valid
 * `middleware` export (an array of functions) when present. A failed import is
 * surfaced as a {@link PageRenderError}.
 */
export async function loadPageModule(file: string): Promise<PageModule> {
  const record = await importCompiledModule(file);
  if (typeof record.default !== 'function') {
    throw new PageRenderError(`page module "${file}" default export must be a function`);
  }
  assertOptionalFunction(record, 'load', file);
  assertOptionalFunction(record, 'getStaticPaths', file);
  assertOptionalRevalidate(record, file);
  validateMiddlewareList(
    record.middleware,
    (message) => new PageRenderError(`page module "${file}" ${message}`),
  );

  return record as unknown as PageModule;
}

/**
 * Import and validate a compiled layout module.
 *
 * Rejects non-`.js`/`.mjs` paths and surfaces import failures as a
 * {@link PageRenderError} — the same path/extension guards shared with
 * {@link loadPageModule} through {@link importCompiledModule}. A layout
 * module differs from a page module only in its contract: it MUST export
 * a function default (the layout component) and carries no `load`,
 * `getStaticPaths`, or `middleware` surface.
 */
export async function loadLayoutModule(file: string): Promise<LayoutModule> {
  const record = await importCompiledModule(file);
  if (typeof record.default !== 'function') {
    throw new PageRenderError(`layout module "${file}" default export must be a function`);
  }
  return record as unknown as LayoutModule;
}

/**
 * Import a compiled `.js`/`.mjs` module, rejecting non-compiled paths and
 * surfacing import failures as {@link PageRenderError}. Shared by
 * {@link loadPageModule} so its path/extension and import-failure handling stay
 * identical wherever a page module is loaded.
 */
async function importCompiledModule(file: string): Promise<Record<string, unknown>> {
  if (typeof file !== 'string' || file === '') {
    throw new PageRenderError('page module path must be a non-empty string');
  }
  const extension = extname(file).toLowerCase();
  if (!PAGE_EXTENSIONS.has(extension)) {
    throw new PageRenderError(
      `page module "${file}" must be a compiled .js or .mjs file (got "${extension || 'no extension'}")`,
    );
  }

  let imported: unknown;
  try {
    imported = await import(pathToFileURL(resolve(file)).href);
  } catch (error) {
    throw new PageRenderError(`failed to import page module "${file}": ${formatError(error)}`);
  }
  if (imported === null || typeof imported !== 'object') {
    throw new PageRenderError(`page module "${file}" has no module exports`);
  }
  return imported as Record<string, unknown>;
}

/**
 * Render a page manifest entry for one request.
 *
 * Resolves `load` (if any) to a plain props object, awaits the default
 * component, and renders through Preact. The returned string is always prefixed
 * with a doctype: a root `<html>` element is emitted as-is, anything else is
 * wrapped in a minimal document.
 */
export async function renderRoute(
  entry: RouteManifestEntry,
  context: RequestContext,
  options: PageRenderOptions = {},
): Promise<string> {
  if (entry === null || typeof entry !== 'object') {
    throw new PageRenderError('renderRoute requires a route manifest entry');
  }
  if (entry.kind !== 'page') {
    throw new PageRenderError(`route "${entry.route}" is not a page entry`);
  }

  const page = await loadPageModule(entry.file);
  const component = page.default as Component<PageProps>;

  if (options.staticMode === true && component[SERVER_ONLY] === true) {
    throw new PageRenderError(
      `page "${entry.route}" is marked SERVER_ONLY and cannot be rendered in static mode`,
    );
  }

  // Static exports render server components without signing; the derived context
  // carries that flag (preserving any services) so a page's renderServerComponent
  // calls see `renderMode: 'static'` and render only the fallback.
  const renderContext: RequestContext =
    options.staticMode === true ? { ...context, renderMode: 'static' } : context;

  const props = await resolvePageProps(page, entry, renderContext, options);
  if (!isPlainObject(props)) {
    throw new PageRenderError(
      `page "${entry.route}" load() must resolve to a plain object of props`,
    );
  }

  let element = await page.default(props, renderContext);

  // Fold the layout chain around the page element. `entry.layouts` lists
  // absolute layout module paths outermost-first (root → page dir), so we
  // iterate in reverse to build the wrapping tree inside-out: the innermost
  // layout wraps the page, its result is wrapped by the next-outer layout, and
  // so on until the outermost layout wraps the whole chain.
  if (entry.layouts && entry.layouts.length > 0) {
    for (let i = entry.layouts.length - 1; i >= 0; i--) {
      const layout = await loadLayoutModule(entry.layouts[i]!);
      // Spread the resolved page props first, then set `children` explicitly
      // so the framework's slot always wins — a page prop named `children`
      // cannot override the actual child element.
      element = await layout.default({ ...props, children: element }, renderContext);
    }
  }

  const html = renderToString(h(Fragment, null, element));
  return DOCTYPE + withDocumentShell(html);
}

/**
 * The built-in {@link PageRenderer}. It is a thin adapter over
 * {@link renderRoute}, so the compiled-page loader, the `load`/`getStaticPaths`
 * contract, and Preact's escaping are unchanged; callers that swap in another
 * renderer opt out of all three.
 */
export const preactPageRenderer: PageRenderer = {
  render(entry, context, options) {
    return renderRoute(entry, context, options);
  },
};

/**
 * Wrap a {@link PageStream} into a streaming HTTP response with chunked
 * transfer encoding. Chunks are trusted producer output (never sanitized) —
 * the same trust model as the string renderer.
 *
 * The response carries `Content-Type: text/html; charset=utf-8` (overridable
 * via `headers`) and `X-Accel-Buffering: no` so a buffering reverse proxy
 * flushes each chunk immediately.
 */
export function renderStreamResponse(stream: PageStream, headers?: HeadersInit): Response {
  let body: ReadableStream<Uint8Array>;

  if (stream instanceof ReadableStream) {
    body = stream;
  } else if (stream instanceof Readable) {
    // A Node `Readable` may be string-mode (emitting string chunks) or
    // byte-mode (emitting Buffer/Uint8Array). Convert through a normalizing
    // async-iterator so every chunk reaches the Response body as bytes:
    // undici's Response rejects non-Uint8Array chunks.
    body = encodeIterable(Readable.toWeb(stream) as AsyncIterable<unknown>);
  } else {
    body = encodeIterable(stream);
  }

  const responseHeaders = new Headers(headers);
  if (!responseHeaders.has('content-type')) {
    responseHeaders.set('content-type', 'text/html; charset=utf-8');
  }
  responseHeaders.set('x-accel-buffering', 'no');

  return new Response(body, { headers: responseHeaders });
}

/**
 * Convert an async iterable whose chunks are either strings or bytes into a
 * byte-only `ReadableStream` suitable as a Response body. String chunks are
 * UTF-8 encoded; byte chunks (`Uint8Array`/`Buffer`) pass through unchanged so
 * an already-binary source is not double-encoded.
 */
function encodeIterable(iterable: AsyncIterable<unknown>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      for await (const chunk of iterable) {
        if (typeof chunk === 'string') {
          controller.enqueue(encoder.encode(chunk));
        } else if (chunk instanceof Uint8Array) {
          controller.enqueue(chunk);
        }
        // Any other chunk type is impossible for the declared PageStream
        // shapes; skip it defensively so a single malformed chunk cannot
        // corrupt the stream.
      }
      controller.close();
    },
  });
}

/**
 * Resolve page props, optionally caching the result through a cache store when
 * configured. When `revalidate` is set, a cache store is available, and this is
 * not a static render, the loader result is cached; any cache backend failure
 * falls back to a fresh `load()` call so caching is a graceful-degradation seam.
 */
async function resolvePageProps(
  page: PageModule,
  entry: RouteManifestEntry,
  renderContext: RequestContext,
  options: PageRenderOptions,
): Promise<PageProps> {
  const ttl = page.revalidate;
  if (options.staticMode !== true && typeof ttl === 'number' && ttl > 0 && Number.isFinite(ttl)) {
    const store = tryResolveCacheStore(renderContext);
    if (store !== undefined) {
      try {
        const cached = await store.remember(
          pageCacheKey(entry, renderContext),
          ttl * 1000,
          async () => JSON.stringify(await loadPageProps(page, renderContext)),
        );
        return JSON.parse(cached) as PageProps;
      } catch {
        // Cache backend error, serialization failure, or any other caching
        // issue — fall through to a fresh load. Caching is a seamless upgrade,
        // never a source of errors.
      }
    }
  }
  return loadPageProps(page, renderContext);
}

/** Call `page.load` (or return `{}` when absent) to produce the raw props. */
function loadPageProps(
  page: PageModule,
  renderContext: RequestContext,
): PageProps | Promise<PageProps> {
  return page.load === undefined ? {} : page.load(renderContext);
}

/** Resolve the cache store from request services, returning undefined on any failure. */
function tryResolveCacheStore(context: RequestContext): CacheStore | undefined {
  try {
    return context.services?.tryGet(cacheToken);
  } catch {
    return undefined;
  }
}

/** Validate that an optional module export is a function when present. */
function assertOptionalFunction(record: Record<string, unknown>, name: string, file: string): void {
  const value = record[name];
  if (value !== undefined && typeof value !== 'function') {
    throw new PageRenderError(`page module "${file}" export "${name}" must be a function`);
  }
}

/** Validate that the optional `revalidate` export is a positive finite number when present. */
function assertOptionalRevalidate(record: Record<string, unknown>, file: string): void {
  const value = record['revalidate'];
  if (value !== undefined) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new PageRenderError(
        `page module "${file}" export "revalidate" must be a positive number`,
      );
    }
  }
}

/**
 * Derive a stable, deterministic cache key from the route pattern, resolved
 * params, and query string. The key is independent of the origin/host so it is
 * stable across environments, and is namespaced under `jsails:page:` to avoid
 * colliding with other cache consumers.
 */
export function pageCacheKey(entry: RouteManifestEntry, context: RequestContext): string {
  const parts: string[] = ['jsails:page', entry.route];

  // Params: sorted by key for determinism, joined as `k=v` pairs.
  const paramKeys = Object.keys(context.params).sort();
  for (const key of paramKeys) {
    parts.push(`${key}=${context.params[key]}`);
  }

  // Query string: sorted by key then value, hashed; omitted when empty.
  const searchParams = [...context.url.searchParams.entries()];
  if (searchParams.length > 0) {
    searchParams.sort(([aKey, aVal], [bKey, bVal]) => {
      const cmp = aKey.localeCompare(bKey);
      return cmp !== 0 ? cmp : aVal.localeCompare(bVal);
    });
    const sorted = searchParams.map(([k, v]) => `${k}=${v}`).join('&');
    const hash = createHash('sha256').update(sorted).digest('hex').slice(0, 8);
    parts.push(`q:${hash}`);
  }

  return parts.join(':');
}

/**
 * Return the rendered HTML unchanged when the emitted root is an `<html>`
 * element, otherwise wrap it in a minimal document so the route still emits
 * valid HTML. Detection reads the maintained renderer's actual output, so it is
 * correct regardless of how many component layers produced the root; escaped
 * text cannot spoof it because a literal `<` in text is emitted as `&lt;`.
 */
function withDocumentShell(html: string): string {
  if (/^<html[\s>]/i.test(html.trimStart())) return html;
  return `<html><head><meta charset="utf-8"></head><body>${html}</body></html>`;
}
