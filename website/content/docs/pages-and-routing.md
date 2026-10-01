---
title: Pages & Routing
order: 3
---

# Pages & Routing

JSails discovers routes from the filesystem. `discoverRoutes(rootDir, { pagesDir?,
apiDir? })` walks `pages/` and `api/` lexically — no module import, no connection.
Only compiled `.js`/`.mjs` modules are discovered; symlinks are never followed;
`api/` routes mount under `/api`. Parameters are single-segment `[id]`; catch-all
`[...id]` is rejected, not accepted as a literal path.

## Page modules

A page is a compiled module with a function default export, an optional
`load(context)` for async props, an optional `getStaticPaths()` for dynamic
routes, and an optional `revalidate` (seconds) that opts the page's `load` result
into the cache store when one is available.

```tsx
// pages/index.tsx  (app-owned page)
import type { RequestContext } from 'jsails';

export async function load(context: RequestContext) {
  return { hello: 'world' };
}

export default function Home({ hello }: { hello: string }) {
  return <h1>{hello}</h1>;
}
```

`preactPageRenderer` + `renderRoute` render pages via **Preact SSR** (doctype plus
a minimal document shell) and reject a `SERVER_ONLY` default component in static
mode. Set `"jsxImportSource": "jsails"` so JSX resolves to a thin
`preact/jsx-runtime` re-export; components are synchronous and async data belongs
in `load`. JSX/Preact runtimes are **not** interchangeable.

### Dynamic routes

A `[param]` filename segment is a single-segment parameter. A dynamic page
provides `getStaticPaths()` so the static export knows which paths to render:

```tsx
// pages/blog/[slug].tsx
export function getStaticPaths() {
  return [{ slug: 'hello-world' }, { slug: 'about' }];
}
```

## API modules

An API module exports named HTTP-method handlers `(request, context) => Response`;
there is no default-export guessing. The global `authorize` is **default-deny** —
absent means every API request is rejected, and a request is allowed only when the
callback resolves to exactly `true` (truthy non-boolean, throw, or rejection all
deny). A per-module `authorize` can only further restrict.

```ts
// api/me.ts
export async function GET(request: Request, context: RequestContext) {
  return Response.json({ session: context.session });
}
```

HTTP extension hooks run in order after the body-limit/405 middleware and before
the filesystem routes, receiving the real Hono app; hook routes are trusted code
that own their own security — the default-deny pipeline covers only filesystem API
routes.

## Per-route middleware

A compiled page or API module may export `middleware`, an array of
`RouteMiddleware` handlers `(context, next) => Response | Promise<Response>`
applied in declared order before the terminal handler. A handler that returns
without calling `next()` short-circuits the chain; a thrown/rejected handler
surfaces as the standard sanitized 500. Middleware can never run before the
default-deny gate.

```ts
// api/reports.ts
export const middleware = [
  async (context, next) => {
    if (!context.session) return new Response('Unauthorized', { status: 401 });
    return next();
  },
];

export async function GET(request: Request, context: RequestContext) {
  return Response.json({ ok: true });
}
```

The ordering invariant is fixed: body-limit/405 → session → origin/CSRF → global
`authorize` → module `authorize` → global middleware → per-route middleware →
handler. Global middleware is set via `globalMiddleware: readonly
RouteMiddlewareRef[]` in the app config; extensions add to the global chain through
`configureMiddleware(handler)` on the `ExtensionRuntime`. A named registry
(`middleware: Record<string, RouteMiddleware>`) is built at assembly time; routes
reference registered names (or inline functions) in their `middleware` export,
resolved by `resolveMiddlewareRefs`. The chain is request-scoped — `next()` is
callable at most once, a second call throws a `MiddlewareError`, and the returned
`Response` is trusted producer output. `validateMiddlewareList` validates a
module's `middleware` export structurally; `runMiddleware` composes the chain over
a terminal handler.

**Limits:** no reordering of built-in pipeline steps; no middleware on
framework-owned routes (`/up`, `/_jsails/introspect`, server-component updates,
extension HTTP hooks); no route-path-keyed config map; no lazy/async name
resolution. The static export never runs middleware.

## Route groups

A `pages/` directory named `(name)` (matching `[A-Za-z0-9_-]+`) is a route group:
it contributes no URL segment but does scope layouts. Groups are **pages-only**;
in `api/` the `(...)` is not a safe static segment and is rejected by the existing
literal check.

## Nested layouts

A `layout.js`/`layout.mjs` file in any `pages/` directory is a layout module,
discovered lexically by `discoverRoutes` and excluded from the route manifest. It
attaches to `RouteManifestEntry.layouts` as an ancestor chain (outermost first —
closest to `pages/` comes first). Layout modules carry no `load`, `middleware`, or
`getStaticPaths`; their default export is `(props: LayoutProps, context?) =>
RenderChild` where `props` receives the page's resolved props plus the
framework-reserved `children` slot (a colliding page prop loses). The function may
be sync or async.

```tsx
// pages/layout.tsx
export default function Layout({ children }: { children: unknown }) {
  return (
    <div>
      <nav>My Site</nav>
      <main>{children}</main>
    </div>
  );
}
```

`renderRoute` folds the chain inside-out: the innermost layout wraps the page, its
result is wrapped by the next-outer, and so on. If the outermost layout emits
`<html>`, the minimal document shell is skipped. Static export folds layouts
identically.

**v1 limits:** layouts have no `load`, no `middleware`, and no `SERVER_ONLY` check
(only the page component is checked); no loading/error boundaries, or
parallel/intercepting routes; the starter's `ui/layout.tsx` remains app-owned and
`pages/layout.js` is opt-in.

## Static export

`jsails build` is a static export: it renders every page (expanding
`getStaticPaths`), copies `public/` byte-for-byte (symlinks rejected, dot-files
skipped), and swaps the result into `out` through a staging directory. API routes
are never rendered and are reported skipped.

```sh
jsails build --config jsails.app.js   # static export into `out`
```

The renderer seam is `PageRenderer.render(entry, context, options)` — the same
interface for `serve` and `build`; configure it with `renderer`. The built-in
renderer keeps the compiled-page loader and `getStaticPaths` contract. A custom
renderer's returned string is **trusted producer HTML** — JSails never sanitizes
it, so the renderer owns its escaping and safety.

## Progressive streaming

A page module may export `stream(context)` → `PageStream` to stream HTML
progressively during live serving instead of waiting for `load` + `default` to
finish. `PageStream` accepts `AsyncIterable<string>`,
`ReadableStream<Uint8Array>`, or a Node `Readable`:

```tsx
// pages/feed.tsx
import type { RequestContext } from 'jsails';
import type { PageStream } from 'jsails/pages';

export async function* stream(context: RequestContext): PageStream {
  yield '<!DOCTYPE html><html><body>';
  for await (const item of fetchItems()) {
    yield `<article>${item.title}</article>`;
  }
  yield '</body></html>';
}
```

`renderStreamResponse(stream, headers?)` (`jsails/pages`) wraps the stream into
a `Response` with chunked transfer encoding and `X-Accel-Buffering: no` so
buffering proxies pass chunks through uninspected.

During live serving `stream` takes precedence over the string renderer
(`default` + `load`); a module may define both exports. Static export (`jsails
build`) ignores `stream` and renders `default` + `load` as usual.

## Asset URLs and Turbo reload

`createAssetUrlResolver(publicDir)` maps a root-relative public asset path
(`/assets/app.js`) to the same path with a content-derived query
(`/assets/app.js?v=<sha256>`). Hashing streams the file through SHA-256 and is
cached by `mtimeMs` + `size`, so an unchanged asset is never re-read. The resolver
is a **graceful-degradation seam, never a source of errors**: a missing
directory/asset, a traversal/absolute/hidden/backslash/query/fragment path, or a
symlink all return the unversioned path unchanged, so browser-free SSR (where
`public/` may not exist) still renders, and a hostile path is never read from
disk.

`context.assetUrl` is optional; `Application` and `createApp` attach the resolver
to each request context and the static export attaches it to each synthesized page
context. The starter layout tags the stylesheet and the module script with
`data-turbo-track="reload"`; Turbo compares that URL across navigations, so a
content change that keeps the same filename yields a new URL and forces a **full
reload** instead of serving a stale deployment cache. This is the intentional
exception to soft navigation: an unchanged asset keeps the same URL, so ordinary
links stay fast soft navigations, while changed build assets reload. The script
also carries `data-turbo-eval="false"` so Turbo does not re-evaluate the client
entry on every navigation. When no resolver is wired in (e.g. browser-free SSR),
`loadLayout` falls back to the plain `/assets/app.css` and `/assets/app.js` paths.

## Next steps

- [Server Components](/docs/server-components) — signed, stateful components with
  backend actions.
- [Client Runtime](/docs/client) — islands, Turbo navigation, and hydration.
