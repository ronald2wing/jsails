/**
 * `bootstrapModels()` — the single seam that loads the compiler-generated model
 * registry.
 *
 * The compiler emits `.jsails/models.registry.ts`, which imports every model
 * class and calls {@link registerModel} for each. `tsc` compiles it to
 * `dist/.jsails/models.registry.js`. This function imports that compiled module
 * so the registry is populated before a {@link JsailsDataSource} harvests it.
 *
 * The user never imports a registry: the config loaders call this before
 * constructing a data source, so model registration is automatic. A project
 * with no models has no registry, and the call is a silent no-op.
 *
 * This module is server-only — it is reached only through the config loaders,
 * never a browser-safe entry.
 */

import { importGeneratedRegistry } from '../internal/generated-registry.js';

/** Options for {@link bootstrapModels}. */
export interface BootstrapModelsOptions {
  /** Project root the `.jsails/` layout is resolved against. Defaults to `cwd`. */
  readonly rootDir?: string;
  /** An exact compiled registry path, bypassing discovery (tests). */
  readonly modulePath?: string;
}

/**
 * Import the compiled model registry, populating the model registry. Returns
 * `true` when a registry module was found and imported, `false` when the project
 * has none. Idempotent: a re-import of an already-loaded module is a no-op, and
 * {@link registerModel} is itself idempotent per class.
 */
export async function bootstrapModels(options: BootstrapModelsOptions = {}): Promise<boolean> {
  return importGeneratedRegistry('models.registry', options);
}
