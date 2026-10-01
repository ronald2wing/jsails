/**
 * Static enumeration of the framework's own global-symbol catalog.
 *
 * The catalog — every public value the framework projects onto `globalThis` —
 * is a property of the **framework**, not of any app that consumes it. It is
 * derived from the framework's own barrels at the app's `build:meta` step and
 * emitted into `.jsails/` (the runtime table and the ambient declarations), so
 * it can never drift from the barrels it describes and nothing is checked in.
 *
 * This module is the derivation engine. It parses each public subpath's barrel
 * **statically** — with the same `parseSync` front end `model-extract` uses —
 * never importing it. Barrel imports pull `bullmq`, `socket.io`, `better-auth`,
 * and `vite`; a build scan that imported a module would turn a syntax-level
 * discovery pass into a runtime dependency, exactly the failure `meta-scan`
 * documents. So export names are read from syntax: an inline
 * `export const X`, an `export { A, B as C }`, and a local
 * `export * from './x.js'` (followed transitively). An `export *` from an
 * **external** package (e.g. `preact/jsx-runtime`) is deliberately **not**
 * followed — those names belong to the dependency, not to the framework, and
 * projecting them as if they were framework globals is the pollution the
 * warning model exists to avoid. Such a star is recorded as skipped.
 *
 * The barrel is read from TypeScript source in-repo (`source` mode, before
 * `tsc`) or from the emitted `.d.ts` against an installed framework
 * (`declaration` mode, where only compiled output ships). Both list the same
 * exports in the same forms.
 *
 * Each subpath is classified `browser | both | server` by a transitive walk of
 * its **static** import graph: an eager `import`/`export … from` into a
 * `node:*` builtin or a server-only dependency marks the subpath `server`;
 * `import type` and dynamic `import()` are not eager and do not count.
 *
 * The scan is pure: it reads files and returns data. It never imports a module,
 * opens a connection, or writes anything.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { parseSync } from 'rolldown/utils';

import type {
  FrameworkSymbol,
  FrameworkSymbolTarget,
  SymbolDeclaration,
} from './framework-symbols.js';
import { applySymbolDeclaration, resolveSymbolDeclaration } from './framework-symbols.js';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

/** One value export of a public subpath, as declared by the subpath's barrel. */
export interface ScannedExport {
  /** The bare identifier as exported. `default` is excluded from the catalog. */
  readonly name: string;
  /** The public subpath it is reached through (e.g. `jsails/models`). */
  readonly specifier: string;
  /** The runtime(s) this subpath may be projected into. */
  readonly target: FrameworkSymbolTarget;
}

/** An `export * from` whose target could not be enumerated, and why. */
export interface SkippedStar {
  /** The public subpath whose barrel carries the star. */
  readonly specifier: string;
  /** The star's source as written (e.g. `preact/jsx-runtime`). */
  readonly source: string;
  /** `external` — a non-relative specifier, not followed by design. */
  readonly reason: 'external';
}

/** The full scan result. */
export interface FrameworkCatalogScan {
  /** Every value export across every public subpath, in barrel-declaration order. */
  readonly exports: readonly ScannedExport[];
  /** External `export *` sources that were not followed. */
  readonly skippedStars: readonly SkippedStar[];
}

/** A resolved public subpath: its key and the TS source file of its barrel. */
export interface ResolvedSubpath {
  /** The bare subpath key, e.g. `models` (no `./`). */
  readonly name: string;
  /** The `jsails`-prefixed specifier authors import from, e.g. `jsails/models`. */
  readonly specifier: string;
  /** Absolute path to the barrel's TypeScript source. */
  readonly file: string;
}

/** Options for {@link resolvePublicSubpaths} and {@link scanFrameworkCatalog}. */
export interface ScanFrameworkCatalogOptions {
  /** Absolute path to the repo root (holds `package.json` and `src/`). */
  readonly rootDir: string;
  /**
   * Which barrel files to read. `source` (default) reads the TypeScript source
   * (`src/**\/index.ts`) — used in-repo, before `tsc`. `declaration` reads the
   * emitted `.d.ts` (`dist/**\/index.d.ts`) — used against an installed
   * framework, where only compiled output ships. Both list the same exports in
   * the same `export { X } from './y.js'` / `export *` forms.
   */
  readonly sourceKind?: 'source' | 'declaration';
}

/* ------------------------------------------------------------------ */
/*  Subpath resolution                                                 */
/* ------------------------------------------------------------------ */

/** One entry of `package.json` `exports`, in either string or conditions form. */
type ExportsEntry = string | Record<string, string>;

/**
 * Resolve every public subpath to its barrel file.
 *
 * A subpath's `exports` entry points at `./dist/src/<...>/index.js` (and its
 * `.d.ts` sibling). In `source` mode the barrel is the same path rooted at
 * `src/` with a source extension — strip a leading `dist/`, strip the JS
 * extension, and probe `.ts` then `.tsx`. In `declaration` mode the barrel is
 * the emitted `.d.ts` beside the compiled `.js` — the same path with a `.d.ts`
 * extension. Resolving to source (not `dist`) is what lets the scan run
 * **before** `tsc` in-repo; resolving to `.d.ts` is what lets it run against an
 * installed framework that ships only compiled output.
 */
export function resolvePublicSubpaths(options: ScanFrameworkCatalogOptions): ResolvedSubpath[] {
  const pkg = JSON.parse(readFileSync(resolve(options.rootDir, 'package.json'), 'utf8')) as {
    exports?: Record<string, ExportsEntry>;
  };
  const entries = pkg.exports ?? {};
  const sourceKind = options.sourceKind ?? 'source';
  const resolved: ResolvedSubpath[] = [];

  for (const [key, value] of Object.entries(entries)) {
    if (key === './package.json' || key === '.') {
      continue;
    }
    const name = key.replace(/^\.\//, '');
    const rel = typeof value === 'string' ? value : (value.import ?? value.types ?? value.default);
    if (rel === undefined) {
      continue;
    }
    const file = resolveBarrelFile(options.rootDir, rel, sourceKind);
    resolved.push({ name, specifier: `jsails/${name}`, file });
  }

  resolved.sort((a, b) => (a.specifier < b.specifier ? -1 : a.specifier > b.specifier ? 1 : 0));
  return resolved;
}

/** Map a `./dist/src/.../index.js` export path to its barrel file for the mode. */
function resolveBarrelFile(
  rootDir: string,
  relative: string,
  sourceKind: 'source' | 'declaration',
): string {
  // Exports point at compiled output (`./dist/src/<...>/index.js`).
  const withoutDist = relative.replace(/^\.?\/?dist\//, '');
  const withoutExt = withoutDist.replace(/\.(js|mjs|cjs|d\.ts|ts|tsx)$/, '');
  if (sourceKind === 'declaration') {
    // The emitted declaration sits beside the compiled `.js` under `dist/`.
    return resolve(rootDir, 'dist', withoutExt + '.d.ts');
  }
  for (const ext of ['.ts', '.tsx']) {
    const candidate = resolve(rootDir, withoutExt + ext);
    if (fileExists(candidate)) {
      return candidate;
    }
  }
  return resolve(rootDir, withoutExt + '.ts');
}

function fileExists(path: string): boolean {
  try {
    readFileSync(path, { flag: 'r' });
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/*  Export enumeration                                                 */
/* ------------------------------------------------------------------ */

/** A minimal structural view of the OXC ESTree nodes the scan reads. */
interface EstreeNode {
  readonly type: string;
  readonly body?: EstreeNode[];
  readonly source?: { readonly value: string } | null;
  readonly exported?: { readonly name?: string } | null;
  readonly declaration?: EstreeNode | null;
  readonly specifiers?: EstreeNode[];
  readonly local?: { readonly name?: string };
  readonly exportKind?: string;
  readonly importKind?: string;
  readonly id?: { readonly name?: string };
  readonly declarations?: readonly { readonly id?: { readonly name?: string } }[];
}

/**
 * Enumerate the **value** export names of one barrel, following local
 * `export *` transitively. Type-only specifiers (`export type { X }`) and the
 * `default` re-export alias are excluded — `default` is a barrel convenience
 * (`export { XPlugin as default }`), never a name an author writes bare.
 *
 * External `export *` sources are recorded in `skipped` and not followed.
 */
function enumerateBarrel(
  file: string,
  specifier: string,
  skipped: SkippedStar[],
  sourceKind: 'source' | 'declaration',
): string[] {
  const code = readFileSync(file, 'utf8');
  const program = parseModule(code, file);
  const names: string[] = [];
  const seen = new Set<string>();

  for (const node of program.body ?? []) {
    switch (node.type) {
      case 'ExportNamedDeclaration': {
        // `export type { X }` and `export interface I {}` mark the whole
        // declaration type-only; its specifiers/declaration carry no usable
        // value kind of their own. Check the kind BEFORE extracting an inline
        // name — else `export interface I {}` leaks a non-existent value.
        if (node.exportKind === 'type') {
          break;
        }
        const inline = inlineDeclarationName(node.declaration);
        if (inline !== undefined) {
          pushUnique(names, seen, inline);
        }
        for (const spec of node.specifiers ?? []) {
          if (spec.exportKind === 'type') {
            continue;
          }
          const exported = spec.exported?.name ?? spec.local?.name;
          if (exported !== undefined && exported !== 'default') {
            pushUnique(names, seen, exported);
          }
        }
        break;
      }
      case 'ExportAllDeclaration': {
        const src = node.source?.value;
        if (src === undefined) {
          break;
        }
        if (node.exported?.name !== undefined) {
          // `export * as ns` — the namespace name is the export.
          pushUnique(names, seen, node.exported.name);
          break;
        }
        if (src.startsWith('.')) {
          const nested = resolveRelative(file, src, sourceKind);
          for (const name of enumerateBarrel(nested, specifier, skipped, sourceKind)) {
            pushUnique(names, seen, name);
          }
        } else {
          skipped.push({ specifier, source: src, reason: 'external' });
        }
        break;
      }
      default:
        break;
    }
  }

  return names;
}

/** The declared name of an inline `export const/function/class` declaration. */
function inlineDeclarationName(declaration: EstreeNode | null | undefined): string | undefined {
  if (declaration === null || declaration === undefined) {
    return undefined;
  }
  // `export function f`/`export class C` carry the name on the declaration
  // itself; `export const x`/`let`/`var` wrap one or more names one level deeper
  // in `declarations[].id`. A single-name `const` is the common barrel form.
  const direct = declaration.id?.name;
  if (direct !== undefined) {
    return direct !== 'default' ? direct : undefined;
  }
  const first = declaration.declarations?.[0]?.id?.name;
  return first !== undefined && first !== 'default' ? first : undefined;
}

function pushUnique(list: string[], seen: Set<string>, name: string): void {
  if (!seen.has(name)) {
    seen.add(name);
    list.push(name);
  }
}

function parseModule(code: string, fileName: string): EstreeNode {
  const result = parseSync(fileName, code, { sourceType: 'module' });
  if (result.errors.some((error) => error.severity === 'Error')) {
    throw new Error(`framework catalog: unparseable barrel (${fileName})`);
  }
  return result.program as unknown as EstreeNode;
}

/** Resolve a relative `./x.js` import specifier to its barrel file for the mode. */
function resolveRelative(
  fromFile: string,
  specifier: string,
  sourceKind: 'source' | 'declaration',
): string {
  const base = resolve(dirname(fromFile), specifier);
  const withoutExt = base.replace(/\.(js|mjs|cjs|ts|tsx|d\.ts)$/, '');
  if (sourceKind === 'declaration') {
    return withoutExt + '.d.ts';
  }
  for (const ext of ['.ts', '.tsx']) {
    const candidate = withoutExt + ext;
    if (fileExists(candidate)) {
      return candidate;
    }
  }
  return withoutExt + '.ts';
}

/* ------------------------------------------------------------------ */
/*  Target classification                                              */
/* ------------------------------------------------------------------ */

/** A node builtin (`node:fs`) — never bundleable in a browser. */
const SERVER_MODULE_PREFIX = 'node:';

/**
 * The **authored** set of browser-safe public subpaths — the single source of
 * truth for the `browser` classification.
 *
 * Browser-safety is a decision, not an emergent property. The import graph can
 * prove a barrel is *server-bound* (it eagerly reaches `node:*` or a server
 * package), but it can never prove a barrel is *server-only by intent*: a
 * subpath that eagerly imports only relative modules and `hono`/`zod` is
 * statically bundleable and still semantically a server module. Inferring
 * browser-safety from the graph therefore gets it wrong in exactly the cases
 * that matter — `jsails/introspect` registered a live Hono route over the
 * request pipeline, yet was classified `both` the moment a server-side import
 * was refactored away.
 *
 * So the browser set is **named here**, and the graph walk is a *validator* of
 * that declaration ({@link assertBrowserSafeSubpathsBundleable}), never the
 * classifier. A subpath absent from this set is `server` — the conservative
 * default — so forgetting to list a browser-safe subpath fails closed (it loses
 * its browser globals, a visible omission) rather than leaking a server module
 * into the client bundle.
 *
 * Deliberately **not** the authority for the runtime loader map: the browser
 * installer needs literal `() => import('…')` specifiers a bundler can see, so
 * its map stays hand-written and a test asserts its keys equal this set. One
 * authored list, verified in two places.
 */
const BROWSER_SAFE_SUBPATHS: ReadonlySet<string> = new Set([
  'jsails/api',
  'jsails/broadcast/client',
  'jsails/cache',
  'jsails/client',
  'jsails/client/model',
  'jsails/extensions',
  'jsails/http',
  'jsails/i18n',
  'jsails/logging',
  'jsails/mail',
  'jsails/notifications',
  'jsails/render-to-string',
  'jsails/signals',
  'jsails/support',
  'jsails/theme',
  'jsails/validation',
]);

/**
 * External packages a browser-safe subpath may statically import. This is the
 * allowlist the **validator** ({@link assertBrowserSafeSubpathsAreBundleable})
 * checks a declared-browser-safe barrel's graph against: an eager reach into any
 * package not named here (or into `node:*`) means the declaration is false.
 *
 * An allowlist, not a denylist: the validator cannot know whether an arbitrary
 * package is browser-safe, so anything not named here is treated as server.
 * Every entry is a browser or isomorphic library: Preact and its runtimes,
 * signals, the Turbo client, the Socket.IO browser client, Zod, and Hono
 * (edge/browser-capable). Server packages (`typeorm`, `kysely`, `mysql2`, `pg`,
 * `nodemailer`, `bullmq`, `ioredis`, `better-auth`, `vite`, `shiki`,
 * `markdown-it`, `gray-matter`, `reflect-metadata`, `sql.js`, `sitemap`,
 * `unhead`, `rolldown`, …) are omitted so a barrel reaching them fails
 * validation.
 */
const BROWSER_SAFE_DEPENDENCIES: ReadonlySet<string> = new Set([
  'preact',
  'preact/hooks',
  'preact/jsx-runtime',
  'preact-render-to-string',
  '@preact/signals',
  '@preact/signals-core',
  '@hotwired/turbo',
  'socket.io-client',
  'zod',
  'hono',
  'base64-js',
  'change-case',
  'date-fns',
  'defu',
  'dinero.js',
  'dinero.js/currencies',
  'es-toolkit',
  'es-toolkit/compat',
  'fast-deep-equal',
  'klona',
  'ms',
  'p-limit',
  'p-map',
  'p-retry',
  'pluralize',
  'pretty-bytes',
  'pretty-ms',
  'qs',
  'slugify',
]);

/**
 * Whether a barrel's **static** import graph reaches a `node:*` builtin or a
 * bare package outside the {@link BROWSER_SAFE_DEPENDENCIES} allowlist.
 *
 * This is a **bundleability probe**, not a classifier. It answers one question:
 * "would a browser bundle be able to include this?" A `true` result proves the
 * barrel is server-bound. A `false` result proves only that it *could* bundle —
 * not that it *should*. Intent lives in {@link BROWSER_SAFE_SUBPATHS}; this
 * function validates that declaration.
 */
function barrelReachesServer(
  entryFile: string,
  sourceKind: 'source' | 'declaration' = 'source',
): boolean {
  const visited = new Set<string>();
  const queue = [entryFile];

  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (visited.has(file)) {
      continue;
    }
    visited.add(file);

    let code: string;
    try {
      code = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const program = parseModule(code, file);

    for (const specifier of staticSpecifiers(program)) {
      if (specifier.startsWith(SERVER_MODULE_PREFIX)) {
        return true;
      }
      if (specifier.startsWith('.')) {
        queue.push(resolveRelative(file, specifier, sourceKind));
        continue;
      }
      // A bare specifier: browser-safe only if explicitly allowlisted. Anything
      // unknown (including server packages the allowlist does not know) fails
      // safe to `server`.
      if (!BROWSER_SAFE_DEPENDENCIES.has(specifier)) {
        return true;
      }
    }
  }

  return false;
}

/** The eager import/export specifiers of a parsed module (type-only excluded). */
function staticSpecifiers(program: EstreeNode): string[] {
  const specifiers: string[] = [];
  for (const node of program.body ?? []) {
    if (node.type === 'ImportDeclaration') {
      // An import is eager unless the whole declaration is `import type`.
      const src = node.source?.value;
      if (src !== undefined && node.importKind !== 'type') {
        specifiers.push(src);
      }
    } else if (node.type === 'ExportNamedDeclaration') {
      const src = node.source?.value;
      if (src !== undefined && node.exportKind !== 'type') {
        specifiers.push(src);
      }
    } else if (node.type === 'ExportAllDeclaration') {
      const src = node.source?.value;
      if (src !== undefined && node.exportKind !== 'type') {
        specifiers.push(src);
      }
    }
  }
  return specifiers;
}

/* ------------------------------------------------------------------ */
/*  Public scan                                                        */
/* ------------------------------------------------------------------ */

/**
 * Scan every public subpath and return its value exports with a target.
 * Deterministic: subpaths are specifier-sorted, exports keep barrel order.
 *
 * Subpaths named by {@link PROJECTION_INFRASTRUCTURE_SPECIFIERS} are skipped:
 * they exist to *drive* the projection (installers, catalogs), so projecting
 * their own exports onto `globalThis` would be nonsense ergonomics and would
 * make the browser installer load itself.
 */
export function scanFrameworkCatalog(options: ScanFrameworkCatalogOptions): FrameworkCatalogScan {
  const subpaths = resolvePublicSubpaths(options);
  const sourceKind = options.sourceKind ?? 'source';
  const exports: ScannedExport[] = [];
  const skippedStars: SkippedStar[] = [];

  for (const subpath of subpaths) {
    if (PROJECTION_INFRASTRUCTURE_SPECIFIERS.has(subpath.specifier)) {
      continue;
    }
    const names = enumerateBarrel(subpath.file, subpath.specifier, skippedStars, sourceKind);
    // Browser-safety is authored ({@link BROWSER_SAFE_SUBPATHS}); a subpath not
    // named there fails safe to `server`. The declaration is validated
    // separately by the drift test via {@link assertBrowserSafeSubpathsBundleable}.
    const target: FrameworkSymbolTarget = BROWSER_SAFE_SUBPATHS.has(subpath.specifier)
      ? 'both'
      : 'server';
    for (const name of names) {
      exports.push({ name, specifier: subpath.specifier, target });
    }
  }

  return { exports, skippedStars };
}

/**
 * The browser-safe subpaths declared in {@link BROWSER_SAFE_SUBPATHS}, sorted.
 * The single authority the browser installer's loader map is checked against.
 */
export function declaredBrowserSafeSubpaths(): readonly string[] {
  return [...BROWSER_SAFE_SUBPATHS].sort();
}

/**
 * Validate the {@link BROWSER_SAFE_SUBPATHS} declaration against the actual
 * barrels: every declared-browser-safe subpath must have a bundleable eager
 * import graph. Returns the offending specifiers (empty when the declaration is
 * sound).
 *
 * This is the point of inverting the default. The graph walk can only *falsify*
 * browser-safety, so it belongs after the fact: a barrel that eagerly imports
 * `node:fs` (or a server package) while being declared browser-safe is a
 * **contradiction** — the client bundle would fail at build time, or worse, pull
 * a server module in. Surfacing it here names the exact subpath and turns a
 * silent mis-classification into a loud, actionable failure.
 */
export function assertBrowserSafeSubpathsBundleable(
  options: ScanFrameworkCatalogOptions,
): string[] {
  const subpaths = resolvePublicSubpaths(options);
  const sourceKind = options.sourceKind ?? 'source';
  const bySpecifier = new Map(subpaths.map((subpath) => [subpath.specifier, subpath.file]));
  const offenders: string[] = [];
  for (const specifier of BROWSER_SAFE_SUBPATHS) {
    const file = bySpecifier.get(specifier);
    if (file === undefined) {
      // A declared browser-safe specifier with no `exports` entry is a typo or a
      // removed subpath — the declaration is stale.
      offenders.push(specifier);
      continue;
    }
    if (barrelReachesServer(file, sourceKind)) {
      offenders.push(specifier);
    }
  }
  return offenders;
}

/**
 * Subpaths that are the projection's own machinery. A projection must not
 * project itself: `installFrameworkSymbols` as a bare `globalThis` name is
 * meaningless, and the browser installer importing its own entry would be a
 * self-cycle. Excluded from both catalogs.
 */
export const PROJECTION_INFRASTRUCTURE_SPECIFIERS: ReadonlySet<string> = new Set([
  'jsails/symbols',
  'jsails/symbols/client',
]);

/* ------------------------------------------------------------------ */
/*  Derivation                                                         */
/* ------------------------------------------------------------------ */

/** Options for {@link deriveFrameworkSymbols}. */
export interface DeriveFrameworkSymbolsOptions extends ScanFrameworkCatalogOptions {
  /**
   * Which subpaths to project. **Defaults to `none`** — nothing projects unless
   * a declaration opts a set in (the framework passes its curated
   * {@link FRAMEWORK_SYMBOL_DECLARATION}). `all` projects every public subpath;
   * `selected` narrows to the named specifiers. Resolved here, at derivation
   * time, so the runtime installer receives an already-filtered table and runs
   * no declaration logic.
   */
  readonly declaration?: SymbolDeclaration;
}

/**
 * Derive the framework-symbol table for one app: scan the framework's barrels
 * and filter by the declaration. This is the single entry point `build:meta`
 * calls to produce both the runtime module and the ambient declarations, so the
 * two halves can never disagree.
 *
 * Deterministic: the scan is specifier-sorted with barrel order within a
 * subpath, and {@link applySymbolDeclaration} preserves that order.
 */
export function deriveFrameworkSymbols(
  options: DeriveFrameworkSymbolsOptions,
): readonly FrameworkSymbol[] {
  const scan = scanFrameworkCatalog(options);
  const globals: FrameworkSymbol[] = scan.exports.map((entry) => ({
    name: entry.name,
    specifier: entry.specifier,
    target: entry.target,
  }));
  return applySymbolDeclaration(globals, resolveSymbolDeclaration(options.declaration));
}
