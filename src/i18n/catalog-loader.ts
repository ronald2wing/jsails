/**
 * Catalog loading for i18n — server-only (imports `node:fs`).
 *
 * Provides the {@link Loader} contract, a file-system-backed
 * {@link createFileLoader}, and the {@link deepMerge} helper for
 * composing catalogs from multiple sources.
 *
 * Two catalog shapes are supported:
 * 1. Flat JSON — `<loadPath>/<locale>.<ext>` is a single nested object.
 * 2. Nested group files — `<loadPath>/<locale>/<stem>.<ext>` where the
 *    filename stem becomes the top-level group key.
 *
 * Resolution order per locale: flat files first (per loadPath, in order),
 * then group directories (per loadPath, in order), deep-merged with later
 * load paths winning on key conflicts.
 *
 * This module must never be re-exported from the browser-safe
 * {@link jsails/i18n} root entry.
 */

import { readFile as fsReadFile, readdir as fsReaddir } from 'node:fs/promises';

import { I18nError, type Messages } from './translator.js';

// ---- Locale validation -------------------------------------------------

const LOCALE_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Throw a value-free error when `locale` contains unsafe characters. */
function validateLocale(locale: string): void {
  if (!LOCALE_PATTERN.test(locale)) {
    throw new I18nError('invalid locale');
  }
}

// ---- Loader contract ---------------------------------------------------

/**
 * A source of locale catalogs. Implementations may be sync or async.
 *
 * `load` returns `Messages` (the existing nested-map type from
 * `jsails/i18n`) so the result feeds `MessageTranslator` directly.
 */
export interface Loader {
  /** Load the merged catalog for `locale`, or `undefined` when absent. */
  load(locale: string): Promise<Messages | undefined>;

  /** Locales this loader can serve, when enumerable. */
  availableLocales(): Promise<readonly string[]>;

  /** Drop cached catalogs so the next `load` re-reads the source. */
  reload(): Promise<void>;
}

// ---- FileLoaderOptions ---------------------------------------------------

/**
 * Options for {@link createFileLoader}.
 *
 * `readFile` and `readDir` are injectable for tests; both default to
 * `node:fs/promises`.
 */
export interface FileLoaderOptions {
  /** Directories searched in order for a locale's files. */
  readonly loadPaths: readonly string[];

  /** File extensions to read, in order. Defaults to `['.json', '.mjs']`. */
  readonly extensions?: readonly string[];

  /** Injectable reader for tests; defaults to `node:fs/promises`. */
  readonly readFile?: (path: string) => Promise<string>;

  /** Injectable directory lister for tests; defaults to `node:fs/promises`. */
  readonly readDir?: (path: string) => Promise<readonly string[]>;
}

// ---- Deep merge ----------------------------------------------------------

/**
 * Recursively merge `overlay` into `base`.
 *
 * - A leaf (string) in `overlay` replaces a leaf in `base`.
 * - A map in `overlay` merges recursively into a map in `base`.
 * - A type mismatch (leaf vs map) throws {@link I18nError} value-free.
 */
export function deepMerge(base: Messages, overlay: Messages): Messages {
  const result: Record<string, string | Messages> = { ...base };

  for (const key of Object.keys(overlay)) {
    const baseValue = base[key];
    const overlayValue = overlay[key];
    if (overlayValue === undefined) continue;

    if (typeof overlayValue === 'string') {
      if (baseValue !== undefined && typeof baseValue !== 'string') {
        throw new I18nError('catalog shape conflict');
      }
      result[key] = overlayValue;
      continue;
    }

    // overlayValue is a Messages object.
    if (typeof overlayValue === 'object' && overlayValue !== null) {
      if (baseValue !== undefined) {
        if (typeof baseValue === 'string') {
          throw new I18nError('catalog shape conflict');
        }
        result[key] = deepMerge(baseValue, overlayValue);
      } else {
        result[key] = overlayValue;
      }
    }
  }

  return result;
}

// ---- File loader implementation -----------------------------------------

/** Assert that a JSON-parsed value is a non-array object. */
function isMessagesLike(value: unknown): value is Messages {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Build a file-system-backed `Loader` that reads locale catalogs from
 * `loadPaths` using two catalog shapes (flat and nested group files),
 * deep-merged with later load paths winning on key conflicts.
 *
 * Results are cached per locale; `reload()` clears the cache.
 */
export function createFileLoader(options: FileLoaderOptions): Loader {
  if (options.loadPaths.length === 0) {
    throw new I18nError('invalid load path');
  }

  const loadPaths = options.loadPaths;
  const extensions = options.extensions ?? ['.json', '.mjs'];

  // Resolve injectable readers lazily so the defaults (fs) aren't
  // forced at module import time for callers that inject.
  const resolveReadFile = (): ((path: string) => Promise<string>) =>
    options.readFile ?? ((path: string) => fsReadFile(path, 'utf-8'));

  const resolveReadDir = (): ((path: string) => Promise<readonly string[]>) =>
    options.readDir ?? ((path: string) => fsReaddir(path));

  const cache = new Map<string, Messages>();

  /** Try reading a flat file `<loadPath>/<locale><ext>`. */
  async function loadFlatFile(
    locale: string,
    loadPath: string,
    ext: string,
    readFile: (p: string) => Promise<string>,
  ): Promise<Messages | undefined> {
    try {
      const content = await readFile(`${loadPath}/${locale}${ext}`);
      const parsed: unknown = JSON.parse(content);
      return isMessagesLike(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  /** Try reading a group directory `<loadPath>/<locale>/`. */
  async function loadGroupDirectory(
    locale: string,
    loadPath: string,
    readFile: (p: string) => Promise<string>,
    readDir: (p: string) => Promise<readonly string[]>,
  ): Promise<Messages | undefined> {
    const dirPath = `${loadPath}/${locale}`;

    let entries: readonly string[];
    try {
      entries = await readDir(dirPath);
    } catch {
      return undefined;
    }

    const groupMessages: Record<string, Messages> = {};

    for (const entry of entries) {
      const matchingExt = extensions.find((e) => entry.endsWith(e));
      if (matchingExt === undefined) continue;

      const stem = entry.slice(0, -matchingExt.length);
      if (stem.length === 0) continue;

      try {
        const content = await readFile(`${dirPath}/${entry}`);
        const parsed: unknown = JSON.parse(content);
        if (isMessagesLike(parsed)) {
          groupMessages[stem] = parsed;
        }
      } catch {
        // Skip unreadable files.
      }
    }

    if (Object.keys(groupMessages).length === 0) return undefined;
    return groupMessages;
  }

  /** Core resolution: flat files then group directories, per loadPath. */
  async function loadLocale(locale: string): Promise<Messages | undefined> {
    validateLocale(locale);

    const readFile = resolveReadFile();
    const readDir = resolveReadDir();

    let merged: Messages | undefined;

    // 1. Flat files per loadPath (first matching extension wins per path).
    for (const loadPath of loadPaths) {
      for (const ext of extensions) {
        const flat = await loadFlatFile(locale, loadPath, ext, readFile);
        if (flat !== undefined) {
          merged = merged === undefined ? flat : deepMerge(merged, flat);
          break; // First matching extension wins per loadPath.
        }
      }
    }

    // 2. Nested group directories per loadPath.
    for (const loadPath of loadPaths) {
      const group = await loadGroupDirectory(locale, loadPath, readFile, readDir);
      if (group !== undefined) {
        merged = merged === undefined ? group : deepMerge(merged, group);
      }
    }

    return merged;
  }

  return {
    async load(locale: string): Promise<Messages | undefined> {
      const cached = cache.get(locale);
      if (cached !== undefined) return cached;

      const catalog = await loadLocale(locale);
      if (catalog !== undefined) {
        cache.set(locale, catalog);
      }
      return catalog;
    },

    async availableLocales(): Promise<readonly string[]> {
      const locales = new Set<string>();
      const readDir = resolveReadDir();

      for (const loadPath of loadPaths) {
        let dirEntries: readonly string[];
        try {
          dirEntries = await readDir(loadPath);
        } catch {
          continue;
        }

        // Flat files.
        for (const entry of dirEntries) {
          const ext = extensions.find((e) => entry.endsWith(e));
          if (ext !== undefined) {
            const stem = entry.slice(0, -ext.length);
            if (LOCALE_PATTERN.test(stem)) {
              locales.add(stem);
            }
          }
        }

        // Group directories: a locale-stem directory with content files.
        for (const entry of dirEntries) {
          if (LOCALE_PATTERN.test(entry)) {
            try {
              await readDir(`${loadPath}/${entry}`);
              locales.add(entry);
            } catch {
              // Not a directory (probably a file whose name matches the locale
              // pattern but is not a locale directory — ignore).
            }
          }
        }
      }

      return [...locales].sort();
    },

    async reload(): Promise<void> {
      cache.clear();
    },
  };
}
