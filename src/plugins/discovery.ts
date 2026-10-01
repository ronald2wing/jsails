/**
 * Two-source plugin discovery (manifests only; no code execution).
 *
 * `discoverPlugins` walks the two supported origins without importing any plugin
 * code: the direct npm `dependencies` of the app package (each dependency that
 * self-identifies through its own `package.json` `jsails` field — installing a
 * plugin is activating it) and the storage-backed plugins folder (each
 * `manifest.json` bundle). A dependency-source plugin is then walked
 * transitively: each plugin's own `package.json` `dependencies` are resolved
 * Node-style from the plugin's directory (walking up toward `rootDir` but never
 * beyond), and any resolved package that self-identifies as a JSails plugin is
 * discovered recursively. The result is a sorted, provenance-tagged plugin list
 * plus a list of non-fatal `issues` (missing/unreadable/invalid manifests, a
 * missing transitive dependency, a dependency cycle, conflicting versions of one
 * id, or an enabled plugin requiring a disabled id) and the directed
 * plugin-to-plugin dependency `edges`. The opt-out list (`jsails.plugins.disabled`
 * plus the explicit `disabled` option) removes a plugin by id before it is
 * reported, pruning descendants owned exclusively by disabled roots; a descendant
 * still reachable from an enabled root survives. When the explicit `enabled`
 * allow-list option is provided, discovery becomes opt-in: only listed ids are
 * activated, a discovered id not in the list is skipped, and a listed id that is
 * not installed is reported as an `enabled_plugin_missing` issue. `disabled`
 * still wins over `enabled`. Callers that wire plugin activation must pass the
 * same `enabled` list so activation matches discovery; omitting it keeps every
 * discovered plugin active (the historical opt-out-only behavior). Ambiguous or
 * conflicting ids are hard errors (a thrown {@link PluginDiscoveryError}), never
 * silently dropped.
 *
 * Discovery is synchronous and filesystem-only: it reads `package.json` and
 * `manifest.json` files through an injectable fs facade, follows no symlinks,
 * and never evaluates a module.
 *
 * The implementation is split so each concern is self-contained:
 * `discovery/scan.ts` owns the filesystem scanning/resolution and the result
 * model, `discovery/validate.ts` owns manifest/bundle validation, and
 * `discovery/dependencies.ts` owns the transitive walk, cycle detection, and
 * conflict resolution. This barrel owns the public surface and the orchestration.
 */

import { join } from 'node:path';

import {
  DEFAULT_PLUGINS_DIR,
  PluginDiscoveryError,
  defaultFs,
  discoverDirectDependencies,
  readAppPackage,
  type DiscoveredPlugin,
  type DiscoverPluginsOptions,
  type DiscoverPluginsResult,
  type PluginEdge,
  type PluginIssue,
  type SkippedPlugin,
  type SkippedPluginReason,
} from './discovery/scan.js';
import {
  collectConflictingVersions,
  collectDisabledRequired,
  discoverTransitiveDependencies,
  finalizeDependencyPlugin,
  reachableFromEnabledRoots,
  splitEdgeKey,
} from './discovery/dependencies.js';
import { discoverBundles } from './discovery/validate.js';

export {
  DEFAULT_PLUGINS_DIR,
  PluginDiscoveryError,
  type DiscoveredPlugin,
  type DiscoverPluginsOptions,
  type DiscoverPluginsResult,
  type PluginDirent,
  type PluginDiscoveryErrorCode,
  type PluginEdge,
  type PluginFs,
  type PluginIssue,
  type SkippedPlugin,
  type SkippedPluginReason,
} from './discovery/scan.js';

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Discover plugins from both sources, plus the transitive plugin-to-plugin
 * dependency graph. See the module doc for the exact semantics. Throws
 * {@link PluginDiscoveryError} for a conflicting id/version; everything else
 * (missing/unreadable/invalid manifests, a malformed opt-out list, a missing
 * transitive dependency) is reported as an issue and the plugin is simply
 * omitted.
 */
export function discoverPlugins(options: DiscoverPluginsOptions): DiscoverPluginsResult {
  const fs = options.fs ?? defaultFs;
  const rootDir = options.rootDir;
  const pluginsDir = options.pluginsDir ?? join(rootDir, DEFAULT_PLUGINS_DIR);
  const packageJsonPath = options.packageJsonPath ?? join(rootDir, 'package.json');

  const appPackage = readAppPackage(fs, packageJsonPath);
  const disabled = new Set<string>([...(options.disabled ?? []), ...appPackage.disabled]);

  const issues: PluginIssue[] = [];

  const direct = discoverDirectDependencies(fs, rootDir, appPackage.dependencies, issues);
  const edges = new Set<string>();
  const transitive = discoverTransitiveDependencies(fs, rootDir, direct, issues, edges);

  const bundles: DiscoveredPlugin[] = [];
  discoverBundles(fs, pluginsDir, bundles, issues);

  const plugins: DiscoveredPlugin[] = [
    ...direct.map(finalizeDependencyPlugin),
    ...transitive.map(finalizeDependencyPlugin),
    ...bundles,
  ];

  // Prune disabled ids plus descendants owned exclusively by disabled roots; a
  // descendant also reachable from an enabled root survives.
  const reachable = reachableFromEnabledRoots(plugins, edges, disabled);
  const enabled = plugins.filter((plugin) => !disabled.has(plugin.id) && reachable.has(plugin.id));

  // Apply the explicit enable allow-list (when present) on top of the disabled
  // pruning, tracking every excluded id with its reason.
  const enabledList = normalizeEnabledList(options.enabled);
  let active = enabled;
  let skipped: SkippedPlugin[] | undefined;
  if (enabledList !== undefined) {
    const enabledIds = new Set(enabledList);
    const skippedById = new Map<string, SkippedPlugin>();

    // Disabled wins: a disabled id is skipped even when also listed in
    // `enabled`.
    for (const plugin of plugins) {
      if (disabled.has(plugin.id)) {
        skippedById.set(skippedKey(plugin.id, 'disabled'), {
          id: plugin.id,
          reason: 'disabled',
        });
      }
    }

    // A reachable, non-disabled plugin not in the allow-list is skipped
    // without a per-plugin issue.
    for (const plugin of enabled) {
      if (!enabledIds.has(plugin.id)) {
        skippedById.set(skippedKey(plugin.id, 'not-enabled'), {
          id: plugin.id,
          reason: 'not-enabled',
        });
      }
    }

    // A listed id that is not installed at all is missing.
    const discoveredIds = new Set(plugins.map((plugin) => plugin.id));
    const missing = enabledList.filter((id) => !discoveredIds.has(id)).sort();
    for (const id of missing) {
      skippedById.set(skippedKey(id, 'missing'), {
        id,
        reason: 'missing',
      });
      issues.push({
        source: 'package',
        code: 'enabled_plugin_missing',
        message: `enabled plugin "${id}" is not installed`,
        pluginId: id,
      });
    }

    active = enabled.filter((plugin) => enabledIds.has(plugin.id));
    skipped = [...skippedById.values()];
  }

  collectDisabledRequired(edges, active, disabled, issues);
  collectConflictingVersions(active, issues);
  assertUnique(active);

  return {
    plugins: sortPlugins(active),
    issues,
    edges: sortEdges(edges),
    ...(skipped === undefined ? {} : { skipped: sortSkipped(skipped) }),
  };
}

/** Assert the uniqueness invariants across all enabled plugins. */
function assertUnique(plugins: readonly DiscoveredPlugin[]): void {
  const dependencyKeys = new Map<string, string>();
  const bundleVersions = new Map<string, string>();
  const allIds = new Map<string, DiscoveredPlugin>();

  for (const plugin of plugins) {
    const key = `${plugin.id}\u0000${plugin.version}`;
    if (plugin.source === 'dependency') {
      const existing = dependencyKeys.get(key);
      if (existing !== undefined) {
        throw new PluginDiscoveryError(
          'duplicate_dependency_id',
          `plugin id "${plugin.id}" is declared by both "${existing}" and "${plugin.packageName ?? ''}"`,
        );
      }
      dependencyKeys.set(key, plugin.packageName ?? '');
    } else {
      const existing = bundleVersions.get(key);
      if (existing !== undefined) {
        throw new PluginDiscoveryError(
          'duplicate_bundle_version',
          `plugin id "${plugin.id}" version "${plugin.version}" appears in more than one bundle`,
        );
      }
      bundleVersions.set(key, plugin.bundleDir ?? '');
    }

    const previous = allIds.get(plugin.id);
    if (previous !== undefined && previous.source !== plugin.source) {
      throw new PluginDiscoveryError(
        'duplicate_cross_source',
        `plugin id "${plugin.id}" is present in both the dependency and bundle sources`,
      );
    }
    allIds.set(plugin.id, plugin);
  }
}

/** Sort edges by (from, to) for a deterministic result. */
function sortEdges(edges: ReadonlySet<string>): PluginEdge[] {
  return [...edges]
    .map(splitEdgeKey)
    .sort((a, b) =>
      a.from !== b.from ? (a.from < b.from ? -1 : 1) : a.to < b.to ? -1 : a.to > b.to ? 1 : 0,
    );
}

/** Sort plugins by id, then version string, then source. */
function sortPlugins(plugins: readonly DiscoveredPlugin[]): readonly DiscoveredPlugin[] {
  return [...plugins].sort((a, b) => {
    if (a.id !== b.id) return a.id < b.id ? -1 : 1;
    if (a.version !== b.version) return a.version < b.version ? -1 : 1;
    return a.source < b.source ? -1 : a.source > b.source ? 1 : 0;
  });
}

/** Normalize the explicit enable allow-list, dropping empty and duplicate ids. */
function normalizeEnabledList(
  enabled: readonly string[] | undefined,
): readonly string[] | undefined {
  if (enabled === undefined) {
    return undefined;
  }
  return [...new Set(enabled.filter((id) => id.length > 0))];
}

/** Stable dedupe key for a skipped plugin id plus reason. */
function skippedKey(id: string, reason: SkippedPluginReason): string {
  return `${id}\u0000${reason}`;
}

/** Sort skipped plugins by id, then reason, for a deterministic result. */
function sortSkipped(skipped: readonly SkippedPlugin[]): SkippedPlugin[] {
  return [...skipped].sort((a, b) => {
    if (a.id !== b.id) return a.id < b.id ? -1 : 1;
    return a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0;
  });
}
