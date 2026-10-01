/**
 * Route and output-path planning for {@link generateStaticSite}.
 *
 * Renders every `page` manifest entry to an HTML string, expands dynamic
 * routes via `getStaticPaths`, maps each resolved route to a contained output
 * path, and registers every output in a shared collision map. Nothing here
 * writes to disk; a planning failure therefore leaves a prior build untouched.
 */

import { relative, sep } from 'node:path';

import type { ServiceRegistry } from '../../extensions/services.js';
import { formatError } from '../../internal/errors.js';
import {
  routeToOutputPath,
  substituteRouteParams,
  type RouteManifest,
  type RouteManifestEntry,
} from '../../routing/routes.js';
import type { AssetUrlResolver, RequestContext } from '../../contracts/http.js';
import type { PageRenderer } from '../../contracts/render.js';
import { loadPageModule } from '../page.js';

/** Raised when a static build cannot be planned, validated, or committed safely. */
export class StaticSiteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaticSiteError';
  }
}

/** A rendered page mapped to its contained, posix-separated output path. */
export interface PlannedPage {
  readonly rel: string;
  readonly html: string;
}

const DEFAULT_BASE_URL = 'http://localhost';

/** Parse and validate `baseUrl`, defaulting to a local origin. */
export function resolveBaseUrl(baseUrl: string | undefined): URL {
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

/**
 * Record one output path, rejecting duplicates and file/directory conflicts.
 * A file path may not equal another output nor be an ancestor directory of it.
 */
export function addOutput(outputs: Map<string, string>, rel: string, label: string): void {
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

/** Render every page entry, expanding dynamic routes via `getStaticPaths`. */
export async function planPages(
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
        `getStaticPaths for "${entry.route}" failed: ${formatError(error)}`,
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
