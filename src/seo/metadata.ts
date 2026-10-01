/**
 * Per-page metadata model and authoring helper (`jsails/seo`).
 *
 * A page declares metadata through the reserved `metadata` / `generateMetadata`
 * module exports (see `PageModule` in `jsails/pages`); {@link defineMetadata}
 * is the canonical construction point that validates shapes value-free and
 * returns a deep-frozen value. The head builder (`./head.js`) turns a
 * {@link PageMetadata} into real `<head>` tags.
 *
 * This module is deliberately free of `node:*` and of the `sitemap` package so
 * it can be imported as a type-only dependency from the browser-safe
 * `jsails/contracts` graph without pulling the server-only SEO runtime in.
 */

import { SeoError } from './errors.js';
import type { JsonLdNode, JsonLdScript } from './json-ld.js';

/** An Open Graph (`og:*`) metadata block. */
export interface OpenGraphMetadata {
  readonly title?: string;
  readonly description?: string;
  /** `og:type` — e.g. `website`, `article`. */
  readonly type?: string;
  /** `og:url`; falls back to `canonical` when absent. */
  readonly url?: string;
  readonly image?: string;
  readonly siteName?: string;
  /** `og:locale` — e.g. `en_US`. */
  readonly locale?: string;
}

/** A Twitter card (`twitter:*`) metadata block. */
export interface TwitterMetadata {
  /** `twitter:card` — e.g. `summary`, `summary_large_image`. */
  readonly card?: string;
  readonly title?: string;
  readonly description?: string;
  readonly image?: string;
  /** `twitter:site` — the site's @handle. */
  readonly site?: string;
  /** `twitter:creator` — the author's @handle. */
  readonly creator?: string;
}

/** An `<link rel="alternate">` entry (hreflang / feed alternates). */
export interface AlternateLink {
  /** `hreflang` — e.g. `en`, `fr`, `x-default`. */
  readonly hreflang: string;
  readonly href: string;
  /** Optional `type` — e.g. `application/rss+xml`. */
  readonly type?: string;
}

/**
 * A raw `<meta>` escape hatch. Exactly one of `name` / `property` /
 * `httpEquiv` should be set; `content` is required.
 */
export interface MetaTag {
  readonly content: string;
  readonly name?: string;
  readonly property?: string;
  readonly httpEquiv?: string;
}

/**
 * The per-page metadata a page module may declare. Every field is optional; the
 * head builder merges app-level `defaults` underneath and the page wins per
 * field.
 */
export interface PageMetadata {
  readonly title?: string;
  readonly description?: string;
  /** Absolute or origin-relative canonical URL. */
  readonly canonical?: string;
  /** A `robots` directive string, e.g. `noindex, nofollow`. */
  readonly robots?: string;
  readonly keywords?: readonly string[];
  readonly openGraph?: OpenGraphMetadata;
  readonly twitter?: TwitterMetadata;
  readonly alternates?: readonly AlternateLink[];
  /** Structured-data nodes, or prepared {@link JsonLdScript} payloads. */
  readonly jsonLd?: readonly (JsonLdNode | JsonLdScript)[];
  /** Raw `<meta>` tags for anything the typed fields do not cover. */
  readonly meta?: readonly MetaTag[];
}

/**
 * Runtime SEO options threaded from the resolved app config. `siteName` and
 * `origin` supply defaults the page metadata can override; `defaults` is a
 * base {@link PageMetadata} merged underneath every page.
 *
 * Lives here (not in `./head.js`) so the browser-safe `jsails/contracts` graph
 * can reference it through a type-only import without pulling the server-only
 * head runtime (unhead) in.
 */
export interface SeoRuntimeOptions {
  readonly siteName?: string;
  /** The site's canonical origin (e.g. `https://example.com`), no trailing slash. */
  readonly origin?: string;
  readonly defaults?: PageMetadata;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(field: string, message: string): never {
  throw new SeoError('invalid_metadata', `metadata.${field} ${message}`, [{ field, message }]);
}

function assertOptionalString(value: unknown, field: string): void {
  if (value !== undefined && typeof value !== 'string') {
    fail(field, 'must be a string');
  }
}

function assertOptionalStringArray(value: unknown, field: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    fail(field, 'must be an array of strings');
  }
}

function assertOptionalObject(value: unknown, field: string): void {
  if (value !== undefined && !isPlainObject(value)) {
    fail(field, 'must be an object');
  }
}

function assertOptionalArray(value: unknown, field: string): void {
  if (value !== undefined && !Array.isArray(value)) {
    fail(field, 'must be an array');
  }
}

function validateOpenGraph(value: unknown): void {
  assertOptionalObject(value, 'openGraph');
  if (value === undefined) return;
  const og = value as Record<string, unknown>;
  for (const key of ['title', 'description', 'type', 'url', 'image', 'siteName', 'locale']) {
    assertOptionalString(og[key], `openGraph.${key}`);
  }
}

function validateTwitter(value: unknown): void {
  assertOptionalObject(value, 'twitter');
  if (value === undefined) return;
  const tw = value as Record<string, unknown>;
  for (const key of ['card', 'title', 'description', 'image', 'site', 'creator']) {
    assertOptionalString(tw[key], `twitter.${key}`);
  }
}

function validateAlternates(value: unknown): void {
  assertOptionalArray(value, 'alternates');
  if (value === undefined) return;
  (value as readonly unknown[]).forEach((entry, index) => {
    if (!isPlainObject(entry)) {
      fail(`alternates.${String(index)}`, 'must be an object');
    }
    const link = entry;
    if (typeof link.hreflang !== 'string') {
      fail(`alternates.${String(index)}.hreflang`, 'must be a string');
    }
    if (typeof link.href !== 'string') {
      fail(`alternates.${String(index)}.href`, 'must be a string');
    }
    assertOptionalString(link.type, `alternates.${String(index)}.type`);
  });
}

function validateMetaTags(value: unknown): void {
  assertOptionalArray(value, 'meta');
  if (value === undefined) return;
  (value as readonly unknown[]).forEach((entry, index) => {
    if (!isPlainObject(entry)) {
      fail(`meta.${String(index)}`, 'must be an object');
    }
    const tag = entry;
    if (typeof tag.content !== 'string') {
      fail(`meta.${String(index)}.content`, 'must be a string');
    }
    assertOptionalString(tag.name, `meta.${String(index)}.name`);
    assertOptionalString(tag.property, `meta.${String(index)}.property`);
    assertOptionalString(tag.httpEquiv, `meta.${String(index)}.httpEquiv`);
  });
}

function validateJsonLd(value: unknown): void {
  assertOptionalArray(value, 'jsonLd');
}

// ---------------------------------------------------------------------------
// defineMetadata
// ---------------------------------------------------------------------------

/**
 * Validate and freeze a {@link PageMetadata} value. Unknown keys are permitted
 * (the typed `meta` field is the supported escape hatch, but a forward-compat
 * key is not an error); known fields are shape-checked and a malformed value
 * throws a value-free {@link SeoError} with `code: 'invalid_metadata'`.
 *
 * The returned value is a deep-frozen copy: nested objects and arrays are
 * frozen so a page cannot mutate metadata after construction.
 */
export function defineMetadata(input: PageMetadata): PageMetadata {
  if (!isPlainObject(input)) {
    throw new SeoError('invalid_metadata', 'metadata must be an object');
  }
  const value = input;

  assertOptionalString(value.title, 'title');
  assertOptionalString(value.description, 'description');
  assertOptionalString(value.canonical, 'canonical');
  assertOptionalString(value.robots, 'robots');
  assertOptionalStringArray(value.keywords, 'keywords');
  validateOpenGraph(value.openGraph);
  validateTwitter(value.twitter);
  validateAlternates(value.alternates);
  validateJsonLd(value.jsonLd);
  validateMetaTags(value.meta);

  return deepFreezeMetadata(input);
}

/** Deep-freeze a metadata value (nested objects and arrays included). */
function deepFreezeMetadata(metadata: PageMetadata): PageMetadata {
  if (metadata.openGraph !== undefined) Object.freeze(metadata.openGraph);
  if (metadata.twitter !== undefined) Object.freeze(metadata.twitter);
  if (metadata.keywords !== undefined) Object.freeze(metadata.keywords);
  if (metadata.alternates !== undefined) {
    for (const link of metadata.alternates) Object.freeze(link);
    Object.freeze(metadata.alternates);
  }
  if (metadata.jsonLd !== undefined) Object.freeze(metadata.jsonLd);
  if (metadata.meta !== undefined) {
    for (const tag of metadata.meta) Object.freeze(tag);
    Object.freeze(metadata.meta);
  }
  return Object.freeze(metadata);
}
