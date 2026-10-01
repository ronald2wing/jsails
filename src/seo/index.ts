/**
 * `jsails/seo` — per-page metadata, head-tag rendering, JSON-LD, and
 * `sitemap.xml` / `robots.txt` generation.
 *
 * Server-only: the head builder pulls `unhead` and the sitemap builder pulls
 * the `sitemap` package. The metadata *types* are re-exported from
 * `./metadata.js`, which is dependency-free, so a type-only import from the
 * browser-safe contracts graph stays clean.
 */

export { SeoError } from './errors.js';

export { defineMetadata } from './metadata.js';
export type {
  AlternateLink,
  MetaTag,
  OpenGraphMetadata,
  PageMetadata,
  SeoRuntimeOptions,
  TwitterMetadata,
} from './metadata.js';

export { jsonLd, serializeJsonLd } from './json-ld.js';
export type { JsonLdNode, JsonLdScript } from './json-ld.js';

export { assertOrigin, buildHeadTags, injectHead } from './head.js';

export { buildSitemapXml } from './sitemap.js';
export type { SitemapEntry, SitemapOptions } from './sitemap.js';

export { buildRobotsTxt } from './robots.js';
export type { RobotsOptions } from './robots.js';

export { fontFace, imageAttrs } from './asset-helpers.js';
export type { FontFaceInput, ImageAttrsInput } from './asset-helpers.js';
