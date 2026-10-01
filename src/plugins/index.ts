/**
 * Plugin system — manifest contract, two-source discovery, validation, and the
 * installer foundations.
 *
 * This subpath is server-side (it reads the filesystem) and, apart from the
 * TypeORM entity backing database-managed plugin state
 * (`JsailsPluginState`), imports no HTTP, queue, or Socket.IO runtime: it
 * carries the manifest contract, the provenance labels, the two-source
 * discovery walk, the framework-version check, the `.tgz` bundle extractor, the
 * persisted plugin-state store, the two-source enablement merge, and
 * download-capability resolution, and activation. Everything here reads and
 * validates manifests and installer inputs only except {@link activatePlugins},
 * which dynamically imports plugin entry modules (executing trusted plugin
 * code at import time, though never calling a plugin's `setup` — the extension
 * runner does that).
 */

export {
  parsePluginManifest,
  pluginManifestSchema,
  jsailsPackageFieldSchema,
  parseSemver,
  isValidSemverVersion,
  isValidSemverRange,
  satisfiesRange,
  PluginManifestError,
  PLUGIN_ID_PATTERN,
  PERMISSION_PATTERN,
  PLUGIN_MANIFEST_FILENAME,
  type PluginManifest,
  type PluginManifestIssue,
  type SemverVersion,
} from './manifest.js';

export { PLUGIN_SOURCES, pluginSourceLabel, type PluginSource } from './provenance.js';

export {
  discoverPlugins,
  PluginDiscoveryError,
  DEFAULT_PLUGINS_DIR,
  type DiscoverPluginsOptions,
  type DiscoverPluginsResult,
  type DiscoveredPlugin,
  type PluginIssue,
  type PluginDiscoveryErrorCode,
  type SkippedPlugin,
  type SkippedPluginReason,
  type PluginFs,
  type PluginDirent,
} from './discovery.js';

export {
  checkPlugins,
  readFrameworkVersion,
  PluginCheckError,
  type CheckPluginsResult,
  type CheckFinding,
  type CheckFindingKind,
} from './check.js';

export {
  extractTarGz,
  ArchiveError,
  DEFAULT_MAX_ENTRIES,
  DEFAULT_MAX_TOTAL_BYTES,
  type ExtractTarGzOptions,
  type ArchiveErrorCode,
} from './archive.js';

export {
  PluginStateStore,
  PluginStateError,
  pluginStateSchema,
  PLUGIN_STATE_FILENAME,
  PLUGIN_STATE_VERSION,
  type PluginState,
  type PluginStateEntry,
  type PluginStateSource,
  type PluginStateStoreOptions,
  type PluginStateFs,
} from './state-store.js';

export {
  JsailsPluginState,
  pluginStateEntities,
  PLUGIN_STATE_TABLE,
} from './database-state-entity.js';

export {
  createDatabasePluginStateStore,
  loadPluginEnablement,
  type DatabasePluginStateStoreOptions,
  type LoadPluginEnablementInput,
} from './database-state-store.js';

export {
  resolveDownloadsCapability,
  type ResolveDownloadsCapabilityInput,
  type DownloadsCapability,
} from './download-capability.js';

export {
  createPluginInstaller,
  PluginInstallerError,
  DEFAULT_MAX_BYTES,
  type PluginInstaller,
  type PluginInstallerErrorCode,
  type PluginInstallerOptions,
  type InstallPluginInput,
  type PluginInstallResult,
  type PluginFetch,
  type VerifySignature,
  type PluginInstallerFs,
  type PluginInstallerStat,
} from './installer.js';

export {
  resolvePluginEnablement,
  PluginEnablementError,
  type ResolvePluginEnablementInput,
  type PluginEnablement,
} from './enablement.js';

export {
  activatePlugins,
  isBareSpecifier,
  type ActivatePluginsInput,
  type ActivatePluginsResult,
} from './activation.js';

export {
  resolvePluginUse,
  normalizeUseEntry,
  extractPluginFromUse,
  type ResolvePluginUseInput,
  type ResolvePluginUseResult,
} from './use.js';
