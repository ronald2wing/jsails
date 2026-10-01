/**
 * Browser client runtime: the public entry for island hydration and stateful
 * server-component bindings over Turbo Drive navigation.
 *
 * Exports a deliberately small surface:
 *
 * - `startClient(options?)` — dynamically loads Turbo, starts the shared
 *   session, registers any declarative `islands`, hydrates the initial markup,
 *   and auto-enables the component bindings. Idempotent.
 * - `registerIsland(name, component)` — register a typed Preact island.
 * - `morphComponent(target, html, options?)` — render a Turbo morph stream
 *   message and await the actual morph.
 *
 * The island marker contract and bounded-JSON props parsing live in
 * `./islands.js`; Turbo event wiring and the before-navigation hook live in
 * `./navigation.js`. The internal DOM binding layer (`./bindings/index.js`) and the
 * component state controller (`./state-decoding.js`) are consumed by the
 * runtime but are NOT re-exported here — internal tests import those files
 * directly.
 */

export {
  startClient,
  morphComponent,
  createTurboEventAdapter,
  ClientEnvironmentError,
  JSAILS_BEFORE_NAVIGATION,
  FRAME_MISSING_MESSAGE,
  TURBO_PREFETCH_ATTRIBUTE,
  TURBO_TO_JSAILS_EVENT_MAP,
  MORPH_RENDER_TIMEOUT_MS,
  type StartClientOptions,
  type MorphComponentOptions,
  type BeforeNavigationDetail,
  type TurboEventAdapter,
} from './navigation.js';

// Turbo Stream message emitters: pure string builders, usable client- or
// server-side, that return a serialized `<turbo-stream>` element for the
// running Turbo session to apply. Trusted producer output — the caller owns
// escaping of any HTML it passes in.
export * from './streams.js';

export {
  registerIsland,
  ISLAND_ATTRIBUTE,
  ISLAND_PROPS_ATTRIBUTE,
  ISLAND_HYDRATED_ATTRIBUTE,
  TURBO_PERMANENT_ATTRIBUTE,
  IslandRegistryError,
  IslandPropsError,
  type IslandComponent,
  type IslandProps,
  type IslandMap,
} from './islands.js';

export {
  definePathConfiguration,
  resolvePathConfiguration,
  resolvePathConfigurationMerged,
  defaultPathRules,
  isNativeApp,
  nativeBridge,
  PathConfigurationError,
  type PathRule,
  type PathConfiguration,
  type PathConfigurationInput,
  type NativeBridge,
} from './native.js';

// Hotwire Native protocol: bridge messages, component registry, visit-proposal
// contract, and the injectable-fetch path-configuration loader.
export {
  createBridgeMessage,
  replyTo,
  isBridgeMessage,
  createBridgeComponentRegistry,
  isVisitProposal,
  BridgeMessageError,
  BridgeComponentError,
  type BridgeMessage,
  type VisitProposalAction,
  type VisitProposal,
} from './native-protocol.js';

export {
  createPathConfigurationLoader,
  mergePathConfigurations,
  PathConfigLoaderError,
  type PathConfigSource,
  type PathConfigSourceKind,
  type PathConfigurationLoader,
} from './path-config-loader.js';
