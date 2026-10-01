/**
 * The `jsails/build` bundler-integration surface: the Vite plugins a starter
 * wires into `vite.config`, plus the guards and transforms they enforce.
 *
 * - `cleanBundlePlugin` — a `generateBundle` hook asserting no server-only
 *   module reached the browser bundle.
 * - `serverDirectivePlugin` — a `transform` hook stubbing `'use server'`
 *   functions in a client chunk.
 * - `autoloadPlugin` / `compilerPlugin` — the compiler's own Vite plugins,
 *   re-exported here so a `vite.config` imports the whole plugin set from one
 *   subpath instead of reaching into `jsails/compiler`.
 *
 * Importing this barrel is inert — nothing is bundled and no bundler code is
 * loaded; the plugins only run when a build tool invokes their hooks.
 */

export {
  CleanBundleError,
  assertCleanClientBundle,
  cleanBundlePlugin,
  findServerOnlyModules,
  type CleanBundlePluginOptions,
  type CleanBundleViolation,
  type ClientBundleChunk,
} from './clean-bundle-check.js';

export {
  ServerDirectiveError,
  stripServerDirectives,
  type ServerDirectiveResult,
} from './server-directive.js';

export {
  serverDirectivePlugin,
  type ServerDirectivePluginOptions,
} from './server-directive-plugin.js';

export { autoloadPlugin, type AutoloadPluginOptions } from '../compiler/index.js';

export { compilerPlugin, type CompilerPluginOptions } from '../compiler/index.js';

export {
  scanProjectMeta,
  type ComponentModule,
  type ProjectMeta,
  type ScanProjectMetaOptions,
} from './meta-scan.js';

export {
  META_DIR,
  buildMetaArtifacts,
  emitAutoloadJson,
  emitComponentsRegistry,
  emitModelsRegistry,
  writeMetaArtifacts,
  type MetaArtifacts,
} from './generate-meta.js';
