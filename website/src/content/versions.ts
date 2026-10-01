/**
 * Docs version source of truth — a thin adapter over `jsails/content`.
 *
 * The framework primitive owns manifest reading/validation and the
 * current/latest/default resolution. This module keeps the site's legacy
 * `{ current, versions: [{ label }] }` shape so `layout.tsx` and the docs
 * pages stay byte-compatible, and so `build(version?)` keeps its semantics.
 */
import { fileURLToPath } from 'node:url';
import { resolve as resolvePath } from 'node:path';
import { readContentVersions } from 'jsails/content';

export interface DocsVersion {
  readonly label: string;
}

export interface DocsVersionManifest {
  readonly current: string;
  readonly versions: readonly DocsVersion[];
}

function resolveVersionsPath(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = __filename.slice(0, __filename.lastIndexOf('/'));
  return resolvePath(__dirname, '..', '..', '..', 'content', 'versions.json');
}

export function readDocsVersions(): DocsVersionManifest {
  const manifest = readContentVersions(resolveVersionsPath());
  return Object.freeze({
    current: manifest.current,
    versions: Object.freeze(manifest.versions.map((v) => Object.freeze({ label: v.name }))),
  });
}
