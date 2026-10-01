/**
 * Page and renderer contracts for filesystem pages, layouts, and static site
 * generation. (Server-component authoring contracts live in
 * `src/server-components/` and are not re-exported here.)
 */

import type { Readable } from 'node:stream';

import type { RenderChild } from './component.js';
import type { RequestContext } from './http.js';
import type { PageMetadata } from '../seo/metadata.js';
import type { RouteMiddlewareRef } from '../routing/middleware.js';
import type { RouteManifestEntry } from '../routing/routes.js';

export { SERVER_ONLY } from './component.js';
export type {
  Component,
  ComponentChildren,
  FunctionComponent,
  IntrinsicElement,
  RenderChild,
  VNode,
} from './component.js';

/** Props passed to a page's default export. */
export type PageProps = Record<string, unknown>;

/**
 * A stream of HTML chunks from a page's streaming export.
 *
 * `AsyncIterable<string>` is the friendliest author shape: each yielded chunk
 * is encoded incrementally by the runtime. `ReadableStream<Uint8Array>` and
 * Node `Readable` pass through as-is.
 */
export type PageStream = AsyncIterable<string> | ReadableStream<Uint8Array> | Readable;

/**
 * The default export of a page: renders props to a render child.
 *
 * May be async: the framework resolves the promise through its async renderer
 * (`renderToStringAsync`). Preact function components stay synchronous; async
 * data should be loaded in {@link PageModule.load} and passed in as props.
 */
export interface PageComponent<P = PageProps> {
  (props: P, context?: RequestContext): RenderChild | Promise<RenderChild>;
}

/**
 * A filesystem-routed page module.
 *
 * `default` renders the page; `context` is omitted during static generation.
 * `load` resolves dynamic props from the request context (async data fetch).
 * `getStaticPaths` enumerates the params for static generation. `middleware`
 * is an optional array of handlers run (in order) before `load` during live
 * serving; a handler may short-circuit with a `Response` (e.g. a redirect) or
 * await `next()` to proceed. Filename-to-route mapping is owned elsewhere.
 */
export interface PageModule<P = PageProps> {
  default: PageComponent<P>;
  load?(context: RequestContext): P | Promise<P>;
  getStaticPaths?(): Array<Record<string, string>> | Promise<Array<Record<string, string>>>;
  middleware?: readonly RouteMiddlewareRef[];
  /**
   * Opt-in route data cache TTL in seconds. When set (a positive finite
   * number) and a cache store is available on the request context, the
   * page's `load()` result is cached under a key derived from the route
   * pattern, resolved params, and query string. Absent means `load` runs
   * fresh on every request.
   */
  revalidate?: number;
  /**
   * Opt-in invalidation tags. When combined with `revalidate`, every tag is
   * recorded against the page's cache key so `revalidateTag(tag)` can purge it
   * on demand (the Next.js tag-invalidation analog). Absent means the page is
   * reachable only by `revalidatePath` or TTL expiry.
   */
  tags?: readonly string[];
  /**
   * Opt-in progressive streaming export. When defined, live serving calls
   * `stream(context)` instead of the string renderer (`default` + `load`).
   * A module may define both `stream` and `default`; `stream` wins during
   * live serving. Static export (`jsails build`) ignores `stream` and renders
   * `default` + `load` as usual.
   */
  stream?(context: RequestContext): PageStream | Promise<PageStream>;
  /**
   * Reserved SEO export. A static {@link PageMetadata} object, or a function
   * resolving one from the request context. When both `metadata` and
   * `generateMetadata` are present, `generateMetadata` wins.
   */
  metadata?: PageMetadata | ((context: RequestContext) => PageMetadata | Promise<PageMetadata>);
  /**
   * Reserved SEO export. Resolves the page's {@link PageMetadata} from the
   * request context; takes precedence over a static `metadata` object.
   */
  generateMetadata?(context: RequestContext): PageMetadata | Promise<PageMetadata>;
}

/**
 * Props passed to a layout's default export: `children` plus any page props.
 *
 * Non-generic — page props flow through as `Record<string, unknown>`.
 * A layout that needs narrower typing casts its props at the component level.
 */
export interface LayoutProps {
  children: RenderChild;
  [key: string]: unknown;
}

/**
 * A compiled layout module.
 *
 * `default` wraps its `children` (the inner rendered output) plus any page
 * props the layout consumes. The `context` parameter is omitted during static
 * generation, like {@link PageComponent}. Unlike {@link PageModule}, a layout
 * module carries no `load`, `getStaticPaths`, or `middleware` surface.
 */
export interface LayoutModule {
  default: (props: LayoutProps, context?: RequestContext) => RenderChild | Promise<RenderChild>;
}

/** Options controlling a single page render, shared by every renderer. */
export interface PageRenderOptions {
  /**
   * Reject a default component annotated `SERVER_ONLY` instead of rendering it
   * to a static file. Nested annotations are not inspected.
   */
  staticMode?: boolean;
}

/**
 * Adapter seam for rendering one page route.
 *
 * A renderer receives the manifest entry, the request context, and render
 * options, and returns the complete HTML document as a string (or a promise of
 * one). The returned string is trusted producer output: JSails never sanitizes
 * it. The built-in Preact renderer keeps Preact's escaping; a custom renderer
 * owns the escaping and safety of everything it emits.
 */
export interface PageRenderer {
  render(
    entry: RouteManifestEntry,
    context: RequestContext,
    options?: PageRenderOptions,
  ): string | Promise<string>;
}
