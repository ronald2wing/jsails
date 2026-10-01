/**
 * Scope-walker: port unimport's {@code traveseScopes} onto
 * {@code rolldown/utils}'s {@link Visitor}. Pure — no I/O, no imports beyond
 * the walker.
 *
 * Walks an estree-shaped {@link Program} (from {@code parseSync}) and returns
 * the set of free identifiers — names used in a value position but not declared
 * in any reachable scope. References and declarations are collected during the
 * walk; resolution runs **after** the walk completes, so a forward reference to
 * a hoisted {@code function}/{@code var} (or a class declared later in the same
 * scope) resolves correctly rather than being misreported as free.
 *
 * Honest limits (matching unimport): a {@code var} declared after its use in
 * the same function scope is considered declared (JS hoisting), so the walker
 * never reports it as free. A {@code let}/{@code const} used before its
 * declaration in the same block is also treated as declared (the ESTree scope
 * model — the type checker's temporal dead-zone violation is a separate
 * concern). No type information is consulted; only lexical scope.
 */

import { Visitor, type ESTree } from 'rolldown/utils';

type Program = ESTree.Program;

/**
 * Minimal structural node view. The estree shapes vary per node type, so the
 * walker confirms {@code type} first and reads fields only after, exactly as
 * unimport's walker does over an untyped estree tree.
 */
type Node = { type: string; [key: string]: unknown };

/* ------------------------------------------------------------------ */
/*  Scope model                                                        */
/* ------------------------------------------------------------------ */

interface Scope {
  readonly parent: number;
  readonly declarations: Set<string>;
  readonly references: Set<string>;
}

/* ------------------------------------------------------------------ */
/*  Node helpers                                                       */
/* ------------------------------------------------------------------ */

const asNode = (value: unknown): Node | undefined =>
  value !== null && typeof value === 'object' && typeof (value as Node).type === 'string'
    ? (value as Node)
    : undefined;

const nodeName = (node: Node): string | undefined =>
  typeof node.name === 'string' ? node.name : undefined;

const asArray = (value: unknown): Node[] => (Array.isArray(value) ? (value as Node[]) : []);

/* ------------------------------------------------------------------ */
/*  Binding-pattern extraction                                         */
/* ------------------------------------------------------------------ */

/** Extract every binding name from a nested destructuring pattern. */
function extractBindings(pattern: unknown, into: Set<string>): void {
  const node = asNode(pattern);
  if (node === undefined) {
    return;
  }
  switch (node.type) {
    case 'Identifier': {
      const name = nodeName(node);
      if (name !== undefined) {
        into.add(name);
      }
      return;
    }
    case 'ObjectPattern':
      for (const prop of asArray(node.properties)) {
        extractBindings(prop, into);
      }
      return;
    case 'ArrayPattern':
      for (const element of asArray(node.elements)) {
        extractBindings(element, into);
      }
      return;
    case 'AssignmentPattern':
      extractBindings(node.left, into);
      return;
    case 'RestElement':
      extractBindings(node.argument, into);
      return;
    case 'Property':
      // The bound name of a destructuring property is its value.
      extractBindings(node.value, into);
      return;
    default:
      return;
  }
}

/* ------------------------------------------------------------------ */
/*  Value-position check                                               */
/* ------------------------------------------------------------------ */

/**
 * True when `id` sits in a value position under `parent`. Ported from
 * unimport's {@code traveseScopes} reference rules, extended with the
 * operator/argument nodes the walker parent-tracks.
 */
function isValuePosition(parent: Node, id: Node): boolean {
  switch (parent.type) {
    case 'CallExpression':
    case 'NewExpression':
      if (parent.callee === id) return true;
      return asArray(parent.arguments).includes(id);
    case 'MemberExpression':
      if (parent.object === id) return true;
      return parent.computed === true && parent.property === id;
    case 'VariableDeclarator':
      return parent.init === id;
    case 'SpreadElement':
      return parent.argument === id;
    case 'ClassDeclaration':
    case 'ClassExpression':
      return parent.superClass === id;
    case 'Property':
    case 'PropertyDefinition':
      if (parent.value === id) return true;
      return parent.computed === true && parent.key === id;
    case 'MethodDefinition':
      return parent.computed === true && parent.key === id;
    case 'TemplateLiteral':
      return asArray(parent.expressions).includes(id);
    case 'AssignmentExpression':
      // A plain identifier on either side is a reference (`x = 1` reads the
      // binding it writes, and can be a free variable). A member expression on
      // the left is handled by MemberExpression, not here.
      return parent.left === id || parent.right === id;
    case 'AssignmentPattern':
    case 'LogicalExpression':
    case 'ForOfStatement':
    case 'ForInStatement':
      return parent.right === id;
    case 'ReturnStatement':
    case 'ThrowStatement':
      return parent.argument === id;
    case 'ExportDefaultDeclaration':
    case 'ExportNamedDeclaration':
      return parent.declaration === id;
    case 'IfStatement':
    case 'WhileStatement':
    case 'DoWhileStatement':
      return parent.test === id;
    case 'SwitchStatement':
      return parent.discriminant === id;
    case 'SwitchCase':
      return parent.test === id;
    case 'BinaryExpression':
      return parent.left === id || parent.right === id;
    case 'UnaryExpression':
    case 'UpdateExpression':
    case 'AwaitExpression':
    case 'YieldExpression':
      return parent.argument === id;
    case 'ConditionalExpression':
      return parent.test === id || parent.consequent === id || parent.alternate === id;
    case 'SequenceExpression':
    case 'ArrayExpression':
      return asArray(parent.expressions ?? parent.elements).includes(id);
    case 'TaggedTemplateExpression':
      return parent.tag === id;
    case 'ArrowFunctionExpression':
      // A bare identifier body (`x => y`) is a reference; a block body is
      // handled by the BlockStatement scope.
      return parent.body === id;
    case 'ExpressionStatement':
    case 'ParenthesizedExpression':
    case 'ChainExpression':
      return parent.expression === id;
    // JSX: an element's name is a component reference (`<Counter />` reads
    // `Counter`); a member name (`<Foo.Bar />`) reads `Foo`. Attribute names
    // (`<input value=... />`) are not references, but attribute expressions
    // are plain Identifiers handled by JSXExpressionContainer below.
    case 'JSXOpeningElement':
    case 'JSXClosingElement':
      return parent.name === id;
    case 'JSXMemberExpression':
      return parent.object === id;
    case 'JSXExpressionContainer':
      return parent.expression === id;
    case 'JSXSpreadAttribute':
      return parent.argument === id;
    case 'JSXAttribute':
      // A JSXIdentifier attribute name is not a reference; but its value, when
      // a container, is reached through JSXExpressionContainer.
      return false;
    default:
      return false;
  }
}

/* ------------------------------------------------------------------ */
/*  Declaration-position check                                         */
/* ------------------------------------------------------------------ */

/** True when `id` under `parent` is a binding occurrence, not a reference. */
function isDeclarationPosition(parent: Node, id: Node): boolean {
  if (
    parent.type === 'ImportSpecifier' ||
    parent.type === 'ImportDefaultSpecifier' ||
    parent.type === 'ImportNamespaceSpecifier'
  ) {
    return parent.local === id;
  }
  if (parent.type === 'VariableDeclarator') {
    // `id` may be the top-level Identifier or nested in a pattern.
    return isInBindingPattern(parent.id, id);
  }
  if (
    parent.type === 'FunctionDeclaration' ||
    parent.type === 'FunctionExpression' ||
    parent.type === 'ClassDeclaration' ||
    parent.type === 'ClassExpression'
  ) {
    return parent.id === id;
  }
  if (parent.type === 'CatchClause') {
    return parent.param === id;
  }
  if (
    parent.type === 'FunctionDeclaration' ||
    parent.type === 'FunctionExpression' ||
    parent.type === 'ArrowFunctionExpression'
  ) {
    return asArray(parent.params).some((param) => isInBindingPattern(param, id));
  }
  if (parent.type === 'LabeledStatement') {
    return parent.label === id;
  }
  return false;
}

/** True when `id` is (or is nested inside) the binding pattern `pattern`. */
function isInBindingPattern(pattern: unknown, id: Node): boolean {
  const node = asNode(pattern);
  if (node === undefined) return false;
  if (node === id) return true;
  switch (node.type) {
    case 'ObjectPattern':
      return asArray(node.properties).some((prop) => isInBindingPattern(prop, id));
    case 'ArrayPattern':
      return asArray(node.elements).some((element) => isInBindingPattern(element, id));
    case 'AssignmentPattern':
      return isInBindingPattern(node.left, id);
    case 'RestElement':
      return isInBindingPattern(node.argument, id);
    case 'Property':
      return isInBindingPattern(node.value, id);
    default:
      return false;
  }
}

/* ------------------------------------------------------------------ */
/*  Main entry point                                                   */
/* ------------------------------------------------------------------ */

/**
 * Walk an estree {@link Program} and return the set of unmatched (free)
 * identifier names. A name that resolves in any reachable scope — declared
 * locally, imported, caught, or hoisted — is excluded; only names with no
 * enclosing declaration are returned.
 *
 * Two-phase, mirroring unimport: references and declarations are gathered per
 * scope during the walk, then a post-walk pass resolves each reference outward.
 * Deferring resolution is what makes hoisting correct — a function referenced
 * before its declaration still finds the later declaration in its scope.
 *
 * The walker is pure: no filesystem, no module resolution, no I/O.
 */
export function collectUnmatchedIdentifiers(program: Program): ReadonlySet<string> {
  const root = program as unknown as Node;
  // Scopes are retained for the whole walk (never popped off `scopes`); a
  // `scopeStack` tracks the active index so post-walk resolution can walk each
  // scope's `parent` chain. Mutating the array on exit would lose every inner
  // scope before resolution ran.
  const scopes: Scope[] = [{ parent: -1, declarations: new Set(), references: new Set() }];
  const scopeStack: number[] = [0];
  const parentStack: Node[] = [];
  // Index of the nearest enclosing function scope; `var` declarations hoist to
  // it rather than to the block they appear in.
  const functionScopeStack: number[] = [0];

  const current = (): Scope => scopes[scopeStack[scopeStack.length - 1]!]!;
  const pushScope = (): void => {
    const parent = scopeStack[scopeStack.length - 1]!;
    scopes.push({ parent, declarations: new Set(), references: new Set() });
    scopeStack.push(scopes.length - 1);
  };
  const popScope = (): void => {
    scopeStack.pop();
  };
  const pushFunctionScope = (): void => {
    pushScope();
    functionScopeStack.push(scopeStack[scopeStack.length - 1]!);
  };
  const popFunctionScope = (): void => {
    functionScopeStack.pop();
    popScope();
  };
  const currentFunctionScope = (): Scope =>
    scopes[functionScopeStack[functionScopeStack.length - 1]!]!;
  const pushParent = (node: Node): void => {
    parentStack.push(node);
  };
  const popParent = (): void => {
    parentStack.pop();
  };

  const hooks: Record<string, (node: Node) => void> = {};

  /**
   * Push a scope for the duration of `node`. The loop and catch forms below
   * register their own handlers (they also bind names into the fresh scope) and
   * overwrite these, so `scopeHooks` is only for forms whose scope is empty on
   * entry.
   */
  const scopeHooks = (kind: string): void => {
    hooks[kind] = (node) => {
      pushParent(node);
      pushScope();
    };
    hooks[`${kind}:exit`] = () => {
      popParent();
      popScope();
    };
  };

  // A plain block (or class static block) opens a scope with no bindings.
  scopeHooks('BlockStatement');
  scopeHooks('StaticBlock');

  // Program: the root scope is already present; only track the parent.
  hooks['Program'] = (node) => {
    pushParent(node);
  };
  hooks['Program:exit'] = () => {
    popParent();
  };

  // Function declarations: the id lands in the ENCLOSING scope (so a hoisted
  // call from a sibling resolves), params in the new function scope.
  hooks['FunctionDeclaration'] = (node) => {
    pushParent(node);
    const id = asNode(node.id);
    const name = id !== undefined ? nodeName(id) : undefined;
    if (name !== undefined) {
      current().declarations.add(name);
    }
    pushFunctionScope();
    for (const param of asArray(node.params)) {
      extractBindings(param, current().declarations);
    }
  };
  hooks['FunctionDeclaration:exit'] = () => {
    popParent();
    popFunctionScope();
  };

  // Function expressions: a named expression's id binds inside its own scope.
  hooks['FunctionExpression'] = (node) => {
    pushParent(node);
    pushFunctionScope();
    const id = asNode(node.id);
    const name = id !== undefined ? nodeName(id) : undefined;
    if (name !== undefined) {
      current().declarations.add(name);
    }
    for (const param of asArray(node.params)) {
      extractBindings(param, current().declarations);
    }
  };
  hooks['FunctionExpression:exit'] = () => {
    popParent();
    popFunctionScope();
  };

  hooks['ArrowFunctionExpression'] = (node) => {
    pushParent(node);
    pushFunctionScope();
    for (const param of asArray(node.params)) {
      extractBindings(param, current().declarations);
    }
  };
  hooks['ArrowFunctionExpression:exit'] = () => {
    popParent();
    popFunctionScope();
  };

  // Loop heads declare into the loop's own scope (the scope is pushed by the
  // scopeHooks above before these fire).
  hooks['ForStatement'] = (node) => {
    pushParent(node);
    pushScope();
    const init = asNode(node.init);
    if (init !== undefined && init.type === 'VariableDeclaration') {
      const target = init.kind === 'var' ? currentFunctionScope() : current();
      for (const decl of asArray(init.declarations)) {
        extractBindings(decl.id, target.declarations);
      }
    }
  };
  hooks['ForStatement:exit'] = () => {
    popParent();
    popScope();
  };

  hooks['ForInStatement'] = (node) => {
    pushParent(node);
    pushScope();
    const left = asNode(node.left);
    const target =
      left !== undefined && left.type === 'VariableDeclaration' && left.kind === 'var'
        ? currentFunctionScope()
        : current();
    extractBindings(node.left, target.declarations);
  };
  hooks['ForInStatement:exit'] = () => {
    popParent();
    popScope();
  };

  hooks['ForOfStatement'] = (node) => {
    pushParent(node);
    pushScope();
    const left = asNode(node.left);
    const target =
      left !== undefined && left.type === 'VariableDeclaration' && left.kind === 'var'
        ? currentFunctionScope()
        : current();
    extractBindings(node.left, target.declarations);
  };
  hooks['ForOfStatement:exit'] = () => {
    popParent();
    popScope();
  };

  hooks['CatchClause'] = (node) => {
    pushParent(node);
    pushScope();
    if (node.param !== undefined) {
      extractBindings(node.param, current().declarations);
    }
  };
  hooks['CatchClause:exit'] = () => {
    popParent();
    popScope();
  };

  // ------------------------------------------------------------------
  // Declarations that do not open a scope
  // ------------------------------------------------------------------
  hooks['ImportDeclaration'] = (node) => {
    for (const spec of asArray(node.specifiers)) {
      const local = asNode(spec.local);
      const name = local !== undefined ? nodeName(local) : undefined;
      if (name !== undefined) {
        current().declarations.add(name);
      }
    }
  };

  hooks['VariableDeclaration'] = (node) => {
    // `var` is function-scoped: it hoists to the nearest enclosing function
    // scope (or the root), not to the block it appears in. `let`/`const` bind
    // in the current block.
    const target = node.kind === 'var' ? currentFunctionScope() : current();
    for (const decl of asArray(node.declarations)) {
      extractBindings(decl.id, target.declarations);
    }
  };

  hooks['ClassDeclaration'] = (node) => {
    pushParent(node);
    const id = asNode(node.id);
    const name = id !== undefined ? nodeName(id) : undefined;
    if (name !== undefined) {
      current().declarations.add(name);
    }
  };
  hooks['ClassDeclaration:exit'] = () => {
    popParent();
  };

  // ------------------------------------------------------------------
  // Parent tracking for every node that can be an Identifier's parent
  // ------------------------------------------------------------------
  const parentOnly = [
    'ExpressionStatement',
    'CallExpression',
    'NewExpression',
    'MemberExpression',
    'VariableDeclarator',
    'SpreadElement',
    'ClassDeclaration',
    'ClassExpression',
    'Property',
    'PropertyDefinition',
    'MethodDefinition',
    'TemplateLiteral',
    'AssignmentExpression',
    'AssignmentPattern',
    'LogicalExpression',
    'ReturnStatement',
    'ThrowStatement',
    'ExportDefaultDeclaration',
    'ExportNamedDeclaration',
    'ExportSpecifier',
    'IfStatement',
    'WhileStatement',
    'DoWhileStatement',
    'SwitchStatement',
    'SwitchCase',
    'BinaryExpression',
    'UnaryExpression',
    'UpdateExpression',
    'ConditionalExpression',
    'AwaitExpression',
    'YieldExpression',
    'SequenceExpression',
    'TaggedTemplateExpression',
    'ArrayExpression',
    'ParenthesizedExpression',
    'ChainExpression',
    'LabeledStatement',
    'JSXOpeningElement',
    'JSXClosingElement',
    'JSXMemberExpression',
    'JSXExpressionContainer',
    'JSXSpreadAttribute',
    'JSXAttribute',
    'JSXElement',
    'JSXFragment',
    'JSXNamespacedName',
  ] as const;

  for (const kind of parentOnly) {
    if (hooks[kind] === undefined) {
      hooks[kind] = (node) => {
        pushParent(node);
      };
      hooks[`${kind}:exit`] = () => {
        popParent();
      };
    }
  }

  // ------------------------------------------------------------------
  // References: record into the current scope; resolve after the walk
  // ------------------------------------------------------------------
  hooks['Identifier'] = (node) => {
    const parent = parentStack[parentStack.length - 1];
    if (parent === undefined) {
      return;
    }
    if (isDeclarationPosition(parent, node)) {
      return;
    }
    // `export { x }` reads the local binding `x`; `export { x } from './y.js'`
    // re-exports from another module and does NOT reference a local binding, so
    // the grandparent's `source` decides. `isValuePosition` cannot see the
    // grandparent, so this case is handled here.
    if (parent.type === 'ExportSpecifier') {
      const grandparent = parentStack[parentStack.length - 2];
      if (
        grandparent !== undefined &&
        grandparent.source !== null &&
        grandparent.source !== undefined
      ) {
        return;
      }
      if (parent.local !== node) {
        return;
      }
      const name = nodeName(node);
      if (name !== undefined) {
        current().references.add(name);
      }
      return;
    }
    if (!isValuePosition(parent, node)) {
      return;
    }
    const name = nodeName(node);
    if (name !== undefined) {
      current().references.add(name);
    }
  };

  // JSX element names parse as `JSXIdentifier`, not `Identifier`. A lowercase
  // intrinsic element (`<div>`) is a host element, not a binding; only a
  // capitalized or member name references a value, but recording a lowercase
  // name is harmless — a host element never names an autoload symbol.
  hooks['JSXIdentifier'] = (node) => {
    const parent = parentStack[parentStack.length - 1];
    if (parent === undefined) {
      return;
    }
    if (!isValuePosition(parent, node)) {
      return;
    }
    const name = nodeName(node);
    if (name !== undefined && /^[A-Z]/.test(name)) {
      current().references.add(name);
    }
  };

  new Visitor(hooks).visit(root as unknown as ESTree.Program);

  // Post-walk resolution: a reference resolves if a scope declares it while
  // walking outward from the scope it was seen in to the root. Deferring this
  // is what makes hoisting correct — a function referenced before its
  // declaration still finds the later declaration in its scope.
  const unmatched = new Set<string>();
  for (let index = 0; index < scopes.length; index++) {
    const scope = scopes[index]!;
    for (const name of scope.references) {
      let resolved = false;
      for (let cursor = index; cursor >= 0; cursor = scopes[cursor]!.parent) {
        if (scopes[cursor]!.declarations.has(name)) {
          resolved = true;
          break;
        }
      }
      if (!resolved) {
        unmatched.add(name);
      }
    }
  }

  return unmatched;
}
