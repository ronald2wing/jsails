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
 * `./navigation.js`. The internal DOM binding layer (`./components.js`) and the
 * component state controller (`./component-state.js`) are consumed by the
 * runtime but are NOT re-exported here — internal tests import those files
 * directly.
 */

export {
  startClient,
  morphComponent,
  ClientEnvironmentError,
  JSAILS_BEFORE_NAVIGATION,
  FRAME_MISSING_MESSAGE,
  MORPH_RENDER_TIMEOUT_MS,
  type StartClientOptions,
  type MorphComponentOptions,
  type BeforeNavigationDetail,
} from './navigation.js';

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
