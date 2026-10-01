---
title: SEO
order: 12
section: Building
---

# SEO & Metadata

`jsails/seo` is the framework-owned SEO surface: per-page metadata that reaches
the rendered `<head>` in both live SSR and static export, typed JSON-LD
structured data, and build-time `sitemap.xml` / `robots.txt` generation.

The subpath is **server-only** for now. The head builder pulls `unhead` and the
sitemap builder pulls the `sitemap` package, so `jsails/seo` is never added to
the browser-safe allowlist and must not enter the `jsails/api` or `jsails/client`
graphs. Only the metadata _types_ are dependency-free (see
[Declaring metadata](#declaring-metadata)), so a type-only import stays clean.

## Declaring metadata

A page declares its metadata through the reserved `metadata` and
`generateMetadata` module exports, the same convention Next's App Router and
React Router 7 use. `generateMetadata` wins when both are present; `metadata`
may be an object **or** a function.

```tsx
// pages/about.tsx  (app-owned page)
import type { PageMetadata } from 'jsails/seo';
import type { RequestContext } from 'jsails';

// A static metadata object: validated and frozen at module load.
export const metadata: PageMetadata = defineMetadata({
  title: 'About',
  description: 'How JSails is assembled.',
});

// Or generate it per request; this export takes precedence over `metadata`.
export function generateMetadata(context: RequestContext): PageMetadata {
  return defineMetadata({
    title: `Post ${context.params.slug}`,
    canonical: `/blog/${context.params.slug}`,
  });
}

export default function About() {
  return <h1>About</h1>;
}
```

`defineMetadata(input)` is an identity-with-validation helper: it validates the
known fields value-free and returns a **deep-frozen** copy, so a page cannot
mutate metadata after construction. Unknown keys are permitted for forward
compatibility; a malformed known field throws a `SeoError` with
`code: 'invalid_metadata'` and a value-free `errors` list of `{ field, message }`
entries (dotted paths, never the offending value).

### `PageMetadata` fields

Every field is optional; app-level `defaults` are merged **underneath** and the
page wins per field.

| Field         | Type                                      | Emitted as                                           |
| ------------- | ----------------------------------------- | ---------------------------------------------------- |
| `title`       | `string`                                  | `<title>`                                            |
| `description` | `string`                                  | `<meta name="description">`                          |
| `canonical`   | `string`                                  | `<link rel="canonical">` (resolved against `origin`) |
| `robots`      | `string`                                  | `<meta name="robots">`, e.g. `noindex, nofollow`     |
| `keywords`    | `readonly string[]`                       | `<meta name="keywords">` (comma-joined)              |
| `openGraph`   | `OpenGraphMetadata`                       | `og:*` tags                                          |
| `twitter`     | `TwitterMetadata`                         | `twitter:*` tags                                     |
| `alternates`  | `readonly AlternateLink[]`                | `<link rel="alternate">` (hreflang)                  |
| `jsonLd`      | `readonly (JsonLdNode \| JsonLdScript)[]` | `<script type="application/ld+json">`                |
| `meta`        | `readonly MetaTag[]`                      | raw `<meta>` escape hatch                            |

`openGraph` (`title`, `description`, `type`, `url`, `image`, `siteName`,
`locale`) and `twitter` (`card`, `title`, `description`, `image`, `site`,
`creator`) are each shallow-merged, so a page overrides one sub-field without
restating the block. A missing `og:site_name` falls back to the config
`siteName`, and a missing `og:url` falls back to the resolved canonical. A
relative `canonical` or `alternates[].href` is joined to the configured `origin`;
an absolute `http(s)` URL passes through unchanged.

`MetaTag` carries `content` plus exactly one of `name` / `property` /
`httpEquiv` for anything the typed fields do not cover.

## JSON-LD

`jsonLd(node)` serializes a `schema-dts` `Thing` (or an array of them) into a
prepared `JsonLdScript` — the exact script `type` plus a serialized `json` body.
The head builder emits it as `<script type="application/ld+json">`.

```ts
// `defineMetadata` and `jsonLd` are installed as globals — no import needed.
export const metadata = defineMetadata({
  title: 'Widget',
  jsonLd: [
    jsonLd({
      '@context': 'https://schema.org',
      '@type': 'Article',
      headline: 'Widget',
    }),
  ],
});
```

`serializeJsonLd` escapes every `<` as `\u003c`, so a string value containing
`</script>` (or `<!--`) cannot break out of the surrounding script element — it
is invisible to a JSON consumer. A value that cannot be serialized throws a
`SeoError` with `code: 'invalid_json_ld'`.

## Head injection

`buildHeadTags(metadata, options?)` turns a `PageMetadata` into the serialized
`<head>`-tag string using unhead's server renderer. It is **synchronous**
(`renderSSRHead` is sync), so the page renderer stays synchronous; it returns
`''` when there is nothing to emit. A fresh unhead instance is created per call,
so concurrent SSR renders never share state. unhead is configured with its
defaults disabled because JSails owns the document shell.

`injectHead(html, headTags)` is the companion splice: the framework calls both
after `renderRoute` produces the shell string, inserting the tags before the
first `</head>`, creating a `<head>` after the opening `<html>` when a layout
owns `<html>`, or prefixing a bare fragment. You rarely call either directly —
page authors declare metadata and the renderer injects it.

## App config

Register site-wide defaults under the `seo` key in `jsails.app.js`. Absent means
no SEO defaults and no `robots.txt` emission.

```js
// jsails.app.js  (app-owned; plain ESM)
export default {
  rootDir: '.',
  seo: {
    siteName: 'JSails',
    origin: 'https://example.com',
    defaults: {
      title: 'JSails',
      description: 'A TypeORM-based data layer and app runtime.',
    },
    robots: {
      userAgent: '*',
      allow: ['/'],
      disallow: ['/admin'],
      sitemap: 'https://example.com/sitemap.xml',
    },
  },
};
```

- `siteName` fills a missing `openGraph.siteName`.
- `origin` is the canonical site origin (validated as an absolute `http(s)`
  origin). It resolves relative canonical/alternate URLs and the sitemap `loc`
  entries; it must have no trailing slash.
- `defaults` is a base `PageMetadata` merged under every page's own metadata.
- `robots` is a `RobotsOptions` (`userAgent`, `allow`, `disallow`, `sitemap`,
  `host`) consumed by the static exporter. `buildRobotsTxt` renders one
  `User-agent` block with its `Allow`/`Disallow` rules plus `Sitemap:` / `Host:`.

The `siteName`/`origin`/`defaults` subset reaches every page request context as
`context.seo`; `robots` is consumed by the static exporter only.

## Static export

When `seo` is configured, `jsails build` emits `sitemap.xml` and `robots.txt`
into `out/`. The sitemap wraps the `sitemap` package's stream to build a
`<urlset>` document from every rendered page (API routes are never included),
resolving each `loc` against the resolved base URL. Pages whose effective
robots directive — page metadata, else the `defaults` — includes `noindex` are
**excluded** from the sitemap.

`buildSitemapXml(entries, options?)` and `buildRobotsTxt(options)` are the pure
string producers behind both: no file I/O, the exporter writes the result. An
entry whose `loc` is not an absolute `http(s)` URL throws a `SeoError` with
`code: 'invalid_sitemap_url'`; a malformed robots directive throws
`code: 'invalid_robots'`.

> The route-manifest sitemap is distinct from `jsails/content`'s
> content-scoped `renderSitemap`. They cover different axes (every rendered page
> vs. a content collection) and are named differently on purpose — do not
> consolidate them.

## Admin panel

The admin document always carries `<meta name="robots" content="noindex,
nofollow">`. An admin panel is never a public page, so indexing it is
unconditionally wrong — there is no config knob to change it.

## Errors

`SeoError` is value-free: it never echoes a metadata value, a page title, a URL,
or rendered HTML. Its `message` may name a field path (structural metadata, not
user content), and it carries a stable machine-readable `code`, plus an `errors`
list of `{ field, message }` entries when thrown by `defineMetadata` shape
validation.

| Code                  | Raised by                                                            |
| --------------------- | -------------------------------------------------------------------- |
| `invalid_metadata`    | `defineMetadata` (malformed known field)                             |
| `invalid_json_ld`     | `serializeJsonLd` (unserializable value)                             |
| `invalid_origin`      | `assertOrigin` (not an absolute `http(s)` origin)                    |
| `invalid_sitemap_url` | `buildSitemapXml` (a `loc` is not absolute)                          |
| `invalid_robots`      | `buildRobotsTxt` (a directive has a line break or a bad sitemap URL) |

## Next steps

- [Content](/docs/content) — the content surface for blogs and structured text.
- [Deployment](/docs/deploy) — Jamal and static hosting.
