/**
 * Plugin-global projection at app assembly.
 *
 * A plugin opts a set of its public subpaths onto `globalThis` through an
 * {@link AutoloadDeclaration} (default `none`). Unlike the framework surface —
 * whose names are known at `build:meta` and emitted into the ambient `.d.ts` —
 * a plugin's names are **runtime-only**: they are enumerated from the plugin's
 * loaded subpath modules at assembly, never declared in the ambient `.d.ts`
 * (which would force `build:meta` to import plugin code). A plugin's bare names
 * are therefore a runtime convenience; a consumer that wants a *type-checkable*
 * reference reaches the name through `symbols` or an explicit import.
 *
 * This module projects the **own-surface** axis of the two-axis
 * {@link AutoloadDeclaration} — the `selected.specifiers` a plugin names. The
 * **delegation** axis (`selected.plugins`, or `all` over installed plugins) is a
 * provenance concern resolved by {@link resolveAutoloadExposure} over the install
 * graph; the *caller* computes the active set and passes each active plugin's own
 * declaration here.
 *
 * **`all` own-surface is not expressible here** without a subpath inventory: a
 * plugin that wants its whole surface bare writes the explicit `selected`
 * `specifiers` list.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { AutoloadDeclaration, FrameworkSymbol } from './framework-symbols.js';
import { projectFrameworkSymbols } from './projection.js';
import type { FrameworkSymbolOverrideWarning } from './projection.js';

/** Options for the projection entry points. */
export interface InstallPluginGlobalsOptions {
  /** Sink for override warnings; defaults to `console.warn`. */
  readonly onWarn?: (warning: FrameworkSymbolOverrideWarning) => void;
}

/** A plugin's own-surface autoload to project, with its origin label. */
export interface PluginAutoloadEntry {
  /** Origin label for the projection (the plugin id). */
  readonly origin: string;
  /** The plugin's own autoload declaration (absent ⇒ `none`). */
  readonly autoload?: AutoloadDeclaration;
}

/** The generated plugin-declarations entry, relative to the project root. */
const PLUGIN_DECLARATIONS_ENTRY = join('.jsails', 'plugin-declarations.js');

/**
 * Read the folded plugin declarations emitted at `build:meta` and project each
 * active plugin's own surface onto `globalThis`. A project that has not run
 * `build:meta` has no such file — a silent no-op, like `installProjectSymbols`.
 */
export async function installPluginDeclarations(
  rootDir: string,
  options: InstallPluginGlobalsOptions = {},
): Promise<void> {
  const declarationsPath = join(rootDir, PLUGIN_DECLARATIONS_ENTRY);
  if (!existsSync(declarationsPath)) {
    return;
  }
  const module = (await import(pathToFileURL(declarationsPath).href)) as {
    PLUGIN_DECLARATIONS?: readonly {
      id: string;
      autoload?: AutoloadDeclaration;
    }[];
  };
  const declarations = module.PLUGIN_DECLARATIONS ?? [];
  await installDeclaredGlobals(
    declarations.map((declaration) => ({ origin: declaration.id, autoload: declaration.autoload })),
    options,
  );
}

/**
 * Project a pre-resolved set of autoload entries onto `globalThis`. The entries
 * come from the folded `.jsails/plugin-declarations.js` emitted at `build:meta` —
 * the single source of a plugin's `autoload` surface, read at assembly, never
 * from a runtime `describe()`.
 *
 * A plugin with `none` (or `selected` with no `specifiers`) contributes nothing —
 * the default. Each named subpath's exports become bare names; collisions and
 * overrides are handled by the shared projection engine (first-in-order wins the
 * bare slot; later projections win with a warning).
 */
export async function installDeclaredGlobals(
  entries: readonly PluginAutoloadEntry[],
  options: InstallPluginGlobalsOptions = {},
): Promise<void> {
  for (const entry of entries) {
    const declaration = entry.autoload;
    if (declaration === undefined || declaration.mode !== 'selected') {
      continue;
    }
    const specifiers = declaration.specifiers ?? [];
    if (specifiers.length === 0) {
      continue;
    }

    const globals: FrameworkSymbol[] = [];
    const modules = new Map<string, Record<string, unknown>>();

    for (const specifier of specifiers) {
      const module = (await import(specifier)) as Record<string, unknown>;
      modules.set(specifier, module);
      for (const name of Object.keys(module)) {
        if (name === 'default') {
          continue; // the default export is never a bare global.
        }
        globals.push({ name, specifier, target: 'server' });
      }
    }

    if (globals.length === 0) {
      continue;
    }

    projectFrameworkSymbols({
      globals,
      modules,
      origin: `plugin:${entry.origin}`,
      ...(options.onWarn ? { onWarn: options.onWarn } : {}),
    });
  }
}
