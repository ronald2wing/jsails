/**
 * Build-time static site generation for compiled filesystem page routes.
 *
 * `generateStaticSite` renders every `page` manifest entry through the supplied
 * {@link PageRenderer} — the built-in Preact renderer by default, which shares
 * the HTTP layer's {@link renderRoute} path — and writes the result under
 * `outDir`; `api` entries are never rendered or imported and are reported as
 * skipped. Dynamic pages must export `getStaticPaths` returning exact string
 * parameter records — every page is resolved (and collisions detected) before
 * any file is written, so a planning failure leaves a prior build untouched.
 *
 * Boundaries:
 * - Compiled `.js`/`.mjs` page modules only; TypeScript, bundling, JSX
 *   transforms, hydration, ISR, and server actions are out of scope. A supplied
 *   renderer may emit any HTML it likes, but dynamic-path discovery still
 *   requires a compiled module exporting `getStaticPaths`.
 * - No ORM, Valkey, or network service is initialized. Each page is rendered
 *   with a single in-memory GET context (`session: null`) built from `baseUrl`.
 * - `publicDir` contents are copied byte-for-byte with no compilation. Symlinks
 *   are rejected and dot-files (e.g. `.env`) are skipped, never copied.
 * - Writes go through a sibling staging directory. An existing non-empty
 *   `outDir` is only replaced when it carries the ownership marker written by a
 *   previous run; an unowned non-empty directory is refused, and a failed rename
 *   restores the original output instead of deleting arbitrary paths.
 *
 * `written`/`copied` are absolute paths of files placed in the final `outDir`;
 * `skipped` holds the route strings of `api` entries.
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import type { ServiceRegistry } from '../../extensions/services.js';
import type { RouteManifest } from '../../routing/routes.js';
import type { AssetUrlResolver } from '../../contracts/http.js';
import type { PageRenderer } from '../../contracts/render.js';
import { preactPageRenderer } from '../page.js';
import { planAssets } from './public-assets.js';
import { planPages, resolveBaseUrl } from './plan.js';
import {
  assertNoSymlinkAncestors,
  assertOutDirSafety,
  commitStaging,
  inspectOutput,
  writeStaging,
} from './write.js';

export { StaticSiteError } from './plan.js';

/** Options for {@link generateStaticSite}. */
export interface GenerateStaticSiteOptions {
  /** Route manifest produced by `discoverRoutes`. */
  manifest: RouteManifest;
  /** Output directory; created or replaced as an owned build target. */
  outDir: string;
  /** Optional directory of static assets copied verbatim into `outDir`. */
  publicDir?: string;
  /** Origin used to build each page's request URL. Must be `http(s)`. */
  baseUrl?: string;
  /**
   * Renderer used for every page. Defaults to the built-in
   * {@link preactPageRenderer}. A custom renderer is trusted HTML producer
   * code: its returned string is written as-is, with no sanitization.
   */
  renderer?: PageRenderer;
  /**
   * Read-only services exposed to the renderer through `context.services`.
   * Omitted means no registry is started and the field stays absent.
   */
  services?: ServiceRegistry;
  /**
   * Resolver for public asset URLs, attached to each synthesized page context
   * so templates and server components can emit cache-busted asset URLs during
   * static generation. Omitted means the field stays absent and callers use
   * unversioned paths.
   */
  assetUrl?: AssetUrlResolver;
  /**
   * Absolute persistent-storage directory, attached to each synthesized page
   * context as `storagePath`. Omitted means the field stays absent. The build
   * never creates the directory.
   */
  storagePath?: string;
}

/** Result of a static build. Paths in `written`/`copied` are absolute. */
export interface GenerateStaticSiteResult {
  /** Rendered page files placed in `outDir`, in manifest order. */
  written: string[];
  /** Copied public-asset files placed in `outDir`, in walk order. */
  copied: string[];
  /** Route strings of `api` entries, in manifest order. */
  skipped: string[];
}

/**
 * Render and write a static site from a route manifest.
 *
 * All page rendering, dynamic-path resolution, output-path validation, asset
 * discovery, and collision detection complete before the staging directory is
 * created. Contract violations therefore reject before touching `outDir`, and a
 * previously committed build is preserved unless the new build fully succeeds.
 */
export async function generateStaticSite(
  options: GenerateStaticSiteOptions,
): Promise<GenerateStaticSiteResult> {
  if (options === null || typeof options !== 'object') {
    throw new TypeError('generateStaticSite requires an options object');
  }
  const { manifest } = options;
  if (manifest === null || typeof manifest !== 'object' || !Array.isArray(manifest.entries)) {
    throw new TypeError('generateStaticSite requires a manifest with an entries array');
  }
  if (typeof options.outDir !== 'string' || options.outDir === '') {
    throw new TypeError('outDir must be a non-empty string');
  }
  if (
    options.publicDir !== undefined &&
    (typeof options.publicDir !== 'string' || options.publicDir === '')
  ) {
    throw new TypeError('publicDir must be a non-empty string when provided');
  }

  const baseUrl = resolveBaseUrl(options.baseUrl);
  const outDir = resolve(options.outDir);
  const publicDir = options.publicDir === undefined ? undefined : resolve(options.publicDir);
  const renderer = options.renderer ?? preactPageRenderer;
  if (typeof renderer.render !== 'function') {
    throw new TypeError('renderer must implement render(entry, context, options)');
  }
  const services = options.services;
  const assetUrl = options.assetUrl;
  const storagePath = options.storagePath;

  assertOutDirSafety(outDir, manifest, publicDir);
  assertNoSymlinkAncestors(outDir);
  const existed = inspectOutput(outDir);

  // Planning phase: nothing is written until every page and asset is resolved.
  const outputs = new Map<string, string>();
  const skipped: string[] = [];
  const pages = await planPages(
    manifest,
    outDir,
    baseUrl,
    skipped,
    outputs,
    renderer,
    services,
    assetUrl,
    storagePath,
  );
  const assets = planAssets(publicDir, outDir, outputs);

  // Build phase: populate a sibling staging directory, then swap it into place.
  const parent = dirname(outDir);
  mkdirSync(parent, { recursive: true });
  const staging = mkdtempSync(join(parent, '.jsails-site-'));
  try {
    writeStaging(staging, pages, assets);
    commitStaging(staging, outDir, existed);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }

  return {
    written: pages.map((page) => join(outDir, ...page.rel.split('/'))),
    copied: assets.map((asset) => join(outDir, ...asset.rel.split('/'))),
    skipped,
  };
}
