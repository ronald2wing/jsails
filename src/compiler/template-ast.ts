/**
 * The Vue-like `<template>` grammar parser.
 *
 * The `view` region of a component may be authored either as raw JSX (the
 * shipped dialect) or as a `<template>` block in a small Vue-like grammar. This
 * module parses the latter into a neutral `TemplateNode[]` tree; the lowerer
 * (`template-lower.ts`) turns that tree into JSX.
 *
 * The parser is hand-written and dependency-free: the template is not TSX until
 * lowering, so it cannot be handed to the TS/JSX parser. Expression strings
 * (`{expr}`, directive values) are carried verbatim and never evaluated — the
 * emitted JSX is typechecked by `tsc` after lowering.
 *
 * Errors are reported, not thrown: a malformed construct records one positioned
 * diagnostic through the `TemplateParseReporter` and aborts the parse (no tree),
 * because a cascading parse error is noise — one malformed tag usually corrupts
 * everything after it. The abort unwinds through a module-private sentinel that
 * never escapes `parseTemplate`.
 *
 * Errors are value-free (see `errors.ts`): the `subject` is a tag or directive
 * name only, never source text.
 */

import type { CompilerErrorCode } from './errors.js';

/**
 * Callback that records a template parse error. Offsets are **body-relative**
 * (to the string handed to `parseTemplate`); the caller translates them to
 * file-absolute positions, exactly as `DirectiveReporter` leaves positioning to
 * its caller.
 */
export interface TemplateParseReporter {
  (code: CompilerErrorCode, message: string, subject: string, start: number, end: number): void;
}

/**
 * Internal sentinel that unwinds the recursive descent after a reported error.
 * It is caught inside `parseTemplate` and never escapes; a caller never sees it.
 */
class ParseAbort extends Error {}

/** A parsed template node. */
export type TemplateNode =
  | {
      readonly kind: 'element';
      readonly tag: string;
      readonly attrs: readonly TemplateAttr[];
      readonly children: readonly TemplateNode[];
      /** Absolute offset of the opening `<` within the parsed source. */
      readonly start: number;
      /** Absolute offset just past this node's last character (exclusive). */
      readonly end: number;
    }
  | { readonly kind: 'text'; readonly value: string; readonly start: number; readonly end: number }
  | {
      readonly kind: 'interpolation';
      readonly expr: string;
      readonly start: number;
      readonly end: number;
    };

/** A template attribute: a plain attribute or a directive. */
export interface TemplateAttr {
  /** The attribute name as authored, e.g. `class`, `:href`, `v-if`, `js-model`. */
  readonly name: string;
  /**
   * The attribute value: raw source text for a quoted value, the expression
   * text for a brace value, or `null` for a bare attribute.
   */
  readonly value: string | null;
  /** How the value was written; `null` when the attribute is bare. */
  readonly valueKind: 'quoted' | 'expr' | null;
  /** Absolute offset of the attribute name's first character. */
  readonly start: number;
  /** Absolute offset just past this attribute's last character (exclusive). */
  readonly end: number;
}

const TAG_NAME = /^[A-Za-z][A-Za-z0-9-]*/;
const ATTR_NAME = /^[A-Za-z_:@][A-Za-z0-9_:@.-]*/;

/**
 * Parse a `<template>` body into a node tree.
 *
 * @param source the text between `<template>` and `</template>`.
 * @param report receives a positioned diagnostic on a malformed construct; the
 *        parse then aborts and an empty tree is returned.
 * @returns the parsed nodes, or an empty array when a parse error was reported.
 */
export function parseTemplate(
  source: string,
  report: TemplateParseReporter,
): readonly TemplateNode[] {
  const parser = new TemplateParser(source, report);
  try {
    const nodes = parser.parseNodes(undefined);
    parser.skipWhitespace();
    if (!parser.atEnd()) {
      // A stray closing tag or malformed content remains.
      parser.fail('unparseable', 'Unexpected content in template', 'template');
    }
    if (
      nodes.length === 0 ||
      nodes.every((node) => node.kind === 'text' && node.value.trim() === '')
    ) {
      parser.fail('unparseable', 'Template is empty', 'template');
    }
    return Object.freeze(nodes);
  } catch (error) {
    if (error instanceof ParseAbort) {
      return Object.freeze([]);
    }
    throw error;
  }
}

class TemplateParser {
  private index = 0;

  constructor(
    private readonly source: string,
    private readonly report: TemplateParseReporter,
  ) {}

  /**
   * Report a parse error at `start` and unwind the descent. The range spans to
   * the current scan position (at least one character) so the frame always has
   * something to underline.
   */
  fail(code: CompilerErrorCode, message: string, subject: string, start = this.index): never {
    this.report(code, message, subject, start, Math.max(start + 1, this.index));
    throw new ParseAbort();
  }

  atEnd(): boolean {
    return this.index >= this.source.length;
  }

  skipWhitespace(): void {
    while (!this.atEnd() && /\s/.test(this.source[this.index] ?? '')) {
      this.index += 1;
    }
  }

  /**
   * Parse sibling nodes until the end of input or a closing tag for `closingTag`.
   * When `closingTag` is `undefined`, parse to end of input (the top level).
   */
  parseNodes(closingTag: string | undefined): TemplateNode[] {
    const nodes: TemplateNode[] = [];
    for (;;) {
      if (this.atEnd()) {
        if (closingTag !== undefined) {
          this.fail('unparseable', `Unclosed tag '${closingTag}'`, closingTag);
        }
        return nodes;
      }

      if (this.source.startsWith('</', this.index)) {
        if (closingTag === undefined) {
          this.fail('unparseable', 'Unexpected closing tag', 'template');
        }
        return nodes;
      }

      if (this.source[this.index] === '<') {
        nodes.push(this.parseElement());
        continue;
      }

      if (this.source[this.index] === '{') {
        nodes.push(this.parseInterpolation());
        continue;
      }

      nodes.push(this.parseText());
    }
  }

  private parseElement(): TemplateNode {
    const start = this.index;
    this.expect('<');
    const tag = this.readTagName();
    const attrs = this.parseAttrs();

    this.skipWhitespace();
    if (this.source.startsWith('/>', this.index)) {
      this.index += 2;
      return Object.freeze({
        kind: 'element',
        tag,
        attrs: Object.freeze(attrs),
        children: Object.freeze([]),
        start,
        end: this.index,
      });
    }

    this.expect('>');
    const children = this.parseNodes(tag);
    this.expectCloseTag(tag);
    return Object.freeze({
      kind: 'element',
      tag,
      attrs: Object.freeze(attrs),
      children: Object.freeze(children),
      start,
      end: this.index,
    });
  }

  private parseAttrs(): TemplateAttr[] {
    const attrs: TemplateAttr[] = [];
    for (;;) {
      this.skipWhitespace();
      if (this.atEnd()) {
        return attrs;
      }
      const ch = this.source[this.index];
      if (ch === '>' || ch === '/' || ch === '<') {
        return attrs;
      }
      attrs.push(this.parseAttr());
    }
  }

  private parseAttr(): TemplateAttr {
    const start = this.index;
    const match = ATTR_NAME.exec(this.source.slice(this.index));
    if (match === null) {
      this.fail('unparseable', 'Malformed attribute', 'template', start);
    }
    const name = match[0];
    this.index += name.length;

    if (this.source[this.index] !== '=') {
      return Object.freeze({ name, value: null, valueKind: null, start, end: this.index });
    }
    this.index += 1; // consume '='

    const quote = this.source[this.index];
    if (quote === '"' || quote === "'") {
      this.index += 1;
      const end = this.source.indexOf(quote, this.index);
      if (end === -1) {
        this.fail('unparseable', `Unterminated attribute '${name}'`, name, start);
      }
      const value = this.source.slice(this.index, end);
      this.index = end + 1;
      return Object.freeze({ name, value, valueKind: 'quoted', start, end: this.index });
    }

    if (quote === '{') {
      const value = this.readBraced();
      return Object.freeze({ name, value, valueKind: 'expr', start, end: this.index });
    }

    this.fail('unparseable', `Malformed value for attribute '${name}'`, name, start);
  }

  private parseInterpolation(): TemplateNode {
    // Vue-faithful mustache: `{{ expr }}`. A single `{expr}` is the older JSX-ish
    // form and is still accepted. The two are distinguished by the second brace,
    // so a `{` followed by `{` starts a mustache and is read to the matching `}}`.
    const start = this.index;
    if (this.source.startsWith('{{', this.index)) {
      const expr = this.readMustache();
      return Object.freeze({ kind: 'interpolation', expr, start, end: this.index });
    }
    const expr = this.readBraced();
    return Object.freeze({ kind: 'interpolation', expr, start, end: this.index });
  }

  /** Read a `{{ … }}` mustache, returning the trimmed inner expression. */
  private readMustache(): string {
    this.index += 2; // consume '{{'
    const start = this.index;
    while (!this.atEnd()) {
      if (this.source.startsWith('}}', this.index)) {
        const expr = this.source.slice(start, this.index).trim();
        this.index += 2; // consume '}}'
        return expr;
      }
      this.index += 1;
    }
    this.fail('unparseable', 'Unterminated interpolation', 'template', start);
  }

  /** Read a `{…}` group, returning the inner text. Handles nested braces. */
  private readBraced(): string {
    this.expect('{');
    let depth = 1;
    const start = this.index;
    while (!this.atEnd()) {
      const ch = this.source[this.index];
      if (ch === '{') {
        depth += 1;
      } else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          const expr = this.source.slice(start, this.index);
          this.index += 1; // consume '}'
          return expr;
        }
      }
      this.index += 1;
    }
    this.fail('unparseable', 'Unterminated interpolation', 'template', start);
  }

  private parseText(): TemplateNode {
    const start = this.index;
    while (!this.atEnd()) {
      const ch = this.source[this.index];
      if (ch === '<' || ch === '{') {
        break;
      }
      this.index += 1;
    }
    return Object.freeze({
      kind: 'text',
      value: this.source.slice(start, this.index),
      start,
      end: this.index,
    });
  }

  private readTagName(): string {
    const match = TAG_NAME.exec(this.source.slice(this.index));
    if (match === null) {
      this.fail('unparseable', 'Malformed tag', 'template');
    }
    this.index += match[0].length;
    return match[0];
  }

  private expectCloseTag(tag: string): void {
    this.skipWhitespace();
    if (!this.source.startsWith('</', this.index)) {
      this.fail('unparseable', `Unclosed tag '${tag}'`, tag);
    }
    this.index += 2;
    const closeName = this.readTagName();
    if (closeName !== tag) {
      this.fail('unparseable', `Mismatched close tag '${closeName}'`, tag);
    }
    this.skipWhitespace();
    this.expect('>');
  }

  private expect(token: string): void {
    if (!this.source.startsWith(token, this.index)) {
      this.fail('unparseable', 'Malformed template', 'template');
    }
    this.index += token.length;
  }
}
