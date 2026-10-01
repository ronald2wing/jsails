/**
 * The `'use server'` source transform: a pure, fail-closed rewrite that strips
 * server-only function bodies so a mixed module stays safe to import in the
 * browser bundle.
 *
 * The authoring model's seam is normally a *file* boundary (`*.server.ts`,
 * asserted by `cleanBundlePlugin`). This transform narrows the seam to a
 * *function* boundary: a function marked with a leading `'use server'` string
 * directive has its body replaced by a throwing stub, keeping its name, params,
 * return type, and export modifier so existing imports still typecheck and
 * resolve. The original body — the part that may touch the database, session,
 * or a server-only import — never reaches the client chunk.
 *
 * This adds **no** new way to submit an action. The browser still mutates state
 * only through the signed-snapshot update endpoint (`submit(action)`); the stub
 * exists so the module is safe to *import*, never so the function is *callable*.
 *
 * Fail-closed by construction: the directive is honored only as the module
 * prologue or the prologue of a top-level exported function/`const`-arrow
 * declaration. Anywhere else — a nested closure, an object property, a class
 * method, a bare block, a non-exported function — is a hard error, not a silent
 * pass: a marked body the transform cannot stub would otherwise ship server code
 * to the client, so the build must fail.
 *
 * The parser is the bundler's own oxc engine (`rolldown/parseAst`), not the
 * TypeScript compiler API. Two reasons: a consumer's `typescript` may be v7,
 * whose package default export is a version stub with no compiler API (parsing
 * with it crashed every build), and the plugin already runs *inside* the
 * consumer's Vite/Rolldown — so parsing with the same engine the bundler uses
 * removes a version-coupled dependency entirely. Edits are surgical text
 * splices (`RolldownMagicString`) rather than a reprint, so unmarked code is
 * preserved byte-for-byte.
 */

import type { Program } from '@oxc-project/types';
import { RolldownMagicString } from 'rolldown';
import { parseAst } from 'rolldown/parseAst';
import type { ParserOptions } from 'rolldown/parseAst';

/** Outcome of {@link stripServerDirectives}. */
export interface ServerDirectiveResult {
  /** The rewritten source (identical to the input when nothing was marked). */
  readonly code: string;
  /** Whether any `'use server'` directive was found (file- or function-level). */
  readonly hadDirective: boolean;
  /**
   * Names of the exported functions whose bodies were stubbed, sorted. A
   * file-level directive lists every stubbed export; a function-level directive
   * lists only the marked ones. Names are diagnostics only — never secrets.
   */
  readonly stubbed: readonly string[];
}

/** Raised when a `'use server'` directive appears where it cannot be rewritten. */
export class ServerDirectiveError extends Error {
  readonly code: 'unsupported_position' | 'unparseable';
  /** The offending function/binding name when known; never source text. */
  readonly subject?: string;

  constructor(message: string, code: 'unsupported_position' | 'unparseable', subject?: string) {
    super(message);
    this.name = 'ServerDirectiveError';
    this.code = code;
    if (subject !== undefined) {
      this.subject = subject;
    }
  }
}

/** The directive string this transform recognizes. */
const SERVER_DIRECTIVE = 'use server';

/** Map a filename to the parser's language, so JSX/TSX is disambiguated. */
function langFor(fileName: string): ParserOptions['lang'] {
  if (/\.(tsx|mtsx)$/i.test(fileName)) {
    return 'tsx';
  }
  if (/\.(jsx|mjsx)$/i.test(fileName)) {
    return 'jsx';
  }
  if (/\.(js|mjs|cjs)$/i.test(fileName)) {
    return 'js';
  }
  return 'ts';
}

/**
 * A structural view of the few node shapes this transform walks. The oxc AST is
 * a discriminated union; narrowing by `type` on `unknown` keeps the walker
 * honest without importing the whole union.
 */
interface NodeLike {
  readonly type: string;
  readonly start: number;
  readonly end: number;
  readonly [key: string]: unknown;
}

const isNode = (value: unknown): value is NodeLike =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { type?: unknown }).type === 'string';

const asNode = (value: unknown): NodeLike | undefined => (isNode(value) ? value : undefined);

const asNodeArray = (value: unknown): readonly NodeLike[] =>
  Array.isArray(value) ? value.filter(isNode) : [];

/** True when a node is a string directive prologue whose text is `'use server'`. */
function isServerDirective(node: NodeLike | undefined): boolean {
  return node?.type === 'ExpressionStatement' && node.directive === SERVER_DIRECTIVE;
}

/** True when `body[0]` is the file-level `'use server'` directive. */
function hasFileDirective(program: NodeLike): boolean {
  return isServerDirective(asNodeArray(program.body)[0]);
}

/**
 * True when a function body's first statement is the `'use server'` directive.
 *
 * `isServerDirective` keys on the parser's `.directive` marker, which oxc sets
 * only for a real prologue — so this recognizes an honored function-level
 * directive, never a mid-body string.
 */
function hasFunctionDirective(body: unknown): boolean {
  const block = asNode(body);
  return block?.type === 'BlockStatement' && isServerDirective(asNodeArray(block.body)[0]);
}

/** The identifier name of a function-like node, or `undefined`. */
function nameOf(node: NodeLike | undefined): string | undefined {
  const id = asNode(node?.id);
  return typeof id?.name === 'string' ? id.name : undefined;
}

/** Build the `{ throw new Error('...') }` replacement block for a stubbed function. */
function stubBlock(name: string): string {
  const message = `server-only function "${name}" was called in the client bundle`;
  return `{ throw new Error(${JSON.stringify(message)}); }`;
}

/**
 * The function node and body block of an exported function-like statement, or
 * `undefined` when the statement is not one. Covers a `FunctionDeclaration`, an
 * exported `const` bound to an arrow/function expression, and a function
 * exported directly via `export default`.
 */
function functionBody(
  statement: NodeLike,
): { readonly name: string; readonly body: NodeLike } | undefined {
  // `export function f() {}` / `export default function () {}` — unwrap first.
  const target =
    statement.type === 'ExportNamedDeclaration' || statement.type === 'ExportDefaultDeclaration'
      ? asNode(statement.declaration)
      : statement;
  if (target === undefined) {
    return undefined;
  }
  if (target.type === 'FunctionDeclaration') {
    const body = asNode(target.body);
    return body?.type === 'BlockStatement'
      ? { name: nameOf(target) ?? '<anonymous>', body }
      : undefined;
  }
  if (target.type === 'VariableDeclaration') {
    const declarator = asNodeArray(target.declarations)[0];
    const init = asNode(declarator?.init);
    if (init?.type !== 'ArrowFunctionExpression' && init?.type !== 'FunctionExpression') {
      return undefined;
    }
    const body = asNode(init.body);
    return body?.type === 'BlockStatement'
      ? { name: nameOf(declarator) ?? '<anonymous>', body }
      : undefined;
  }
  return undefined;
}

/** A statement is an export whose target is a function-like declaration. */
function isExportedFunction(statement: NodeLike): boolean {
  if (statement.type === 'ExportDefaultDeclaration') {
    return asNode(statement.declaration)?.type === 'FunctionDeclaration';
  }
  if (statement.type !== 'ExportNamedDeclaration') {
    return false;
  }
  const declaration = asNode(statement.declaration);
  return declaration?.type === 'FunctionDeclaration' || declaration?.type === 'VariableDeclaration';
}

/** Visit every node in the tree, applying `visit` to each. */
function walk(node: unknown, visit: (node: NodeLike) => void): void {
  const current = asNode(node);
  if (current === undefined) {
    return;
  }
  visit(current);
  for (const [key, value] of Object.entries(current)) {
    if (key === 'parent') {
      continue;
    }
    if (Array.isArray(value)) {
      for (const child of value) {
        walk(child, visit);
      }
    } else {
      walk(value, visit);
    }
  }
}

/**
 * Assert that every `'use server'` directive sits where the transform can honor
 * it, throwing otherwise. The honored positions are exactly two: the module
 * prologue (`program.body[0]`) and the prologue of a top-level exported
 * function/`const`-arrow declaration. Any other occurrence — mid-body, a bare
 * block, a nested closure, a class method, an object property — is a position
 * the transform cannot rewrite, so it fails closed rather than shipping an
 * inert directive the author believed was active.
 *
 * Validity is computed by collecting the honored statement offsets up front and
 * flagging every directive expression outside that set, so the rule is total:
 * a new shape cannot slip through by not being enumerated.
 */
function assertNoUnsupportedDirective(program: NodeLike, fileName: string): void {
  const statements = asNodeArray(program.body);
  const honored = new Set<number>();
  // Only `program.body[0]` is the module prologue; a directive after any other
  // top-level statement is misplaced and must not be whitelisted.
  const prologue = statements[0];
  if (isDirectiveExpression(prologue)) {
    honored.add(prologue.start);
  }
  for (const statement of statements) {
    if (!isExportedFunction(statement)) {
      continue;
    }
    const first = asNodeArray(asNode(functionBody(statement)?.body)?.body)[0];
    if (isDirectiveExpression(first)) {
      honored.add(first.start);
    }
  }
  walk(program, (node) => {
    if (isDirectiveExpression(node) && !honored.has(node.start)) {
      throw new ServerDirectiveError(
        `'use server' must be the module prologue or the first statement of an exported function body (${fileName})`,
        'unsupported_position',
      );
    }
  });
}

/**
 * True when a node is an `ExpressionStatement` whose expression is the
 * `'use server'` string literal — a directive prologue or a misplaced string.
 */
function isDirectiveExpression(node: NodeLike | undefined): node is NodeLike {
  if (node?.type !== 'ExpressionStatement') {
    return false;
  }
  const expression = asNode(node.expression);
  return expression?.type === 'Literal' && expression.value === SERVER_DIRECTIVE;
}

/** Parse to the oxc AST, translating a parser failure into a value-free error. */
function parseModule(code: string, fileName: string): NodeLike {
  try {
    const program: Program = parseAst(
      code,
      { lang: langFor(fileName), sourceType: 'module', astType: 'ts' },
      fileName,
    );
    return program as unknown as NodeLike;
  } catch {
    // The bundler parser's message embeds a source frame (`RolldownError`); the
    // transform's errors must stay value-free, so discard it and report only the
    // file. `cause` is deliberately not attached — it would re-expose the frame.
    throw new ServerDirectiveError(`could not parse ${fileName}`, 'unparseable');
  }
}

/**
 * Strip every server-only function body the directive marks, returning the
 * rewritten source plus diagnostics. Pure: the same input yields the same
 * output, no filesystem or bundler access. The module-level directive marks
 * every exported function; a function-level directive marks only that function.
 *
 * Throws {@link ServerDirectiveError} when the source cannot be parsed or a
 * directive sits where it cannot be rewritten — never ships server code
 * silently.
 */
export function stripServerDirectives(code: string, fileName: string): ServerDirectiveResult {
  const program = parseModule(code, fileName);
  const statements = asNodeArray(program.body);
  const fileLevel = hasFileDirective(program);

  const marked = (
    statement: NodeLike,
  ): { readonly name: string; readonly body: NodeLike } | undefined => {
    const target = functionBody(statement);
    if (target === undefined || !isExportedFunction(statement)) {
      return undefined;
    }
    // A file-level directive marks every exported function; a function-level
    // directive marks only the function whose body opens with it.
    if (!fileLevel && !hasFunctionDirective(target.body)) {
      return undefined;
    }
    return target;
  };

  const functionLevel = fileLevel
    ? false
    : statements.some((statement) => marked(statement) !== undefined);

  // Fail-closed: scan for a directive in any position this transform cannot
  // rewrite, whether or not a top-level directive was found.
  assertNoUnsupportedDirective(program, fileName);

  if (!fileLevel && !functionLevel) {
    return { code, hadDirective: false, stubbed: [] };
  }

  const stubbed: string[] = [];
  const magic = new RolldownMagicString(code);
  for (const statement of statements) {
    if (statement.type === 'ExportNamedDeclaration' && asNode(statement.source) !== undefined) {
      // A re-export (`export { x } from './y'`) cannot be rewritten in place;
      // the target module owns its own directive. Fail rather than silently ship.
      if (statement.exportKind !== 'type') {
        throw new ServerDirectiveError(
          `a re-export in a 'use server' module cannot be rewritten (${fileName})`,
          'unsupported_position',
        );
      }
      continue;
    }
    const target = marked(statement);
    if (target === undefined) {
      continue;
    }
    stubbed.push(target.name);
    // Replace the whole `{ ... }` body (signature, params, and return type stay
    // untouched) with the throwing stub.
    magic.overwrite(target.body.start, target.body.end, stubBlock(target.name));
  }

  stubbed.sort();
  return { code: magic.toString(), hadDirective: true, stubbed };
}
