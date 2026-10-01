/**
 * C1 autoload scanner — substrate-only (no runtime wiring).
 *
 * Scans the N1 tree (`app/`, `server/`, `shared/`) under `rootDir` for source
 * modules, reads and parses each autoloadable one, extracts its named value
 * exports, classifies each symbol's injection context (`'app'` for client+server,
 * `'server'` for server-only), resolves same-context duplicate names to a bare
 * winner plus a collision set, and returns a frozen, deterministic
 * {@link AutoloadRegistry}.
 *
 * The scan is **source-driven**: a module is parsed with `parseSync`, never
 * imported. A build scan must not execute application code — running a module's
 * top-level side effects at scan time turns a syntax-level discovery pass into a
 * runtime dependency, and the emitted declaration files feed `tsc` before any
 * module is ever evaluated. `export *` is expanded within the walked set so a
 * re-exported symbol is still injectable.
 *
 * C1 is an internal substrate consumed by C2 and the build; it has no public
 * API and nothing here is re-exported from `src/index.ts` or
 * `src/build/index.ts`. Importing this module is inert — no directories are
 * walked until {@link scanAutoload} is called.
 */

import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { parseSync } from 'rolldown/utils';

import {
  AUTOLOADABLE_PREFIXES,
  N1_DIRECTORIES,
  SOURCE_EXTENSIONS,
  type AutoloadContext,
} from './conventions.js';
import { walkLexicalFiles } from './lexical-walk.js';

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

/** Re-exported so consumers of the scanner keep importing their context type here. */
export type { AutoloadContext };

/**
 * Error codes for {@link AutoloadError}. `failed_to_parse` and
 * `invalid_symbol_name` come from scanning source; `invalid_registry` and
 * `registry_missing` come from reading the serialized artifact.
 */
export type AutoloadErrorCode =
  'failed_to_parse' | 'invalid_symbol_name' | 'invalid_registry' | 'registry_missing';

/** A single named export discovered in an autoloadable module. */
export interface AutoloadSymbol {
  readonly name: string;
  readonly context: AutoloadContext;
  /** Absolute source path; consumers rewrite the extension to its compiled form. */
  readonly file: string;
}

/** One source module in the N1 tree. */
export interface AutoloadEntry {
  readonly file: string; // absolute
  readonly relative: string; // posix-relative to rootDir
  readonly context: AutoloadContext;
  readonly autoloadable: boolean;
  readonly symbols: readonly AutoloadSymbol[];
}

/**
 * Per-name index: the same identifier may exist in both `'app'` and `'server'`
 * (disjoint injection namespaces), so the value is itself a context→symbol map.
 * A bare name→symbol map would silently drop one context.
 */
export type AutoloadSymbolIndex = ReadonlyMap<string, ReadonlyMap<AutoloadContext, AutoloadSymbol>>;

/**
 * Collision index: keyed by bare name, the value is the full duplicate set of
 * symbols that declared that name within a single context — the bare winner
 * first, then every loser, sorted by `relative` path. Only names with MORE THAN
 * ONE same-context symbol appear; the legitimate cross-context case (the same
 * name in `'app'` and `'server'`) is never a collision and stays in `byName`.
 */
export type AutoloadCollisionMap = ReadonlyMap<string, readonly AutoloadSymbol[]>;

/**
 * The resolved name index: `byName` holds the bare winner per name+context;
 * `collisions` holds the same-context duplicate sets that did not win. Both the
 * live scan ({@link buildByName}) and the serialized artifact
 * ({@link parseAutoloadJson}) produce this identical shape.
 */
export interface AutoloadResolvedIndex {
  readonly byName: AutoloadSymbolIndex;
  readonly collisions: AutoloadCollisionMap;
}

/** Frozen, deterministic scan result. */
export interface AutoloadRegistry extends AutoloadResolvedIndex {
  readonly entries: readonly AutoloadEntry[];
}

/* ------------------------------------------------------------------ */
/*  Scanner                                                            */
/* ------------------------------------------------------------------ */

/** Options for {@link scanAutoload}. */
export interface ScanAutoloadOptions {
  /**
   * File extensions accepted as source modules. Defaults to the
   * TypeScript/JavaScript source set, mirroring component resolution. */
  readonly extensions?: ReadonlySet<string>;
}

/** Regular expression for a legal JavaScript identifier name. */
const IDENTIFIER_RE = /^[$_a-zA-Z][$\w]*$/;

/** A known source extension, anchored at the end of a path. Order matters. */
const MODULE_EXTENSION_RE = /\.(tsx|ts|mtsx|mts|jsx|mjs|js)$/;

/** One classified source file discovered during the walk. */
interface WalkedFile {
  readonly absolute: string;
  readonly relative: string;
  readonly context: AutoloadContext;
  readonly autoloadable: boolean;
}

/* ------------------------------------------------------------------ */
/*  Error                                                              */
/* ------------------------------------------------------------------ */

/** Raised when a scanned module cannot be read/parsed or violates a uniqueness rule. */
export class AutoloadError extends Error {
  readonly code: AutoloadErrorCode;

  constructor(code: AutoloadErrorCode, message: string) {
    super(message);
    this.name = 'AutoloadError';
    this.code = code;
  }
}

/* ------------------------------------------------------------------ */
/*  Main entry point                                                   */
/* ------------------------------------------------------------------ */

/**
 * Scan the N1 tree under `rootDir` and return a frozen, deterministic
 * {@link AutoloadRegistry}. The scanner reads and parses every source module in
 * an autoloadable directory to read its named value exports — it never imports
 * a module, so no application code runs at scan time.
 *
 * Scan is **inert until called**; importing this module never walks
 * directories, reads modules, or opens connections. */
export async function scanAutoload(
  rootDir: string,
  options: ScanAutoloadOptions = {},
): Promise<AutoloadRegistry> {
  const extensions = options.extensions ?? SOURCE_EXTENSIONS;

  // Pass 1: walk every N1 directory once, classify each file, and index it by
  // its extension-stripped absolute path so `export *` can be resolved within
  // the walked set.
  const walked: WalkedFile[] = [];
  const byModulePath = new Map<string, string>();
  const relativeByAbsolute = new Map<string, string>();

  for (const [n1, context] of N1_DIRECTORIES) {
    const dir = join(rootDir, n1);
    for (const nested of walkLexicalFiles(dir, { extensions })) {
      // A declaration file carries no runtime exports and is not a module.
      if (nested.endsWith('.d.ts')) {
        continue;
      }
      const relative = `${n1}/${nested}`;
      const absolute = join(rootDir, relative);
      byModulePath.set(stripExtension(absolute), absolute);
      relativeByAbsolute.set(absolute, relative);
      walked.push({
        absolute,
        relative,
        context,
        autoloadable: isAutoloadable(relative),
      });
    }
  }

  const directCache = new Map<string, FileExports>();
  const resolvedCache = new Map<string, ReadonlySet<string>>();

  // Pass 2: resolve the exported names of each autoloadable module (expanding
  // `export *` transitively) and materialize the entries.
  const entries: AutoloadEntry[] = walked.map((file) => ({
    file: file.absolute,
    relative: file.relative,
    context: file.context,
    autoloadable: file.autoloadable,
    symbols: file.autoloadable
      ? extractSymbols(file, byModulePath, relativeByAbsolute, directCache, resolvedCache)
      : [],
  }));

  // Deterministic order: code-unit sort by posix `relative`.
  entries.sort((a, b) => compareStrings(a.relative, b.relative));

  // Resolve the name index: the bare winner per name+context plus the
  // same-context collision sets. `buildByName` returns a fully-frozen result.
  const { byName, collisions } = buildByName(entries);

  // Freeze the entries array and every entry + its symbols array and symbol
  // objects, so no consumer can mutate the registry after the scan.
  Object.freeze(entries);
  for (const entry of entries) {
    for (const symbol of entry.symbols) {
      Object.freeze(symbol);
    }
    Object.freeze(entry.symbols);
    Object.freeze(entry);
  }

  return Object.freeze({ entries, byName, collisions });
}

/* ------------------------------------------------------------------ */
/*  Serialized registry (build artifact)                               */
/* ------------------------------------------------------------------ */

/**
 * Schema version of the `.jsails/autoload.json` artifact. Bumping it is a
 * breaking change: {@link parseAutoloadJson} refuses any other value, so a
 * stale artifact from an older build fails loudly instead of being misread.
 */
export const AUTOLOAD_JSON_VERSION = 1;

/** One autoloadable module in the serialized registry. */
export interface AutoloadJsonEntry {
  /** Posix-relative source path (relative to the project root). */
  readonly file: string;
  readonly context: AutoloadContext;
  /** The module's autoloadable named exports. */
  readonly symbols: readonly string[];
}

/** The serialized autoload registry written by `jsails build:meta`. */
export interface AutoloadJsonDocument {
  readonly version: number;
  readonly entries: readonly AutoloadJsonEntry[];
}

/**
 * Project a live scan registry onto its serialized form. Only autoloadable
 * entries carrying symbols are kept: the consuming Vite transform needs the
 * symbol→module mapping, not the full walk. The build scan is the single
 * producer; {@link parseAutoloadJson} is the single consumer, so the on-disk
 * format has exactly one definition.
 */
export function toAutoloadJson(registry: AutoloadRegistry): AutoloadJsonDocument {
  const entries = registry.entries
    .filter((entry) => entry.autoloadable && entry.symbols.length > 0)
    .map((entry) => ({
      file: entry.relative,
      context: entry.context,
      symbols: entry.symbols.map((symbol) => symbol.name),
    }));
  return { version: AUTOLOAD_JSON_VERSION, entries };
}

/**
 * Parse a serialized registry back into the resolved name index the Vite
 * transform consumes. Source paths are stored relative (the artifact is
 * portable) and are re-absolutized against `rootDir`. Every malformation — an
 * unknown version, a non-array `entries`, or a wrong entry shape — raises a
 * value-free {@link AutoloadError}: the raw document is never echoed.
 *
 * The artifact can encode a collision (two same-context entries naming the same
 * symbol), so this applies the same winner + collision resolution as
 * {@link buildByName} and returns the identical `{ byName, collisions }` shape.
 * Entries are re-sorted by `relative` before resolution so the winner rule does
 * not depend on the (untrusted) document order.
 */
export function parseAutoloadJson(document: unknown, rootDir: string): AutoloadResolvedIndex {
  if (!isRecord(document) || document.version !== AUTOLOAD_JSON_VERSION) {
    throw new AutoloadError('invalid_registry', 'unsupported autoload registry version');
  }
  if (!Array.isArray(document.entries)) {
    throw new AutoloadError('invalid_registry', 'autoload registry entries must be an array');
  }

  const entries: AutoloadJsonEntry[] = [];
  for (const raw of document.entries) {
    entries.push(parseAutoloadEntry(raw));
  }
  // Canonical order matches `scanAutoload`: relative-sorted, so the winner rule
  // is identical whether the index came from a live scan or the artifact.
  entries.sort((a, b) => compareStrings(a.file, b.file));

  const modules = entries.map((entry) => ({
    relative: entry.file,
    symbols: entry.symbols.map((name) =>
      Object.freeze({ name, context: entry.context, file: join(rootDir, entry.file) }),
    ),
  }));

  return buildByName(modules);
}

/** Validate one serialized entry, refusing any shape the producer never emits. */
function parseAutoloadEntry(raw: unknown): AutoloadJsonEntry {
  if (!isRecord(raw)) {
    throw new AutoloadError('invalid_registry', 'malformed autoload registry entry');
  }
  const { file, context, symbols } = raw;
  if (typeof file !== 'string' || !isContext(context) || !isStringArray(symbols)) {
    throw new AutoloadError('invalid_registry', 'malformed autoload registry entry');
  }
  return { file, context, symbols };
}

/** True for a non-null object usable as a record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** True for a valid injection context literal. */
function isContext(value: unknown): value is AutoloadContext {
  return value === 'app' || value === 'server';
}

/** True for an array whose every element is a string. */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/* ------------------------------------------------------------------ */
/*  Classification                                                     */
/* ------------------------------------------------------------------ */

/** Whether a root-relative path belongs to an autoloadable directory. */
function isAutoloadable(relative: string): boolean {
  for (const prefix of AUTOLOADABLE_PREFIXES) {
    if (relative.startsWith(prefix)) {
      return true;
    }
  }
  return false;
}

/* ------------------------------------------------------------------ */
/*  Symbol extraction                                                  */
/* ------------------------------------------------------------------ */

/**
 * Read and parse an autoloadable module, then return its named value exports as
 * symbols (sorted by name). `export *` re-exports are expanded within the walked
 * set so a re-exported symbol is still injectable.
 */
function extractSymbols(
  file: WalkedFile,
  byModulePath: ReadonlyMap<string, string>,
  relativeByAbsolute: ReadonlyMap<string, string>,
  directCache: Map<string, FileExports>,
  resolvedCache: Map<string, ReadonlySet<string>>,
): AutoloadSymbol[] {
  const names = resolveNames(
    file.absolute,
    byModulePath,
    relativeByAbsolute,
    directCache,
    resolvedCache,
    new Set<string>(),
  );
  return [...names]
    .sort(compareStrings)
    .map((name) => ({ name, context: file.context, file: file.absolute }));
}

/* ------------------------------------------------------------------ */
/*  Export resolution                                                  */
/* ------------------------------------------------------------------ */

/** A module's direct `export`s: named exports plus `export *` specifiers. */
interface FileExports {
  readonly names: readonly string[];
  readonly stars: readonly string[];
}

/**
 * Resolve a module's full named-export set, following `export *` re-exports.
 * Memoized per module; a cycle contributes nothing further (`visiting` guards
 * re-entry), matching ESM's own cyclic-export semantics.
 */
function resolveNames(
  absolute: string,
  byModulePath: ReadonlyMap<string, string>,
  relativeByAbsolute: ReadonlyMap<string, string>,
  directCache: Map<string, FileExports>,
  resolvedCache: Map<string, ReadonlySet<string>>,
  visiting: Set<string>,
): ReadonlySet<string> {
  const cached = resolvedCache.get(absolute);
  if (cached !== undefined) {
    return cached;
  }
  if (visiting.has(absolute)) {
    return new Set<string>();
  }
  visiting.add(absolute);

  const direct = readExports(absolute, relativeByAbsolute, directCache);
  const names = new Set<string>(direct.names);
  for (const specifier of direct.stars) {
    const target = resolveStar(absolute, specifier, byModulePath);
    if (target === undefined) {
      continue;
    }
    for (const name of resolveNames(
      target,
      byModulePath,
      relativeByAbsolute,
      directCache,
      resolvedCache,
      visiting,
    )) {
      names.add(name);
    }
  }

  visiting.delete(absolute);
  resolvedCache.set(absolute, names);
  return names;
}

/**
 * Read and parse a module, returning its direct named exports and `export *`
 * specifiers. Memoized so a shared star target is parsed once.
 */
function readExports(
  absolute: string,
  relativeByAbsolute: ReadonlyMap<string, string>,
  cache: Map<string, FileExports>,
): FileExports {
  const cached = cache.get(absolute);
  if (cached !== undefined) {
    return cached;
  }

  const relative = relativeByAbsolute.get(absolute) ?? basename(absolute);

  let source: string;
  try {
    source = readFileSync(absolute, 'utf8');
  } catch {
    throw new AutoloadError('failed_to_parse', `failed to parse autoload module "${relative}"`);
  }

  let program: EstreeNode;
  try {
    program = parseModule(source, absolute);
  } catch {
    // `parseSync` is error-tolerant and its error objects carry a `codeframe`
    // embedding source text, so the failure is refused value-free.
    throw new AutoloadError('failed_to_parse', `failed to parse autoload module "${relative}"`);
  }

  const names: string[] = [];
  const stars: string[] = [];
  for (const statement of asNodeArray(program.body)) {
    collectExports(statement, names, stars, relative);
  }

  const result: FileExports = Object.freeze({
    names: Object.freeze(names),
    stars: Object.freeze(stars),
  });
  cache.set(absolute, result);
  return result;
}

/** Resolve an `export *` specifier to a walked module, or `undefined` if external. */
function resolveStar(
  fromAbsolute: string,
  specifier: string,
  byModulePath: ReadonlyMap<string, string>,
): string | undefined {
  // A bare specifier (`react`, `jsails`) is external to the N1 walk.
  if (!specifier.startsWith('.')) {
    return undefined;
  }
  return byModulePath.get(stripExtension(join(dirname(fromAbsolute), specifier)));
}

/* ------------------------------------------------------------------ */
/*  ESTree helpers                                                     */
/* ------------------------------------------------------------------ */

type EstreeNode = {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
};

const asNode = (value: unknown): EstreeNode | undefined =>
  value !== null && typeof value === 'object' && typeof (value as EstreeNode).type === 'string'
    ? (value as EstreeNode)
    : undefined;

const asNodeArray = (value: unknown): EstreeNode[] =>
  Array.isArray(value) ? (value as EstreeNode[]) : [];

const nodeName = (node: EstreeNode | undefined): string | undefined =>
  typeof node?.name === 'string' ? node.name : undefined;

/* ------------------------------------------------------------------ */
/*  Export collection                                                  */
/* ------------------------------------------------------------------ */

/**
 * Collect the exported names and `export *` specifiers from one top-level
 * statement. Type-only exports (`export type { X }`, interfaces, type aliases)
 * are skipped — they have no runtime value. The `default` export is excluded.
 */
function collectExports(
  statement: EstreeNode,
  names: string[],
  stars: string[],
  relative: string,
): void {
  if (statement.type === 'ExportNamedDeclaration') {
    if (statement.exportKind === 'type') {
      return;
    }
    const declaration = asNode(statement.declaration);
    if (declaration !== undefined) {
      for (const name of declaredNames(declaration)) {
        addName(name, names, relative);
      }
      return;
    }
    for (const specifier of asNodeArray(statement.specifiers)) {
      if (specifier.exportKind === 'type') {
        continue;
      }
      const name = exportedName(specifier);
      if (name !== undefined) {
        addName(name, names, relative);
      }
    }
    return;
  }

  if (statement.type === 'ExportAllDeclaration') {
    // `export * as ns from '...'` names a symbol; a bare `export * from '...'`
    // contributes a star specifier resolved against the walked set.
    const exported = asNode(statement.exported);
    if (exported !== undefined) {
      const name =
        nodeName(exported) ?? (typeof exported.value === 'string' ? exported.value : undefined);
      if (name !== undefined) {
        addName(name, names, relative);
      }
      return;
    }
    const source = asNode(statement.source);
    if (source !== undefined && typeof source.value === 'string') {
      stars.push(source.value);
    }
  }
}

/** The runtime names a declaration statement introduces. */
function declaredNames(declaration: EstreeNode): readonly string[] {
  // `declare function foo(): void` / `declare const x` are ambient: type-only.
  if (declaration.declare === true) {
    return [];
  }
  switch (declaration.type) {
    case 'VariableDeclaration': {
      const names: string[] = [];
      for (const declarator of asNodeArray(declaration.declarations)) {
        collectBindingNames(asNode(declarator.id), names);
      }
      return names;
    }
    case 'FunctionDeclaration':
    case 'ClassDeclaration':
    case 'TSEnumDeclaration': {
      const name = nodeName(asNode(declaration.id));
      return name !== undefined ? [name] : [];
    }
    default:
      // Interfaces, type aliases, and namespaces are type-only.
      return [];
  }
}

/** Collect every identifier bound by a destructuring/identifier pattern. */
function collectBindingNames(node: EstreeNode | undefined, out: string[]): void {
  if (node === undefined) {
    return;
  }
  switch (node.type) {
    case 'Identifier': {
      const name = nodeName(node);
      if (name !== undefined) {
        out.push(name);
      }
      return;
    }
    case 'AssignmentPattern':
      collectBindingNames(asNode(node.left), out);
      return;
    case 'RestElement':
      collectBindingNames(asNode(node.argument), out);
      return;
    case 'ArrayPattern':
      for (const element of asNodeArray(node.elements)) {
        collectBindingNames(asNode(element), out);
      }
      return;
    case 'ObjectPattern':
      for (const property of asNodeArray(node.properties)) {
        if (property.type === 'RestElement') {
          collectBindingNames(asNode(property.argument), out);
        } else if (property.type === 'Property') {
          collectBindingNames(asNode(property.value), out);
        }
      }
      return;
    default:
      return;
  }
}

/** The exported name of a specifier: `export { x as y }` → `y`. */
function exportedName(specifier: EstreeNode): string | undefined {
  const exported = asNode(specifier.exported);
  if (exported === undefined) {
    return undefined;
  }
  if (exported.type === 'Identifier') {
    return nodeName(exported);
  }
  if (exported.type === 'Literal' && typeof exported.value === 'string') {
    return exported.value;
  }
  return undefined;
}

/** Record a named export, refusing the `default` export and non-identifier names. */
function addName(name: string, out: string[], relative: string): void {
  if (name === 'default') {
    return;
  }
  if (!IDENTIFIER_RE.test(name)) {
    throw new AutoloadError(
      'invalid_symbol_name',
      `invalid export name in autoload module "${relative}": ${JSON.stringify(name)}`,
    );
  }
  out.push(name);
}

/* ------------------------------------------------------------------ */
/*  Parsing / naming                                                   */
/* ------------------------------------------------------------------ */

/** Parse source as a module, throwing on a hard syntax error. */
function parseModule(source: string, fileName: string): EstreeNode {
  const result = parseSync(fileName, source, { sourceType: 'module' });
  if (result.errors.some((error: { severity: string }) => error.severity === 'Error')) {
    throw new Error('autoload parse failed');
  }
  return result.program as unknown as EstreeNode;
}

/** Strip a known module extension from a path (`x/foo.ts` → `x/foo`). */
function stripExtension(path: string): string {
  return path.replace(MODULE_EXTENSION_RE, '');
}

/* ------------------------------------------------------------------ */
/*  Name resolution                                                    */
/* ------------------------------------------------------------------ */

/**
 * A module's contribution to name resolution: its canonical `relative` path and
 * its symbols. Both `AutoloadEntry` (the live scan) and a parsed JSON entry map
 * onto this shape, so one resolution rule serves both producers.
 */
interface NameResolutionModule {
  readonly relative: string;
  readonly symbols: readonly AutoloadSymbol[];
}

/**
 * Build the resolved name index from symbol-bearing modules in canonical
 * (relative-sorted) order.
 *
 * For each name + context the FIRST symbol encountered is the bare winner and
 * occupies `byName`; every later same-context symbol is a collision. The
 * collision value for a name is the winner-plus-losers of each colliding
 * context, each context's set sorted by `relative` (then name, constant per
 * key) and contexts ordered `'app'` before `'server'`. A name present once per
 * context never enters `collisions` — the cross-context case (same name in
 * `'app'` and `'server'`) is legitimate and both contexts stay in `byName`.
 *
 * The caller owns the order: `scanAutoload` passes entries already sorted by
 * `compareStrings(relative)`, and `parseAutoloadJson` re-sorts its entries the
 * same way, so both paths produce identical output for the same tree.
 */
function buildByName(modules: readonly NameResolutionModule[]): AutoloadResolvedIndex {
  // Map each symbol's absolute file back to its relative path, so collision sets
  // can be sorted by `relative` independent of input order.
  const relativeByFile = new Map<string, string>();
  for (const module of modules) {
    for (const symbol of module.symbols) {
      relativeByFile.set(symbol.file, module.relative);
    }
  }

  const byName = new Map<string, Map<AutoloadContext, AutoloadSymbol>>();
  // Per name, per colliding context: the winner plus every loser, in discovery
  // order. Populated only when a name has more than one same-context symbol.
  const losersByName = new Map<string, Map<AutoloadContext, AutoloadSymbol[]>>();

  for (const module of modules) {
    for (const symbol of module.symbols) {
      let contexts = byName.get(symbol.name);
      if (contexts === undefined) {
        contexts = new Map<AutoloadContext, AutoloadSymbol>();
        byName.set(symbol.name, contexts);
      }
      const winner = contexts.get(symbol.context);
      if (winner === undefined) {
        contexts.set(symbol.context, symbol);
        continue;
      }
      let byContext = losersByName.get(symbol.name);
      if (byContext === undefined) {
        byContext = new Map<AutoloadContext, AutoloadSymbol[]>();
        losersByName.set(symbol.name, byContext);
      }
      let group = byContext.get(symbol.context);
      if (group === undefined) {
        group = [winner];
        byContext.set(symbol.context, group);
      }
      group.push(symbol);
    }
  }

  const collisions = new Map<string, readonly AutoloadSymbol[]>();
  for (const [name, byContext] of losersByName) {
    const ordered = [...byContext.keys()].sort(compareStrings);
    const list: AutoloadSymbol[] = [];
    for (const context of ordered) {
      const group = byContext.get(context) ?? [];
      group.sort((a, b) => {
        const byRelative = compareStrings(
          relativeByFile.get(a.file) ?? '',
          relativeByFile.get(b.file) ?? '',
        );
        return byRelative !== 0 ? byRelative : compareStrings(a.name, b.name);
      });
      list.push(...group);
    }
    collisions.set(name, Object.freeze(list));
  }

  for (const contexts of byName.values()) {
    Object.freeze(contexts);
  }

  return Object.freeze({
    byName: Object.freeze(byName),
    collisions: Object.freeze(collisions),
  });
}

/* ------------------------------------------------------------------ */
/*  Sort helper                                                        */
/* ------------------------------------------------------------------ */

/** Code-unit string comparison; locale-independent for deterministic order. */
function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
