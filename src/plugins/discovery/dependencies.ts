/**
 * Transitive dependency resolution, cycle detection, and conflict reporting.
 *
 * This slice walks each direct dependency plugin's own `dependencies` map to
 * discover plugins transitively, records the directed plugin-to-plugin edges,
 * and reports non-fatal problems (a missing transitive dependency, a dependency
 * cycle, conflicting versions of one id, an enabled plugin requiring a disabled
 * id). It also computes the set of plugin ids reachable from enabled roots so a
 * disabled root prunes its exclusively-owned descendants. It never imports a
 * module or opens a connection.
 */

import { join } from 'node:path';

import {
  readDependencies,
  readJsailsField,
  resolveInstalledPackage,
  type DependencyPlugin,
  type DiscoveredPlugin,
  type PluginEdge,
  type PluginFs,
  type PluginIssue,
} from './scan.js';
import { parseDependencyManifest } from './validate.js';

/**
 * Traverse the transitive dependency graph of the direct dependency plugins.
 * Each plugin's `dependencies` are resolved Node-style from its own directory;
 * a resolved package that self-identifies as a JSails plugin is added (or merged
 * into an existing entry) and recursed into. Non-plugin dependencies are
 * ignored, a missing resolved target emits `transitive_dependency_missing`, and
 * each plugin-to-plugin dependency records one directed edge. Revisiting a plugin
 * id already on the current root-to-here path emits `dependency_cycle` and stops
 * that edge. The same id + version reached via multiple parents merges into a
 * single entry, unioning `requiredBy` and the provenance chain.
 */
export function discoverTransitiveDependencies(
  fs: PluginFs,
  rootDir: string,
  direct: readonly DependencyPlugin[],
  issues: PluginIssue[],
  edges: Set<string>,
): DependencyPlugin[] {
  const directKeys = new Set(direct.map((plugin) => pluginKey(plugin.id, plugin.version)));
  const transitive = new Map<string, DependencyPlugin>();
  for (const plugin of direct) {
    expandTransitiveDependencies(
      fs,
      rootDir,
      plugin,
      directKeys,
      transitive,
      edges,
      issues,
      new Set([plugin.id]),
      [plugin.id],
    );
  }
  return [...transitive.values()];
}

/** Resolve and recurse through one plugin's `dependencies`. */
function expandTransitiveDependencies(
  fs: PluginFs,
  rootDir: string,
  plugin: DependencyPlugin,
  directKeys: Set<string>,
  transitive: Map<string, DependencyPlugin>,
  edges: Set<string>,
  issues: PluginIssue[],
  ancestors: ReadonlySet<string>,
  path: readonly string[],
): void {
  const names = [...plugin.dependencies.keys()].sort();
  for (const name of names) {
    const resolved = resolveInstalledPackage(fs, plugin.dir, rootDir, name);
    if (resolved === undefined) {
      issues.push({
        source: 'dependency',
        code: 'transitive_dependency_missing',
        message: `transitive dependency "${name}" of plugin "${plugin.id}" is not installed`,
        path: join(rootDir, 'node_modules', ...name.split('/'), 'package.json'),
      });
      continue;
    }

    const jsails = readJsailsField(resolved.raw);
    if (jsails === undefined) {
      continue; // a non-plugin dependency; ignored, never recursed.
    }
    const manifest = parseDependencyManifest(jsails, resolved.manifestPath, issues);
    if (manifest === undefined) {
      continue;
    }

    edges.add(edgeKey(plugin.id, manifest.id));

    // A plugin id already on the current root-to-here path is a cycle: report
    // it and stop following this edge rather than recursing forever.
    if (ancestors.has(manifest.id)) {
      issues.push({
        source: 'dependency',
        code: 'dependency_cycle',
        message: `dependency cycle: ${[...path, manifest.id].join(' -> ')}`,
        pluginId: manifest.id,
        path: plugin.manifestPath,
      });
      continue;
    }

    const key = pluginKey(manifest.id, manifest.version);
    if (directKeys.has(key)) {
      continue; // already present as a root plugin.
    }

    const existing = transitive.get(key);
    if (existing !== undefined) {
      // Same id + version via another parent: merge, and do not re-expand.
      existing.requiredBy.add(plugin.id);
      for (const id of plugin.provenance) existing.provenance.add(id);
      existing.provenance.add(manifest.id);
      continue;
    }

    const child: DependencyPlugin = {
      id: manifest.id,
      version: manifest.version,
      packageName: name,
      manifestPath: resolved.manifestPath,
      dir: resolved.dir,
      dependencies: readDependencies(resolved.raw),
      manifest,
      root: false,
      requiredBy: new Set([plugin.id]),
      provenance: new Set([...plugin.provenance, manifest.id]),
    };
    transitive.set(key, child);
    expandTransitiveDependencies(
      fs,
      rootDir,
      child,
      directKeys,
      transitive,
      edges,
      issues,
      new Set([...ancestors, manifest.id]),
      [...path, manifest.id],
    );
  }
}

/** Turn a dependency plugin record into the final discovered-plugin shape. */
export function finalizeDependencyPlugin(plugin: DependencyPlugin): DiscoveredPlugin {
  return {
    id: plugin.id,
    version: plugin.version,
    source: 'dependency',
    manifest: plugin.manifest,
    manifestPath: plugin.manifestPath,
    packageName: plugin.packageName,
    root: plugin.root,
    requiredBy: [...plugin.requiredBy].sort(),
    provenanceChain: [...plugin.provenance].sort(),
  };
}

/** Stable merge key for a plugin: id plus version. */
function pluginKey(id: string, version: string): string {
  return `${id}\u0000${version}`;
}

/** Stable dedupe key for a directed edge. */
function edgeKey(from: string, to: string): string {
  return `${from}\u0000${to}`;
}

/** Split an edge dedupe key back into its `from`/`to` ids. */
export function splitEdgeKey(key: string): PluginEdge {
  const separator = key.indexOf('\u0000');
  return { from: key.slice(0, separator), to: key.slice(separator + 1) };
}

/**
 * Compute every plugin id reachable from an enabled root (a direct dependency
 * or a bundle whose id is not disabled), following the recorded dependency
 * edges. Disabled ids are pruned from the output but still traversed through,
 * so a descendant that also has an enabled-root path survives.
 */
export function reachableFromEnabledRoots(
  plugins: readonly DiscoveredPlugin[],
  edges: ReadonlySet<string>,
  disabled: ReadonlySet<string>,
): Set<string> {
  const adjacency = new Map<string, Set<string>>();
  for (const key of edges) {
    const { from, to } = splitEdgeKey(key);
    let neighbors = adjacency.get(from);
    if (neighbors === undefined) {
      neighbors = new Set();
      adjacency.set(from, neighbors);
    }
    neighbors.add(to);
  }

  const reachable = new Set<string>();
  const queue: string[] = [];
  for (const plugin of plugins) {
    const isRoot = plugin.root === true || plugin.source === 'bundle';
    if (!isRoot || disabled.has(plugin.id) || reachable.has(plugin.id)) {
      continue;
    }
    reachable.add(plugin.id);
    queue.push(plugin.id);
  }
  for (let head = 0; head < queue.length; head += 1) {
    const id = queue[head];
    if (id === undefined) continue;
    const neighbors = adjacency.get(id);
    if (neighbors === undefined) continue;
    for (const next of neighbors) {
      if (!reachable.has(next)) {
        reachable.add(next);
        queue.push(next);
      }
    }
  }
  return reachable;
}

/** Emit `disabled_required_plugin` for every enabled -> disabled dependency edge. */
export function collectDisabledRequired(
  edges: ReadonlySet<string>,
  enabled: readonly DiscoveredPlugin[],
  disabled: ReadonlySet<string>,
  issues: PluginIssue[],
): void {
  const enabledIds = new Set(enabled.map((plugin) => plugin.id));
  const findings: PluginIssue[] = [];
  for (const key of edges) {
    const { from, to } = splitEdgeKey(key);
    if (enabledIds.has(from) && disabled.has(to)) {
      findings.push({
        source: 'dependency',
        code: 'disabled_required_plugin',
        message: `enabled plugin "${from}" requires disabled plugin "${to}"`,
        pluginId: from,
      });
    }
  }
  findings.sort((a, b) => (a.message < b.message ? -1 : a.message > b.message ? 1 : 0));
  issues.push(...findings);
}

/** Emit `conflicting_plugin_versions` for a dependency id at several versions. */
export function collectConflictingVersions(
  plugins: readonly DiscoveredPlugin[],
  issues: PluginIssue[],
): void {
  const byId = new Map<string, string[]>();
  for (const plugin of plugins) {
    if (plugin.source !== 'dependency') continue;
    const versions = byId.get(plugin.id);
    if (versions === undefined) {
      byId.set(plugin.id, [plugin.version]);
    } else if (!versions.includes(plugin.version)) {
      versions.push(plugin.version);
    }
  }
  for (const id of [...byId.keys()].sort()) {
    const versions = byId.get(id);
    if (versions === undefined || versions.length < 2) continue;
    versions.sort();
    issues.push({
      source: 'dependency',
      code: 'conflicting_plugin_versions',
      message: `plugin "${id}" has conflicting versions: ${versions.join(', ')}`,
      pluginId: id,
    });
  }
}
