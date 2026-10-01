/**
 * Head-tag building and injection (`jsails/seo`).
 *
 * {@link buildHeadTags} turns a {@link PageMetadata} into a serialized
 * `<head>`-tag string using unhead's server renderer; {@link injectHead}
 * splices that string into a rendered document. Both are pure and synchronous
 * (`renderSSRHead` is sync), so the page renderer stays synchronous.
 *
 * unhead is configured with `disableDefaults: true` because JSails owns the
 * document shell (`withDocumentShell` emits the doctype, `<meta charset>`, and
 * `<meta name="viewport">`); letting unhead emit its own defaults would
 * duplicate them.
 */

import { createHead, renderSSRHead } from 'unhead/server';
import { defineScript, useHead } from 'unhead';
import type { ResolvableHead } from 'unhead/types';

import { SeoError } from './errors.js';
import { serializeJsonLd } from './json-ld.js';
import type { JsonLdScript } from './json-ld.js';
import type { AlternateLink, MetaTag, PageMetadata, SeoRuntimeOptions } from './metadata.js';

/**
 * Build the serialized `<head>` tags for a page. Returns `''` when there is
 * nothing to emit. A fresh unhead instance is created per call so concurrent
 * SSR renders never share state.
 */
export function buildHeadTags(metadata: PageMetadata, options: SeoRuntimeOptions = {}): string {
  const merged = mergeMetadata(options.defaults, metadata, options);
  const input = toHeadInput(merged, options);
  if (input === null) {
    return '';
  }
  const head = createHead({ disableDefaults: true });
  useHead(head, input);
  return renderSSRHead(head).headTags;
}

/**
 * Splice a head-tag string into a rendered document. When `headTags` is empty
 * the document is returned unchanged. Otherwise the tags are inserted before
 * the first `</head>`; when the document has an `<html>` element but no
 * `<head>` (a layout that owns `<html>`), a `<head>` is created right after the
 * opening tag; a bare fragment is prefixed with a `<head>` defensively.
 */
export function injectHead(html: string, headTags: string): string {
  if (headTags === '') {
    return html;
  }
  const headClose = /<\/head\s*>/i.exec(html);
  if (headClose !== null) {
    return html.slice(0, headClose.index) + headTags + html.slice(headClose.index);
  }
  const htmlOpen = /<html(?:\s[^>]*)?>/i.exec(html);
  if (htmlOpen !== null) {
    const insertAt = htmlOpen.index + htmlOpen[0].length;
    return html.slice(0, insertAt) + `<head>${headTags}</head>` + html.slice(insertAt);
  }
  return `<head>${headTags}</head>${html}`;
}

/**
 * Validate that a value is a usable origin, returning its normalized form
 * (scheme + host + port, no path). Throws a value-free {@link SeoError}.
 */
export function assertOrigin(origin: string): string {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new SeoError('invalid_origin', 'the SEO origin must be a valid http(s) URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SeoError('invalid_origin', 'the SEO origin must use the http or https scheme');
  }
  return url.origin;
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

/**
 * Merge app defaults underneath page metadata. Page values win per field;
 * `openGraph` and `twitter` are shallow-merged so a page can override one
 * sub-field without restating the block. `siteName` fills a missing
 * `openGraph.siteName`.
 */
function mergeMetadata(
  defaults: PageMetadata | undefined,
  page: PageMetadata,
  options: SeoRuntimeOptions,
): PageMetadata {
  return {
    title: page.title ?? defaults?.title,
    description: page.description ?? defaults?.description,
    canonical: page.canonical ?? defaults?.canonical,
    robots: page.robots ?? defaults?.robots,
    keywords: page.keywords ?? defaults?.keywords,
    openGraph: mergeOpenGraph(defaults?.openGraph, page.openGraph, options),
    twitter: mergeTwitter(defaults?.twitter, page.twitter),
    alternates: page.alternates ?? defaults?.alternates,
    jsonLd: page.jsonLd ?? defaults?.jsonLd,
    meta: page.meta ?? defaults?.meta,
  };
}

function mergeOpenGraph(
  base: PageMetadata['openGraph'],
  page: PageMetadata['openGraph'],
  options: SeoRuntimeOptions,
): PageMetadata['openGraph'] {
  const merged = { ...base, ...page };
  if (merged.siteName === undefined && options.siteName !== undefined) {
    merged.siteName = options.siteName;
  }
  return Object.keys(merged).length === 0 ? undefined : merged;
}

function mergeTwitter(
  base: PageMetadata['twitter'],
  page: PageMetadata['twitter'],
): PageMetadata['twitter'] {
  const merged = { ...base, ...page };
  return Object.keys(merged).length === 0 ? undefined : merged;
}

// ---------------------------------------------------------------------------
// Metadata -> unhead input
// ---------------------------------------------------------------------------

/** A `<meta>` entry as unhead accepts it (name / property / http-equiv). */
type HeadMeta =
  | { name: string; content: string }
  | { property: string; content: string }
  | { 'http-equiv': string; content: string };

/** A `<link>` entry as unhead accepts it. */
type HeadLink =
  | { rel: 'canonical'; href: string }
  | { rel: 'alternate'; href: string; hreflang: string; type?: string };

/** A `<script>` entry as unhead accepts it. */
type HeadScript = ReturnType<typeof defineScript>;

function toHeadInput(metadata: PageMetadata, options: SeoRuntimeOptions): ResolvableHead | null {
  const meta: HeadMeta[] = [];
  const link: HeadLink[] = [];
  const script: HeadScript[] = [];

  if (metadata.description !== undefined) {
    meta.push({ name: 'description', content: metadata.description });
  }
  if (metadata.robots !== undefined) {
    meta.push({ name: 'robots', content: metadata.robots });
  }
  if (metadata.keywords !== undefined && metadata.keywords.length > 0) {
    meta.push({ name: 'keywords', content: metadata.keywords.join(', ') });
  }

  const canonical = resolveUrl(metadata.canonical, options.origin);
  if (canonical !== undefined) {
    link.push({ rel: 'canonical', href: canonical });
  }

  pushOpenGraph(meta, metadata.openGraph, canonical);
  pushTwitter(meta, metadata.twitter);
  pushAlternates(link, metadata.alternates, options.origin);
  pushExtraMeta(meta, metadata.meta);
  pushJsonLd(script, metadata.jsonLd);

  if (
    metadata.title === undefined &&
    meta.length === 0 &&
    link.length === 0 &&
    script.length === 0
  ) {
    return null;
  }
  return { title: metadata.title, meta, link, script };
}

function pushOpenGraph(
  meta: HeadMeta[],
  openGraph: PageMetadata['openGraph'],
  canonical: string | undefined,
): void {
  if (openGraph === undefined) return;
  const push = (property: string, content: string | undefined): void => {
    if (content !== undefined) meta.push({ property, content });
  };
  push('og:title', openGraph.title);
  push('og:description', openGraph.description);
  push('og:type', openGraph.type);
  push('og:url', openGraph.url ?? canonical);
  push('og:image', openGraph.image);
  push('og:site_name', openGraph.siteName);
  push('og:locale', openGraph.locale);
}

function pushTwitter(meta: HeadMeta[], twitter: PageMetadata['twitter']): void {
  if (twitter === undefined) return;
  const push = (name: string, content: string | undefined): void => {
    if (content !== undefined) meta.push({ name, content });
  };
  push('twitter:card', twitter.card);
  push('twitter:title', twitter.title);
  push('twitter:description', twitter.description);
  push('twitter:image', twitter.image);
  push('twitter:site', twitter.site);
  push('twitter:creator', twitter.creator);
}

function pushAlternates(
  link: HeadLink[],
  alternates: readonly AlternateLink[] | undefined,
  origin: string | undefined,
): void {
  if (alternates === undefined) return;
  for (const alternate of alternates) {
    const href = resolveUrl(alternate.href, origin);
    if (href === undefined) continue;
    link.push({ rel: 'alternate', href, hreflang: alternate.hreflang });
  }
}

function pushExtraMeta(meta: HeadMeta[], extra: readonly MetaTag[] | undefined): void {
  if (extra === undefined) return;
  for (const tag of extra) {
    if (tag.name !== undefined) {
      meta.push({ name: tag.name, content: tag.content });
    } else if (tag.property !== undefined) {
      meta.push({ property: tag.property, content: tag.content });
    } else if (tag.httpEquiv !== undefined) {
      meta.push({ 'http-equiv': tag.httpEquiv, content: tag.content });
    } else {
      meta.push({ name: '', content: tag.content });
    }
  }
}

function pushJsonLd(script: HeadScript[], nodes: PageMetadata['jsonLd']): void {
  if (nodes === undefined) return;
  for (const node of nodes) {
    const json = isPreparedJsonLd(node) ? node.json : serializeJsonLd(node);
    script.push(defineScript({ type: 'application/ld+json', textContent: json }));
  }
}

/** A prepared {@link JsonLdScript} carries a serialized `json` string. */
function isPreparedJsonLd(node: unknown): node is JsonLdScript {
  return (
    typeof node === 'object' &&
    node !== null &&
    typeof (node as { json?: unknown }).json === 'string'
  );
}

/**
 * Resolve a possibly-relative URL against the configured origin. An absolute
 * `http(s)` URL is returned unchanged; a relative path is joined to `origin`
 * when one is configured; otherwise the value is returned as-is (a relative
 * canonical is still valid HTML).
 */
function resolveUrl(value: string | undefined, origin: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (/^https?:\/\//i.test(value)) return value;
  if (origin === undefined) return value;
  const base = origin.replace(/\/+$/, '');
  const path = value.startsWith('/') ? value : `/${value}`;
  return `${base}${path}`;
}
