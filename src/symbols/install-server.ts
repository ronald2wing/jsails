/**
 * Runtime installer for the framework-symbol globals.
 *
 * A JSails author writes `class Post extends ApplicationRecord` with no import;
 * the emitted JavaScript resolves `ApplicationRecord` against `globalThis`. This
 * module installs those globals by importing the app's generated
 * `.jsails/framework-symbols.js` — the runtime symbol table `build:meta` derives
 * from the framework's own barrels — and projecting each entry onto `globalThis`.
 *
 * **Why the table is generated, not checked in.** The set of framework globals
 * is a property of the framework's barrels. Deriving it at the app's `build:meta`
 * step (from the installed framework's `.d.ts`, or from source in-repo) means it
 * can never drift from the barrels it describes, and the app's declaration
 * (`all` / `selected` / `none`) is resolved once, at build, not at every start.
 *
 * **Why dynamic import.** ESM has no synchronous module-load hook, so the
 * installer is `async` and must be awaited before any app module evaluates. The
 * CLI bootstrap awaits {@link installFrameworkSymbols} at process start, before
 * it imports the app config or any discovered module. A module that reaches a
 * framework global without the installer having run throws `ReferenceError` —
 * the same failure a missing import produces, which is the honest signal.
 *
 * **Why not lazy getters.** A `globalThis` accessor cannot synchronously import
 * (dynamic import is async), so a per-symbol lazy getter is impossible. The
 * installer loads the whole declared set once, up front. The set is small and
 * each subpath is a barrel the process would load anyway; the cost is bounded
 * and paid once, not per request.
 *
 * Idempotent: a repeated call re-imports (module cache makes it cheap) and
 * reassigns the same values.
 *
 * This module imports only the projection engine; the subpaths themselves are
 * loaded dynamically, so importing this module does not pull the framework graph.
 *
 * **Collision policy (§11.4).** When more than one entry in the global table
 * declares the same bare `name`, the first entry in table order wins the bare
 * slot. Every distinct subpath whose symbols collide additionally gets a
 * **namespace object** installed on `globalThis` under a key derived from the
 * subpath's last path segment (e.g. `jsails/content` → `content`), so the
 * symbol is reachable as `content.readingTime`. When a bare name is unique,
 * no namespace object is created — the common-case surface stays clean.
 *
 * **Why the namespace key is a path segment, not a dotted string.** The
 * planner's draft (§11.6) used `globalThis['content.readingTime']` — a single
 * property whose name contains a dot, unreachable by property access. The
 * correct form is `globalThis.content = { readingTime, ... }`, a real object
 * reachable as `content.readingTime`. This file implements the correct form.
 *
 * **Why no token install.** Operation and event tokens are resolved internally
 * by the name→token registry in `src/extensions/interceptors.ts`; a consumer
 * reaches `intercept` (an autoloaded framework global) and passes a string.
 * Tokens are never installed on `globalThis` (§11.2).
 *
 * **Plugin-symbol installation is NOT here.** This installer is called at CLI
 * bootstrap with only the framework table. Third-party plugin symbols are
 * installed at app assembly time (a later wave), where the full merged table
 * (framework + plugin descriptors) is available.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { FrameworkSymbol } from './framework-symbols.js';
import { distinctFrameworkSymbolSpecifiers, projectFrameworkSymbols } from './projection.js';
import type { FrameworkSymbolOrigin, FrameworkSymbolOverrideWarning } from './projection.js';

// Re-exported for the `jsails/symbols` barrel and the projection's consumers;
// the canonical definitions live in the node-free engine module so the browser
// projection shares them.
export type { FrameworkSymbolOrigin, FrameworkSymbolOverrideWarning };

/* ------------------------------------------------------------------ */
/*  Installation                                                       */
/* ------------------------------------------------------------------ */

/** The generated framework-symbol table, relative to the project root. */
const FRAMEWORK_SYMBOLS_ENTRY = join('.jsails', 'framework-symbols.js');

/**
 * Options for {@link installFrameworkSymbols}. Every field is optional; when
 * absent, the app's generated table and `import()` are used. Inject `globals`
 * and `loadModule` to test collision paths against a synthetic table without
 * importing the real framework modules.
 */
export interface InstallFrameworkSymbolsOptions {
  /**
   * The global table to install. Defaults to the app's generated
   * `.jsails/framework-symbols.js`; inject a synthetic table to test collision
   * paths without a generated artifact.
   */
  readonly globals?: readonly FrameworkSymbol[];
  /**
   * Module loader: receives a specifier, returns the exported namespace.
   * Defaults to `(specifier) => import(specifier)`.
   */
  readonly loadModule?: (specifier: string) => Promise<Record<string, unknown>>;
  /**
   * Sink for override warnings. Defaults to `console.warn`. Inject a collector
   * to assert warnings without capturing stderr, or a no-op to silence them.
   */
  readonly onWarn?: (warning: FrameworkSymbolOverrideWarning) => void;
  /**
   * Origin label applied to every entry of `globals` when it is not derived
   * from the entry's specifier. Framework globals derive
   * `framework:<specifier>` themselves; this exists for plugin projections
   * (`plugin:<name>`) that share the projection engine.
   */
  readonly origin?: FrameworkSymbolOrigin;
}

/**
 * Install every framework global on `globalThis`.
 *
 * Reads the app's generated `.jsails/framework-symbols.js` (written by
 * `build:meta`) and projects its table. A project that has not run `build:meta`
 * has no such file; that is not an error — the file is simply absent and the
 * project relies on explicit imports, exactly as for project symbols.
 *
 * When every declared name is unique, installs only bare names. When a name
 * collides (more than one entry declares it), the first entry in table order
 * wins the bare slot and a **namespace object** is installed for each distinct
 * subpath whose symbols collide, keyed by a segment derived from the subpath
 * (e.g. `globalThis.content = { readingTime, ... }`).
 *
 * **Override policy.** A bare name whose slot already holds a *different* value
 * is replaced, but first a {@link FrameworkSymbolOverrideWarning} is emitted naming what
 * was lost (`from`) and what won (`over`). An identical re-install is silent,
 * so the call is idempotent without noise. The installer never throws on an
 * override and never suppresses one — a later projection wins, transparently.
 *
 * Awaits one dynamic import per distinct subpath. Throws a value-free error
 * when a declared symbol is missing from its subpath — that is a framework bug,
 * not a user error, and must fail loudly rather than leave a bare name
 * unresolved.
 */
export async function installFrameworkSymbols(
  rootDir: string,
  options?: InstallFrameworkSymbolsOptions,
): Promise<void> {
  const globals = options?.globals ?? (await loadFrameworkSymbolTable(rootDir));
  if (globals.length === 0) {
    return;
  }
  const loadModule =
    options?.loadModule ??
    ((specifier: string) => import(specifier) as Promise<Record<string, unknown>>);

  const modules = new Map<string, Record<string, unknown>>();
  for (const specifier of distinctFrameworkSymbolSpecifiers(globals)) {
    modules.set(specifier, await loadModule(specifier));
  }

  projectFrameworkSymbols({
    globals,
    modules,
    ...(options?.onWarn ? { onWarn: options.onWarn } : {}),
    ...(options?.origin ? { origin: options.origin } : {}),
  });
}

/**
 * Read the app's generated framework-symbol table. Returns an empty table when
 * `build:meta` has not run — the same "absent is not an error" contract as
 * {@link installProjectSymbols}.
 */
async function loadFrameworkSymbolTable(rootDir: string): Promise<readonly FrameworkSymbol[]> {
  const tablePath = join(rootDir, FRAMEWORK_SYMBOLS_ENTRY);
  if (!existsSync(tablePath)) {
    return [];
  }
  const module = (await import(pathToFileURL(tablePath).href)) as {
    FRAMEWORK_SYMBOLS?: readonly FrameworkSymbol[];
  };
  return module.FRAMEWORK_SYMBOLS ?? [];
}

/* ------------------------------------------------------------------ */
/*  Project globals                                                    */
/* ------------------------------------------------------------------ */

/** The generated preload entry point, relative to the project root. */
const PROJECT_SYMBOLS_ENTRY = join('.jsails', 'project-symbols.js');

/** Value-free failure raised while installing the generated project globals. */
export type SymbolsInstallErrorCode = 'stale_project_globals';

export class SymbolsInstallError extends Error {
  readonly code: SymbolsInstallErrorCode;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SymbolsInstallError';
    this.code = 'stale_project_globals';
  }
}

/**
 * Install the project's autoloaded symbols by importing the generated
 * `<rootDir>/.jsails/project-symbols.js`, which imports every shim in dependency
 * order and publishes each project symbol onto `globalThis`.
 *
 * A project that has not run `build:meta` (or has no autoloadable symbols) has
 * no `project-symbols.js`; that is not an error — the file is simply absent and
 * the project relies on explicit imports. The import is dynamic so the generated
 * file is evaluated only when it exists, and awaited so every symbol is
 * installed before the caller imports an app module.
 *
 * **Stale artifact.** `.jsails/project-symbols.js` exists but the compiled
 * modules its shims import (`dist/…`, or the configured `compiledRoot`) are
 * missing — a common state after `rm -rf dist` or a fresh clone of a committed
 * `.jsails`. Node raises `ERR_MODULE_NOT_FOUND` from deep inside a generated
 * shim, which names neither the cause nor the fix. We reframe only that code as
 * an actionable {@link SymbolsInstallError}; every other failure (a syntax error
 * in a real module, a transitive import error) propagates unchanged so it is not
 * mislabelled as staleness.
 */
export async function installProjectSymbols(rootDir: string): Promise<void> {
  const globalsPath = join(rootDir, PROJECT_SYMBOLS_ENTRY);
  if (!existsSync(globalsPath)) {
    return;
  }
  try {
    await import(pathToFileURL(globalsPath).href);
  } catch (error) {
    if (isModuleNotFoundError(error)) {
      throw new SymbolsInstallError(
        `project globals at "${PROJECT_SYMBOLS_ENTRY}" reference compiled modules that are ` +
          'missing; rebuild the project (e.g. `jsails build:meta`) before starting',
        { cause: error },
      );
    }
    throw error;
  }
}

/** Narrow a caught value to a Node module-resolution failure. */
function isModuleNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'ERR_MODULE_NOT_FOUND'
  );
}
