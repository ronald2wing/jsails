/**
 * Project-symbol shim tree generator.
 *
 * The framework-symbols installer (A1) makes *framework* symbols
 * (`ApplicationRecord`, `defineJob`, ...) resolvable as bare identifiers at
 * runtime. Project symbols — a user's `Author` model, a `formatDate` util — are
 * not framework-owned, so they cannot be baked into a static table. Instead the
 * build emits a small **shim tree** under `.jsails/project-symbols/`: one shim
 * module per autoloadable source module, each importing its real compiled module
 * and publishing its exports onto `globalThis`. A single
 * `.jsails/project-symbols.js` imports every shim in dependency order, so a
 * preload of that one file makes every project symbol resolvable as a bare
 * identifier.
 *
 * Why a shim tree rather than a codemod: the server tree is compiled by `tsc`,
 * which has no transform hook, and `tsc` preserves bare references (it never
 * injects imports for ambient symbols). The shim tree is the runtime half of the
 * ambient declarations `generateProjectSymbolsDts` already emits for the type
 * half.
 *
 * Ordering is load-bearing. A shim that references another project symbol at
 * module-evaluation time (a decorator argument such as `@jsails.belongsTo(Author)`
 * survives into emitted JS as a real runtime reference) must have that symbol's
 * shim evaluated first. ESM hoists imports, so a shim imports its dependencies'
 * shims *before* importing its own real module; the topological order is
 * computed here and rendered into `project-symbols.js`.
 *
 * Pure where it can be: {@link scanShimModules} reads and parses source (no
 * imports, no execution); {@link emitShimTree} is a pure string builder;
 * {@link writeShimTree} is the only writer.
 */

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

import { parseSync } from 'rolldown/utils';

import type {
  AutoloadContext,
  AutoloadEntry,
  AutoloadRegistry,
  AutoloadSymbol,
} from './project-symbols-scan.js';
import { deriveFrameworkSymbolNamespaceKeys } from '../symbols/framework-symbols.js';
import { collectUnmatchedIdentifiers } from './scope-walker.js';

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

/**
 * The generated-artifacts directory. Defined locally rather than imported from
 * the build layer: the compiler must not depend on `src/build/` (that edge
 * would invert the layering and risk a cycle).
 */
const META_DIR = '.jsails';

/** Subdirectory of {@link META_DIR} holding the per-module shims. */
const SHIM_DIR = 'project-symbols';

/** The single preload entry point that imports every shim in order. */
const PROJECT_SYMBOLS_FILE = 'project-symbols.js';

/** Manifest recording the files this generator owns, for stale cleanup. */
const SHIMS_MANIFEST = 'project-symbols.manifest.json';

/** Schema version of {@link SHIMS_MANIFEST}. */
const SHIMS_MANIFEST_VERSION = 1;

/** Default compiled-output root, relative to the project root. */
const DEFAULT_COMPILED_ROOT = 'dist';

/* ------------------------------------------------------------------ */
/*  Error                                                              */
/* ------------------------------------------------------------------ */

/** Error codes for {@link ShimTreeError}. */
export type ShimTreeErrorCode = 'failed_to_parse' | 'cyclic_dependency' | 'shim_path_collision';

/**
 * Raised when the shim tree cannot be built. Every message is value-free: it
 * names paths and identifiers only, never source text or exported values.
 */
export class ShimTreeError extends Error {
  readonly code: ShimTreeErrorCode;

  constructor(code: ShimTreeErrorCode, message: string) {
    super(message);
    this.name = 'ShimTreeError';
    this.code = code;
  }
}

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

/** One shim module: a source module that contributes symbols to the globals. */
export interface ShimModule {
  /** Absolute source path. */
  readonly file: string;
  /** Posix-relative source path (relative to the project root). */
  readonly relative: string;
  readonly context: AutoloadContext;
  /** The module's autoloadable named exports, sorted. */
  readonly symbols: readonly string[];
  /** Absolute source paths of shim modules this one references at eval time, sorted. */
  readonly deps: readonly string[];
}

/** The rendered shim tree: file contents keyed by `.jsails`-relative posix path. */
export interface ShimTree {
  /** Every emitted file, keyed by its `.jsails`-relative posix path. */
  readonly files: ReadonlyMap<string, string>;
  /** Shim paths (`.jsails`-relative) in dependency order, excluding `project-symbols.js`. */
  readonly order: readonly string[];
}

/** Options for {@link emitShimTree} / {@link writeShimTree}. */
export interface ShimTreeOptions {
  /**
   * Compiled-output root, relative to the project root. Shim modules import the
   * *compiled* module, so specifiers resolve under this root. Defaults to
   * `'dist'`.
   */
  readonly compiledRoot?: string;
  /**
   * Collision map from the registry. When non-empty, namespace objects are
   * emitted into `project-symbols.js` so every colliding symbol is reachable
   * under a path-derived key — the same key the `.d.ts` emitter uses. Defaults
   * to `undefined` (= no collisions), which keeps `project-symbols.js`
   * byte-identical to the pre-collision output.
   */
  readonly collisions?: ReadonlyMap<string, readonly AutoloadSymbol[]>;
}

/* ------------------------------------------------------------------ */
/*  Context visibility                                                 */
/* ------------------------------------------------------------------ */

/**
 * Whether a module in `fromContext` may reference a symbol in `toContext`.
 * A server module sees both app and server symbols; an app (client+server)
 * module sees only app symbols.
 */
function canReference(fromContext: AutoloadContext, toContext: AutoloadContext): boolean {
  return toContext === 'app' || fromContext === 'server';
}

/* ------------------------------------------------------------------ */
/*  Scan                                                               */
/* ------------------------------------------------------------------ */

/**
 * Build the shim module graph from a scan registry.
 *
 * Providers are the registry's autoloadable entries that carry symbols. Each
 * provider's source is re-read and parsed to find its free (unmatched)
 * identifiers; a free identifier that resolves to another provider's symbol
 * becomes a dependency edge. The result is frozen and returned in
 * dependency-first (DFS post-order) order.
 *
 * A free identifier that resolves to no provider is ignored — it is a framework
 * global, a builtin, or a typo the type checker will report. A free identifier
 * that resolves to more than one provider resolves to the bare winner (the
 * symbol whose relative path sorts first, matching the scan's order rule), so a
 * consumer always depends on exactly one shim.
 */
export function scanShimModules(registry: AutoloadRegistry): readonly ShimModule[] {
  const providers = registry.entries.filter(
    (entry) => entry.autoloadable && entry.symbols.length > 0,
  );

  // Map each provider's absolute source path to its shim path, detecting a
  // collision where two sources (e.g. `models/post.ts` and `models/post.tsx`)
  // would map to the same shim file.
  const shimPathByFile = new Map<string, string>();
  const fileByShimPath = new Map<string, string>();
  for (const entry of providers) {
    const shimPath = shimPathFor(entry.relative);
    const existing = fileByShimPath.get(shimPath);
    if (existing !== undefined && existing !== entry.file) {
      throw new ShimTreeError(
        'shim_path_collision',
        `shim path collision at "${shimPath}" between "${existing}" and "${entry.file}"`,
      );
    }
    fileByShimPath.set(shimPath, entry.file);
    shimPathByFile.set(entry.file, shimPath);
  }

  // Resolve each provider's dependency edges.
  const depsByFile = new Map<string, readonly string[]>();
  for (const entry of providers) {
    depsByFile.set(entry.file, resolveDeps(entry, registry, shimPathByFile));
  }

  // Topological order: DFS post-order over sorted roots and sorted deps.
  const ordered = topoSort(providers, depsByFile);

  return Object.freeze(
    ordered.map((entry) =>
      Object.freeze({
        file: entry.file,
        relative: entry.relative,
        context: entry.context,
        symbols: Object.freeze(entry.symbols.map((symbol) => symbol.name).sort(compareStrings)),
        deps: depsByFile.get(entry.file) ?? Object.freeze([]),
      }),
    ),
  );
}

/**
 * Resolve one provider's dependency edges: the set of other providers whose
 * symbols it references as free identifiers at module-evaluation time.
 *
 * The candidate set comes from `registry.byName`, which already holds only the
 * bare winner per name+context — losing collision symbols are excluded there, so
 * a consumer of a colliding name depends on the winner alone. When a server
 * consumer can see more than one context winner (the cross-context case), the
 * winner is the candidate whose `relative` path sorts first, matching the scan's
 * order rule.
 */
function resolveDeps(
  entry: AutoloadEntry,
  registry: AutoloadRegistry,
  shimPathByFile: ReadonlyMap<string, string>,
): readonly string[] {
  const free = readFreeIdentifiers(entry.file, entry.relative);

  // Map each provider's absolute file to its `relative` path, so candidates can
  // be ranked by the same order the scan used to pick winners.
  const relativeByFile = new Map<string, string>();
  for (const scanned of registry.entries) {
    relativeByFile.set(scanned.file, scanned.relative);
  }

  const deps = new Set<string>();
  for (const name of [...free].sort(compareStrings)) {
    const contexts = registry.byName.get(name);
    if (contexts === undefined) {
      continue; // framework global, builtin, or typo — not a project symbol.
    }

    const candidates: string[] = [];
    for (const [context, symbol] of contexts) {
      if (symbol.file === entry.file) {
        continue; // a module never depends on itself.
      }
      if (!canReference(entry.context, context)) {
        continue;
      }
      if (!shimPathByFile.has(symbol.file)) {
        continue; // only providers get shims.
      }
      candidates.push(symbol.file);
    }

    // Rank by `relative` path so the first candidate is the bare winner; the
    // scan already holds one winner per context, so this only disambiguates the
    // legitimate cross-context case.
    candidates.sort((a, b) =>
      compareStrings(relativeByFile.get(a) ?? '', relativeByFile.get(b) ?? ''),
    );
    const only = candidates[0];
    if (only !== undefined) {
      deps.add(only);
    }
  }

  return Object.freeze([...deps].sort(compareStrings));
}

/** Read and parse a provider, returning its free (unmatched) identifier names. */
function readFreeIdentifiers(absolute: string, relativePath: string): ReadonlySet<string> {
  let source: string;
  try {
    source = readFileSync(absolute, 'utf8');
  } catch {
    throw new ShimTreeError('failed_to_parse', `failed to parse shim module "${relativePath}"`);
  }

  try {
    const result = parseSync(absolute, source, { sourceType: 'module' });
    if (result.errors.some((error) => error.severity === 'Error')) {
      throw new ShimTreeError('failed_to_parse', `failed to parse shim module "${relativePath}"`);
    }
    return collectUnmatchedIdentifiers(result.program);
  } catch (error) {
    if (error instanceof ShimTreeError) {
      throw error;
    }
    // `parseSync` error objects carry a `codeframe` embedding source text, so
    // the failure is refused value-free.
    throw new ShimTreeError('failed_to_parse', `failed to parse shim module "${relativePath}"`);
  }
}

/**
 * Order providers dependency-first via DFS post-order. Roots and each node's
 * dependencies are visited in sorted order, so the result is deterministic. A
 * back-edge (a node already on the stack) is a cycle and is refused.
 */
function topoSort(
  providers: readonly AutoloadEntry[],
  depsByFile: ReadonlyMap<string, readonly string[]>,
): readonly AutoloadEntry[] {
  const byFile = new Map(providers.map((entry) => [entry.file, entry]));
  const roots = [...providers].sort((a, b) => compareStrings(a.relative, b.relative));

  const visited = new Set<string>();
  const onStack = new Set<string>();
  const ordered: AutoloadEntry[] = [];

  const visit = (file: string): void => {
    if (visited.has(file)) {
      return;
    }
    if (onStack.has(file)) {
      const entry = byFile.get(file);
      throw new ShimTreeError(
        'cyclic_dependency',
        `cyclic shim dependency at "${entry?.relative ?? file}"`,
      );
    }
    onStack.add(file);

    for (const dep of depsByFile.get(file) ?? []) {
      visit(dep);
    }

    onStack.delete(file);
    visited.add(file);
    const entry = byFile.get(file);
    if (entry !== undefined) {
      ordered.push(entry);
    }
  };

  for (const root of roots) {
    visit(root.file);
  }

  return ordered;
}

/* ------------------------------------------------------------------ */
/*  Emit                                                               */
/* ------------------------------------------------------------------ */

/**
 * Render the shim tree. Pure: no I/O. The modules must already be in
 * dependency order (as returned by {@link scanShimModules}); this function
 * renders them in the given order and does not re-sort.
 */
export function emitShimTree(
  modules: readonly ShimModule[],
  rootDir: string,
  options: ShimTreeOptions = {},
): ShimTree {
  const compiledRoot = options.compiledRoot ?? DEFAULT_COMPILED_ROOT;
  const files = new Map<string, string>();
  const order: string[] = [];

  for (const module of modules) {
    const shimPath = shimPathFor(module.relative);
    order.push(shimPath);
    files.set(shimPath, renderShim(module, rootDir, compiledRoot));
  }

  const namespaceLines = buildNamespaceLines(options.collisions, rootDir);
  files.set(PROJECT_SYMBOLS_FILE, renderGlobals(order, rootDir, namespaceLines));
  return { files, order: Object.freeze(order) };
}

/** Render one shim module: dependency imports, then the real import, then globals. */
function renderShim(module: ShimModule, rootDir: string, compiledRoot: string): string {
  const shimAbs = join(rootDir, META_DIR, shimPathFor(module.relative));
  const lines: string[] = [HEADER];

  // Dependency shims first: ESM hoists imports, so a dependency's shim body
  // runs before this module's real import — the ordering the graph requires.
  for (const dep of module.deps) {
    const depShimAbs = join(rootDir, META_DIR, shimPathFor(relativeSource(rootDir, dep)));
    lines.push(`import '${posixSpecifier(shimAbs, depShimAbs)}';`);
  }

  const realAbs = join(rootDir, compiledRoot, toCompiledExtension(module.relative));
  const names = module.symbols.join(', ');
  lines.push(`import { ${names} } from '${posixSpecifier(shimAbs, realAbs)}';`);
  for (const name of module.symbols) {
    lines.push(`globalThis.${name} = ${name};`);
  }

  return lines.join('\n') + '\n';
}

/**
 * Render the preload entry point: install the framework globals, then namespace
 * objects (when collisions exist), then import every project shim in dependency
 * order — all dynamically and sequentially so the install finishes before any
 * shim evaluates. `rootDir` is embedded as a string literal because the
 * installer reads `<rootDir>/.jsails/framework-symbols.js` at runtime.
 */
function renderGlobals(
  order: readonly string[],
  rootDir: string,
  namespaceLines?: readonly string[],
): string {
  const lines = [
    HEADER,
    `import { installFrameworkSymbols } from 'jsails/symbols';`,
    '',
    `await installFrameworkSymbols(${JSON.stringify(rootDir)});`,
  ];

  // Namespace objects for colliding project symbols. Emitted after the framework
  // install (they may reference framework globals) and before the shim imports
  // (shims may read the namespace objects).
  if (namespaceLines !== undefined && namespaceLines.length > 0) {
    lines.push('');
    lines.push(...namespaceLines);
  }

  for (const shimPath of order) {
    lines.push(`await import('./${shimPath}');`);
  }
  if (order.length === 0) {
    lines.push('export {};');
  }
  return lines.join('\n') + '\n';
}

/* ------------------------------------------------------------------ */
/*  Namespace objects (collision resolution)                           */
/* ------------------------------------------------------------------ */

/** Regular expression matching a known source extension (stripped, not converted). */
const MODULE_EXT_RE = /\.(tsx|ts|mtsx|mts|jsx|mjs|js)$/;

/**
 * Convert an absolute source path to a posix-relative extension-stripped path,
 * suitable as a specifier for {@link deriveFrameworkSymbolNamespaceKeys}.
 * `/root/app/models/post.ts` → `app/models/post`.
 */
function relativeModulePath(rootDir: string, absolute: string): string {
  let rel = relative(rootDir, absolute);
  if (sep === '\\') {
    rel = rel.replace(/\\/g, '/');
  }
  return rel.replace(MODULE_EXT_RE, '');
}

/**
 * Build the namespace assignment lines for colliding project symbols.
 *
 * For each colliding name the **winner** (first symbol in the collision array,
 * matching the scan's order rule) is already installed as a bare global by its
 * shim. This function emits a real namespace object under a key derived from
 * the winner's extension-stripped posix-relative path, so the symbol is also
 * reachable as `key.name`. Multiple colliding names whose winners share a
 * provider path (and therefore a key) merge into one object.
 *
 * Returns `undefined` when there are no collisions, preserving byte-identical
 * `project-symbols.js` output.
 */
function buildNamespaceLines(
  collisions: ReadonlyMap<string, readonly AutoloadSymbol[]> | undefined,
  rootDir: string,
): string[] | undefined {
  if (collisions === undefined || collisions.size === 0) {
    return undefined;
  }

  // Collect every winner's posix-relative extension-stripped path.
  const winnerPaths: string[] = [];
  // Map from winner path → colliding names whose winner lives at that path.
  const namesByPath = new Map<string, string[]>();

  for (const [name, symbols] of collisions) {
    const winner = symbols[0];
    if (winner === undefined) {
      continue;
    }
    const path = relativeModulePath(rootDir, winner.file);
    winnerPaths.push(path);
    let names = namesByPath.get(path);
    if (names === undefined) {
      names = [];
      namesByPath.set(path, names);
    }
    names.push(name);
  }

  // Derive one namespace key per winner path. Reusing the same derivation the
  // `.d.ts` emitter and the framework-symbols installer use, so the key can
  // never drift.
  const keys = deriveFrameworkSymbolNamespaceKeys(winnerPaths);

  // Group merged namespace objects by key, deduplicating names from colliding
  // symbols whose winners land on different paths that resolve to the same key.
  const entriesByKey = new Map<string, { key: string; names: string[] }>();
  for (const [path, names] of namesByPath) {
    const key = keys.get(path);
    if (key === undefined) {
      continue;
    }
    let entry = entriesByKey.get(key);
    if (entry === undefined) {
      entry = { key, names: [] };
      entriesByKey.set(key, entry);
    }
    entry.names.push(...names);
  }

  // Deterministic order: sort keys, then names within each key.
  const sortedKeys = [...entriesByKey.keys()].sort();
  if (sortedKeys.length === 0) {
    return undefined;
  }

  const lines: string[] = [];
  for (const key of sortedKeys) {
    const entry = entriesByKey.get(key);
    if (entry === undefined) {
      continue;
    }
    const uniqueNames = [...new Set(entry.names)].sort();
    const pairs = uniqueNames.map((n) => `${n}: ${n}`).join(', ');
    lines.push(`globalThis.${key} = { ${pairs} };`);
  }
  return lines;
}

/* ------------------------------------------------------------------ */
/*  Write                                                              */
/* ------------------------------------------------------------------ */

/**
 * Materialize the shim tree under `<rootDir>/.jsails/`. Writes only when a
 * file's content changed, deletes files recorded in the previous manifest that
 * are no longer emitted, and writes the manifest last. Returns the rendered
 * tree.
 */
export function writeShimTree(
  modules: readonly ShimModule[],
  rootDir: string,
  options: ShimTreeOptions = {},
): ShimTree {
  const tree = emitShimTree(modules, rootDir, options);
  const metaDir = join(rootDir, META_DIR);

  const previous = readManifest(metaDir);
  const current = new Set(tree.files.keys());

  for (const [relativePath, content] of tree.files) {
    const absolute = join(metaDir, relativePath);
    mkdirSync(dirname(absolute), { recursive: true });
    writeIfChanged(absolute, content);
  }

  // Delete files this generator owned previously but no longer emits. Only
  // manifest-listed files are removed — the manifest is framework-owned, so a
  // user file under `.jsails/` is never touched.
  for (const stale of previous) {
    if (current.has(stale)) {
      continue;
    }
    rmSync(join(metaDir, stale), { force: true });
  }
  pruneEmptyShimDirs(metaDir);

  writeIfChanged(
    join(metaDir, SHIMS_MANIFEST),
    JSON.stringify({ version: SHIMS_MANIFEST_VERSION, files: [...current].sort(compareStrings) }),
  );

  return tree;
}

/** Write `content` to `absolute` only when it differs from what is on disk. */
function writeIfChanged(absolute: string, content: string): void {
  try {
    if (readFileSync(absolute, 'utf8') === content) {
      return;
    }
  } catch {
    // Missing or unreadable — fall through and write.
  }
  writeFileSync(absolute, content);
}

/** Read the previous manifest's file list; a missing/malformed manifest yields none. */
function readManifest(metaDir: string): readonly string[] {
  let raw: string;
  try {
    raw = readFileSync(join(metaDir, SHIMS_MANIFEST), 'utf8');
  } catch {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      (parsed as { version?: unknown }).version === SHIMS_MANIFEST_VERSION &&
      Array.isArray((parsed as { files?: unknown }).files)
    ) {
      const files = (parsed as { files: unknown[] }).files;
      return files.filter((file): file is string => typeof file === 'string');
    }
  } catch {
    // Malformed manifest — skip cleanup rather than risk deleting user files.
  }
  return [];
}

/** Best-effort removal of now-empty shim directories (deepest first). */
function pruneEmptyShimDirs(metaDir: string): void {
  const shimRoot = join(metaDir, SHIM_DIR);
  const dirs = collectDirs(shimRoot);
  // Deepest first so a parent becomes empty before it is considered.
  dirs.sort((a, b) => b.length - a.length);
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: false });
    } catch {
      // Non-empty or already gone — leave it.
    }
  }
}

/** Collect every directory under `root` (excluding `root` itself). */
function collectDirs(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const child = join(dir, entry.name);
        out.push(child);
        walk(child);
      }
    }
  };
  walk(root);
  return out;
}

/* ------------------------------------------------------------------ */
/*  Path helpers                                                       */
/* ------------------------------------------------------------------ */

const HEADER = '// AUTO-GENERATED by @jsails/compiler. Do not edit.\n';

/** The `.jsails`-relative shim path for a source module's root-relative path. */
function shimPathFor(relativeSourcePath: string): string {
  return `${SHIM_DIR}/${toCompiledExtension(relativeSourcePath)}`;
}

/** Recover a source module's root-relative path from its absolute path. */
function relativeSource(rootDir: string, absolute: string): string {
  let rel = relative(rootDir, absolute);
  if (sep === '\\') {
    rel = rel.replace(/\\/g, '/');
  }
  return rel;
}

/**
 * Rewrite a TypeScript source extension to its compiled counterpart:
 * `.ts`/`.tsx` → `.js`, `.mts`/`.mtsx` → `.mjs`. A non-TS extension is
 * preserved. Mirrors `project-symbols-dts.ts`.
 */
function toCompiledExtension(path: string): string {
  return path.replace(/\.(tsx|ts)$/, '.js').replace(/\.(mtsx|mts)$/, '.mjs');
}

/** A posix relative specifier from one absolute file to another, `./`-prefixed. */
function posixSpecifier(fromFileAbs: string, toFileAbs: string): string {
  let rel = relative(dirname(fromFileAbs), toFileAbs);
  if (sep === '\\') {
    rel = rel.replace(/\\/g, '/');
  }
  if (!rel.startsWith('.')) {
    rel = './' + rel;
  }
  return rel;
}

/** Code-unit string comparison; locale-independent for deterministic order. */
function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
