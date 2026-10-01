/**
 * Lowering of a parsed `<template>` tree (`template-ast.ts`) into JSX source.
 *
 * The lowerer is pure: it walks the `TemplateNode[]` tree and emits a JSX
 * string. Expression text is carried verbatim — the compiler never evaluates
 * it — so the emitted JSX is typechecked by `tsc` after lowering.
 *
 * `js-*` directives are lowered through the shared `lowerDirective` table
 * (`directives.ts`), so the template dialect and the raw-JSX dialect share one
 * directive source of truth.
 *
 * Errors are collected, not thrown: every problem emits a diagnostic into the
 * `DiagnosticBag` and the lowering continues with a placeholder so the rest of
 * the template still lowers. Recovery placeholders:
 * - Bad element / malformed conditional / malformed `js-for` → `'{null}'` for the element.
 * - Bad attribute / unknown directive / directive value error → dropped (emit `''`).
 * - `js-html`/`js-content` combined with children → emit with the directive, drop children.
 * - `js-model` on a component, `<component>` without `js-is` → fall back to a self-closing literal tag.
 * - `directiveValue` failure (no value for a value-requiring directive) → treat value as `null`.
 * - `parseFor` failure → emit `'{null}'`.
 *
 * A node that produces an error is lowered to its placeholder immediately, so
 * it is never re-entered: each error site returns before recursing into the same
 * node, which means no child is validated twice.
 */

import { DiagnosticBag } from './diagnostics.js';
import { lowerDirective } from './directives.js';
import {
  CAPTURE_ATTRIBUTE,
  ONCE_ATTRIBUTE,
  PASSIVE_ATTRIBUTE,
} from '../server-components/protocol.js';
import type { TemplateAttr, TemplateNode } from './template-ast.js';

/**
 * Context passed to every template-lowering helper. Carries the diagnostic bag
 * and the absolute source offset of the template body, so a node-relative
 * offset (`TemplateNode.start`/`.end`) converts to a file-absolute position.
 */
export interface LowerContext {
  readonly bag: DiagnosticBag;
  /** Absolute source offset of the template body; node offsets are relative to it. */
  readonly baseOffset: number;
}

/** Lower a parsed template tree to JSX source. */
export function lowerTemplate(nodes: readonly TemplateNode[], ctx: LowerContext): string {
  return lowerNodes(nodes, ctx);
}

/**
 * Whether a lowered view uses the `h(...)` call the dynamic-component lowering
 * emits. The emit layer uses this to inject `import { h } from 'preact'`.
 *
 * The check is the exact `{h(` sequence the lowerer produces; a user's own
 * `h(` in JSX is indistinguishable, so the emit layer also skips injection when
 * the preamble already imports `h`.
 */
export function usesDynamicComponent(view: string): boolean {
  return view.includes('{h(');
}

function lowerNodes(nodes: readonly TemplateNode[], ctx: LowerContext): string {
  const parts: string[] = [];
  let index = 0;
  while (index < nodes.length) {
    const node = nodes[index];
    if (node === undefined) {
      break;
    }
    // `js-for` is handled before the conditional chain: an element carrying both
    // `js-for` and `js-if` evaluates `js-if` inside the loop (Vue 3 semantics), so
    // it must not be consumed as a conditional branch.
    if (node.kind === 'element' && hasDirective(node.attrs, 'js-for')) {
      parts.push(lowerElement(node, ctx, { skipConditional: false }));
      index += 1;
      continue;
    }
    const conditional = readConditional(nodes, index, ctx);
    if (conditional !== null) {
      parts.push(lowerConditional(conditional, ctx));
      index = conditional.end;
      continue;
    }
    parts.push(lowerNode(node, ctx));
    index += 1;
  }
  return parts.join('');
}

interface ConditionalChain {
  readonly branches: readonly {
    readonly kind: 'if' | 'else-if' | 'else';
    readonly cond: string | null;
    readonly node: TemplateNode;
  }[];
  readonly end: number;
}

/**
 * Read a `js-if`/`js-else-if`/`js-else` chain starting at `start`. Returns `null`
 * when the node at `start` does not open a chain.
 *
 * A stray `js-else`/`js-else-if` (no preceding `js-if`) emits an error and is
 * skipped — the chain does not open, so the stray is lowered as an ordinary
 * element by the caller.
 */
function readConditional(
  nodes: readonly TemplateNode[],
  start: number,
  ctx: LowerContext,
): ConditionalChain | null {
  const first = nodes[start];
  if (first === undefined || first.kind !== 'element') {
    return null;
  }
  const firstCond = directiveValue(first.attrs, 'js-if', ctx, first);
  if (firstCond === null) {
    if (hasDirective(first.attrs, 'js-else-if') || hasDirective(first.attrs, 'js-else')) {
      const name = hasDirective(first.attrs, 'js-else-if') ? 'js-else-if' : 'js-else';
      ctx.bag.errorAt(
        'unsupported_position',
        `Directive '${name}' has no preceding js-if`,
        ctx.baseOffset + first.start,
        ctx.baseOffset + first.end,
      );
    }
    return null;
  }

  const branches: ConditionalChain['branches'][number][] = [
    { kind: 'if', cond: firstCond, node: first },
  ];
  let index = start + 1;
  for (;;) {
    const next = nodes[index];
    if (next === undefined || next.kind !== 'element') {
      break;
    }
    const elseIf = directiveValue(next.attrs, 'js-else-if', ctx, next);
    if (elseIf !== null) {
      branches.push({ kind: 'else-if', cond: elseIf, node: next });
      index += 1;
      continue;
    }
    if (hasDirective(next.attrs, 'js-else')) {
      branches.push({ kind: 'else', cond: null, node: next });
      index += 1;
    }
    break;
  }
  return { branches, end: index };
}

function lowerConditional(chain: ConditionalChain, ctx: LowerContext): string {
  let out = '';
  for (let i = 0; i < chain.branches.length; i += 1) {
    const branch = chain.branches[i];
    if (branch === undefined) {
      continue;
    }
    const body = lowerElement(branch.node, ctx, { skipConditional: true });
    if (branch.kind === 'if') {
      out += `{${branch.cond} ? (${body}) : `;
    } else if (branch.kind === 'else-if') {
      out += `${branch.cond} ? (${body}) : `;
    } else {
      out += `(${body})}`;
    }
  }
  // A lone `js-if` (no `js-else`) needs an explicit `null` fallback; otherwise the
  // emitted ternary is syntactically incomplete.
  if (chain.branches.length === 1) {
    out += 'null}';
  }
  return out;
}

function lowerNode(node: TemplateNode, ctx: LowerContext): string {
  switch (node.kind) {
    case 'text':
      return node.value;
    case 'interpolation':
      return `{${node.expr}}`;
    case 'element':
      return lowerElement(node, ctx, { skipConditional: false });
  }
}

interface LowerElementOptions {
  /** When true, `js-if`/`js-else-if`/`js-else` are ignored (already consumed by a chain). */
  readonly skipConditional: boolean;
}

function lowerElement(node: TemplateNode, ctx: LowerContext, options: LowerElementOptions): string {
  if (node.kind !== 'element') {
    return lowerNode(node, ctx);
  }

  const forAttr = findDirective(node.attrs, 'js-for');
  const ifCond = options.skipConditional ? null : directiveValue(node.attrs, 'js-if', ctx, node);
  // A `js-for` element's conditional directives are consumed here (evaluated
  // inside the loop), so they must never reach `renderAttr`.
  const dropConditional = options.skipConditional || forAttr !== null;
  // When the conditional chain is NOT being consumed (skipConditional is false),
  // filter out js-else/js-else-if that aren't part of a chain. A stray js-else
  // was already reported by `readConditional` and must not be re-reported by
  // `renderAttr` as an unknown directive.
  const attrs = node.attrs.filter((attr) => {
    if (isStructuralDirective(attr.name, dropConditional)) {
      return false;
    }
    // Also filter js-else/js-else-if when not in a conditional chain and not
    // part of a js-for (which handles them separately).
    if (!dropConditional && (attr.name === 'js-else-if' || attr.name === 'js-else')) {
      return false;
    }
    return true;
  });
  const rendered = renderElement(node.tag, attrs, node.children, ctx, node);

  if (forAttr !== null) {
    const loop = parseFor(forAttr.value, ctx, forAttr, node);
    if (loop === null) {
      return '{null}';
    }
    // `js-if` on a `js-for` element is evaluated inside the loop (Vue 3
    // semantics). The ternary is the arrow's return value directly — wrapping it
    // in `{...}` would parse as an object literal, not a JSX expression container.
    const body = ifCond === null ? rendered : `${ifCond} ? (${rendered}) : null`;
    // A parenthesized binding (`(item, index)`) is already an arrow parameter
    // list; wrapping it again would emit `((item, index))`. A bare identifier or
    // a destructuring pattern still needs the parens.
    const params = loop.binding.startsWith('(') ? loop.binding : `(${loop.binding})`;
    return `{${loop.list}.map(${params} => (${body}))}`;
  }
  return rendered;
}

function renderElement(
  tag: string,
  attrs: readonly TemplateAttr[],
  children: readonly TemplateNode[],
  ctx: LowerContext,
  enclosingNode: TemplateNode,
): string {
  // `js-html` sets inner HTML, which JSX forbids alongside children. Reject the
  // combination here (the only place that sees both) rather than emitting JSX
  // that `tsc` would reject with a confusing location.
  // Recovery: keep the directive, drop the children.
  const htmlConflict = hasDirective(attrs, 'js-html') && children.length > 0;
  if (htmlConflict) {
    ctx.bag.errorAt(
      'unsupported_position',
      "Directive 'js-html' cannot be combined with children",
      ctx.baseOffset + enclosingNode.start,
      ctx.baseOffset + enclosingNode.end,
    );
  }

  // `js-content="x"` replaces the element's children with the interpolated value.
  // Reject it alongside children (the two are mutually exclusive).
  const content = findDirective(attrs, 'js-content');
  const hasContentConflict = content !== null && children.length > 0;
  if (hasContentConflict) {
    ctx.bag.errorAt(
      'unsupported_position',
      "Directive 'js-content' cannot be combined with children",
      ctx.baseOffset + content.start,
      ctx.baseOffset + content.end,
    );
  }

  // A directive/child conflict drops the children so the element emits valid JSX
  // (only the directive's own child form remains).
  const effectiveChildren = htmlConflict || hasContentConflict ? [] : children;

  // `js-pre` renders the subtree verbatim: no directive lowering, no
  // interpolation. The lowerer emits the raw inner text as a string child.
  const pre = hasDirective(attrs, 'js-pre');

  // `js-model` on a component (a capitalized tag) is a two-way binding contract
  // JSails does not have. Recovery: emit the element as a self-closing literal
  // tag with remaining attrs, dropping the js-model.
  const model = findDirective(attrs, 'js-model');
  if (model !== null && /^[A-Z]/.test(tag)) {
    ctx.bag.errorAt(
      'unsupported_position',
      "Directive 'js-model' is not supported on a component",
      ctx.baseOffset + model.start,
      ctx.baseOffset + model.end,
    );
    const restAttrs = attrs.filter((attr) => attr.name !== 'js-model');
    const renderedAttrs = restAttrs.map((attr) => renderAttr(attr, ctx)).join('');
    if (effectiveChildren.length === 0) {
      return `<${tag}${renderedAttrs} />`;
    }
    return `<${tag}${renderedAttrs}>${lowerNodes(effectiveChildren, ctx)}</${tag}>`;
  }

  // `<component js-is="X" />` renders the expression `X` as the tag. Valid JSX has
  // no arbitrary-expression tag form, so the lowering is a `h(X, props, ...)`
  // call (the same `h` the runtime uses for dynamic rendering). The emit layer
  // injects `import { h } from 'preact'` when the view uses it. The `js-is`
  // attribute is consumed; every other attribute renders normally.
  const dynamic = dynamicTag(tag, attrs, ctx, enclosingNode);
  if (dynamic !== null) {
    const rest = attrs.filter((attr) => !isIsAttribute(attr.name));
    const props = propsObject(rest, ctx);
    if (effectiveChildren.length === 0) {
      return `{h(${dynamic}, ${props})}`;
    }
    return `{h(${dynamic}, ${props}, ${lowerNodes(effectiveChildren, ctx)})}`;
  }

  const renderedAttrs = attrs
    .filter((attr) => attr.name !== 'js-content' && attr.name !== 'js-pre')
    .map((attr) => renderAttr(attr, ctx))
    .join('');

  // `js-content` sets the sole child; `js-pre` emits raw text. Both leave `children`
  // empty for the self-closing/literal emission below.
  if (content !== null) {
    const contentValue = requireValue(content, ctx);
    // Recovery: if value is missing, treat as absent.
    if (contentValue === null) {
      return `<${tag}${renderedAttrs} />`;
    }
    return `<${tag}${renderedAttrs}>{${contentValue}}</${tag}>`;
  }
  if (pre) {
    return `<${tag}${renderedAttrs}>${rawChildrenText(effectiveChildren)}</${tag}>`;
  }

  if (effectiveChildren.length === 0) {
    return `<${tag}${renderedAttrs} />`;
  }
  return `<${tag}${renderedAttrs}>${lowerNodes(effectiveChildren, ctx)}</${tag}>`;
}

/** Emit the raw source text of a node tree (for `js-pre`), with no lowering. */
function rawChildrenText(children: readonly TemplateNode[]): string {
  return children
    .map((child) => {
      if (child.kind === 'text') {
        return child.value;
      }
      if (child.kind === 'interpolation') {
        // `js-pre` suppresses interpolation: emit the mustache verbatim.
        return `{{${child.expr}}}`;
      }
      return rawElement(child);
    })
    .join('');
}

/** Emit an element subtree verbatim (for `js-pre`), preserving the original tag. */
function rawElement(node: TemplateNode): string {
  if (node.kind !== 'element') {
    return node.kind === 'text' ? node.value : `{{${node.expr}}}`;
  }
  const attrs = node.attrs
    .map((attr) => {
      if (attr.value === null) {
        return ` ${attr.name}`;
      }
      return ` ${attr.name}="${attr.value}"`;
    })
    .join('');
  if (node.children.length === 0) {
    return `<${node.tag}${attrs} />`;
  }
  return `<${node.tag}${attrs}>${rawChildrenText(node.children)}</${node.tag}>`;
}

/**
 * Resolve a dynamic-component tag. Returns the `js-is` expression when `tag` is
 * the lowercase `component` sentinel, or `null` for a normal element.
 *
 * A `<component>` with no `js-is` is a value-free `unsupported_position` error:
 * the sentinel has no meaning without a target. Recovery: return `null` so the
 * caller renders a self-closing literal `<component ... />` tag and siblings
 * continue.
 */
function dynamicTag(
  tag: string,
  attrs: readonly TemplateAttr[],
  ctx: LowerContext,
  enclosingNode: TemplateNode,
): string | null {
  if (tag !== 'component') {
    return null;
  }
  const isAttr = attrs.find((attr) => isIsAttribute(attr.name));
  if (isAttr === undefined) {
    // `<component>` without `js-is`: the tag name has no position of its own, so
    // point at the enclosing element's range (honest, not a zero-width guess).
    ctx.bag.errorAt(
      'unsupported_position',
      "Tag 'component' requires a 'js-is' binding",
      ctx.baseOffset + enclosingNode.start,
      ctx.baseOffset + enclosingNode.end,
    );
    // Return null so the caller renders as a literal self-closing tag.
    return null;
  }
  if (isAttr.value === null) {
    ctx.bag.errorAt(
      'unsupported_position',
      "Directive 'js-is' requires a value",
      ctx.baseOffset + isAttr.start,
      ctx.baseOffset + isAttr.end,
    );
    // Recovery: continue with null value so the caller renders a literal tag.
    return null;
  }
  return isAttr.value;
}

function isIsAttribute(name: string): boolean {
  return name === 'js-is';
}

/**
 * Render the non-`js-is` attributes of a dynamic component as a props object
 * literal for the `h(type, props, ...)` call. Mirrors {@link renderAttr}'s
 * value handling but emits object keys instead of JSX attributes.
 */
function propsObject(attrs: readonly TemplateAttr[], ctx: LowerContext): string {
  if (attrs.length === 0) {
    return '{}';
  }
  const entries: string[] = [];
  for (const attr of attrs) {
    const name = attr.name;
    const attrStart = ctx.baseOffset + attr.start;
    const attrEnd = ctx.baseOffset + attr.end;

    if (name.startsWith('js-bind:')) {
      const target = name.slice('js-bind:'.length);
      const val = requireValue(attr, ctx);
      if (val === null) {
        // Recovery: skip this attr.
        continue;
      }
      entries.push(`${target}: ${val}`);
      continue;
    }
    if (name.startsWith('js-on:')) {
      const raw = name.slice('js-on:'.length);
      const [event, ...modifiers] = raw.split('.');
      if (event === undefined || event === '') {
        ctx.bag.errorAt(
          'unsupported_position',
          `Directive '${name}' requires an event name`,
          attrStart,
          attrEnd,
        );
        continue;
      }
      const modResult = modifierMarkers(modifiers, name, ctx, attr);
      if (modResult === null) {
        continue;
      }
      const markers = modResult.map((m) => `, ${quote(m)}: ''`).join('');
      const val = requireValue(attr, ctx);
      if (val === null) {
        continue;
      }
      const handler = wrapEventHandler(val, modifiers);
      entries.push(`${eventKey(event)}: ${handler.wrapped}${markers}`);
      continue;
    }
    if (name === 'js-html') {
      const val = requireValue(attr, ctx);
      if (val === null) {
        continue;
      }
      entries.push(`dangerouslySetInnerHTML: { __html: ${val} }`);
      continue;
    }
    if (name.startsWith('js-')) {
      ctx.bag.errorAt(
        'unsupported_position',
        `Directive '${name}' is not supported on a dynamic component`,
        attrStart,
        attrEnd,
      );
      continue;
    }
    if (attr.value === null) {
      entries.push(`${name}: true`);
    } else if (attr.valueKind === 'expr') {
      entries.push(`${name}: ${attr.value}`);
    } else {
      entries.push(`${name}: ${quote(attr.value)}`);
    }
  }
  return `{ ${entries.join(', ')} }`;
}

/** Event prop key for a dynamic component (`click` → `onClick`). */
function eventKey(event: string): string {
  return `on${capitalize(event)}`;
}

/**
 * Map event modifiers to the marker attribute names the client runtime reads.
 *
 * `.once`/`.capture`/`.passive` are expressible in the delegated-listener model
 * (a marker plus, for capture/passive, one extra document listener). `.camel`
 * and `.prop` are Vue-template artifacts with no JSX analogue — JSX attribute
 * names are already written in target form — so they are rejected value-free.
 */
function modifierMarkers(
  modifiers: readonly string[],
  attrName: string,
  ctx: LowerContext,
  attr: TemplateAttr,
): readonly string[] | null {
  const markers: string[] = [];
  for (const modifier of modifiers) {
    if (modifier === 'once') {
      markers.push(ONCE_ATTRIBUTE);
    } else if (modifier === 'capture') {
      markers.push(CAPTURE_ATTRIBUTE);
    } else if (modifier === 'passive') {
      markers.push(PASSIVE_ATTRIBUTE);
    } else if (modifier === 'prevent' || modifier === 'stop' || modifier === 'self') {
      // Action modifiers are NOT marker attributes — they wrap the handler body
      // inline (see `wrapEventHandler`). They are consumed separately and must
      // not also appear here, so they are skipped without producing a marker.
      continue;
    } else {
      ctx.bag.errorAt(
        'unknown_directive',
        `Unknown event modifier '.${modifier}'`,
        ctx.baseOffset + attr.start,
        ctx.baseOffset + attr.end,
      );
      // Signal the caller to drop the entire attr — an unknown modifier makes
      // the whole directive invalid.
      return null;
    }
  }
  return markers;
}

/**
 * Wrap an event-handler expression with the inline guards the action modifiers
 * (`prevent`/`stop`/`self`) require. Empty when there are no action modifiers.
 *
 * The wrap is a pure source-to-source transform (`(e) => { e.preventDefault();
 * fn(e); }`), never a runtime helper, so the emitted JSX stays self-contained.
 */
function wrapEventHandler(
  fn: string,
  modifiers: readonly string[],
): { readonly wrapped: string; readonly hasWrap: boolean } {
  const prevent = modifiers.includes('prevent');
  const stop = modifiers.includes('stop');
  const self = modifiers.includes('self');
  if (!prevent && !stop && !self) {
    return { wrapped: fn, hasWrap: false };
  }
  const body: string[] = [];
  if (prevent) {
    body.push('e.preventDefault();');
  }
  if (stop) {
    body.push('e.stopPropagation();');
  }
  if (self) {
    body.push('if (e.target !== e.currentTarget) return;');
  }
  body.push(`${fn}(e);`);
  return { wrapped: `(e) => { ${body.join(' ')} }`, hasWrap: true };
}

function renderAttr(attr: TemplateAttr, ctx: LowerContext): string {
  const name = attr.name;
  const attrStart = ctx.baseOffset + attr.start;
  const attrEnd = ctx.baseOffset + attr.end;

  // `js-bind:x="expr"` — attribute binding. `:x` is Vue's shorthand; JSails'
  // only spelling is the `js-`-prefixed form so the surface never reads as Vue.
  if (name.startsWith('js-bind:')) {
    const target = name.slice('js-bind:'.length);
    const val = requireValue(attr, ctx);
    if (val === null) {
      return '';
    }
    return ` ${target}={${val}}`;
  }

  // `js-on:click="fn"` / `js-on:click.prevent="fn"` — event binding. `@click`
  // is Vue's shorthand and is intentionally unsupported.
  if (name.startsWith('js-on:')) {
    const raw = name.slice('js-on:'.length);
    const [event, ...modifiers] = raw.split('.');
    if (event === undefined || event === '') {
      ctx.bag.errorAt(
        'unsupported_position',
        `Directive '${name}' requires an event name`,
        attrStart,
        attrEnd,
      );
      return '';
    }
    const modResult = modifierMarkers(modifiers, name, ctx, attr);
    if (modResult === null) {
      return '';
    }
    const marker = modResult.map((m) => ` ${m}=""`).join('');
    const val = requireValue(attr, ctx);
    if (val === null) {
      return '';
    }
    const handler = wrapEventHandler(val, modifiers);
    return ` on${capitalize(event)}={${handler.wrapped}}${marker}`;
  }

  // `js-html="expr"` — raw inner HTML. Forbidden alongside children.
  if (name === 'js-html') {
    const val = requireValue(attr, ctx);
    if (val === null) {
      return '';
    }
    return ` dangerouslySetInnerHTML={{ __html: ${val} }}`;
  }

  // `js-visible="expr"` — toggle CSS visibility. Distinct from the existing
  // `js-show` render tool (which shows a field), hence a separate name.
  if (name === 'js-visible') {
    const val = requireValue(attr, ctx);
    if (val === null) {
      return '';
    }
    return ` style={{ display: ${val} ? undefined : 'none' }}`;
  }

  // `js-once` — render-then-freeze marker (reuses the client `.once` marker).
  if (name === 'js-once') {
    if (attr.value !== null) {
      ctx.bag.errorAt(
        'unsupported_position',
        "Directive 'js-once' does not take a value",
        attrStart,
        attrEnd,
      );
      return '';
    }
    return ` ${ONCE_ATTRIBUTE}=""`;
  }

  // Render-tool directives: `js-model`, `js-submit`, `js-call`, `js-confirm`,
  // `js-poll`, `js-sort`, `js-intersect`, `js-ref`, `js-ignore`, `js-loading`,
  // `js-show`, `js-text`. A quoted value is a name (`js-model="title"` →
  // `bind('title')`); a brace value is an expression passed through verbatim.
  if (name.startsWith('js-')) {
    const arg =
      attr.value === null ? null : attr.valueKind === 'expr' ? attr.value : quote(attr.value);
    const lowered = lowerDirective(name, arg, (code, message) => {
      ctx.bag.errorAt(code, message, attrStart, attrEnd);
    });
    if (lowered === null) {
      return '';
    }
    const args = lowered.args.join(', ');
    return ` {...${lowered.builder}(${args})}`;
  }

  if (attr.value === null) {
    return ` ${name}`;
  }
  if (attr.valueKind === 'expr') {
    return ` ${name}={${attr.value}}`;
  }
  return ` ${name}="${attr.value}"`;
}

function requireValue(attr: TemplateAttr, ctx: LowerContext): string | null {
  if (attr.value === null) {
    ctx.bag.errorAt(
      'unsupported_position',
      `Directive '${attr.name}' requires a value`,
      ctx.baseOffset + attr.start,
      ctx.baseOffset + attr.end,
    );
    return null;
  }
  return attr.value;
}

/**
 * Parse a `js-for` value into its binding and list expression. Returns `null`
 * on error after emitting a diagnostic.
 *
 * The binding is emitted verbatim into the arrow parameter position, so it may
 * be a single identifier (`item`), a parenthesized identifier list
 * (`(item, index)`), or a destructuring pattern (`{ id, name }`, `[a, b]`). The
 * compiler never parses the pattern — `tsc` typechecks the emitted JSX — but it
 * does reject an unbalanced binding, which would otherwise produce syntactically
 * broken JSX with a confusing `tsc` location.
 */
function parseFor(
  value: string | null,
  ctx: LowerContext,
  attr: TemplateAttr,
  enclosingNode: TemplateNode,
): { readonly binding: string; readonly list: string } | null {
  const attrStart = ctx.baseOffset + attr.start;
  const attrEnd = ctx.baseOffset + attr.end;
  // When the attribute has no start/end (shouldn't happen with positioned attrs),
  // use the enclosing element node as fallback.
  const start = attr.start > 0 ? attrStart : ctx.baseOffset + enclosingNode.start;
  const end = attr.end > 0 ? attrEnd : ctx.baseOffset + enclosingNode.end;

  if (value === null) {
    ctx.bag.errorAt('unsupported_position', 'Directive js-for requires a value', start, end);
    return null;
  }
  const match = /^\s*(.+?)\s+in\s+(.+?)\s*$/.exec(value);
  if (match === null) {
    ctx.bag.errorAt('unsupported_position', 'Malformed js-for expression', start, end);
    return null;
  }
  const binding = match[1] ?? '';
  const list = match[2] ?? '';
  if (!isBalancedBinding(binding)) {
    ctx.bag.errorAt('unsupported_position', 'Malformed js-for binding', start, end);
    return null;
  }
  return { binding, list };
}

/** A binding is balanced when its `(`/`{`/`[` delimiters nest and close. */
function isBalancedBinding(binding: string): boolean {
  if (binding.trim() === '') {
    return false;
  }
  const stack: string[] = [];
  const pairs: Readonly<Record<string, string>> = { ')': '(', '}': '{', ']': '[' };
  for (const char of binding) {
    if (char === '(' || char === '{' || char === '[') {
      stack.push(char);
    } else if (char === ')' || char === '}' || char === ']') {
      if (stack.pop() !== pairs[char]) {
        return false;
      }
    }
  }
  return stack.length === 0;
}

function isStructuralDirective(name: string, skipConditional: boolean): boolean {
  if (name === 'js-for') {
    return true;
  }
  if (skipConditional && (name === 'js-if' || name === 'js-else-if' || name === 'js-else')) {
    return true;
  }
  return false;
}

function findDirective(attrs: readonly TemplateAttr[], name: string): TemplateAttr | null {
  return attrs.find((attr) => attr.name === name) ?? null;
}

function hasDirective(attrs: readonly TemplateAttr[], name: string): boolean {
  return attrs.some((attr) => attr.name === name);
}

function directiveValue(
  attrs: readonly TemplateAttr[],
  name: string,
  ctx: LowerContext,
  enclosingNode: TemplateNode,
): string | null {
  const attr = findDirective(attrs, name);
  if (attr === null) {
    return null;
  }
  if (attr.value === null) {
    // Use the attr position when available, falling back to the enclosing node.
    const start =
      attr.start > 0 ? ctx.baseOffset + attr.start : ctx.baseOffset + enclosingNode.start;
    const end = attr.end > 0 ? ctx.baseOffset + attr.end : ctx.baseOffset + enclosingNode.end;
    ctx.bag.errorAt('unsupported_position', `Directive '${name}' requires a value`, start, end);
    return null;
  }
  return attr.value;
}

function capitalize(value: string): string {
  return value.length === 0 ? value : value[0]!.toUpperCase() + value.slice(1);
}

/** Wrap a directive value as a single-quoted string literal. */
function quote(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}
