/**
 * Framework-symbols preload entry (`jsails/symbols`).
 *
 * A plain barrel over the runtime installer. The generated
 * `<rootDir>/.jsails/project-symbols.js` imports {@link installFrameworkSymbols}
 * from here, `await`s it, and only then dynamically imports the project's shim
 * tree:
 *
 * ```js
 * import { installFrameworkSymbols } from 'jsails/symbols';
 * await installFrameworkSymbols(rootDir);
 * await import('./project-symbols/models/author.js');
 * // ...
 * ```
 *
 * The shims are imported **dynamically and sequentially**, not with hoisted
 * static imports, because a static import runs before the `await` line (imports
 * hoist) and top-level await in one dependency does not serialize its siblings —
 * so a static shim would read a bare `ApplicationRecord` before it was
 * installed. The dynamic chain makes the framework-before-project order
 * explicit and unskippable.
 *
 * Server-only: {@link installFrameworkSymbols} dynamically imports server
 * subpaths (`jsails/server-components`, `jsails/admin`, `jsails/database`, …), so
 * this entry must never reach the browser-safe graph.
 */

export {
  installFrameworkSymbols,
  installProjectSymbols,
  SymbolsInstallError,
} from './install-server.js';
export type {
  SymbolsInstallErrorCode,
  FrameworkSymbolOrigin,
  FrameworkSymbolOverrideWarning,
  InstallFrameworkSymbolsOptions,
} from './install-server.js';
