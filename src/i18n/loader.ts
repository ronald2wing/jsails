/**
 * Server-only catalog loading for `jsails/i18n` (`jsails/i18n/loader`).
 *
 * Re-exports the `Loader` contract, `createFileLoader`/`FileLoaderOptions`,
 * `deepMerge`, and adds `createArrayLoader` for in-memory catalogs (tests,
 * demos).  This barrel imports `node:fs` (through `catalog-loader`), so it
 * must never be re-exported from the browser-safe `jsails/i18n` root entry.
 */

import { type Messages } from './translator.js';

import {
  type Loader,
  type FileLoaderOptions,
  createFileLoader,
  deepMerge,
} from './catalog-loader.js';

export { type Loader, type FileLoaderOptions, type Messages, createFileLoader, deepMerge };

// ---- ArrayLoader ---------------------------------------------------------

/**
 * Build an in-memory `Loader` from a frozen catalog map keyed by locale.
 *
 * `load` returns the catalog by reference (never cloned);
 * `availableLocales` returns sorted keys; `reload` is a no-op.
 */
export function createArrayLoader(catalogs: Readonly<Record<string, Messages>>): Loader {
  return {
    async load(locale: string): Promise<Messages | undefined> {
      return catalogs[locale];
    },

    async availableLocales(): Promise<readonly string[]> {
      return Object.keys(catalogs).sort();
    },

    async reload(): Promise<void> {
      // no-op — in-memory catalogs have no source to re-read.
    },
  };
}
