/**
 * Component resolution for the template dialect.
 *
 * A capitalized tag in a `<template>` (e.g. `<Counter />`) lowers to JSX
 * verbatim. The scope-walker flags the tag as a free reference, but the
 * autoload scan deliberately excludes `app/components/` — so the emitted module
 * would carry an unresolved reference. This module closes that gap: it collects
 * the capitalized tags from a lowered view and resolves each to an explicit
 * import the emitter prepends to the module.
 *
 * A capitalized tag can only mean a **Preact component**. A server component is
 * asynchronous (`renderNested` returns `Promise<VNode>`) and must be rendered in
 * `load`, then passed in as a prop — it can never be an inline template tag.
 *
 * Resolution is N1-faithful: tag `Counter` resolves to
 * `app/components/counter.js` (the kebab-case of the tag). The tag name is the
 * export name; the file is the kebab-case. A tag with no file is a positioned
 * `unresolved_component` diagnostic (reported through the supplied
 * {@link ComponentReporter}) and is skipped — every missing component in a view
 * is reported in one pass, and no unresolved reference is ever emitted silently.
 *
 * Pure except for the existence check: no module is imported, no top-level code
 * runs. The check reads the filesystem only to confirm the resolved file exists.
 */

import { join, relative } from 'node:path';

import { Visitor, parseSync, type ESTree } from 'rolldown/utils';

import {
  CLIENT_COMPONENT_EXTENSIONS,
  CONVENTION_DIRS,
  kebabCase,
  probeConventionFile,
} from './conventions.js';

import type { CompilerErrorCode } from './errors.js';
import type { TemplateNode } from './template-ast.js';

type Program = ESTree.Program;

/** A capitalized tag found in a view, with its absolute source position. */
export interface ComponentTagRef {
  /** The tag as written in the template, e.g. `Counter`. */
  readonly tag: string;
  /** Absolute offset of the tag's first character in the component source. */
  readonly start: number;
  /** Absolute offset just past the tag's last character (exclusive). */
  readonly end: number;
}

/**
 * Callback that records a component-resolution error. The caller owns the
 * message; the reference owns the position, so the diagnostic is pinned to the
 * exact tag rather than the whole region.
 */
export interface ComponentReporter {
  (code: CompilerErrorCode, message: string, subject: string, start: number, end: number): void;
}

/** A capitalized tag resolved to an importable component module. */
export interface ResolvedComponent {
  /** The tag as written in the template, e.g. `Counter`. */
  readonly tag: string;
  /** Absolute path to the resolved component module. */
  readonly file: string;
  /** Import specifier relative to the emitted module, `.js`-rewritten. */
  readonly specifier: string;
}

/** Options for {@link resolveComponentTags}. */
export interface ResolveComponentsOptions {
  /** Directory of the emitted module, for the relative import specifier. */
  readonly fromDir: string;
  /** Project root, used to locate `app/components/`. */
  readonly rootDir: string;
}

/**
 * Collect the capitalized JSX tag names from a lowered view.
 *
 * Walks the estree AST (the same `parseSync` + `Visitor` convention as the
 * scope-walker) and records the position of every `JSXOpeningElement` whose name
 * is a capitalized identifier. A member expression (`<Foo.Bar />`) contributes
 * its root (`Foo`); an intrinsic tag (`<div>`) is ignored. Closing elements are
 * skipped — the opening element carries the canonical position, so a tag is
 * never reported twice.
 *
 * `baseOffset` is added to each tag's view-relative offset to yield a
 * source-absolute position. Returns a deterministic, de-duplicated-by-name,
 * sorted list. Reports a positioned `unparseable` diagnostic (at `baseOffset`)
 * and returns an empty list when the view does not parse.
 */
export function collectComponentTags(
  view: string,
  baseOffset: number,
  report: ComponentReporter,
): readonly ComponentTagRef[] {
  const found = new Map<string, ComponentTagRef>();

  let program: Program;
  try {
    program = parseView(view);
  } catch {
    report('unparseable', 'view region could not be parsed', 'view', baseOffset, baseOffset);
    return Object.freeze([]);
  }

  new Visitor({
    JSXOpeningElement(node: unknown) {
      const element = node as { name?: unknown; start?: unknown; end?: unknown };
      const name = jsxRootName(element.name);
      if (name === undefined || !/^[A-Z]/.test(name) || found.has(name)) {
        return;
      }
      const start = typeof element.start === 'number' ? element.start : 0;
      const end = typeof element.end === 'number' ? element.end : start;
      found.set(
        name,
        Object.freeze({ tag: name, start: baseOffset + start, end: baseOffset + end }),
      );
    },
  }).visit(program);

  return Object.freeze([...found.values()].sort((a, b) => a.tag.localeCompare(b.tag)));
}

/**
 * Collect capitalized element tags from a parsed `<template>` tree.
 *
 * The nodes already carry body-absolute offsets (V2), so `baseOffset` converts
 * them to source-absolute positions without a re-parse — the template dialect
 * cannot be handed to the TSX parser before lowering.
 */
export function collectTemplateComponents(
  nodes: readonly TemplateNode[],
  baseOffset: number,
): readonly ComponentTagRef[] {
  const found = new Map<string, ComponentTagRef>();
  const walk = (list: readonly TemplateNode[]): void => {
    for (const node of list) {
      if (node.kind !== 'element') {
        continue;
      }
      if (/^[A-Z]/.test(node.tag) && !found.has(node.tag)) {
        found.set(
          node.tag,
          Object.freeze({
            tag: node.tag,
            start: baseOffset + node.start,
            end: baseOffset + node.end,
          }),
        );
      }
      walk(node.children);
    }
  };
  walk(nodes);
  return Object.freeze([...found.values()].sort((a, b) => a.tag.localeCompare(b.tag)));
}

/**
 * Resolve capitalized tags to component modules under `app/components/`.
 *
 * Each tag resolves to `app/components/<kebab-case>.js`. A tag with no module is
 * reported as a value-free `unresolved_component` diagnostic and skipped, so a
 * view with several missing components reports all of them in one pass. The
 * returned list is frozen and ordered by tag.
 */
export function resolveComponentTags(
  tags: readonly ComponentTagRef[],
  options: ResolveComponentsOptions,
  report: ComponentReporter,
): readonly ResolvedComponent[] {
  const componentsDir = join(options.rootDir, CONVENTION_DIRS.clientComponents);
  const resolved: ResolvedComponent[] = [];

  for (const ref of tags) {
    const file = probeConventionFile(
      componentsDir,
      kebabCase(ref.tag),
      CLIENT_COMPONENT_EXTENSIONS,
    );
    if (file === undefined) {
      report(
        'unresolved_component',
        `component '${ref.tag}' has no module under app/components/`,
        ref.tag,
        ref.start,
        ref.end,
      );
      continue;
    }
    resolved.push(
      Object.freeze({
        tag: ref.tag,
        file,
        specifier: toSpecifier(options.fromDir, file),
      }),
    );
  }

  return Object.freeze(resolved);
}

/* ------------------------------------------------------------------ */
/*  Internals                                                          */
/* ------------------------------------------------------------------ */

/** Parse a view region as TSX. The synthetic filename must carry a TSX
 * extension so `parseSync` infers the language; a bare name parses as JS. A view
 * arrives in one of two shapes: a complete statement (the `.tsx` region form) or
 * a bare JSX expression that may have several top-level roots (the `.jsails`
 * template form). Try the statement shape first, then a fragment-wrapped shape
 * so a multi-root expression still parses as one node. */
function parseView(view: string): Program {
  const direct = parseSync('view.tsx', view);
  if (!direct.errors.some((error) => error.severity === 'Error')) {
    return direct.program;
  }
  const wrapped = parseSync('view.tsx', `const __view = (<>${view}</>);\n`);
  if (wrapped.errors.some((error) => error.severity === 'Error')) {
    throw new Error('view parse failed');
  }
  return wrapped.program;
}

/** The root identifier of a JSX element name, or `undefined` for a non-name. */
function jsxRootName(name: unknown): string | undefined {
  if (name === null || typeof name !== 'object') {
    return undefined;
  }
  const node = name as { type?: string; name?: unknown; object?: unknown };
  if (node.type === 'JSXIdentifier' && typeof node.name === 'string') {
    return node.name;
  }
  if (node.type === 'JSXMemberExpression') {
    return jsxRootName(node.object);
  }
  return undefined;
}

/** Build a relative import specifier with a `.js` extension. */
function toSpecifier(fromDir: string, file: string): string {
  const rel = relative(fromDir, file).replace(/\\/g, '/');
  const withDot = rel.startsWith('.') ? rel : './' + rel;
  return withDot.replace(/\.(tsx|ts|mtsx|mts|jsx)$/, '.js');
}
