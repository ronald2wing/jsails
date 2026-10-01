/**
 * Browser framework-symbols preload entry (`jsails/symbols/client`).
 *
 * The browser counterpart of `jsails/symbols`: a client entry calls
 * {@link installBrowserSymbols} once to publish the browser-safe framework
 * symbols onto `globalThis`, so island and component code can reference them
 * bare — the same ergonomics the server gets from `installFrameworkSymbols`.
 *
 * A separate subpath (rather than re-exporting from `jsails/client`) keeps the
 * client barrel free of a dependency on the installer, which itself imports the
 * browser barrels (`jsails/api`, `jsails/theme`, …); re-exporting here would
 * make `jsails/client` import a module that imports `jsails/client`.
 *
 * Only the browser-safe half of the framework is projected — see
 * `install-browser.ts` for why.
 */

export { installBrowserSymbols, browserSymbolSpecifiers } from './install-browser.js';
export type { InstallBrowserSymbolsOptions } from './install-browser.js';
export type { FrameworkSymbolOrigin, FrameworkSymbolOverrideWarning } from './projection.js';
