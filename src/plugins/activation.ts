/**
 * Plugin activation: turn discovery + enablement into loaded plugin objects.
 *
 * `activatePlugins` is the slice that finally imports plugin code. It folds the
 * two earlier slices together: it resolves which plugin ids are enabled through
 * {@link loadPluginEnablement} (the managed/non-managed switch — a non-managed
 * deployment performs **zero** state-source I/O), passes that list to
 * {@link discoverPlugins} as the `enabled` allow-list so discovery and
 * activation agree on exactly which plugins are active, then, for each active
 * discovered plugin, resolves its entry module and dynamically imports it.
 *
 * Importing a plugin module **executes trusted plugin code**: a plugin's
 * top-level module body runs at import time. The plugin's `setup` is **not**
 * called here — activation only loads and structurally validates the exported
 * object(s); {@link runExtensions} (or `createApplication`) runs `setup` later,
 * in priority order, against a per-application service registry.
 *
 * A plugin module's default export must be a {@link JsailsPlugin} or an array of
 * them (validated structurally: an object with a non-empty string `name` and a
 * function `setup`). The array is flattened and each entry is validated; a
 * module may instead carry the array under a `plugins` named export, which is
 * accepted when the default export is absent. The default export takes
 * precedence when both are present — that choice is reported here by convention,
 * not by any result field. A failed import or an invalid export yields a
 * `plugin_load_failed` issue (value-free; module contents are never echoed) and
 * that plugin is skipped without aborting the rest. The result is deterministic:
 * plugins are ordered by id, and duplicates across sources already error during
 * discovery.
 *
 * ## Entry resolution
 *
 * A plugin's manifest `entry` may be a relative path (resolved against the
 * package directory) or a bare module specifier (imported directly via
 * `import(specifier)`). {@link isBareSpecifier} distinguishes the two forms.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { JsailsPlugin } from '../extensions/plugin-contract.js';
import {
  discoverPlugins,
  type DiscoveredPlugin,
  type PluginIssue,
  type SkippedPlugin,
} from './discovery.js';
import { loadPluginEnablement } from './database-state-store.js';
import type { PluginStateSource } from './state-store.js';

/** Inputs to {@link activatePlugins}. */
export interface ActivatePluginsInput {
  /** Project root; `node_modules` and the plugins folder resolve under it. */
  readonly rootDir: string;
  /** Plugin ids enabled in the app config (`plugins.enabled`). */
  readonly codeEnabled?: readonly string[];
  /** Whether plugin state is managed in the database. Defaults to `false`. */
  readonly managed?: boolean;
  /** The state source for a managed deployment. Required when `managed` is true. */
  readonly stateSource?: PluginStateSource;
  /** Storage-backed plugins folder. Defaults to `<rootDir>/storage/plugins`. */
  readonly pluginsDir?: string;
}

/** The result of activation: loaded plugins plus every skipped id and issue. */
export interface ActivatePluginsResult {
  /** Loaded plugins, ordered deterministically by id. `setup` is never called. */
  readonly plugins: readonly JsailsPlugin[];
  /** Plugins excluded from activation, with the reason each was skipped. */
  readonly skipped: readonly SkippedPlugin[];
  /** Discovery issues followed by activation (`plugin_load_failed`) issues. */
  readonly issues: readonly PluginIssue[];
}

/**
 * Discover, resolve, and import the enabled plugins. See the module doc for the
 * exact contract. Throws the discovery `PluginDiscoveryError` for a conflicting
 * id/version (never silently dropped); a per-plugin import or export failure is
 * reported as an issue, never thrown.
 */
export async function activatePlugins(input: ActivatePluginsInput): Promise<ActivatePluginsResult> {
  const enablement = await loadPluginEnablement({
    codeEnabled: input.codeEnabled,
    managed: input.managed,
    stateSource: input.stateSource,
  });

  const discovery = discoverPlugins({
    rootDir: input.rootDir,
    pluginsDir: input.pluginsDir,
    enabled: enablement.enabled,
  });

  const issues: PluginIssue[] = [...discovery.issues];
  const plugins: JsailsPlugin[] = [];

  for (const plugin of discovery.plugins) {
    const specifier = entrySpecifier(plugin);
    let namespace: unknown;
    try {
      if (isBareSpecifier(specifier)) {
        namespace = await import(specifier);
      } else {
        const entryPath = resolveEntryPath(plugin);
        namespace = await import(pathToFileURL(entryPath).href);
      }
    } catch {
      issues.push(loadFailure(plugin, specifier));
      continue;
    }
    const extracted = extractPlugins(namespace);
    if (extracted === undefined) {
      issues.push(loadFailure(plugin, specifier));
      continue;
    }
    plugins.push(...extracted);
  }

  return {
    plugins: sortPlugins(plugins),
    skipped: discovery.skipped ?? [],
    issues,
  };
}

/**
 * Resolve the absolute path of a discovered plugin's entry module. A
 * dependency-source plugin's entry is its manifest `entry` resolved against its
 * package directory; a bundle's entry is resolved against its bundle directory.
 */
function resolveEntryPath(plugin: DiscoveredPlugin): string {
  const specifier = entrySpecifier(plugin);
  if (plugin.source === 'bundle') {
    return resolve(plugin.bundleDir ?? dirname(plugin.manifestPath), specifier);
  }
  return resolve(dependencyPackageDir(plugin), specifier);
}

/**
 * Whether an entry specifier is a bare module specifier (not a relative or
 * absolute file path). A bare specifier (e.g. `jsails/auth`, `@acme/blog`,
 * `pkg`) is imported directly via `import(specifier)` — Node resolves it
 * through `node_modules` from the importing module's location. A relative
 * path (`./`, `../`), a POSIX absolute path (`/`), or a Windows drive-letter
 * path (`C:\`, `D:/`) returns false and is resolved as a file path against the
 * plugin's package directory.
 */
export function isBareSpecifier(entry: string): boolean {
  if (entry.startsWith('./') || entry.startsWith('../') || entry.startsWith('/')) {
    return false;
  }
  if (/^[A-Za-z]:[\\/]/.test(entry)) {
    return false;
  }
  return true;
}

/**
 * The package directory of a dependency-source plugin. `manifestPath` is the
 * `package.json` discovery resolved (its walk never leaves `rootDir`), so its
 * directory is the exact package location — correct for a hoisted or nested
 * transitive dependency alike. This reuses discovery's recorded resolution (the
 * resolver itself is not exported); the equivalent manual form is
 * `<rootDir>/node_modules/<name>`, bounded to `rootDir`.
 */
function dependencyPackageDir(plugin: DiscoveredPlugin): string {
  return dirname(plugin.manifestPath);
}

/**
 * The entry module specifier for a plugin. Primary is the manifest `entry` (the
 * `jsails.entry` field); when it is somehow empty, fall back to the package's
 * `exports`/`main`. The manifest schema requires `entry`, so the fallback is
 * defensive only and reads the `package.json` through the manifest path.
 */
function entrySpecifier(plugin: DiscoveredPlugin): string {
  if (plugin.manifest.entry !== '') {
    return plugin.manifest.entry;
  }
  return fallbackEntry(plugin);
}

/** Recover an entry specifier from the package.json `exports`/`main` fields. */
function fallbackEntry(plugin: DiscoveredPlugin): string {
  let raw: string;
  try {
    raw = readFileSync(plugin.manifestPath, 'utf8');
  } catch {
    return '';
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return '';
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return '';
  }
  const record = parsed as Record<string, unknown>;
  const fromExports = stringFromExports(record['exports']);
  if (fromExports !== undefined) {
    return fromExports;
  }
  const main = record['main'];
  return typeof main === 'string' ? main : '';
}

/** A string `exports` value, or the first string under a conventional subpath. */
function stringFromExports(value: unknown): string | undefined {
  if (typeof value === 'string' && value !== '') {
    return value;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const key of ['.', 'import', 'default', 'require', 'node']) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate !== '') {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Extract plugin(s) from an imported module namespace. The default export wins
 * when present (as a plugin or an array of plugins, flattened); otherwise the
 * `plugins` named export is tried. Returns `undefined` when neither yields a
 * valid plugin list.
 */
function extractPlugins(namespace: unknown): JsailsPlugin[] | undefined {
  const record = namespace as Record<string, unknown>;
  const fromDefault = normalizeExport(record['default']);
  if (fromDefault !== undefined) {
    return fromDefault;
  }
  return normalizeExport(record['plugins']);
}

/** Normalize an export value into a validated plugin list, or `undefined`. */
function normalizeExport(value: unknown): JsailsPlugin[] | undefined {
  if (Array.isArray(value)) {
    const flattened = value.flat();
    return flattened.every(isPlugin) ? flattened : undefined;
  }
  return isPlugin(value) ? [value] : undefined;
}

/** Structural plugin check: an object with a non-empty string `name` and a `setup`. */
function isPlugin(value: unknown): value is JsailsPlugin {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record['name'] === 'string' &&
    record['name'].trim() !== '' &&
    typeof record['setup'] === 'function'
  );
}

/** A value-free activation failure issue; module contents are never echoed. */
function loadFailure(plugin: DiscoveredPlugin, entryPath: string): PluginIssue {
  return {
    source: plugin.source,
    code: 'plugin_load_failed',
    message: `plugin "${plugin.id}" failed to load`,
    path: entryPath,
    pluginId: plugin.id,
  };
}

/** Order plugins deterministically by id (the extension `name`). */
function sortPlugins(plugins: readonly JsailsPlugin[]): JsailsPlugin[] {
  return [...plugins].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
