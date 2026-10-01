/**
 * `bootstrapComponents()` — the single seam that loads the compiler-generated
 * component registry.
 *
 * The compiler emits `.jsails/components.registry.ts`, which imports every
 * server-component module and calls {@link registerComponent} for each. `tsc`
 * compiles it to `dist/.jsails/components.registry.js`. This function imports
 * that compiled module so the registry is populated before
 * {@link serverComponentsPlugin} harvests it.
 *
 * The user never imports a registry: the config loaders call this before
 * running extensions, so component registration is automatic. A project with no
 * components has no registry, and the call is a silent no-op.
 *
 * This module is server-only — it is reached only through the config loaders,
 * never a browser-safe entry.
 */

import { importGeneratedRegistry } from '../internal/generated-registry.js';

/** Options for {@link bootstrapComponents}. */
export interface BootstrapComponentsOptions {
  /** Project root the `.jsails/` layout is resolved against. Defaults to `cwd`. */
  readonly rootDir?: string;
  /** An exact compiled registry path, bypassing discovery (tests). */
  readonly modulePath?: string;
}

/**
 * Import the compiled component registry, populating the component registry.
 * Returns `true` when a registry module was found and imported, `false` when the
 * project has none. Idempotent: a re-import of an already-loaded module is a
 * no-op, and {@link registerComponent} is itself idempotent per name.
 */
export async function bootstrapComponents(
  options: BootstrapComponentsOptions = {},
): Promise<boolean> {
  return importGeneratedRegistry('components.registry', options);
}
