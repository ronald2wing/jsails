/**
 * Build-time import injection: scan source code for free identifiers, match
 * them against a C1 {@link AutoloadSymbolIndex}, and prepend (or merge) the
 * necessary {@code import} declarations.
 *
 * Pure — no I/O, no file system access at call time. The caller supplies the
 * source code, the symbols index, and the importing file's name + context.
 */

import { dirname, relative, sep } from 'node:path';

import { RolldownMagicString } from 'rolldown';
import { parseSync } from 'rolldown/utils';

import type {
  AutoloadContext,
  AutoloadSymbol,
  AutoloadSymbolIndex,
} from './project-symbols-scan.js';
import { collectUnmatchedIdentifiers } from './scope-walker.js';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

/** A single injected import: what name, from which module. */
export interface InjectedImport {
  readonly symbol: string;
  readonly from: string;
}

/** Outcome of {@link injectAutoloadImports}. */
export interface AutoloadInjectionResult {
  /** The rewritten source code. */
  readonly code: string;
  /** Every import that was injected (not merged). */
  readonly injected: readonly InjectedImport[];
}

/* ------------------------------------------------------------------ */
/*  Error                                                              */
/* ------------------------------------------------------------------ */

/** Raised when the source cannot be parsed. */
export class AutoloadInjectionError extends Error {
  readonly code: 'unparseable';

  constructor(code: 'unparseable', message: string) {
    super(message);
    this.name = 'AutoloadInjectionError';
    this.code = code;
  }
}

/* ------------------------------------------------------------------ */
/*  Injection                                                         */
/* ------------------------------------------------------------------ */

/** Options for {@link injectAutoloadImports}. */
export interface InjectAutoloadImportsOptions {
  /** The importing file's resolved (absolute) path — used for relative-specifier computation. */
  readonly fileName: string;
  /** The C1 symbol index, pre-filtered to the injection context. */
  readonly symbols: AutoloadSymbolIndex;
  /** The injection context — only symbols whose context matches are injected. */
  readonly context: AutoloadContext;
}

/**
 * Parse {@code code}, find unmatched identifiers, match them against
 * {@code options.symbols}, and prepend (or merge into existing) import
 * declarations.
 *
 * Returns {@code null} when no injections are needed (idempotence guard). */
export function injectAutoloadImports(
  code: string,
  options: InjectAutoloadImportsOptions,
): AutoloadInjectionResult | null {
  let program;
  try {
    const parseResult = parseSync(options.fileName, code, { sourceType: 'module' });
    // `parseSync` is error-tolerant: it returns a partial AST plus an `errors`
    // array rather than throwing. A hard parse error must be refused value-free
    // — the error's `codeframe` embeds source text, so it is never surfaced.
    if (parseResult.errors.some((error) => error.severity === 'Error')) {
      throw new AutoloadInjectionError('unparseable', `could not parse ${options.fileName}`);
    }
    program = parseResult.program;
  } catch (error) {
    if (error instanceof AutoloadInjectionError) {
      throw error;
    }
    throw new AutoloadInjectionError('unparseable', `could not parse ${options.fileName}`);
  }

  const unmatched = collectUnmatchedIdentifiers(program);

  // Filter to names present in the index with the target context.
  // Deterministic ordering: sort by specifier, then by name.
  const matches: { name: string; symbol: AutoloadSymbol }[] = [];
  for (const name of unmatched) {
    const contexts = options.symbols.get(name);
    if (contexts === undefined) continue;
    const symbol = contexts.get(options.context);
    if (symbol !== undefined) {
      matches.push({ name, symbol });
    }
  }

  if (matches.length === 0) {
    return null;
  }

  // Group by resolved relative specifier.
  const importingDir = dirname(options.fileName);

  const bySpec = new Map<string, { name: string; symbol: AutoloadSymbol }[]>();
  for (const m of matches) {
    const spec = resolveImportSpecifier(importingDir, m.symbol.file);
    let group = bySpec.get(spec);
    if (group === undefined) {
      group = [];
      bySpec.set(spec, group);
    }
    group.push(m);
  }

  // Deterministic iteration: sort specifiers.
  const sortedSpecs = Array.from(bySpec.keys()).sort();

  // Find existing ImportDeclarations to merge with.
  const existingImports = findExistingImports(program as unknown as EstreeNode, sortedSpecs);

  const magic = new RolldownMagicString(code);
  const injected: InjectedImport[] = [];

  for (const spec of sortedSpecs) {
    const group = bySpec.get(spec)!;
    group.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    const existing = existingImports.get(spec);

    if (existing !== undefined) {
      // Merge: append missing specifiers to the existing ImportDeclaration.
      const existingNames = new Set(existing.names);
      const newNames = group.filter((m) => !existingNames.has(m.name)).map((m) => m.name);

      if (newNames.length === 0) continue;

      const separator = existing.names.length > 0 ? ', ' : '';
      const newText = separator + newNames.join(', ');

      magic.prependLeft(existing.insertPos, newText);

      for (const name of newNames) {
        injected.push({ symbol: name, from: spec });
      }
    } else {
      // Prepend a new import declaration.
      const names = group.map((m) => m.name).join(', ');
      const statement = `import { ${names} } from '${spec}';\n`;

      magic.prepend(statement);

      for (const m of group) {
        injected.push({ symbol: m.name, from: spec });
      }
    }
  }

  if (injected.length === 0) {
    return null;
  }

  return { code: magic.toString(), injected };
}

/* ------------------------------------------------------------------ */
/*  Estree-shaped import scanning                                     */
/* ------------------------------------------------------------------ */

type EstreeNode = {
  type: string;
  start: number;
  end: number;
  specifiers?: EstreeNode[];
  local?: EstreeNode;
  imported?: EstreeNode;
  source?: EstreeNode;
  value?: string;
  name?: string;
  body?: EstreeNode[];
};

interface ExistingImport {
  names: string[];
  /** Byte offset just after the last named specifier — where `, name` is inserted. */
  insertPos: number;
}

function findExistingImports(program: EstreeNode, targets: string[]): Map<string, ExistingImport> {
  const targetSet = new Set(targets);
  const result = new Map<string, ExistingImport>();

  const body = Array.isArray(program.body) ? program.body : [];
  for (const stmt of body) {
    if (stmt.type !== 'ImportDeclaration') continue;

    const source = stmt.source as EstreeNode;
    if (source === undefined) continue;
    const specifier = typeof source.value === 'string' ? source.value : '';
    if (!targetSet.has(specifier)) continue;

    const names: string[] = [];
    let insertPos = source.start;
    const specs = Array.isArray(stmt.specifiers) ? stmt.specifiers : [];
    for (const spec of specs) {
      if (spec.type === 'ImportSpecifier') {
        const local = spec.local;
        if (local !== undefined && typeof local.name === 'string') {
          names.push(local.name);
        }
      }
      // Track the end of the last specifier so a merge inserts `, name` before
      // the closing brace rather than before the source string.
      if (typeof spec.end === 'number') {
        insertPos = spec.end;
      }
    }

    result.set(specifier, { names, insertPos });
  }

  return result;
}

/* ------------------------------------------------------------------ */
/*  Relative specifier resolution                                      */
/* ------------------------------------------------------------------ */

/**
 * Resolve an absolute source file path to a posix relative specifier suitable
 * for an import statement. The result is always {@code ./}-prefixed.
 *
 * The repo is ESM-only with explicit `.js` specifiers, so a TypeScript source
 * extension is rewritten to its compiled counterpart: `.ts`/`.tsx` → `.js`,
 * `.mts`/`.mtsx` → `.mjs`. A non-TS extension is preserved.
 */
function resolveImportSpecifier(fromDir: string, toAbsolute: string): string {
  let rel = relative(fromDir, toAbsolute);
  if (sep === '\\') {
    rel = rel.replace(/\\/g, '/');
  }

  rel = rel.replace(/\.(tsx|ts)$/, '.js').replace(/\.(mtsx|mts)$/, '.mjs');

  if (!rel.startsWith('.')) {
    rel = './' + rel;
  }

  return rel;
}
