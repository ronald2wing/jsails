/**
 * Block parsing for `.jsails` single-file components.
 *
 * A `.jsails` file is a Vue-inspired single-file component: real top-level
 * `<template>`, `<script>`, `<style>`, and `<server>` blocks. This module is
 * the dependency-free block scanner that splits the source into those blocks.
 * It mirrors the style of `template-ast.ts` (a hand-written scanner over the
 * source string) because the file is not valid TSX until the emitter assembles
 * a `.tsx` module from it.
 *
 * Errors are value-free (see `errors.ts`): the `subject` is a tag or directive
 * name only, never source text.
 */

import { CompilerError } from './errors.js';
import { lineStartOffsets } from './source-lines.js';

/** The extracted blocks of a `.jsails` file. */
export interface SfcBlocks {
  /** `<script>` body — the component config source (required). */
  readonly script: string;
  /** `<template>` body — the Vue-like view grammar (required). */
  readonly template: string;
  /** Concatenated `<style>` bodies — real CSS (optional; `''` when absent). */
  readonly style: string;
  /** `<server>` body — `'use server'` functions (optional; `''` when absent). */
  readonly server: string;
  /**
   * The absolute character offset of each block's first content character (the
   * first non-blank line after the opening tag). Used to convert a
   * block-relative offset into a file-relative `line:column` for diagnostics.
   * For a repeated `<style>` block this is the first occurrence.
   */
  readonly offsets: Readonly<Record<'script' | 'template' | 'style' | 'server', number>>;
}

/** The block tags recognized at the top level. */
const BLOCK_TAGS: readonly string[] = ['script', 'template', 'style', 'server'];

/** A block tag whose content may appear at most once. */
const SINGLETON_TAGS: ReadonlySet<string> = new Set(['script', 'template', 'server']);

/** Matches an opening tag at the start of a line, e.g. `  <template lang="ts">`. */
const OPEN_RE = /^\s*<([A-Za-z][A-Za-z0-9-]*)\b/;

/** Matches a closing tag at the start of a line, e.g. `</template>`. */
const CLOSE_RE = /^\s*<\/([A-Za-z][A-Za-z0-9-]*)\s*>\s*$/;

/** Trim only blank lines from the edges of a block body. */
function trimBlankLines(lines: readonly string[]): { text: string; startIndex: number } {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]?.trim() === '') {
    start += 1;
  }
  while (end > start && lines[end - 1]?.trim() === '') {
    end -= 1;
  }
  return { text: lines.slice(start, end).join('\n'), startIndex: start };
}

/**
 * Parse a `.jsails` source string into its blocks.
 *
 * The scanner is line-anchored: a block opens only when its tag appears at the
 * start of a line, so a `<template>` string inside the `<script>` body is never
 * mistaken for the template block (the script body's lines are inside the open
 * block's span and are not re-scanned as candidates). Blocks are processed in
 * order; the returned bodies are independent of declaration order.
 *
 * Rules:
 * - `<script>` and `<template>` are required.
 * - `<script>`, `<template>`, and `<server>` appear at most once.
 * - `<style>` may repeat; its bodies are concatenated in order.
 * - Whitespace outside blocks is ignored; any other text is an error.
 * - Custom blocks (any other tag) are skipped to their closing tag (Vue parity).
 *
 * @throws CompilerError `unparseable` on an unclosed block or text outside blocks.
 * @throws CompilerError `invalid_region` on a duplicate singleton block.
 * @throws CompilerError `missing_region` when a required block is absent.
 */
export function parseSfc(source: string, _fileName = ''): SfcBlocks {
  const lines = source.split(/\r?\n/);
  const lineStarts = lineStartOffsets(source);
  const bodies = new Map<string, string[]>();
  // Raw first-line index of each block body (the line after its opening tag),
  // recorded for the first occurrence of each tag.
  const bodyStartLine = new Map<string, number>();
  const seen = new Set<string>();

  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? '';

    // Skip a custom block (any tag not in the recognized set) to its closing tag.
    const customOpen = OPEN_RE.exec(line);
    if (customOpen !== null && !BLOCK_TAGS.includes(customOpen[1] ?? '')) {
      const tag = customOpen[1] ?? '';
      index += 1;
      while (index < lines.length) {
        const close = CLOSE_RE.exec(lines[index] ?? '');
        if (close !== null && close[1] === tag) {
          break;
        }
        index += 1;
      }
      index += 1;
      continue;
    }

    const openMatch = customOpen;
    if (openMatch !== null) {
      const tag = openMatch[1] ?? '';
      if (SINGLETON_TAGS.has(tag) && seen.has(tag)) {
        throw new CompilerError(`Duplicate block '<${tag}>'`, 'invalid_region', tag);
      }
      seen.add(tag);
      const bodyLines: string[] = [];
      const bodyStart = index + 1;
      index += 1;
      while (index < lines.length) {
        const bodyLine = lines[index] ?? '';
        const close = CLOSE_RE.exec(bodyLine);
        if (close !== null && close[1] === tag) {
          break;
        }
        bodyLines.push(bodyLine);
        index += 1;
      }
      if (index >= lines.length) {
        throw new CompilerError(`Block '<${tag}>' is not closed`, 'unparseable', tag);
      }
      append(bodies, tag, bodyLines);
      if (!bodyStartLine.has(tag)) {
        bodyStartLine.set(tag, bodyStart);
      }
      index += 1;
      continue;
    }

    // Outside any block and not an opening tag: only whitespace is allowed.
    if (line.trim() !== '') {
      throw new CompilerError('Text outside any block', 'unparseable', 'sfc');
    }
    index += 1;
  }

  for (const required of ['script', 'template']) {
    if (!bodies.has(required)) {
      throw new CompilerError(`Missing required block '<${required}>'`, 'missing_region', required);
    }
  }

  const offsetOf = (tag: string): number => {
    const trimmed = trimBlankLines(bodies.get(tag) ?? []);
    const rawStart = bodyStartLine.get(tag);
    if (rawStart === undefined) {
      return 0;
    }
    return lineStarts[rawStart + trimmed.startIndex] ?? 0;
  };

  const get = (tag: string): string => trimBlankLines(bodies.get(tag) ?? []).text;
  return Object.freeze({
    script: get('script'),
    template: get('template'),
    style: get('style'),
    server: get('server'),
    offsets: Object.freeze({
      script: offsetOf('script'),
      template: offsetOf('template'),
      style: offsetOf('style'),
      server: offsetOf('server'),
    }),
  });
}

/** Append a closed block body, concatenating repeats (for `<style>`). */
function append(bodies: Map<string, string[]>, tag: string, lines: readonly string[]): void {
  const existing = bodies.get(tag);
  if (existing === undefined) {
    bodies.set(tag, [...lines]);
  } else {
    existing.push(...lines);
  }
}
