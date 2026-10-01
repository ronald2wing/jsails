/**
 * Lowering of `js-*` template directives onto the render-tool helpers a
 * component's `render(state, tools)` receives.
 *
 * Directives are authored in the template as attributes (`js-submit="add"`)
 * and lowered to a render-tool call (`submit('add')`). The value is threaded
 * through as raw source text — the compiler never evaluates it — so the
 * generated call site is built from source, not a parsed runtime value.
 *
 * Errors are reported, not thrown, so the lowerer can continue past a bad
 * directive and collect further diagnostics. Messages are value-free: the
 * `subject` is the directive name only, because the source text can carry
 * secrets into a persisted artifact.
 */

import type { CompilerErrorCode } from './errors.js';

/** A directive lowered to a single render-tool call. */
export interface DirectiveLowering {
  /** The render-tool name to invoke, e.g. `'submit'`. */
  readonly builder: string;
  /** Source-text arguments, e.g. `["'add'"]`; empty for a valueless directive. */
  readonly args: readonly string[];
}

/**
 * Callback that records a directive-lowering error. The caller owns the
 * position: `report` receives the code and message only, and the caller pins
 * the diagnostic to the source range it originated from.
 */
export interface DirectiveReporter {
  (code: CompilerErrorCode, message: string, subject: string): void;
}

interface DirectiveSpec {
  readonly builder: string;
  readonly takesValue: boolean;
}

/**
 * The single source of truth: each `js-*` token maps to its render tool and
 * whether it requires a value. Derived, frozen, and never mutated.
 */
const DIRECTIVE_TABLE: Readonly<Record<string, DirectiveSpec>> = Object.freeze({
  'js-confirm': { builder: 'confirm', takesValue: true },
  'js-loading': { builder: 'loadingTarget', takesValue: true },
  'js-show': { builder: 'show', takesValue: true },
  'js-text': { builder: 'text', takesValue: true },
  'js-sort': { builder: 'sort', takesValue: true },
  'js-intersect': { builder: 'intersect', takesValue: true },
  'js-ref': { builder: 'ref', takesValue: true },
  'js-ignore': { builder: 'ignore', takesValue: false },
  'js-call': { builder: 'call', takesValue: true },
  'js-submit': { builder: 'submit', takesValue: true },
  'js-model': { builder: 'bind', takesValue: true },
  'js-poll': { builder: 'poll', takesValue: true },
});

/**
 * Lower one `js-*` attribute to its render-tool call.
 *
 * `value` is the raw, already-unquoted source text of the attribute, or `null`
 * when the attribute carries no value. Returns `null` on error — the caller
 * must skip the attribute — after reporting the diagnostic through `report`.
 * On success the returned object is frozen.
 */
export function lowerDirective(
  name: string,
  value: string | null,
  report: DirectiveReporter,
): DirectiveLowering | null {
  // `Object.hasOwn` guards against prototype keys (`constructor`, `__proto__`,
  // `toString`) resolving to inherited members instead of being rejected.
  const spec = Object.hasOwn(DIRECTIVE_TABLE, name) ? DIRECTIVE_TABLE[name] : undefined;
  if (spec === undefined) {
    report('unknown_directive', `Unknown directive '${name}'`, name);
    return null;
  }

  if (spec.takesValue) {
    if (value === null) {
      report('unsupported_position', `Directive '${name}' requires a value`, name);
      return null;
    }
    return Object.freeze({ builder: spec.builder, args: Object.freeze([value]) });
  }

  if (value !== null) {
    report('unsupported_position', `Directive '${name}' does not take a value`, name);
    return null;
  }
  return Object.freeze({ builder: spec.builder, args: Object.freeze([]) });
}
