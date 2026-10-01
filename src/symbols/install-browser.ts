/**
 * Browser projection of the framework globals.
 *
 * The server installs every framework symbol onto `globalThis` at process start
 * (`installFrameworkSymbols`), reading the app's generated
 * `.jsails/framework-symbols.js`. The browser needs the same ergonomic surface
 * for the **browser-safe** half of the framework, but it must not reach for
 * `node:fs`/`node:path`/`node:url` — and, more importantly, must not pull a
 * server-only module (TypeORM, BullMQ, Hono's node server) into the client
 * bundle just because a name was projected.
 *
 * So the browser projection installs only the subpaths in
 * {@link BROWSER_SYMBOL_LOADERS} — the browser-safe half. A subpath classified
 * `server` is reachable on the server via `globalThis` and in the browser by an
 * explicit `import` — never projected, so it can never drag its server
 * dependencies into the bundle.
 *
 * **Why the browser table is derived, not read from disk.** The browser bundle
 * cannot read `.jsails/framework-symbols.js` (there is no filesystem), and the
 * browser-safe set is a fixed, authored list anyway. So the table is built from
 * the loaded modules themselves: each loader's module namespace supplies its own
 * export names. The literal loader map is the single source of truth for which
 * subpaths project, and a test pins it to the authored browser-safe set so a new
 * subpath cannot be added without extending the map.
 *
 * The projection rules (collisions, namespace objects, override warnings,
 * missing-symbol throw) live in the node-free {@link projectFrameworkSymbols}; this
 * module only supplies the loaders and the derived table.
 *
 * **Why literal import thunks.** Vite/Rollup resolve a dynamic `import(spec)` at
 * build time only when the specifier is statically analyzable. A generic
 * `import(specifier)` over a variable produces a runtime resolution that the
 * bundler cannot follow, so the browser would ship none of these modules. The
 * literal map below is what lets one bundle carry exactly the browser-safe
 * subpaths.
 */

import type { FrameworkSymbol } from './framework-symbols.js';
import { projectFrameworkSymbols } from './projection.js';
import type { FrameworkSymbolOrigin, FrameworkSymbolOverrideWarning } from './projection.js';

/**
 * Loader for the browser-safe subpaths, keyed by the exact public specifier.
 * Each value is a literal dynamic import so the bundler can statically follow it
 * and include only these modules in the client graph.
 */
const BROWSER_SYMBOL_LOADERS: Readonly<Record<string, () => Promise<Record<string, unknown>>>> = {
  'jsails/api': () => import('../api/index.js'),
  'jsails/broadcast/client': () => import('../broadcast/client.js'),
  'jsails/cache': () => import('../cache/index.js'),
  'jsails/client': () => import('../client/index.js'),
  'jsails/client/model': () => import('../client/model/index.js'),
  'jsails/extensions': () => import('../extensions/index.js'),
  'jsails/http': () => import('../http/index.js'),
  'jsails/i18n': () => import('../i18n/index.js'),
  'jsails/logging': () => import('../logging/index.js'),
  'jsails/mail': () => import('../mail/index.js'),
  'jsails/notifications': () => import('../notifications/index.js'),
  'jsails/render-to-string': () => import('../jsx/render-to-string.js'),
  'jsails/signals': () => import('../signals/index.js'),
  'jsails/support': () => import('../support/index.js'),
  'jsails/theme': () => import('../theme/index.js'),
  'jsails/validation': () => import('../validation/index.js'),
};

/** Options for {@link installBrowserSymbols}. */
export interface InstallBrowserSymbolsOptions {
  /**
   * Sink for override warnings. Defaults to `console.warn`; inject a collector
   * to assert warnings without capturing the console.
   */
  readonly onWarn?: (warning: FrameworkSymbolOverrideWarning) => void;
  /** Origin label applied to every entry; used by plugin projections. */
  readonly origin?: FrameworkSymbolOrigin;
}

/**
 * Install the browser-safe framework globals on `globalThis`.
 *
 * Idempotent: an identical re-install is silent (the engine compares identity),
 * so calling it from more than one client entry point is safe. Shares the
 * override-warning and collision semantics of the server projection, so a name
 * resolves the same way in both targets.
 */
export async function installBrowserSymbols(options?: InstallBrowserSymbolsOptions): Promise<void> {
  const modules = new Map<string, Record<string, unknown>>();
  const globals: FrameworkSymbol[] = [];

  for (const [specifier, loader] of Object.entries(BROWSER_SYMBOL_LOADERS)) {
    const module = await loader();
    modules.set(specifier, module);
    for (const name of Object.keys(module)) {
      // `default` is never a global; the server scan excludes it too.
      if (name === 'default') {
        continue;
      }
      globals.push({ name, specifier, target: 'both' });
    }
  }

  projectFrameworkSymbols({
    globals,
    modules,
    ...(options?.onWarn ? { onWarn: options.onWarn } : {}),
    ...(options?.origin ? { origin: options.origin } : {}),
  });
}

/** The browser-safe subpaths this projection installs, sorted. */
export function browserSymbolSpecifiers(): readonly string[] {
  return Object.keys(BROWSER_SYMBOL_LOADERS).sort();
}
