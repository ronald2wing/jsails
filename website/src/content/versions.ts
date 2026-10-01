/**
 * Docs version source of truth.
 *
 * `versions.json` is the single, ordered list of released docs minor versions
 * (newest first) plus the "current" minor that maps to `/docs/<slug>` (the
 * latest release). This module reads and validates that file; the content
 * pipeline, route generator, and the layout dropdown all consume it.
 *
 * @see content/versions.json
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve as resolvePath } from 'node:path';

/** A released docs version, labelled by its numeric minor (e.g. `1.0`). */
export interface DocsVersion {
  /** The version label as it appears in URLs and the dropdown. */
  readonly label: string;
}

/** The parsed, validated version manifest. */
export interface DocsVersionManifest {
  /** The "latest release" minor served at `/docs/<slug>` and `/docs`. */
  readonly current: string;
  /** All released minors, newest first. `current` is always the first entry. */
  readonly versions: readonly DocsVersion[];
}

const MINOR_PATTERN = /^\d+\.\d+$/;

function resolveVersionsPath(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = __filename.slice(0, __filename.lastIndexOf('/'));
  // compiled: website/dist/src/content/versions.js
  // source:   website/src/content/versions.ts
  return resolvePath(__dirname, '..', '..', '..', 'content', 'versions.json');
}

let _manifest: DocsVersionManifest | null = null;

/**
 * Read and validate `versions.json`, memoized. Throws a value-free error when
 * the file is malformed so a bad release freeze fails the build loudly.
 */
export function readDocsVersions(): DocsVersionManifest {
  if (_manifest) return _manifest;

  const raw = readFileSync(resolveVersionsPath(), 'utf8');
  const parsed = JSON.parse(raw) as { current?: unknown; versions?: unknown };

  if (typeof parsed.current !== 'string' || !MINOR_PATTERN.test(parsed.current)) {
    throw new Error('versions.json "current" must be a numeric minor like "1.0"');
  }
  if (!Array.isArray(parsed.versions) || parsed.versions.length === 0) {
    throw new Error('versions.json "versions" must be a non-empty array');
  }

  const versions = parsed.versions.map((label, i) => {
    if (typeof label !== 'string' || !MINOR_PATTERN.test(label)) {
      throw new Error(`versions.json "versions[${i}]" must be a numeric minor`);
    }
    return { label };
  });

  if (versions[0].label !== parsed.current) {
    throw new Error('versions.json "current" must equal the newest entry in "versions"');
  }

  _manifest = Object.freeze({ current: parsed.current, versions: Object.freeze(versions) });
  return _manifest;
}
