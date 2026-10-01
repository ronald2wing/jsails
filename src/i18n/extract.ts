/**
 * Extract translation keys from compiled JavaScript/ESM source.
 *
 * Scans an AST for the framework's translation call sites and returns the
 * statically-resolvable dotted keys (with `scope` folded) plus a count of
 * dynamic calls whose key cannot be resolved without running the code. The
 * parser is `acorn` (maintained, already a transitive dependency); only the
 * JSails-specific recognition lives here.
 *
 * Recognized call sites:
 *   - the `I18n` facade global: `I18n.t`, `I18n.tChoice`, `I18n.exists`
 *   - imported bare helpers: `t`, `choice` (from `jsails/i18n/server`)
 *
 * `l`/`localize` are localization, not keys, and are deliberately ignored.
 * `import * as i18n from ...` and dynamic keys are documented limits.
 */

import {
  parse,
  type ArrayExpression,
  type CallExpression,
  type Expression,
  type Identifier,
  type ImportDeclaration,
  type Literal,
  type Node,
  type Property,
  type SpreadElement,
} from 'acorn';

/** A statically-resolved key reference. */
export interface KeyRef {
  /** The resolved dotted key (scope folded). */
  readonly key: string;
  /** 1-based source line of the call. */
  readonly line: number;
}

/** The result of scanning one module. */
export interface ExtractionResult {
  readonly refs: readonly KeyRef[];
  /** Calls that looked like translation calls but had a non-static key/scope. */
  readonly dynamic: number;
}

/** Subpath that exports the bare `t`/`choice`/`l` helpers. */
const I18N_SERVER_SUBPATH = 'jsails/i18n/server';

/** The `I18n` facade methods that reference a translation key. */
const FACADE_KEY_METHODS = new Set(['t', 'tChoice', 'exists']);

/** The bare helpers that reference a translation key. */
const BARE_KEY_HELPERS = new Set(['t', 'choice']);

/** Methods whose options object is at argument index 1 (`t`, `exists`). */
const OPTIONS_AT_ONE = new Set(['t', 'exists']);
/** Methods whose options object is at argument index 2 (`tChoice`, `choice`). */
const OPTIONS_AT_TWO = new Set(['tChoice', 'choice']);

/**
 * Extract translation keys from compiled module source. `dynamic` counts calls
 * that look like translation calls but whose key or scope is not a static
 * literal, so a caller can surface them as unscanned rather than silently wrong.
 * Unparseable source yields an empty result (the caller reports the file).
 */
export function extractTranslationKeys(source: string): ExtractionResult {
  let ast: Node;
  try {
    ast = parse(source, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      locations: true,
      allowAwaitOutsideFunction: true,
    });
  } catch {
    return { refs: [], dynamic: 0 };
  }

  const refs: KeyRef[] = [];
  let dynamic = 0;
  const importedBare = new Set<string>();

  const walk = (node: Node): void => {
    if (node.type === 'ImportDeclaration') {
      collectImportedBare(node as ImportDeclaration, importedBare);
    } else if (node.type === 'CallExpression') {
      const resolved = resolveCall(node as CallExpression, importedBare);
      if (resolved !== null) {
        if (resolved === undefined) {
          dynamic += 1;
        } else {
          refs.push({ key: resolved, line: node.loc?.start.line ?? 1 });
        }
      }
    }

    for (const key of Object.keys(node) as (keyof Node)[]) {
      const value = node[key];
      if (Array.isArray(value)) {
        for (const child of value) {
          if (isNode(child)) walk(child);
        }
      } else if (isNode(value)) {
        walk(value);
      }
    }
  };

  walk(ast);
  return { refs, dynamic };
}

/** Type guard for acorn ESTree nodes. */
function isNode(value: unknown): value is Node {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { type?: unknown }).type === 'string'
  );
}

/** Record bare `t`/`choice` helpers imported from the i18n server subpath. */
function collectImportedBare(decl: ImportDeclaration, importedBare: Set<string>): void {
  if (decl.source.value !== I18N_SERVER_SUBPATH) return;
  for (const spec of decl.specifiers) {
    if (spec.type === 'ImportSpecifier' && isIdentifier(spec.imported)) {
      if (BARE_KEY_HELPERS.has(spec.imported.name)) {
        importedBare.add(spec.imported.name);
      }
    }
  }
}

function isIdentifier(node: Expression | Literal): node is Identifier {
  return node.type === 'Identifier';
}

/**
 * Resolve a call expression to a dotted key. Returns:
 *   - a string: the scope-folded key
 *   - `undefined`: recognized call whose key/scope was not static (dynamic)
 *   - `null`: not a translation call (skip, do not count as dynamic)
 */
function resolveCall(
  call: CallExpression,
  importedBare: ReadonlySet<string>,
): string | null | undefined {
  const callee = call.callee;
  const args = call.arguments;

  let method: string | undefined;

  if (callee.type === 'MemberExpression' && !callee.computed) {
    if (
      callee.object.type === 'Identifier' &&
      callee.object.name === 'I18n' &&
      callee.property.type === 'Identifier'
    ) {
      method = callee.property.name;
      if (!FACADE_KEY_METHODS.has(method)) return null;
    } else {
      return null;
    }
  } else if (callee.type === 'Identifier') {
    method = callee.name;
    if (!importedBare.has(method)) return null;
  } else {
    return null;
  }

  const optionsIndex = OPTIONS_AT_ONE.has(method) ? 1 : OPTIONS_AT_TWO.has(method) ? 2 : -1;
  if (optionsIndex === -1) return null;

  const key = literalString(args[0]);
  if (key === undefined) return undefined;

  const scope = resolveScope(args[optionsIndex]);
  if (scope === undefined) return undefined;

  return scope === null ? key : [...scope, key].join('.');
}

/** Extract the string value of a literal argument, or `undefined`. */
function literalString(arg: Expression | SpreadElement | undefined): string | undefined {
  if (arg?.type === 'Literal' && typeof arg.value === 'string') {
    return arg.value;
  }
  return undefined;
}

/**
 * Resolve a `scope` option from the options argument. Returns the scope
 * segments, `null` when there is no `scope` option, or `undefined` when the
 * `scope` is present but not a static literal (dynamic).
 */
function resolveScope(
  optionsArg: Expression | SpreadElement | undefined,
): readonly string[] | null | undefined {
  if (optionsArg === undefined || optionsArg.type !== 'ObjectExpression') {
    return null;
  }
  const object = optionsArg;
  for (const prop of object.properties) {
    if (prop.type !== 'Property') continue;
    if (isPropertyComputed(prop)) continue;
    if (propertyKeyName(prop) !== 'scope') continue;

    const value = prop.value;
    if (value.type === 'Literal' && typeof value.value === 'string') {
      return value.value.split('.');
    }
    if (value.type === 'ArrayExpression') {
      return arrayLiteralParts(value);
    }
    return undefined;
  }
  return null;
}

function isPropertyComputed(prop: Property): boolean {
  return prop.computed === true;
}

function propertyKeyName(prop: Property): string | undefined {
  if (prop.key.type === 'Identifier') return prop.key.name;
  if (prop.key.type === 'Literal') return String(prop.key.value);
  return undefined;
}

/** Extract a `scope` array's string parts, or `undefined` when not all static. */
function arrayLiteralParts(value: ArrayExpression): readonly string[] | undefined {
  const parts: string[] = [];
  for (const element of value.elements) {
    if (element === null || element.type !== 'Literal' || typeof element.value !== 'string') {
      return undefined;
    }
    parts.push(element.value);
  }
  return parts;
}
