/**
 * The first-party feature-flags subpath (`jsails/flags`).
 *
 * A boolean gate the app flips without a deploy. The public surface is narrow:
 * the value-free {@link FeatureFlagError}, the {@link FeatureStore} contract
 * with an in-memory default and an optional database-backed store, the
 * {@link resolveFeature} active/inactive branch helper, and the
 * {@link flagsPlugin} exposing a {@link FeatureFlags} service under a typed
 * token. Scopes are independent string/id namespaces, so the same key can be
 * active for one scope and inactive elsewhere.
 *
 * Importing this barrel is inert: nothing connects and no flag is read or
 * written until a store or service method is called. The database-backed store
 * only touches TypeORM through the injected data source's repository.
 */

export {
  FeatureFlagError,
  createMemoryFeatureStore,
  resolveFeature,
  type FeatureFlags,
  type FeatureResolution,
  type FeatureStore,
} from './flags.js';

export { flagsPlugin, flagsToken, type FlagsPluginOptions } from './plugin.js';

// The `flags` factory is the subpath's default export, matching every other
// first-party plugin subpath: `plugins.use` resolves a specifier by importing
// the default export and calling it with the options tuple.
export { flagsPlugin as default } from './plugin.js';

export {
  JsailsFeatureFlag,
  featureFlagEntities,
  FEATURE_FLAG_TABLE,
  createDatabaseFeatureFlagStore,
  type DatabaseFeatureFlagStoreOptions,
} from './database-store.js';
