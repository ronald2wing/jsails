/**
 * Plugin manifest contract — public surface.
 *
 * This barrel re-exports the manifest contract from its three slices so every
 * existing `import ... from '.../plugins/manifest.js'` keeps resolving to the
 * same symbols:
 *
 * - `manifest/schema.ts` — the Zod {@link pluginManifestSchema}, the typed
 *   manifest model (`PluginManifest`, `PluginDependency`, `PluginManifestIssue`),
 *   the value-free {@link PluginManifestError}, the identifier/permission
 *   patterns and bounds, and `parsePluginManifest`.
 * - `manifest/package-field.ts` — the npm `package.json` `jsails` field schema
 *   (`jsailsPackageFieldSchema`, which is {@link pluginManifestSchema} by
 *   reference).
 * - `manifest/semver.ts` — the dependency-free semver subset (`parseSemver`,
 *   `isValidSemverVersion`, `isValidSemverRange`, `satisfiesRange`).
 */

export {
  parsePluginManifest,
  pluginManifestSchema,
  PluginManifestError,
  PLUGIN_ID_PATTERN,
  PERMISSION_PATTERN,
  PLUGIN_MANIFEST_FILENAME,
  type PluginManifest,
  type PluginDependency,
  type PluginManifestIssue,
} from './manifest/schema.js';

export { jsailsPackageFieldSchema } from './manifest/package-field.js';

export {
  parseSemver,
  isValidSemverVersion,
  isValidSemverRange,
  satisfiesRange,
  type SemverVersion,
} from './manifest/semver.js';
