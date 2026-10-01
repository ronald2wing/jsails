/**
 * Pure shape analysis and split/combine planning for HotView components.
 *
 * All operations are pure transforms over source strings - no I/O, no
 * module resolution. Parser: parseSync (estree) from rolldown/utils.
 * Splice: RolldownMagicString. Scope walker: collectUnmatchedIdentifiers
 * from src/compiler/scope-walker.js.
 *
 * Split boundary: model = stateSchema + z.infer type alias + initialState;
 * style = defineStyle(...) binding (exported or not); server = 'use server'
 * function declarations. The closure rule refuses any reference to an
 * entry-local binding that is neither imported nor also migrated.
 */

import { RolldownMagicString } from 'rolldown';
import { parseSync } from 'rolldown/utils';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type ComponentShape = 'sfc' | 'mfc' | 'none' | 'ambiguous';

export interface ComponentShapeFiles {
  readonly entryFile?: string;
  readonly directory?: {
    readonly entry: string;
    readonly model?: string;
    readonly style?: string;
    readonly server?: string;
  };
}

export interface SplitPlan {
  readonly entry: string;
  readonly model?: string;
  readonly style?: string;
  readonly server?: string;
}

export type CombineResult = string;

export interface CombineParts {
  readonly entry: string;
  readonly model?: string;
  readonly style?: string;
  readonly server?: string;
}

/* ------------------------------------------------------------------ */
/*  Error                                                              */
/* ------------------------------------------------------------------ */

export type ConvertComponentErrorCode =
  | 'not_found'
  | 'ambiguous_shape'
  | 'already_sfc'
  | 'already_mfc'
  | 'unparseable'
  | 'unmigratable_reference'
  | 'target_exists'
  | 'missing_part'
  | 'colliding_binding';

export class ConvertComponentError extends Error {
  readonly code: ConvertComponentErrorCode;
  readonly subject?: string;

  constructor(message: string, code: ConvertComponentErrorCode, subject?: string) {
    super(message);
    this.name = 'ConvertComponentError';
    this.code = code;
    if (subject !== undefined) {
      this.subject = subject;
    }
  }
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
/*  Program parsing                                                    */
/* ------------------------------------------------------------------ */

function parseModule(code: string, fileName: string): EstreeNode {
  // parseSync infers the language from the filename extension. A non-TS
  // filename (e.g. widget.tsx-part) is parsed as plain JS, turning `type X =
  // ...` into a syntax error. Append .tsx when there is no recognised
  // extension so parseSync always treats the input as TypeScript.
  const tsFileName = /\.(ts|tsx|mts|mtsx|js|jsx)$/.test(fileName) ? fileName : fileName + '.tsx';
  const result = parseSync(tsFileName, code, { sourceType: 'module' });
  if (result.errors.some((e: { severity: string }) => e.severity === 'Error')) {
    throw new ConvertComponentError(`could not parse ${fileName}`, 'unparseable');
  }
  return result.program as unknown as EstreeNode;
}

/* ------------------------------------------------------------------ */
/*  Top-level binding collection                                       */
/* ------------------------------------------------------------------ */

interface TopLevelBindings {
  readonly declared: ReadonlySet<string>;
  readonly imports: ReadonlySet<string>;
  readonly byName: ReadonlyMap<string, EstreeNode>;
}

function collectTopLevelBindings(program: EstreeNode): TopLevelBindings {
  const declared = new Set<string>();
  const imports = new Set<string>();
  const byName = new Map<string, EstreeNode>();

  for (const stmt of asNodeArray(program.body)) {
    if (stmt.type === 'ImportDeclaration') {
      for (const spec of asNodeArray(stmt.specifiers)) {
        const local = asNode(spec.local);
        const name = local !== undefined ? nodeName(local) : undefined;
        if (name !== undefined) {
          declared.add(name);
          imports.add(name);
        }
      }
      continue;
    }

    let target: EstreeNode = stmt;
    if (stmt.type === 'ExportNamedDeclaration') {
      const decl = asNode(stmt.declaration);
      if (decl !== undefined) {
        target = decl;
      } else {
        for (const spec of asNodeArray(stmt.specifiers)) {
          const local = asNode(spec.local);
          const name = local !== undefined ? nodeName(local) : undefined;
          if (name !== undefined) {
            declared.add(name);
            byName.set(name, stmt);
          }
        }
        continue;
      }
    }
    addDeclFromStmt(target, declared, byName, stmt);
  }

  return { declared, imports, byName };
}

function addDeclFromStmt(
  target: EstreeNode,
  declared: Set<string>,
  byName: Map<string, EstreeNode>,
  stmt: EstreeNode,
): void {
  if (target.type === 'VariableDeclaration') {
    for (const d of asNodeArray(target.declarations)) {
      for (const n of extractBindingNames(d.id)) {
        declared.add(n);
        byName.set(n, stmt);
      }
    }
  } else if (target.type === 'FunctionDeclaration') {
    const name = nodeName(asNode(target.id));
    if (name !== undefined) {
      declared.add(name);
      byName.set(name, stmt);
    }
  } else if (target.type === 'ClassDeclaration') {
    const name = nodeName(asNode(target.id));
    if (name !== undefined) {
      declared.add(name);
      byName.set(name, stmt);
    }
  } else if (target.type === 'TSTypeAliasDeclaration') {
    const name = nodeName(asNode(target.id));
    if (name !== undefined) {
      declared.add(name);
      byName.set(name, stmt);
    }
  }
}

function extractBindingNames(pattern: unknown): string[] {
  const names: string[] = [];
  const node = asNode(pattern);
  if (node === undefined) return names;
  if (node.type === 'Identifier') {
    const name = nodeName(node);
    if (name !== undefined) names.push(name);
    return names;
  }
  if (node.type === 'ObjectPattern') {
    for (const prop of asNodeArray(node.properties)) {
      names.push(...extractBindingNames(prop));
    }
    return names;
  }
  if (node.type === 'ArrayPattern') {
    for (const el of asNodeArray(node.elements)) {
      names.push(...extractBindingNames(el));
    }
    return names;
  }
  if (node.type === 'AssignmentPattern') {
    return extractBindingNames(node.left);
  }
  if (node.type === 'RestElement') {
    return extractBindingNames(node.argument);
  }
  if (node.type === 'Property') {
    return extractBindingNames(node.value);
  }
  return names;
}

/* ------------------------------------------------------------------ */
/*  isValuePosition - determines if an Identifier is in value position  */
/* ------------------------------------------------------------------ */

function isValuePosition(parent: EstreeNode, node: EstreeNode): boolean {
  switch (parent.type) {
    case 'CallExpression':
    case 'NewExpression':
      if (parent.callee === node) return true;
      return asNodeArray(parent.arguments).some((a) => a === node);
    case 'MemberExpression':
      if (parent.object === node) return true;
      return parent.computed === true && parent.property === node;
    case 'VariableDeclarator':
      return parent.init === node;
    case 'SpreadElement':
      return parent.argument === node;
    case 'Property':
      if (parent.value === node) return true;
      return parent.computed === true && parent.key === node;
    case 'TemplateLiteral':
      return asNodeArray(parent.expressions).some((e) => e === node);
    case 'AssignmentExpression':
      return parent.left === node || parent.right === node;
    case 'AssignmentPattern':
    case 'LogicalExpression':
      return parent.right === node;
    case 'ReturnStatement':
    case 'ThrowStatement':
      return parent.argument === node;
    case 'IfStatement':
    case 'WhileStatement':
    case 'DoWhileStatement':
      return parent.test === node;
    case 'SwitchStatement':
      return parent.discriminant === node;
    case 'BinaryExpression':
      return parent.left === node || parent.right === node;
    case 'UnaryExpression':
    case 'UpdateExpression':
    case 'AwaitExpression':
    case 'YieldExpression':
      return parent.argument === node;
    case 'ConditionalExpression':
      return parent.test === node || parent.consequent === node || parent.alternate === node;
    case 'ArrayExpression':
    case 'SequenceExpression':
      return asNodeArray(parent.expressions ?? parent.elements).some((e) => e === node);
    case 'TaggedTemplateExpression':
      return parent.tag === node;
    case 'ArrowFunctionExpression':
      return parent.body === node;
    case 'TSTypeQuery':
      return parent.exprName === node;
    default:
      return false;
  }
}

/* ------------------------------------------------------------------ */
/*  Subtree reference collection                                       */
/* ------------------------------------------------------------------ */

function collectSubtreeReferences(root: EstreeNode): Set<string> {
  const refs = new Set<string>();
  const parents: EstreeNode[] = [];

  function walk(node: unknown): void {
    const cur = asNode(node);
    if (cur === undefined) return;

    if (cur.type === 'Identifier') {
      const p = parents[parents.length - 1];
      if (p !== undefined && isValuePosition(p, cur)) {
        const name = nodeName(cur);
        if (name !== undefined) refs.add(name);
      }
      return;
    }

    parents.push(cur);
    for (const [key, value] of Object.entries(cur)) {
      if (key === 'parent' || key === 'leadingComments' || key === 'trailingComments') continue;
      if (Array.isArray(value)) {
        for (const child of value) walk(child);
      } else {
        walk(value);
      }
    }
    parents.pop();
  }

  walk(root);
  return refs;
}

/* ------------------------------------------------------------------ */
/*  Candidate detection                                                */
/* ------------------------------------------------------------------ */

interface BindingInfo {
  readonly name: string;
  readonly statement: EstreeNode;
}

function findModelCandidates(
  statements: readonly EstreeNode[],
  bindings: TopLevelBindings,
): BindingInfo[] {
  const candidates: BindingInfo[] = [];
  const stateSchemaStmt = bindings.byName.get('stateSchema');
  if (stateSchemaStmt !== undefined) {
    candidates.push({ name: 'stateSchema', statement: stateSchemaStmt });
  }
  for (const stmt of statements) {
    if (stmt.type !== 'TSTypeAliasDeclaration') continue;
    const id = asNode(stmt.id);
    const name = id !== undefined ? nodeName(id) : undefined;
    if (name === undefined || !bindings.declared.has(name)) continue;
    const refs = collectSubtreeReferences(stmt);
    if (refs.has('stateSchema')) {
      candidates.push({ name, statement: stmt });
    }
  }
  const initialStmt = bindings.byName.get('initialState');
  if (initialStmt !== undefined) {
    candidates.push({ name: 'initialState', statement: initialStmt });
  }
  return candidates;
}

function findStyleCandidate(statements: readonly EstreeNode[]): BindingInfo | undefined {
  for (const stmt of statements) {
    const vd =
      stmt.type === 'VariableDeclaration'
        ? stmt
        : stmt.type === 'ExportNamedDeclaration'
          ? asNode(stmt.declaration)
          : undefined;
    if (vd?.type !== 'VariableDeclaration') continue;
    for (const d of asNodeArray(vd.declarations)) {
      const id = asNode(d.id);
      if (id?.type !== 'Identifier') continue;
      const name = nodeName(id);
      if (name === undefined) continue;
      const init = asNode(d.init);
      if (init?.type === 'CallExpression') {
        const callee = asNode(init.callee);
        if (callee?.type === 'Identifier' && nodeName(callee) === 'defineStyle') {
          return { name, statement: stmt };
        }
      }
    }
  }
  return undefined;
}

function findServerCandidates(statements: readonly EstreeNode[]): BindingInfo[] {
  const candidates: BindingInfo[] = [];
  for (const stmt of statements) {
    let target: EstreeNode = stmt;
    if (stmt.type === 'ExportNamedDeclaration') {
      const decl = asNode(stmt.declaration);
      if (decl === undefined) continue;
      target = decl;
    }
    if (target.type !== 'FunctionDeclaration') continue;
    const body = asNode(target.body);
    if (body?.type !== 'BlockStatement') continue;
    const firstBodyStmt = asNodeArray(body.body)[0];
    if (firstBodyStmt?.type !== 'ExpressionStatement') continue;
    if (firstBodyStmt.directive !== 'use server') continue;
    const name = nodeName(asNode(target.id));
    if (name !== undefined) candidates.push({ name, statement: stmt });
  }
  return candidates;
}
/* ------------------------------------------------------------------ */
/*  Part import reconstruction                                         */
/* ------------------------------------------------------------------ */

function computeNeededImports(
  stmts: readonly EstreeNode[],
  imports: ReadonlySet<string>,
): Set<string> {
  const refs = new Set<string>();
  for (const stmt of stmts) {
    for (const ref of collectSubtreeReferences(stmt)) {
      refs.add(ref);
    }
  }
  return new Set([...refs].filter((r) => imports.has(r)));
}

function buildPartImports(
  code: string,
  neededNames: ReadonlySet<string>,
  importStmts: readonly EstreeNode[],
): string {
  const lines: string[] = [];
  for (const stmt of importStmts) {
    if (stmt.type !== 'ImportDeclaration') continue;
    const sourceValue = (stmt.source as EstreeNode & { value: string }).value;
    const needed = asNodeArray(stmt.specifiers).filter((spec) => {
      const local = asNode(spec.local);
      const name = local !== undefined ? nodeName(local) : undefined;
      return name !== undefined && neededNames.has(name);
    });
    if (needed.length === 0) continue;
    const firstType = needed[0]!.type;
    const specTexts = needed.map((s) => code.slice(s.start, s.end).trim());
    if (firstType === 'ImportSpecifier') {
      lines.push(`import { ${specTexts.join(', ')} } from '${sourceValue}';`);
    } else if (firstType === 'ImportDefaultSpecifier') {
      lines.push(`import ${specTexts.join(', ')} from '${sourceValue}';`);
    } else {
      lines.push(`import * as ${specTexts.join(', ')} from '${sourceValue}';`);
    }
  }
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/*  Build part file                                                    */
/* ------------------------------------------------------------------ */

function buildPart(code: string, stmts: readonly EstreeNode[]): string {
  if (stmts.length === 0) return code;
  const magic = new RolldownMagicString(code);
  const sorted = [...stmts].sort((a, b) => a.start - b.start);
  for (let i = sorted.length - 1; i >= 0; i--) {
    const s = sorted[i]!;
    const end = findRemovalEnd(code, s.end);
    magic.remove(s.start, end);
  }
  return magic.toString().trim();
}

function findRemovalEnd(code: string, end: number): number {
  let pos = end;
  while (pos < code.length && (code[pos] === ' ' || code[pos] === '\t')) {
    pos++;
  }
  if (pos < code.length && code[pos] === '\n') pos++;
  return pos;
}

function extractStatements(code: string, stmts: readonly EstreeNode[]): string {
  if (stmts.length === 0) return '';
  const sorted = [...stmts].sort((a, b) => a.start - b.start);
  const parts: string[] = [];
  for (const s of sorted) {
    const start = findFragmentStart(code, s.start);
    parts.push(code.slice(start, s.end).trimEnd());
  }
  return parts.join('\n\n');
}

function findFragmentStart(code: string, start: number): number {
  let pos = start - 1;
  while (pos >= 0 && (code[pos] === ' ' || code[pos] === '\t')) pos--;
  if (pos >= 0 && code[pos] === '\n') pos--;
  if (pos >= 0 && code[pos] === '\r') pos--;
  return pos + 1;
}

/* ------------------------------------------------------------------ */
/*  planSplit: SFC -> MFC                                             */
/* ------------------------------------------------------------------ */

/**
 * Plans a split of an SFC entry file into MFC parts.
 * Returns a SplitPlan with entry, model, style, and server strings.
 * Throws ConvertComponentError on problems.
 */
export function planSplit(code: string, fileName: string): SplitPlan {
  const program = parseModule(code, fileName);
  const bindings = collectTopLevelBindings(program);
  const statements = asNodeArray(program.body);

  // Detect candidates
  const modelCandidates = findModelCandidates(statements, bindings);
  const styleCandidate = findStyleCandidate(statements);
  const serverCandidates = findServerCandidates(statements);

  if (
    modelCandidates.length === 0 &&
    styleCandidate === undefined &&
    serverCandidates.length === 0
  ) {
    throw new ConvertComponentError('Component has no splittable parts', 'not_found');
  }

  // §12 closure check: collect all identifiers used by migrated bindings
  const migratedNames = new Set<string>();
  const migratedStmts = new Set<EstreeNode>();
  for (const c of modelCandidates) {
    migratedNames.add(c.name);
    migratedStmts.add(c.statement);
  }
  if (styleCandidate !== undefined) {
    migratedNames.add(styleCandidate.name);
    migratedStmts.add(styleCandidate.statement);
  }
  for (const c of serverCandidates) {
    migratedNames.add(c.name);
    migratedStmts.add(c.statement);
  }

  // Collect all references from migrated statement subtrees
  const allRefs = new Set<string>();
  for (const stmt of Array.from(migratedStmts)) {
    for (const ref of collectSubtreeReferences(stmt)) {
      allRefs.add(ref);
    }
  }

  // §12: every free top-level reference must be import or also migrated
  for (const ref of allRefs) {
    if (migratedNames.has(ref)) continue;
    if (bindings.imports.has(ref)) continue;
    // Not an import and not being migrated — this is an entry-local ref
    // Find which migrated binding references it
    for (const stmt of Array.from(migratedStmts)) {
      if (collectSubtreeReferences(stmt).has(ref)) {
        const subject = [...migratedNames].find((n) => {
          const s = bindings.byName.get(n);
          return (
            s !== undefined &&
            Array.from(migratedStmts).includes(s) &&
            collectSubtreeReferences(s).has(ref)
          );
        });
        const msg =
          subject !== undefined
            ? `Binding '${subject}' references '${ref}' which is neither imported nor also migrated`
            : `Unmigratable reference '${ref}' is neither imported nor also migrated`;
        throw new ConvertComponentError(msg, 'unmigratable_reference', ref);
      }
    }
    throw new ConvertComponentError(
      `Unmigratable reference: '${ref}'`,
      'unmigratable_reference',
      ref,
    );
  }

  // Build entry by removing migrated statements
  const allMigrated = [
    ...modelCandidates.map((c) => c.statement),
    styleCandidate?.statement,
    ...serverCandidates.map((c) => c.statement),
  ].filter(Boolean) as EstreeNode[];

  // Each part must carry only the imports its own migrated statements
  // reference, so the part is self-contained and compiles independently.
  const importStmts = statements.filter((s) => s.type === 'ImportDeclaration');

  // Rebuild the entry: remove migrated statements and all imports, then
  // reconstruct only the imports the remaining statements still reference.
  // This drops specifiers like `z` and `defineStyle` that migrated into
  // sub-parts and are no longer needed in the entry.
  const allToRemoveFromEntry = [...allMigrated, ...importStmts];
  const entryBody = buildPart(code, allToRemoveFromEntry).trim();

  const remainingStmts = statements.filter(
    (s) => !allMigrated.includes(s) && s.type !== 'ImportDeclaration',
  );
  const entryNeeded = computeNeededImports(remainingStmts, bindings.imports);
  const entryImports = buildPartImports(code, entryNeeded, importStmts);

  const entry = entryImports ? entryImports + '\n\n' + entryBody : entryBody;

  // Build model part
  let model: string | undefined;
  if (modelCandidates.length > 0) {
    const modelStmts = modelCandidates.map((c) => c.statement);
    const modelNeeded = computeNeededImports(modelStmts, bindings.imports);
    const modelBody = extractStatements(code, modelStmts);
    if (modelNeeded.size > 0) {
      model = buildPartImports(code, modelNeeded, importStmts) + '\n\n' + modelBody;
    } else {
      model = modelBody;
    }
  }

  // Build style part
  let style: string | undefined;
  if (styleCandidate !== undefined) {
    const styleStmts = [styleCandidate.statement];
    const styleNeeded = computeNeededImports(styleStmts, bindings.imports);
    const styleBody = extractStatements(code, styleStmts);
    if (styleNeeded.size > 0) {
      style = buildPartImports(code, styleNeeded, importStmts) + '\n\n' + styleBody;
    } else {
      style = styleBody;
    }
  }

  // Build server part
  let server: string | undefined;
  if (serverCandidates.length > 0) {
    const serverStmts = serverCandidates.map((c) => c.statement);
    const serverNeeded = computeNeededImports(serverStmts, bindings.imports);
    const serverBody = extractStatements(code, serverStmts);
    if (serverNeeded.size > 0) {
      server = buildPartImports(code, serverNeeded, importStmts) + '\n\n' + serverBody;
    } else {
      server = serverBody;
    }
  }

  return { entry, model, style, server };
}

/* ------------------------------------------------------------------ */
/*  planCombine: MFC -> SFC                                           */
/* ------------------------------------------------------------------ */

interface PartInfo {
  body: string;
  imports: readonly EstreeNode[];
  bindings: TopLevelBindings;
}

/**
 * Parses a part source string and returns its import declarations,
 * its body (everything but the import declarations), and its
 * top-level bindings for collision-checking.
 */
function analyzePart(code: string, fileName: string): PartInfo {
  const program = parseModule(code, fileName);
  const bindings = collectTopLevelBindings(program);
  const stmts = asNodeArray(program.body);
  const imports = stmts.filter((s) => s.type === 'ImportDeclaration');
  const body = buildPart(code, imports);
  return { body, imports, bindings };
}

/**
 * Merges import declarations from multiple sources (entry + sub-parts)
 * into a single deduplicated import block. Deduplication is by source
 * string first, then by local name; first-seen order wins.
 */
function mergeImports(
  sources: readonly { code: string; imports: readonly EstreeNode[] }[],
): string {
  interface SpecEntry {
    type: string;
    text: string;
    localName: string;
  }

  const groups: { source: string; specs: SpecEntry[] }[] = [];

  for (const { code, imports } of sources) {
    for (const stmt of imports) {
      if (stmt.type !== 'ImportDeclaration') continue;
      const sourceValue = (stmt.source as EstreeNode & { value: string }).value;
      let group = groups.find((g) => g.source === sourceValue);
      if (group === undefined) {
        group = { source: sourceValue, specs: [] };
        groups.push(group);
      }
      for (const spec of asNodeArray(stmt.specifiers)) {
        const local = asNode(spec.local);
        const localName = local !== undefined ? nodeName(local) : undefined;
        if (localName === undefined) continue;
        if (!group.specs.some((s) => s.localName === localName)) {
          group.specs.push({
            type: spec.type,
            text: code.slice(spec.start, spec.end).trim(),
            localName,
          });
        }
      }
    }
  }

  const lines: string[] = [];
  for (const { source, specs } of groups) {
    if (specs.length === 0) continue;

    const defaults: string[] = [];
    const named: string[] = [];
    const namespaces: string[] = [];
    for (const s of specs) {
      if (s.type === 'ImportDefaultSpecifier') defaults.push(s.text);
      else if (s.type === 'ImportSpecifier') named.push(s.text);
      else if (s.type === 'ImportNamespaceSpecifier') namespaces.push(s.text);
    }

    const parts: string[] = [];
    if (defaults.length > 0) parts.push(defaults.join(', '));
    if (named.length > 0) parts.push(`{ ${named.join(', ')} }`);
    if (namespaces.length > 0) parts.push(`* as ${namespaces.join(', ')}`);

    lines.push(`import ${parts.join(', ')} from '${source}';`);
  }

  return lines.join('\n');
}

/**
 * Combines MFC parts back into a single SFC file.
 * Parts come from the entry file and the model/style/server sub-files.
 * Returns the combined SFC source string.
 * Throws ConvertComponentError on problems.
 */
export function planCombine(parts: CombineParts, fileName: string): CombineResult {
  const entryInfo = analyzePart(parts.entry, fileName);

  // Non-import entry bindings are the ground truth for collision checks.
  // An import name (e.g. `z`) shared between entry and a sub-part is NOT
  // a collision — only a duplicate non-import top-level binding is.
  const entryNonImportDeclared = new Set(entryInfo.bindings.declared);
  for (const name of entryInfo.bindings.imports) {
    entryNonImportDeclared.delete(name);
  }

  // Parse sub-parts (model, style, server) for collision check and import
  // extraction. A missing or empty part is skipped.
  const subParts: { partCode: string; info: PartInfo }[] = [];
  const addSubPart = (code: string | undefined) => {
    if (code && code.trim() !== '') {
      subParts.push({ partCode: code, info: analyzePart(code, fileName + '-part') });
    }
  };
  addSubPart(parts.model);
  addSubPart(parts.style);
  addSubPart(parts.server);

  // § Collision check: a sub-part must not redeclare a non-import entry binding.
  for (const { info } of subParts) {
    for (const name of info.bindings.declared) {
      if (entryNonImportDeclared.has(name)) {
        throw new ConvertComponentError(
          "Binding '" + name + "' already defined in entry",
          'colliding_binding',
          name,
        );
      }
    }
  }

  // Merge imports from entry and every sub-part into one deduplicated block.
  const importSources = [
    { code: parts.entry, imports: entryInfo.imports },
    ...subParts.map((s) => ({ code: s.partCode, imports: s.info.imports })),
  ];
  const mergedImports = mergeImports(importSources);

  // Assemble sections: imports → model body → style body → server body → entry body.
  const sections: string[] = [];
  if (mergedImports !== '') {
    sections.push(mergedImports);
  }

  for (const { info } of subParts) {
    if (info.body.trim() !== '') {
      sections.push(info.body.trim());
    }
  }

  if (entryInfo.body.trim() !== '') {
    sections.push(entryInfo.body.trim());
  }

  return sections.join('\n\n') + '\n';
}

/* ------------------------------------------------------------------ */
/*  detectComponentShape                                               */
/* ------------------------------------------------------------------ */

/**
 * Detects the current shape of a component from its source code
 * and directory structure.
 *
 * - sfc: a single .tsx file (no directory sibling with the same basename)
 * - mfc: a directory with at least an index.tsx (entry file) present
 * - ambiguous: both a .tsx file AND a directory sibling exist
 * - none: no recognized component files found
 */
export function detectComponentShape(files: ComponentShapeFiles): ComponentShape {
  const hasSfcFile = files.entryFile !== undefined;
  const hasMfcDir = files.directory !== undefined;

  if (hasSfcFile && hasMfcDir) return 'ambiguous';
  if (hasSfcFile) return 'sfc';
  if (hasMfcDir) return 'mfc';
  return 'none';
}
