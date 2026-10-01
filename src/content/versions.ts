/**
 * Content versioning (`jsails/content`).
 *
 * Multi-version docs converge on directory-per-version + an author-ordered
 * manifest + a versioned URL prefix. Three concepts are deliberately distinct:
 *
 * - `current`  — the mutable working tree (its own prefix; Docusaurus /docs/next)
 * - `latest`   — the version the BARE prefix serves (`/docs/<slug>`)
 * - `default`  — the version the selector opens on / the root redirects to
 *
 * `current`, `latest`, and `default` frequently coincide (single maintained
 * version) but must never be conflated. The manifest is the single source of
 * truth and is NEVER auto-sorted — position encodes `banner` derivation.
 */

import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import { ContentError } from './errors.js';
import { discoverContent } from './discover.js';
import type { ContentPage } from './content-model.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** One entry in a version manifest, as authored. */
export interface ContentVersionEntry {
  /** Directory name and slug (e.g. `1.0`). Non-empty, unique within the manifest. */
  readonly name: string;
  /** Explicit display label. Non-empty. Never derived from `name`. */
  readonly label: string;
  /** URL prefix segment (e.g. `1.0`). Non-empty. */
  readonly path: string;
  /** Optional badge text surfaced by a selector. */
  readonly tag?: string;
  /**
   * Optional banner override. When absent it is derived from position relative
   * to `latest` (before → `'unreleased'`, after → `'unmaintained'`).
   */
  readonly banner?: 'unreleased' | 'unmaintained';
  /** Exclude from search indexing (SEO hint; never affects reachability). */
  readonly noIndex?: boolean;
  /** Exclude from the version selector/search (NOT privacy; stays URL-reachable). */
  readonly hidden?: boolean;
}

/** A validated, author-ordered version manifest. */
export interface ContentVersionsManifest {
  /** Version name of the mutable working tree. Must reference a `versions[].name`. */
  readonly current: string;
  /** Version name the bare prefix serves. Defaults to `current`. */
  readonly latest?: string;
  /** Version name the selector opens on. Defaults to `current`. */
  readonly default?: string;
  /** Every version, in author order. Never sorted. */
  readonly versions: readonly ContentVersionEntry[];
}

/** A version with `current`/`latest`/`default` and `banner` resolved. */
export interface ContentVersionInfo {
  readonly name: string;
  readonly label: string;
  readonly path: string;
  readonly tag?: string;
  /** Resolved banner (override wins, else position-derived, else `undefined`). */
  readonly banner?: 'unreleased' | 'unmaintained';
  readonly noIndex: boolean;
  readonly hidden: boolean;
  /** True when `name === manifest.current`. */
  readonly isCurrent: boolean;
  /** True when `name === resolved latest`. */
  readonly isLatest: boolean;
  /** True when `name === resolved default`. */
  readonly isDefault: boolean;
  /** Reserved aliases resolving to this version (`latest`/`stable`/`dev`). */
  readonly aliases: readonly string[];
  /** Resolved content directory for this version (absolute or as given). */
  readonly dir: string;
}

/** The frozen versioning descriptor over one manifest. */
export interface ContentVersions {
  /** Every version, in manifest order. */
  versions(): readonly ContentVersionInfo[];
  /** Version names in manifest order (no lookup, no sort). */
  names(): readonly string[];
  /** Look up by name or alias. Returns `null` on miss — never throws. */
  forVersion(nameOrAlias: string): ContentVersionInfo | null;
  /** The resolved latest version. */
  latest(): ContentVersionInfo | null;
  /** The resolved default version. */
  defaultVersion(): ContentVersionInfo | null;
  /** The resolved current version. */
  current(): ContentVersionInfo | null;
  /**
   * Pure URL-prefix rule for a version and an in-version slug.
   * latest → `<prefix>/<slug>`; others → `<prefix>/<path>/<slug>`.
   * An empty slug yields the bare version root (no trailing slash).
   */
  versionPath(version: string | ContentVersionInfo, slug: string): string;
  /** Discover and return this version's pages (memoized via discoverContent). */
  pages(version: string | ContentVersionInfo): Promise<readonly ContentPage[]>;
}

/** Options for {@link defineContentVersions}. */
export interface DefineContentVersionsOptions {
  /** The mutable working tree directory (`current`). */
  readonly currentDir: string;
  /** Base directory holding one subdirectory per frozen version. */
  readonly versionsDir: string;
  /** An already-validated manifest (typically from {@link readContentVersions}). */
  readonly manifest: ContentVersionsManifest;
  /** Optional URL prefix for {@link ContentVersions.versionPath} (default `/docs`). */
  readonly prefix?: string;
  /** Incremental cache dir, forwarded to `discoverContent`. */
  readonly cacheDir?: string;
}

// ---------------------------------------------------------------------------
// readContentVersions
// ---------------------------------------------------------------------------

const _manifests = new Map<string, ContentVersionsManifest>();

/**
 * Read, validate, and memoize a version manifest from a JSON file.
 *
 * @throws {ContentError} value-free on any shape/reference violation.
 */
export function readContentVersions(path: string): ContentVersionsManifest {
  const resolved = resolvePath(path);
  const cached = _manifests.get(resolved);
  if (cached) return cached;

  let raw: string;
  try {
    raw = readFileSync(resolved, 'utf8');
  } catch {
    throw new ContentError('versions_unreadable', `Cannot read versions manifest at "${resolved}"`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ContentError(
      'versions_invalid_json',
      `Versions manifest at "${resolved}" is not valid JSON`,
    );
  }

  const manifest = validateManifest(parsed);
  _manifests.set(resolved, manifest);
  return manifest;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** ContentVersionEntry shape: an object with the expected string fields. */
interface RawVersionEntry {
  name?: unknown;
  label?: unknown;
  path?: unknown;
  tag?: unknown;
  banner?: unknown;
  noIndex?: unknown;
  hidden?: unknown;
}

const VALID_BANNERS = new Set(['unreleased', 'unmaintained']);

/**
 * Safe single path segment: starts with alphanumeric, then alnum/dot/underscore/hyphen.
 * Rejects traversal (`..`), hidden (`.`-prefixed), absolute (`/a`), directory (`a/b`),
 * backslash (`a\\b`), and NUL-embedded values — all of which would escape `versionsDir`
 * when interpolated into a path or URL segment.
 */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

function isRecord(input: unknown): input is Record<string, unknown> {
  return input !== null && typeof input === 'object' && !Array.isArray(input);
}

/**
 * Validate a raw JSON payload as a {@link ContentVersionsManifest}.
 *
 * Every violation throws a value-free {@link ContentError}. For entry-level
 * validation errors the message carries the entry index but never the offending
 * value.
 */
function validateManifest(input: unknown): ContentVersionsManifest {
  if (!isRecord(input)) {
    throw new ContentError('versions_invalid_manifest', 'Versions manifest must be an object');
  }

  const current = input.current;
  if (typeof current !== 'string' || current.length === 0) {
    throw new ContentError(
      'versions_invalid_current',
      'Versions manifest "current" must be a non-empty string',
    );
  }

  const versions = input.versions;
  if (!Array.isArray(versions) || versions.length === 0) {
    throw new ContentError(
      'versions_invalid_versions',
      'Versions manifest "versions" must be a non-empty array',
    );
  }

  // Validate each entry.
  const validatedEntries: ContentVersionEntry[] = [];
  const nameSet = new Set<string>();

  for (let i = 0; i < versions.length; i++) {
    const raw = versions[i];
    if (!isRecord(raw)) {
      throw new ContentError(
        'versions_invalid_entry',
        `Versions manifest entry at index ${i} must be an object`,
      );
    }
    const entry = raw as RawVersionEntry;

    if (typeof entry.name !== 'string' || entry.name.length === 0) {
      throw new ContentError(
        'versions_invalid_entry',
        `Versions manifest entry at index ${i} has an invalid "name"`,
      );
    }
    // Reject traversal, absolute, hidden, and non-segment values (name forms a
    // directory path in `defineContentVersions`, path forms a URL segment).
    if (!SAFE_SEGMENT.test(entry.name)) {
      throw new ContentError(
        'versions_invalid_name',
        `Versions manifest entry at index ${i} has an unsafe "name"`,
      );
    }
    if (typeof entry.label !== 'string' || entry.label.length === 0) {
      throw new ContentError(
        'versions_invalid_entry',
        `Versions manifest entry at index ${i} has an invalid "label"`,
      );
    }
    if (typeof entry.path !== 'string' || entry.path.length === 0) {
      throw new ContentError(
        'versions_invalid_entry',
        `Versions manifest entry at index ${i} has an invalid "path"`,
      );
    }
    if (!SAFE_SEGMENT.test(entry.path)) {
      throw new ContentError(
        'versions_invalid_path',
        `Versions manifest entry at index ${i} has an unsafe "path"`,
      );
    }

    if (nameSet.has(entry.name)) {
      throw new ContentError('versions_duplicate_name', `Duplicate version name at index ${i}`);
    }
    nameSet.add(entry.name);

    // `tag` when present must be a non-empty string.
    let tag: string | undefined;
    if (entry.tag === undefined) {
      tag = undefined;
    } else if (typeof entry.tag !== 'string' || entry.tag.length === 0) {
      throw new ContentError(
        'versions_invalid_tag',
        `Versions manifest entry at index ${i} has an invalid "tag"`,
      );
    } else {
      tag = entry.tag;
    }

    // `banner` when present must be exactly 'unreleased' or 'unmaintained'.
    let banner: 'unreleased' | 'unmaintained' | undefined;
    if (entry.banner === undefined) {
      banner = undefined;
    } else if (typeof entry.banner !== 'string' || !VALID_BANNERS.has(entry.banner)) {
      throw new ContentError(
        'versions_invalid_banner',
        `Versions manifest entry at index ${i} has an invalid "banner"`,
      );
    } else {
      banner = entry.banner as 'unreleased' | 'unmaintained';
    }

    // `noIndex` / `hidden` when present must be booleans.
    let noIndex: boolean | undefined;
    if (entry.noIndex === undefined) {
      noIndex = undefined;
    } else if (typeof entry.noIndex !== 'boolean') {
      throw new ContentError(
        'versions_invalid_flag',
        `Versions manifest entry at index ${i} has an invalid "noIndex"`,
      );
    } else {
      noIndex = entry.noIndex;
    }

    let hidden: boolean | undefined;
    if (entry.hidden === undefined) {
      hidden = undefined;
    } else if (typeof entry.hidden !== 'boolean') {
      throw new ContentError(
        'versions_invalid_flag',
        `Versions manifest entry at index ${i} has an invalid "hidden"`,
      );
    } else {
      hidden = entry.hidden;
    }

    validatedEntries.push(
      Object.freeze({
        name: entry.name,
        label: entry.label,
        path: entry.path,
        tag,
        banner,
        noIndex,
        hidden,
      }),
    );
  }

  // `current` must reference an existing name.
  if (!nameSet.has(current)) {
    throw new ContentError(
      'versions_unknown_reference',
      'manifest "current" references an unknown version',
    );
  }

  let latest: string | undefined;
  const latestRaw = input.latest;
  if (latestRaw === undefined) {
    latest = undefined;
  } else {
    if (typeof latestRaw !== 'string' || latestRaw.length === 0) {
      throw new ContentError(
        'versions_unknown_reference',
        'Versions manifest "latest" must be a non-empty string',
      );
    }
    if (!nameSet.has(latestRaw)) {
      throw new ContentError(
        'versions_unknown_reference',
        'manifest "latest" references an unknown version',
      );
    }
    latest = latestRaw;
  }

  let defaultVersion: string | undefined;
  const defaultRaw = input.default;
  if (defaultRaw === undefined) {
    defaultVersion = undefined;
  } else {
    if (typeof defaultRaw !== 'string' || defaultRaw.length === 0) {
      throw new ContentError(
        'versions_unknown_reference',
        'Versions manifest "default" must be a non-empty string',
      );
    }
    if (!nameSet.has(defaultRaw)) {
      throw new ContentError(
        'versions_unknown_reference',
        'manifest "default" references an unknown version',
      );
    }
    defaultVersion = defaultRaw;
  }

  return Object.freeze({
    current,
    latest,
    default: defaultVersion,
    versions: Object.freeze(validatedEntries),
  });
}

// ---------------------------------------------------------------------------
// defineContentVersions
// ---------------------------------------------------------------------------

/**
 * Build a frozen versioning descriptor from a validated manifest.
 *
 * `discoverContent` is called lazily by `pages()`, not eagerly — so only the
 * version(s) actually rendered trigger content discovery.
 */
export async function defineContentVersions(
  options: DefineContentVersionsOptions,
): Promise<ContentVersions> {
  const manifest = options.manifest;
  // Re-validate defensively so an inline hand-built manifest cannot bypass
  // validation.
  const validated = validateManifest(manifest);

  const prefix = normalizePrefix(options.prefix ?? '/docs');
  const latestName = validated.latest ?? validated.current;
  const defaultName = validated.default ?? validated.current;

  const infos: ContentVersionInfo[] = validated.versions.map((entry) => {
    const isCurrent = entry.name === validated.current;
    const isLatest = entry.name === latestName;
    const isDefault = entry.name === defaultName;
    const banner = entry.banner ?? deriveBanner(validated, entry.name, latestName);
    const aliases: string[] = [];
    if (isLatest) aliases.push('latest', 'stable');
    if (isCurrent) aliases.push('dev');
    return Object.freeze({
      name: entry.name,
      label: entry.label,
      path: entry.path,
      tag: entry.tag,
      banner,
      noIndex: entry.noIndex === true,
      hidden: entry.hidden === true,
      isCurrent,
      isLatest,
      isDefault,
      aliases: Object.freeze(aliases),
      dir: isCurrent ? options.currentDir : resolvePath(options.versionsDir, entry.name),
    });
  });

  const byName = new Map(infos.map((i) => [i.name, i] as const));
  const byAlias = new Map<string, ContentVersionInfo>();
  for (const info of infos) {
    for (const a of info.aliases) {
      byAlias.set(a, info);
    }
  }

  const resolveInfo = (v: string | ContentVersionInfo): ContentVersionInfo | null =>
    typeof v === 'string' ? (byName.get(v) ?? byAlias.get(v) ?? null) : v;

  const descriptor: ContentVersions = {
    versions: () => infos,
    names: () => namesFrozen,
    forVersion: (n) => byName.get(n) ?? byAlias.get(n) ?? null,
    latest: () => byName.get(latestName) ?? null,
    defaultVersion: () => byName.get(defaultName) ?? null,
    current: () => byName.get(validated.current) ?? null,
    versionPath(version, slug) {
      const info = resolveInfo(version);
      if (info === null) {
        throw new ContentError('versions_unknown_version', 'Unknown version in versionPath');
      }
      const cleanSlug = normalizeSlug(slug);
      const base = info.isLatest ? prefix : `${prefix}/${info.path}`;
      return cleanSlug.length === 0 ? base : `${base}/${cleanSlug}`;
    },
    async pages(version) {
      const info = resolveInfo(version);
      if (info === null) {
        throw new ContentError('versions_unknown_version', 'Unknown version in pages');
      }
      const collection = await discoverContent(info.dir, { cacheDir: options.cacheDir });
      return collection.pages;
    },
  };

  Object.freeze(infos);
  const namesFrozen = Object.freeze(infos.map((i) => i.name));
  return Object.freeze(descriptor);
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Derive a banner from manifest position relative to `latest`.
 *
 * Versions listed before `latest` → `'unreleased'`; after → `'unmaintained'`;
 * `latest` itself → `undefined`.
 */
function deriveBanner(
  manifest: ContentVersionsManifest,
  name: string,
  latestName: string,
): 'unreleased' | 'unmaintained' | undefined {
  let nameIdx = -1;
  let latestIdx = -1;
  for (let i = 0; i < manifest.versions.length; i++) {
    const entry = manifest.versions[i];
    if (entry === undefined) continue;
    if (entry.name === name) nameIdx = i;
    if (entry.name === latestName) latestIdx = i;
  }
  if (nameIdx < latestIdx) return 'unreleased';
  if (nameIdx > latestIdx) return 'unmaintained';
  return undefined;
}

/** Ensure a leading `/`, strip trailing `/`, reject empty strings. */
function normalizePrefix(p: string): string {
  if (p.length === 0) {
    throw new ContentError('versions_invalid_prefix', 'Version prefix must not be empty');
  }
  let normalized = p.startsWith('/') ? p : `/${p}`;
  while (normalized.endsWith('/') && normalized.length > 1) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

/** Trim, strip leading `/`, collapse duplicate `/`, strip trailing `/`. */
function normalizeSlug(s: string): string {
  let result = s.trim();
  while (result.startsWith('/')) result = result.slice(1);
  while (result.endsWith('/')) result = result.slice(0, -1);
  // Collapse duplicate slashes.
  while (result.includes('//')) result = result.replace('//', '/');
  return result;
}
