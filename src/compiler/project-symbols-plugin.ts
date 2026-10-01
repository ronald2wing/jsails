/**
 * The jsails-autoload Vite/Rolldown plugin: a `buildStart` / `transform`
 * pipeline that injects import declarations into transformed modules from a
 * precomputed autoload registry.
 *
 * The registry is produced by the standalone `jsails build:meta` step, which
 * walks the authoring tree once and writes `.jsails/autoload.json` (alongside
 * the ambient `.jsails/project-symbols.*.d.ts` declarations that feed `tsc`). This
 * plugin is a **consumer** of that artifact: `buildStart` reads and parses the
 * JSON once, and `transform` only consults the cached symbol index.
 *
 * Standalone fallback: when the artifact is absent — a bare Vite build with no
 * preceding `build:meta` — `buildStart` falls back to a source-level
 * {@link scanAutoload} so the exported plugin still works on its own. A present
 * but malformed artifact is **not** silently ignored; it throws a value-free
 * {@link AutoloadError}, because a corrupt generated file is a build bug.
 *
 * Construction is inert: no files are read and no directories are walked until
 * the build hooks fire.
 *
 * Mirror {@link serverDirectivePlugin} in shape (enforce: 'pre', CSS_QUERY
 * guard, applies() gating, null-on-skip) so the two transforms compose safely.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cwd } from 'node:process';

import {
  AutoloadError,
  parseAutoloadJson,
  scanAutoload,
  type AutoloadContext,
  type AutoloadSymbolIndex,
} from './project-symbols-scan.js';
import { injectAutoloadImports, type AutoloadInjectionResult } from './project-symbols-imports.js';

/* ------------------------------------------------------------------ */
/*  Options                                                            */
/* ------------------------------------------------------------------ */

export interface AutoloadPluginOptions {
  /** Project root directory. Defaults to `process.cwd()`. */
  readonly rootDir?: string;
  /**
   * Extensions the transform applies to. Defaults to the TypeScript/JSX set
   * the authoring surface uses (`.ts`, `.tsx`, `.mts`, `.mtsx`, `.jsx`, `.js`).
   */
  readonly include?: readonly string[];
  /**
   * When `true`, context selection is inverted: modules are treated as
   * server-context (seeing `app` + `server` symbols). Defaults to `false`,
   * which selects context by id path (modules under a `server/` segment get
   * `'server'`; everything else gets `'app'`).
   */
  readonly server?: boolean;
}

const DEFAULT_INCLUDE = Object.freeze(['.ts', '.tsx', '.mts', '.mtsx', '.jsx', '.js']);

/** The synthetic id Vite passes for CSS/asset requests that must never be parsed. */
const CSS_QUERY = /\.(css|scss|sass|less|styl)(\?|$)/i;

/** True when `id` (a Vite module id, possibly with a query) matches one of the extensions. */
function applies(id: string, include: readonly string[]): boolean {
  if (CSS_QUERY.test(id)) {
    return false;
  }
  const clean = id.split('?')[0] ?? id;
  return include.some((extension) => clean.endsWith(extension));
}

/* ------------------------------------------------------------------ */
/*  Plugin                                                             */
/* ------------------------------------------------------------------ */

/**
 * Build the autoload plugin. `buildStart` reads the precomputed registry once
 * (falling back to a source scan) and caches the symbol index; `transform`
 * injects imports from it.
 */
export function autoloadPlugin(options: AutoloadPluginOptions = {}): {
  name: string;
  enforce: 'pre';
  buildStart(): Promise<void>;
  transform(code: string, id: string): { code: string; map: null } | null;
} {
  const include = options.include ?? DEFAULT_INCLUDE;
  const rootDir = options.rootDir ?? cwd();
  const forcedServer = options.server === true;

  let symbols: AutoloadSymbolIndex | null = null;

  return {
    name: 'jsails-autoload',
    enforce: 'pre',

    async buildStart() {
      symbols = await loadRegistry(rootDir);
    },

    transform(code, id) {
      if (symbols === null) {
        return null;
      }

      if (!applies(id, include)) {
        return null;
      }

      const context: AutoloadContext = forcedServer
        ? 'server'
        : isServerModule(id)
          ? 'server'
          : 'app';

      const result: AutoloadInjectionResult | null = injectAutoloadImports(code, {
        fileName: id,
        symbols,
        context,
      });

      if (result === null) {
        return null;
      }

      return { code: result.code, map: null };
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Context selection                                                  */
/* ------------------------------------------------------------------ */

/**
 * True when a module id's path contains a `server/` segment (agnostic to
 * platform separators).
 */
function isServerModule(id: string): boolean {
  return /[/\\]server[/\\]/.test(id);
}

/* ------------------------------------------------------------------ */
/*  Registry loading                                                   */
/* ------------------------------------------------------------------ */

const JSAILS_DIR = '.jsails';
const AUTOLOAD_JSON = 'autoload.json';

/**
 * Resolve the symbol index `transform` consumes. The precomputed
 * `.jsails/autoload.json` from `jsails build:meta` is preferred; when it is
 * absent, fall back to a standalone source scan (a bare Vite build).
 */
async function loadRegistry(rootDir: string): Promise<AutoloadSymbolIndex> {
  const document = readAutoloadDocument(rootDir);
  if (document === null) {
    return (await scanAutoload(rootDir)).byName;
  }
  return parseAutoloadJson(document, rootDir).byName;
}

/**
 * Read and parse `.jsails/autoload.json`, returning the raw document for
 * {@link parseAutoloadJson} to validate. Returns `null` only when the artifact
 * does not exist; a corrupt artifact throws rather than degrading silently.
 */
function readAutoloadDocument(rootDir: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(join(rootDir, JSAILS_DIR, AUTOLOAD_JSON), 'utf8');
  } catch (error) {
    if (isMissingFile(error)) {
      return null; // no `build:meta` ran — the caller falls back to a scan.
    }
    throw new AutoloadError('invalid_registry', `could not read "${AUTOLOAD_JSON}"`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new AutoloadError('invalid_registry', `invalid autoload registry "${AUTOLOAD_JSON}"`);
  }
}

/** True for a filesystem error reporting the file does not exist. */
function isMissingFile(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
  );
}
