/**
 * Manifest and bundle validation.
 *
 * This slice turns raw JSON into validated {@link PluginManifest}s and discovers
 * bundles from the storage-backed plugins folder. It never walks the dependency
 * graph — that is {@link ./scan.js} and {@link ./dependencies.js} — and it never
 * imports a module or opens a connection. Manifest shape validation is delegated
 * to {@link parsePluginManifest}; this slice only records value-free issues and
 * decides whether a plugin is omitted or admitted.
 */

import { dirname, join } from 'node:path';

import {
  parsePluginManifest,
  PLUGIN_MANIFEST_FILENAME,
  PluginManifestError,
  type PluginManifest,
  type PluginManifestIssue,
} from '../manifest.js';

import type { DiscoveredPlugin, PluginDirent, PluginFs, PluginIssue } from './scan.js';

/**
 * Parse a raw `jsails` manifest value into a {@link PluginManifest}, recording a
 * value-free `invalid_manifest` issue on failure. Returns `undefined` when the
 * manifest is invalid (the plugin is omitted).
 */
export function parseDependencyManifest(
  raw: unknown,
  manifestPath: string,
  issues: PluginIssue[],
): PluginManifest | undefined {
  try {
    return parsePluginManifest(raw);
  } catch (error) {
    const message =
      error instanceof PluginManifestError ? formatManifestIssues(error) : 'invalid manifest';
    issues.push({
      source: 'dependency',
      code: 'invalid_manifest',
      message,
      path: manifestPath,
      pluginId: readManifestId(raw),
    });
    return undefined;
  }
}

/**
 * Discover plugins from the storage-backed plugins folder. Every `manifest.json`
 * found under the folder (recursively) is a bundle rooted at its directory;
 * symlinks are never followed.
 */
export function discoverBundles(
  fs: PluginFs,
  pluginsDir: string,
  plugins: DiscoveredPlugin[],
  issues: PluginIssue[],
): void {
  walkBundleDir(fs, pluginsDir, plugins, issues);
}

function walkBundleDir(
  fs: PluginFs,
  dir: string,
  plugins: DiscoveredPlugin[],
  issues: PluginIssue[],
): void {
  let entries: readonly PluginDirent[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    // A missing plugins folder is an empty bundle set, not an error.
    return;
  }
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of sorted) {
    if (entry.isSymbolicLink()) {
      continue;
    }
    if (entry.isDirectory()) {
      walkBundleDir(fs, join(dir, entry.name), plugins, issues);
      continue;
    }
    if (entry.isFile() && entry.name === PLUGIN_MANIFEST_FILENAME) {
      const manifestPath = join(dir, entry.name);
      let raw: string;
      try {
        raw = fs.readFileSync(manifestPath);
      } catch {
        issues.push({
          source: 'bundle',
          code: 'manifest_unreadable',
          message: 'bundle manifest could not be read',
          path: manifestPath,
        });
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        issues.push({
          source: 'bundle',
          code: 'invalid_manifest',
          message: 'bundle manifest is not valid JSON',
          path: manifestPath,
        });
        continue;
      }
      addBundlePlugin(plugins, issues, parsed, manifestPath);
    }
  }
}

/**
 * Parse a raw bundle manifest into a discovered plugin, recording an issue (with
 * value-free details) on failure. Bundles stay opaque to the dependency graph:
 * they are never `root`, never required by a plugin, and carry no provenance.
 */
function addBundlePlugin(
  plugins: DiscoveredPlugin[],
  issues: PluginIssue[],
  raw: unknown,
  manifestPath: string,
): void {
  let manifest: PluginManifest;
  try {
    manifest = parsePluginManifest(raw);
  } catch (error) {
    const message =
      error instanceof PluginManifestError ? formatManifestIssues(error) : 'invalid manifest';
    issues.push({
      source: 'bundle',
      code: 'invalid_manifest',
      message,
      path: manifestPath,
      pluginId: readManifestId(raw),
    });
    return;
  }
  plugins.push({
    id: manifest.id,
    version: manifest.version,
    source: 'bundle',
    manifest,
    manifestPath,
    bundleDir: dirname(manifestPath),
    root: false,
    requiredBy: [],
    provenanceChain: [],
  });
}

/** Extract a best-effort plugin id from a raw manifest for issue attribution. */
function readManifestId(raw: unknown): string | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }
  const id = (raw as Record<string, unknown>)['id'];
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

/** Render a value-free summary of the manifest issues (never raw values). */
function formatManifestIssues(error: PluginManifestError): string {
  return `invalid plugin manifest: ${error.issues.map(renderIssue).join('; ')}`;
}

function renderIssue(issue: PluginManifestIssue): string {
  const location = issue.path.length > 0 ? issue.path.join('.') : '(manifest)';
  return `${location}: ${issue.message}`;
}
