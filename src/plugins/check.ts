/**
 * Plugin validation/check: reconcile a discovery result against the running
 * framework version.
 *
 * `checkPlugins` turns a {@link DiscoverPluginsResult} into a list of findings —
 * `malformed` (manifests that failed to parse, surfaced as warnings during
 * discovery), `duplicate` (the same plugin id at more than one version, which a
 * later activation slice must resolve), `incompatible` (a plugin whose
 * `jsailsCompat` range does not include the framework version), and the graph
 * findings surfaced by discovery (`missing` for a missing transitive
 * dependency, `conflict` for conflicting plugin versions, `cycle` for a
 * dependency cycle, `disabled` for an enabled plugin requiring a disabled one).
 * It additionally validates each plugin's declared `plugins` dependency ranges
 * against the discovered versions, reporting `missing`/`conflict` when a
 * semver-parseable range is unmet. It never opens a connection or imports
 * plugin code.
 *
 * `readFrameworkVersion` resolves the framework's own `package.json` version
 * relative to this module's location on disk, so a check against the installed
 * framework works from any cwd.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { DiscoverPluginsResult, DiscoveredPlugin, PluginIssue } from './discovery.js';
import { isValidSemverRange, satisfiesRange } from './manifest.js';

/** Raised when the framework version cannot be resolved. */
export class PluginCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginCheckError';
  }
}

/** The kind of a check finding. */
export type CheckFindingKind =
  'malformed' | 'duplicate' | 'incompatible' | 'missing' | 'conflict' | 'cycle' | 'disabled';

/** A single check failure. */
export interface CheckFinding {
  /** The failure category. */
  readonly kind: CheckFindingKind;
  /** Stable machine code, e.g. `invalid_manifest`, `duplicate`, `incompatible`. */
  readonly code: string;
  /** Value-free description. */
  readonly message: string;
  /** Plugin id, when the finding refers to a specific plugin. */
  readonly pluginId?: string;
  /** Path of the offending file, when one was identified. */
  readonly path?: string;
}

/** The result of a check: findings plus the inputs it judged. */
export interface CheckPluginsResult {
  /** True when there are no findings. */
  readonly ok: boolean;
  /** Every finding, in a deterministic order. */
  readonly findings: readonly CheckFinding[];
  /** The plugins that were checked (the discovery result, unchanged). */
  readonly plugins: readonly DiscoveredPlugin[];
  /** The framework version the check was run against. */
  readonly frameworkVersion: string;
}

/** Finding kind per discovery issue code; anything else defaults to `malformed`. */
const ISSUE_KIND: Readonly<Record<string, CheckFindingKind>> = {
  dependency_cycle: 'cycle',
  conflicting_plugin_versions: 'conflict',
  disabled_required_plugin: 'disabled',
  transitive_dependency_missing: 'missing',
};

/**
 * Check a discovery result against `frameworkVersion`. Malformed-manifest issues
 * from discovery are promoted to findings (graph issues like cycles, conflicting
 * versions, disabled requirements, and missing transitive dependencies carry
 * their own kind); a plugin id present at more than one version is a `duplicate`
 * finding; a plugin whose `jsailsCompat` range does not include the framework
 * version is `incompatible`; and a declared `plugins` dependency whose semver
 * range is unmet by the discovered versions is `missing` or `conflict`.
 */
export function checkPlugins(
  result: DiscoverPluginsResult,
  frameworkVersion: string,
): CheckPluginsResult {
  const findings: CheckFinding[] = [];

  for (const issue of result.issues) {
    findings.push(fromIssue(issue));
  }

  const byId = groupById(result.plugins);
  for (const [id, versions] of [...byId.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (versions.length > 1) {
      findings.push({
        kind: 'duplicate',
        code: 'duplicate',
        message: `plugin "${id}" has multiple versions: ${versions.map((p) => p.version).join(', ')}`,
        pluginId: id,
      });
    }
  }

  for (const plugin of result.plugins) {
    if (!satisfiesRange(frameworkVersion, plugin.manifest.jsailsCompat)) {
      findings.push({
        kind: 'incompatible',
        code: 'incompatible',
        message:
          `plugin "${plugin.id}@${plugin.version}" does not support framework ` +
          `"${frameworkVersion}" (jsailsCompat: ${plugin.manifest.jsailsCompat})`,
        pluginId: plugin.id,
        path: plugin.manifestPath,
      });
    }
  }

  checkDeclaredDependencies(result.plugins, findings);

  return {
    ok: findings.length === 0,
    findings,
    plugins: result.plugins,
    frameworkVersion,
  };
}

/** Promote a discovery issue into a finding, keyed by its code. */
function fromIssue(issue: PluginIssue): CheckFinding {
  return {
    kind: ISSUE_KIND[issue.code] ?? 'malformed',
    code: issue.code,
    message: issue.message,
    pluginId: issue.pluginId,
    path: issue.path,
  };
}

/**
 * Validate each plugin's declared `plugins` dependency ranges against the
 * discovered versions. A range that is not semver-parseable (an npm `file:`,
 * `workspace:`, or `git:` spec, or any other unparseable string) is skipped; a
 * semver range whose required id is not discovered is `missing`, and one whose
 * discovered versions none satisfy is `conflict`.
 */
function checkDeclaredDependencies(
  plugins: readonly DiscoveredPlugin[],
  findings: CheckFinding[],
): void {
  const versionsById = groupVersionsById(plugins);
  for (const plugin of plugins) {
    for (const dependency of plugin.manifest.plugins ?? []) {
      if (!isValidSemverRange(dependency.range)) {
        continue;
      }
      const versions = versionsById.get(dependency.id) ?? [];
      if (versions.length === 0) {
        findings.push({
          kind: 'missing',
          code: 'missing_dependency',
          message:
            `plugin "${plugin.id}" requires plugin "${dependency.id}" ` +
            `(${dependency.range}), which is not discovered`,
          pluginId: plugin.id,
          path: plugin.manifestPath,
        });
      } else if (!versions.some((version) => satisfiesRange(version, dependency.range))) {
        findings.push({
          kind: 'conflict',
          code: 'unsatisfied_dependency',
          message:
            `plugin "${plugin.id}" requires plugin "${dependency.id}" ` +
            `(${dependency.range}), but discovered version(s) ${versions.join(', ')} ` +
            'do not satisfy it',
          pluginId: plugin.id,
          path: plugin.manifestPath,
        });
      }
    }
  }
}

/** Group plugins by id, preserving discovery (sorted) order within each group. */
function groupById(plugins: readonly DiscoveredPlugin[]): Map<string, DiscoveredPlugin[]> {
  const map = new Map<string, DiscoveredPlugin[]>();
  for (const plugin of plugins) {
    const existing = map.get(plugin.id);
    if (existing === undefined) {
      map.set(plugin.id, [plugin]);
    } else {
      existing.push(plugin);
    }
  }
  return map;
}

/** Group discovered plugin versions by id, in discovery order. */
function groupVersionsById(plugins: readonly DiscoveredPlugin[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const plugin of plugins) {
    const versions = map.get(plugin.id);
    if (versions === undefined) {
      map.set(plugin.id, [plugin.version]);
    } else if (!versions.includes(plugin.version)) {
      versions.push(plugin.version);
    }
  }
  return map;
}

/**
 * Resolve the framework version from the framework's own `package.json`,
 * located relative to this module (three levels up from
 * `dist/src/plugins/check.js`). An explicit `packageJsonPath` overrides the
 * default for tests and non-standard layouts.
 */
export function readFrameworkVersion(packageJsonPath?: string): string {
  const path = packageJsonPath ?? defaultFrameworkPackageJson();
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new PluginCheckError(`could not read the framework package.json at "${path}"`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new PluginCheckError(`the framework package.json at "${path}" is not valid JSON`);
  }
  const version =
    parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)['version']
      : undefined;
  if (typeof version !== 'string' || version.length === 0) {
    throw new PluginCheckError(`the framework package.json at "${path}" has no version`);
  }
  return version;
}

/** The framework `package.json` path resolved from this module's location. */
function defaultFrameworkPackageJson(): string {
  const here = fileURLToPath(import.meta.url);
  return join(dirname(here), '..', '..', '..', 'package.json');
}
