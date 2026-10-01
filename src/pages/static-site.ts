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

import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { dirname, join, parse, relative, resolve, sep } from 'node:path';

import type { AssetUrlResolver, RequestContext } from '../contracts/http.js';
import type { PageRenderer } from '../contracts/render.js';
import type { ServiceRegistry } from '../extensions/services.js';
import {
  routeToOutputPath,
  substituteRouteParams,
  type RouteManifest,
  type RouteManifestEntry,
} from '../routing/manifest.js';
import { loadPageModule, preactPageRenderer } from './page.js';

/** Raised when a static build cannot be planned, validated, or committed safely. */
export class StaticSiteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaticSiteError';
  }
}

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

/** Fixed marker proving a non-empty output directory belongs to this build. */
const MARKER_FILE = '.jsails-static-site.json';
const MARKER_CONTENTS = `${JSON.stringify({ generator: 'jsails', version: 1 })}\n`;
const DEFAULT_BASE_URL = 'http://localhost';

interface PlannedPage {
  readonly rel: string;
  readonly html: string;
}

interface PlannedAsset {
  readonly rel: string;
  readonly from: string;
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

/** Render every page entry, expanding dynamic routes via `getStaticPaths`. */
async function planPages(
  manifest: RouteManifest,
  outDir: string,
  baseUrl: URL,
  skipped: string[],
  outputs: Map<string, string>,
  renderer: PageRenderer,
  services: ServiceRegistry | undefined,
  assetUrl: AssetUrlResolver | undefined,
  storagePath: string | undefined,
): Promise<PlannedPage[]> {
  const pages: PlannedPage[] = [];

  for (const entry of manifest.entries) {
    if (entry.kind === 'api') {
      skipped.push(entry.route);
      continue;
    }
    if (entry.kind !== 'page') {
      throw new StaticSiteError(
        `unsupported manifest entry kind "${String(entry.kind)}" for route "${entry.route}"`,
      );
    }

    if (!entry.dynamic) {
      const html = await renderPage(
        entry,
        entry.route,
        {},
        baseUrl,
        renderer,
        services,
        assetUrl,
        storagePath,
      );
      const rel = outputRel(outDir, entry.route);
      addOutput(outputs, rel, `page "${entry.route}"`);
      pages.push({ rel, html });
      continue;
    }

    const page = await loadPageModule(entry.file);
    if (page.getStaticPaths === undefined) {
      throw new StaticSiteError(
        `dynamic page "${entry.route}" must export getStaticPaths for static generation`,
      );
    }

    let records: unknown;
    try {
      records = await page.getStaticPaths();
    } catch (error) {
      throw new StaticSiteError(
        `getStaticPaths for "${entry.route}" failed: ${describeError(error)}`,
      );
    }
    if (!Array.isArray(records)) {
      throw new StaticSiteError(`getStaticPaths for "${entry.route}" must return an array`);
    }

    for (const record of records) {
      const params = validateParamRecord(entry, record);
      const route = substituteRouteParams(entry, params);
      const html = await renderPage(
        entry,
        route,
        params,
        baseUrl,
        renderer,
        services,
        assetUrl,
        storagePath,
      );
      const rel = outputRel(outDir, route);
      addOutput(outputs, rel, `page "${route}"`);
      pages.push({ rel, html });
    }
  }

  return pages;
}

/** Validate one `getStaticPaths` record against the entry's declared params. */
function validateParamRecord(entry: RouteManifestEntry, record: unknown): Record<string, string> {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    throw new StaticSiteError(
      `getStaticPaths for "${entry.route}" must return plain parameter records`,
    );
  }
  const values = record as Record<string, unknown>;
  for (const name of entry.params) {
    if (!Object.hasOwn(values, name)) {
      throw new StaticSiteError(
        `getStaticPaths record for "${entry.route}" is missing parameter ":${name}"`,
      );
    }
    if (typeof values[name] !== 'string') {
      throw new StaticSiteError(
        `getStaticPaths parameter ":${name}" for "${entry.route}" must be a string`,
      );
    }
  }
  for (const key of Object.keys(values)) {
    if (!entry.params.includes(key)) {
      throw new StaticSiteError(
        `getStaticPaths record for "${entry.route}" has unexpected parameter "${key}"`,
      );
    }
  }
  return values as Record<string, string>;
}

/**
 * Build a GET context and render one resolved route to an HTML string.
 *
 * `services` is attached to the synthesized context only when the caller
 * supplied a registry; the build never starts one. The renderer is trusted
 * producer code, so its string is returned as-is, but a non-string result is
 * rejected here — before the staging directory exists — rather than written.
 */
async function renderPage(
  entry: RouteManifestEntry,
  route: string,
  params: Record<string, string>,
  baseUrl: URL,
  renderer: PageRenderer,
  services: ServiceRegistry | undefined,
  assetUrl: AssetUrlResolver | undefined,
  storagePath: string | undefined,
): Promise<string> {
  const url = new URL(route, baseUrl);
  const context: RequestContext = {
    request: new Request(url, { method: 'GET' }),
    url,
    params,
    session: null,
    renderMode: 'static',
    ...(services === undefined ? {} : { services }),
    ...(assetUrl === undefined ? {} : { assetUrl }),
    ...(storagePath === undefined ? {} : { storagePath }),
  };
  const html = await renderer.render(entry, context, { staticMode: true });
  if (typeof html !== 'string') {
    throw new StaticSiteError(`renderer for route "${route}" must return an HTML string`);
  }
  return html;
}

/** Map a resolved route to its contained, posix-separated output path. */
function outputRel(outDir: string, route: string): string {
  const target = routeToOutputPath(outDir, route);
  const rel = relative(outDir, target);
  if (rel === '' || rel.startsWith('..') || rel.includes('\0')) {
    throw new StaticSiteError(`route "${route}" does not map inside the output directory`);
  }
  return rel.split(sep).join('/');
}

/**
 * Record one output path, rejecting duplicates and file/directory conflicts.
 * A file path may not equal another output nor be an ancestor directory of it.
 */
function addOutput(outputs: Map<string, string>, rel: string, label: string): void {
  const normalized = rel.split(sep).join('/');
  const existing = outputs.get(normalized);
  if (existing !== undefined) {
    throw new StaticSiteError(
      `output collision: ${label} and ${existing} both resolve to "${normalized}"`,
    );
  }
  for (const other of outputs.keys()) {
    if (other.startsWith(`${normalized}/`)) {
      throw new StaticSiteError(
        `output collision: ${label} ("${normalized}") is a file conflicting with directory "${other}"`,
      );
    }
    if (normalized.startsWith(`${other}/`)) {
      throw new StaticSiteError(
        `output collision: ${label} ("${normalized}") is inside output file "${other}"`,
      );
    }
  }
  outputs.set(normalized, label);
}

/** Recursively collect copyable public assets, rejecting symlinks and dot-files. */
function planAssets(
  publicDir: string | undefined,
  outDir: string,
  outputs: Map<string, string>,
): PlannedAsset[] {
  if (publicDir === undefined || !existsSync(publicDir)) return [];

  const rootStat = lstatSync(publicDir);
  if (rootStat.isSymbolicLink()) {
    throw new StaticSiteError(`publicDir "${publicDir}" must not be a symlink`);
  }
  if (!rootStat.isDirectory()) {
    throw new StaticSiteError(`publicDir "${publicDir}" must be a directory`);
  }

  const assets: PlannedAsset[] = [];
  walk('', publicDir);
  return assets;

  function walk(prefix: string, dir: string): void {
    const dirents = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const dirent of dirents) {
      // Dot-entries are skipped, never copied: this is what keeps `.env` and
      // other secret-bearing files out of the published output.
      if (dirent.name.startsWith('.')) continue;

      const rel = prefix === '' ? dirent.name : `${prefix}/${dirent.name}`;
      const full = join(dir, dirent.name);

      if (dirent.isSymbolicLink()) {
        throw new StaticSiteError(`public asset "${rel}" is a symlink; symlinks are not copied`);
      }
      if (dirent.isDirectory()) {
        walk(rel, full);
        continue;
      }
      if (!dirent.isFile()) {
        throw new StaticSiteError(`public asset "${rel}" is not a regular file`);
      }

      const target = resolve(outDir, ...rel.split('/'));
      if (target !== outDir && !target.startsWith(outDir + sep)) {
        throw new StaticSiteError(`public asset "${rel}" escapes the output directory`);
      }
      addOutput(outputs, rel, `public asset "${rel}"`);
      assets.push({ rel, from: full });
    }
  }
}

/** Write the ownership marker, rendered pages, and copied assets into staging. */
function writeStaging(staging: string, pages: PlannedPage[], assets: PlannedAsset[]): void {
  writeFileSync(join(staging, MARKER_FILE), MARKER_CONTENTS);
  for (const page of pages) {
    const target = join(staging, ...page.rel.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, page.html);
  }
  for (const asset of assets) {
    const target = join(staging, ...asset.rel.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(asset.from, target);
  }
}

/**
 * Swap staging into `outDir`. An owned existing directory is moved aside first
 * and restored if the swap fails; only the moved-aside backup and staging (both
 * created here) are ever removed.
 */
function commitStaging(staging: string, outDir: string, existed: boolean): void {
  if (!existed) {
    renameSync(staging, outDir);
    return;
  }

  const backup = uniqueSibling(outDir);
  renameSync(outDir, backup);
  try {
    renameSync(staging, outDir);
  } catch (error) {
    try {
      renameSync(backup, outDir);
    } catch {
      // Restore failed: leave the backup in place rather than deleting output.
    }
    throw error;
  }
  try {
    rmSync(backup, { recursive: true, force: true });
  } catch {
    // The new output is live; a stray backup is preferable to failing the build.
  }
}

/** Return a same-parent path that does not collide with the target. */
function uniqueSibling(target: string): string {
  return join(
    dirname(target),
    `.jsails-old-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
  );
}

/**
 * Confirm `outDir` is a usable target: an absent or empty directory, or a
 * non-empty one carrying the build's exact ownership marker. A regular file
 * that merely shares the marker name (foreign, forged, or truncated contents)
 * is refused. Never deletes anything.
 */
function inspectOutput(outDir: string): boolean {
  let stat: Stats;
  try {
    stat = lstatSync(outDir);
  } catch (error) {
    if (isEnoent(error)) return false;
    throw error;
  }
  if (stat.isSymbolicLink()) {
    throw new StaticSiteError(`output directory "${outDir}" must not be a symlink`);
  }
  if (!stat.isDirectory()) {
    throw new StaticSiteError(`output path "${outDir}" exists and is not a directory`);
  }
  if (readdirSync(outDir).length === 0) return true;

  const marker = join(outDir, MARKER_FILE);
  let markerStat: Stats;
  try {
    markerStat = lstatSync(marker);
  } catch {
    throw new StaticSiteError(
      `refusing to overwrite non-empty output directory "${outDir}" without ownership marker "${MARKER_FILE}"`,
    );
  }
  if (markerStat.isSymbolicLink() || !markerStat.isFile()) {
    throw new StaticSiteError(
      `refusing to overwrite "${outDir}": ownership marker "${MARKER_FILE}" is not a regular file`,
    );
  }
  let contents: string;
  try {
    contents = readFileSync(marker, 'utf8');
  } catch {
    throw new StaticSiteError(
      `refusing to overwrite "${outDir}": ownership marker "${MARKER_FILE}" cannot be read`,
    );
  }
  if (contents !== MARKER_CONTENTS) {
    throw new StaticSiteError(
      `refusing to overwrite "${outDir}": ownership marker "${MARKER_FILE}" is invalid or foreign`,
    );
  }
  return true;
}

/** Reject an output directory that would contain sources or the public dir. */
function assertOutDirSafety(
  outDir: string,
  manifest: RouteManifest,
  publicDir: string | undefined,
): void {
  for (const entry of manifest.entries) {
    const file = resolve(entry.file);
    if (file === outDir || isInside(outDir, file)) {
      throw new StaticSiteError(
        `outDir "${outDir}" must not be or contain manifest module "${file}"`,
      );
    }
  }
  if (publicDir === undefined) return;
  if (publicDir === outDir || isInside(outDir, publicDir)) {
    throw new StaticSiteError(
      `outDir "${outDir}" must not equal or contain publicDir "${publicDir}"`,
    );
  }
  if (isInside(publicDir, outDir)) {
    throw new StaticSiteError(`outDir "${outDir}" must not be inside publicDir "${publicDir}"`);
  }
}

/** Reject a symlink at any existing component of the output path. */
function assertNoSymlinkAncestors(target: string): void {
  const abs = resolve(target);
  const { root } = parse(abs);
  const segments = abs
    .slice(root.length)
    .split(sep)
    .filter((segment) => segment !== '');
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    let stat: Stats;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if (isEnoent(error)) return;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new StaticSiteError(`output path ancestry "${current}" is a symlink`);
    }
  }
}

/** True when `child` is strictly below directory `parent`. */
function isInside(parent: string, child: string): boolean {
  return child !== parent && child.startsWith(parent + sep);
}

/** Parse and validate `baseUrl`, defaulting to a local origin. */
function resolveBaseUrl(baseUrl: string | undefined): URL {
  const raw = baseUrl ?? DEFAULT_BASE_URL;
  if (typeof raw !== 'string' || raw === '') {
    throw new StaticSiteError('baseUrl must be a non-empty string');
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new StaticSiteError(`baseUrl "${raw}" is not a valid absolute URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new StaticSiteError(`baseUrl "${raw}" must use http or https`);
  }
  return url;
}

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
