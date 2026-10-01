/**
 * Plugin provenance: which source a discovered plugin came from.
 *
 * A plugin is either declared as a direct npm dependency that self-identifies
 * through its own `package.json` `jsails` field (source `'dependency'`; install
 * equals activate), or it lives in the storage-backed plugins folder as a
 * downloaded/manual bundle (source `'bundle'`). Provenance is carried on every
 * discovered plugin so later slices can order activation and report an origin
 * without re-reading disk.
 */

/** The origin of a discovered plugin. */
export type PluginSource = 'dependency' | 'bundle';

/** Every valid plugin source, in a stable order. */
export const PLUGIN_SOURCES: readonly PluginSource[] = Object.freeze(['dependency', 'bundle']);

/** Human label per source, used in CLI output. */
const PLUGIN_SOURCE_LABELS: Readonly<Record<PluginSource, string>> = {
  dependency: 'dependency',
  bundle: 'bundle',
};

/** Return the display label for a plugin source. */
export function pluginSourceLabel(source: PluginSource): string {
  return PLUGIN_SOURCE_LABELS[source];
}
