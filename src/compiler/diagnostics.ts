/**
 * The diagnostic accumulator for the component compiler.
 *
 * The compiler collects every diagnostic it can find in one pass (collect-then-
 * decide) rather than throwing on the first problem, so a single build reports
 * every reachable error and warning. This module owns that collection and the
 * rendering of code frames.
 *
 * `message` stays value-free (a diagnostic name, never source text). The `frame`
 * is the one sanctioned exception: it is rendered from the author's in-memory
 * source for the build log and is never persisted. Frames can be disabled by
 * callers that want strictly value-free output.
 */

import {
  type CompileDiagnostic,
  type CompilerErrorCode,
  type DiagnosticSeverity,
  type RelatedDiagnostic,
  type SourcePosition,
  type SourceRange,
} from './errors.js';
import { lineStartOffsets, offsetToPoint } from './source-lines.js';

/** Options for a diagnostic bag. */
export interface DiagnosticOptions {
  /** The full source the ranges point into; frame rendering is skipped without it. */
  readonly source?: string;
  /** Whether to render code frames into `frame`. Defaults to `true`. */
  readonly frames?: boolean;
  /** Number of source lines of context shown on each side of the caret line. */
  readonly frameContext?: number;
}

/** One collected diagnostic before it is frozen into the public list. */
interface PendingDiagnostic {
  readonly severity: DiagnosticSeverity;
  readonly code: CompilerErrorCode;
  readonly message: string;
  readonly range: SourceRange;
  readonly related?: readonly RelatedDiagnostic[];
}

const DEFAULT_FRAME_CONTEXT = 2;

/**
 * Accumulates diagnostics during a single compile pass.
 *
 * Ordering is not insertion order: `toList()` sorts by position so the reported
 * sequence matches the source top-to-bottom regardless of the walk order.
 */
export class DiagnosticBag {
  private readonly pending: PendingDiagnostic[] = [];
  private readonly source: string | undefined;
  private readonly frames: boolean;
  private readonly frameContext: number;
  private readonly lineStarts: readonly number[];

  constructor(options: DiagnosticOptions = {}) {
    this.source = options.source;
    this.frames = options.frames ?? true;
    this.frameContext = options.frameContext ?? DEFAULT_FRAME_CONTEXT;
    this.lineStarts = options.source === undefined ? [] : lineStartOffsets(options.source);
  }

  /** Record an error. */
  error(
    code: CompilerErrorCode,
    message: string,
    range: SourceRange,
    related?: readonly RelatedDiagnostic[],
  ): void {
    this.push('error', code, message, range, related);
  }

  /** Record a warning. */
  warn(
    code: CompilerErrorCode,
    message: string,
    range: SourceRange,
    related?: readonly RelatedDiagnostic[],
  ): void {
    this.push('warning', code, message, range, related);
  }

  /** Convert absolute character offsets into a 1-based source range. */
  range(startOffset: number, endOffset: number): SourceRange {
    const start = this.point(startOffset);
    // A zero-width span still points at one character so a caret renders.
    const end =
      endOffset > startOffset
        ? this.point(endOffset)
        : { line: start.line, column: start.column + 1 };
    return { start, end };
  }

  /** Record an error from absolute character offsets. */
  errorAt(
    code: CompilerErrorCode,
    message: string,
    startOffset: number,
    endOffset: number,
    related?: readonly RelatedDiagnostic[],
  ): void {
    this.error(code, message, this.range(startOffset, endOffset), related);
  }

  /** Record a warning from absolute character offsets. */
  warnAt(
    code: CompilerErrorCode,
    message: string,
    startOffset: number,
    endOffset: number,
    related?: readonly RelatedDiagnostic[],
  ): void {
    this.warn(code, message, this.range(startOffset, endOffset), related);
  }

  /** Whether any recorded diagnostic has `error` severity. */
  get hasErrors(): boolean {
    return this.pending.some((entry) => entry.severity === 'error');
  }

  private point(offset: number): SourcePosition {
    return offsetToPoint(this.lineStarts, offset);
  }

  /** The frozen, position-ordered diagnostic list. */
  toList(): readonly CompileDiagnostic[] {
    const sorted = [...this.pending].sort((a, b) => compareRanges(a.range, b.range));
    return Object.freeze(
      sorted.map((entry) => {
        const diagnostic: CompileDiagnostic = {
          severity: entry.severity,
          code: entry.code,
          message: entry.message,
          range: entry.range,
          frame: this.frames ? this.renderFrame(entry.range) : '',
          ...(entry.related === undefined ? {} : { related: entry.related }),
        };
        return Object.freeze(diagnostic);
      }),
    );
  }

  private push(
    severity: DiagnosticSeverity,
    code: CompilerErrorCode,
    message: string,
    range: SourceRange,
    related?: readonly RelatedDiagnostic[],
  ): void {
    this.pending.push({
      severity,
      code,
      message,
      range,
      ...(related === undefined ? {} : { related }),
    });
  }

  /**
   * Render a code frame: a window of source lines with a caret span under the
   * offending range. Returns `''` when no source is available.
   */
  private renderFrame(range: SourceRange): string {
    if (this.source === undefined || this.source.length === 0) {
      return '';
    }
    const lines = this.source.split(/\r?\n/);
    const first = Math.max(1, range.start.line - this.frameContext);
    const last = Math.min(lines.length, range.end.line + this.frameContext);
    const gutter = String(last).length;
    const rendered: string[] = [];

    for (let line = first; line <= last; line += 1) {
      const content = lines[line - 1] ?? '';
      rendered.push(`${pad(line, gutter)} | ${content}`);
      const caret = carets(line, content, range, gutter);
      if (caret !== '') {
        rendered.push(caret);
      }
    }
    return rendered.join('\n');
  }
}

/** Pad a line number to a fixed gutter width. */
function pad(value: number, width: number): string {
  return String(value).padStart(width, ' ');
}

/**
 * Build the caret underline for `line` when the range covers it, else `''`.
 * The underline length reflects the covered columns on that line.
 */
function carets(line: number, content: string, range: SourceRange, gutter: number): string {
  if (line < range.start.line || line > range.end.line) {
    return '';
  }
  const startCol = line === range.start.line ? range.start.column : 1;
  const endCol =
    line === range.end.line ? Math.max(range.end.column, startCol + 1) : content.length + 1;
  const lead = ' '.repeat(Math.max(0, startCol - 1));
  const span = Math.max(1, endCol - startCol);
  return `${' '.repeat(gutter)} | ${lead}${'^'.repeat(span)}`;
}

/** Order two ranges by start position, then by end position. */
function compareRanges(a: SourceRange, b: SourceRange): number {
  if (a.start.line !== b.start.line) {
    return a.start.line - b.start.line;
  }
  if (a.start.column !== b.start.column) {
    return a.start.column - b.start.column;
  }
  return a.end.line - b.end.line || a.end.column - b.end.column;
}
