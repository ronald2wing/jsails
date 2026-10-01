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

import { extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { Fragment, h } from 'preact';

import { SERVER_ONLY, type Component } from '../contracts/component.js';
import type { RequestContext } from '../contracts/http.js';
import type {
  PageModule,
  PageProps,
  PageRenderer,
  PageRenderOptions,
} from '../contracts/render.js';
import { renderToString } from '../render/render-to-string.js';
import type { RouteManifestEntry } from '../routing/manifest.js';

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
 * Options for {@link renderRoute}; retained as a public alias of
 * {@link PageRenderOptions}.
 */
export type RenderRouteOptions = PageRenderOptions;

/**
 * Import and validate a compiled page module.
 *
 * Rejects non-`.js`/`.mjs` paths (in particular `.ts`) before touching the
 * filesystem, then requires a function default export and function-valued
 * `load`/`getStaticPaths` exports when present. A failed import is surfaced as
 * a {@link PageRenderError}.
 */
export async function loadPageModule(file: string): Promise<PageModule> {
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
    throw new PageRenderError(`failed to import page module "${file}": ${describeError(error)}`);
  }
  if (imported === null || typeof imported !== 'object') {
    throw new PageRenderError(`page module "${file}" has no module exports`);
  }

  const record = imported as Record<string, unknown>;
  if (typeof record.default !== 'function') {
    throw new PageRenderError(`page module "${file}" default export must be a function`);
  }
  assertOptionalFunction(record, 'load', file);
  assertOptionalFunction(record, 'getStaticPaths', file);

  return record as unknown as PageModule;
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
  options: RenderRouteOptions = {},
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

  const props = page.load === undefined ? {} : await page.load(renderContext);
  if (!isPlainObject(props)) {
    throw new PageRenderError(
      `page "${entry.route}" load() must resolve to a plain object of props`,
    );
  }

  const rendered = await page.default(props, renderContext);
  const html = renderToString(h(Fragment, null, rendered));
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

/** Validate that an optional module export is a function when present. */
function assertOptionalFunction(record: Record<string, unknown>, name: string, file: string): void {
  const value = record[name];
  if (value !== undefined && typeof value !== 'function') {
    throw new PageRenderError(`page module "${file}" export "${name}" must be a function`);
  }
}

/** True for plain objects only: not null, not an array, not a class instance. */
function isPlainObject(value: unknown): value is PageProps {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
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

/** Extract a message for import failures without leaking a stack trace. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
