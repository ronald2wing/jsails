/**
 * Import a compiler-generated runtime module (the `.jsails/` model and component
 * registries).
 *
 * The compiler emits registry sources under `.jsails/`; `tsc` compiles them
 * alongside the app, so at runtime they live at `<rootDir>/dist/.jsails/<name>.js`.
 * A `build:meta` run is a prerequisite, but a project with no models or
 * components legitimately has no registry — so a missing module is a silent
 * no-op, never an error. An explicit `modulePath` short-circuits discovery for
 * tests and out-of-tree layouts.
 *
 * This module is server-only (it touches `node:fs`); it is reached only through
 * the model/component bootstrap seams, never a browser-safe entry.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Options for {@link importGeneratedRegistry}. */
export interface ImportGeneratedRegistryOptions {
  /** Project root the `.jsails/` layout is resolved against. Defaults to `cwd`. */
  readonly rootDir?: string;
  /** An exact compiled module path, bypassing discovery. */
  readonly modulePath?: string;
}

/**
 * Locate and import the generated registry named `name` (e.g.
 * `models.registry`). The compiled output `dist/.jsails/<name>.js` is tried
 * first, then a colocated `.jsails/<name>.js` (a from-source run). Returns
 * `true` when a module was imported, `false` when none exists.
 */
export async function importGeneratedRegistry(
  name: string,
  options: ImportGeneratedRegistryOptions = {},
): Promise<boolean> {
  const candidates =
    options.modulePath !== undefined
      ? [options.modulePath]
      : [
          resolve(options.rootDir ?? process.cwd(), 'dist/.jsails', `${name}.js`),
          resolve(options.rootDir ?? process.cwd(), '.jsails', `${name}.js`),
        ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      await import(pathToFileURL(candidate).href);
      return true;
    }
  }
  return false;
}
