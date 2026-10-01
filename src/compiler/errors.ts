/**
 * Compiler errors for the component source compiler.
 *
 * Errors are value-free by construction: they may be surfaced to a build log,
 * and the source text they describe can carry secrets (or copy them into a
 * persisted artifact). The `subject` carries only a diagnostic name.
 */

export type CompilerErrorCode =
  | 'unparseable'
  | 'unknown_directive'
  | 'unsupported_position'
  | 'unmigratable_reference'
  | 'invalid_region'
  | 'missing_region'
  | 'unresolved_component'
  | 'unresolved_model'
  | 'ambiguous_relation';

/** A 1-based line/column position within a source file. */
export interface SourcePosition {
  readonly line: number;
  readonly column: number;
}

/** A half-open source range: `start` is inclusive, `end` is exclusive. */
export interface SourceRange {
  readonly start: SourcePosition;
  readonly end: SourcePosition;
}

/** Diagnostic severity; errors abort codegen, warnings do not. */
export type DiagnosticSeverity = 'error' | 'warning';

/**
 * A location that explains a companion diagnostic — for a chained construct
 * (e.g. a `js-else` whose missing `js-if` lives elsewhere). The `message` is
 * value-free: it names the relationship, never the source text.
 */
export interface RelatedDiagnostic {
  readonly message: string;
  readonly range: SourceRange;
}

/**
 * A single structured compiler diagnostic.
 *
 * `message` is value-free (a diagnostic name, never source text) so it stays
 * safe to log or persist. `frame` is the one sanctioned exception: it is a
 * rendered code frame built from the author's in-memory source at compile time,
 * shown to the author's build log, and never persisted — it is empty when frames
 * are disabled.
 */
export interface CompileDiagnostic {
  readonly severity: DiagnosticSeverity;
  readonly code: CompilerErrorCode;
  readonly message: string;
  readonly range: SourceRange;
  readonly frame: string;
  readonly related?: readonly RelatedDiagnostic[];
}

/** Raised when component source cannot be compiled into its target shape. */
export class CompilerError extends Error {
  readonly code: CompilerErrorCode;
  /** The offending region/identifier name when known; never source text. */
  readonly subject?: string;
  /** The offending range when known. */
  readonly range?: SourceRange;

  constructor(message: string, code: CompilerErrorCode, subject?: string, range?: SourceRange) {
    super(message);
    this.name = 'CompilerError';
    this.code = code;
    if (subject !== undefined) {
      this.subject = subject;
    }
    if (range !== undefined) {
      this.range = range;
    }
  }
}

/**
 * A build failure that carries the full diagnostic list for a component source.
 *
 * The plugin throws this (with error-severity diagnostics only) so a bundler can
 * render a positioned overlay: `.loc` points at the first error, `message` embeds
 * every rendered frame, and `.diagnostics` exposes the structured list to
 * tooling. It extends {@link CompilerError} so an existing
 * `catch (e) if (e instanceof CompilerError)` still holds. `code` is the first
 * error's code; `range` its range.
 */
export class CompilerBuildError extends CompilerError {
  /** The file/line/column of the first error, for a bundler overlay. */
  readonly loc: { readonly file: string; readonly line: number; readonly column: number };
  /** Every error-severity diagnostic, in source order. */
  readonly diagnostics: readonly CompileDiagnostic[];

  constructor(file: string, diagnostics: readonly CompileDiagnostic[], message: string) {
    const first = diagnostics[0] as CompileDiagnostic;
    super(message, first.code, undefined, first.range);
    this.name = 'CompilerBuildError';
    this.loc = {
      file,
      line: first.range.start.line,
      column: first.range.start.column,
    };
    this.diagnostics = diagnostics;
  }
}
