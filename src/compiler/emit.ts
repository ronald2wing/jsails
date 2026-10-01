/**
 * Shape-aware component emission: reassembly, directive lowering, and output
 * generation for the three component shapes (single, inline-server, multi-file).
 *
 * All operations are pure transforms over source strings. The emitter is the
 * caller of `planSplit` for Shape 3 — it does not re-derive the split-boundary
 * closure rule.
 *
 * Errors are collected, not thrown: the emit layer creates a `DiagnosticBag`
 * and threads it through lowering. When errors exist, codegen is skipped and
 * the emitted component carries the diagnostic list.
 */

import { ConvertComponentError, planSplit } from './component-shape.js';
import { DiagnosticBag } from './diagnostics.js';
import { lowerDirective } from './directives.js';
import type { CompileDiagnostic, CompilerErrorCode } from './errors.js';
import type { ComponentRegions, RegionName } from './regions.js';
import { collectComponentTags, resolveComponentTags } from './resolve-components.js';
import { lineStartOffsets } from './source-lines.js';
import { SourceMapBuilder, type ComponentSourceMap } from './source-map.js';
import { lowerTemplateRegion, type LoweredTemplateRegion } from './template.js';
import { usesDynamicComponent } from './template-lower.js';

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

export type EmitShape = 'single' | 'inline-server' | 'multi-file';

/** Where to resolve capitalized template tags to component modules. */
export interface EmitResolveOptions {
  /** Directory of the emitted module, for the relative import specifier. */
  readonly fromDir: string;
  /** Project root, used to locate `app/components/`. */
  readonly rootDir: string;
}

export interface EmitOptions {
  readonly name: string;
  readonly regions: ComponentRegions;
  readonly shape: EmitShape;
  /**
   * When present, capitalized tags in the view are resolved to explicit
   * component imports prepended to the emitted module. When absent, the view is
   * emitted verbatim (the compiler stays usable without a project root).
   */
  readonly resolve?: EmitResolveOptions;
  /**
   * The full component source, used to render code frames for diagnostics.
   * When absent, diagnostics carry an empty `frame`.
   */
  readonly source?: string;
  /** Whether to render code frames. Defaults to `true`. */
  readonly frames?: boolean;
}

export interface EmittedComponent {
  readonly entry: string;
  readonly model?: string;
  readonly style?: string;
  readonly server?: string;
  /**
   * The source map for `entry`. Present for Shape 1/2, where `entry` is the
   * verbatim reassembly of the regions; `null` when codegen was skipped (errors)
   * or for Shape 3, whose `entry` is rebuilt by `planSplit` (not map-aware), so a
   * single reassembly map would be wrong.
   */
  readonly map: ComponentSourceMap | null;
  readonly diagnostics: readonly CompileDiagnostic[];
}

/* ------------------------------------------------------------------ */
/*  Reassembly                                                        */
/* ------------------------------------------------------------------ */

const REGION_ORDER: readonly RegionName[] = ['model', 'server', 'style', 'view'];

/**
 * One chunk of the reassembled output. `srcStartLine` is the 0-based source line
 * of the chunk's first line, or `null` when the chunk carries no source origin
 * (a region marker, a blank separator, the injected import block).
 */
interface OutputChunk {
  readonly text: string;
  readonly srcStartLine: number | null;
  /** Generated column the chunk's first line starts at (non-zero when indented). */
  readonly genCol: number;
}

/**
 * Rebuild a single-file source by emitting the preamble (file doc comment and
 * imports) followed by the four regions in the fixed order `model`, `server`,
 * `style`, `view`, each wrapped in its region markers, separated by an empty
 * line. Region bodies are preserved verbatim so the output is an idempotent
 * input to `extractRegions`.
 *
 * `synthesizedPreambleLines` is the number of compiler-injected import lines
 * prepended to the authored preamble; those generated lines carry no source
 * origin and are emitted unmapped.
 *
 * One chunk list drives both the code and the map, so the two cannot drift:
 * every generated line that carries a verbatim body is mapped to its original
 * source line, and every synthesized line is emitted unmapped.
 */
function reassemble(
  regions: Omit<ComponentRegions, 'offsets'>,
  offsets: ComponentRegions['offsets'],
  source: string,
  lineStarts: readonly number[],
  file: string,
  synthesizedPreambleLines: number,
): { readonly code: string; readonly map: ComponentSourceMap | null } {
  const builder = new SourceMapBuilder(source, file, lineStarts);
  const chunks: OutputChunk[] = [];

  if (regions.preamble.length > 0) {
    const lines = regions.preamble.split('\n');
    const injected = lines.slice(0, synthesizedPreambleLines);
    const original = lines.slice(synthesizedPreambleLines);
    if (injected.length > 0) {
      chunks.push({ text: injected.join('\n'), srcStartLine: null, genCol: 0 });
    }
    if (original.length > 0) {
      chunks.push({
        text: original.join('\n'),
        srcStartLine: builder.sourceLineAt(offsets.preamble),
        genCol: 0,
      });
    }
  }

  for (const name of REGION_ORDER) {
    chunks.push({ text: `// #region ${name}`, srcStartLine: null, genCol: 0 });
    chunks.push({
      text: regions[name],
      srcStartLine: builder.sourceLineAt(offsets[name]),
      genCol: 0,
    });
    chunks.push({ text: `// #endregion ${name}`, srcStartLine: null, genCol: 0 });
  }

  const code = chunks.map((chunk) => chunk.text).join('\n\n') + '\n';

  let genLine = 0;
  for (let index = 0; index < chunks.length; index += 1) {
    if (index > 0) {
      // The blank line the `\n\n` join introduces between chunks.
      builder.markUnmapped(genLine, 0);
      genLine += 1;
    }
    const chunk = chunks[index];
    if (chunk === undefined) {
      continue;
    }
    if (chunk.srcStartLine === null) {
      builder.addVerbatimBlock(chunk.text, genLine, -1, chunk.genCol);
    } else {
      builder.addVerbatimBlock(chunk.text, genLine, chunk.srcStartLine, chunk.genCol);
    }
    genLine += chunk.text.split('\n').length;
  }

  return { code, map: builder.build({ file }) };
}

/* ------------------------------------------------------------------ */
/*  Directive lowering (text transform over the view region)           */
/* ------------------------------------------------------------------ */

/**
 * A bounded regex over JSX attribute syntax that matches `js-*` attributes.
 *
 * Limits (documented):
 * - Only matches quoted or bare attributes: `js-submit="val"`, `js-submit='val'`,
 *   or bare `js-ignore`. Does NOT match brace delimiters (`js-submit={expr}`).
 * - Does not skip `js-*` text inside string literals or comments — the regex
 *   operates on the raw source and may produce a false positive there.
 * - This is a deliberate choice: a full JSX parse is costly and the aspirational
 *   dialect uses quoted attributes exclusively.
 */
const DIRECTIVE_ATTR_RE = /js-([a-z][a-z0-9-]*)(?:=(?:"([^"]*)"|'([^']*)'))?/g;

function lowerViewRegion(view: string, bag: DiagnosticBag, baseOffset: number): string {
  return view.replace(
    DIRECTIVE_ATTR_RE,
    (match, token: string, dqValue: string | undefined, sqValue: string | undefined, offset) => {
      const value: string | null =
        dqValue !== undefined ? dqValue : sqValue !== undefined ? sqValue : null;
      const lowered = lowerDirective('js-' + token, value, (code, message) => {
        bag.errorAt(code, message, baseOffset + offset, baseOffset + offset + match.length);
      });
      if (lowered === null) {
        return '';
      }
      if (lowered.args.length === 0) {
        return `{...${lowered.builder}()}`;
      }
      return `{...${lowered.builder}(${lowered.args[0]})}`;
    },
  );
}

/* ------------------------------------------------------------------ */
/*  Component import resolution                                        */
/* ------------------------------------------------------------------ */

/**
 * Resolve capitalized tags in the view and prepend an import for each to the
 * preamble. Idempotent: a tag whose import already appears in the preamble is
 * not duplicated, so re-emitting an already-resolved module is a no-op.
 *
 * Tag positions come from the source of truth for each dialect: a `<template>`
 * block supplies exact positions from its parsed nodes (`lowered.components`);
 * the raw-JSX dialect is collected from the region string at its own offset,
 * before any `js-*` text lowering could shift positions. A tag with no module is
 * reported as a positioned `unresolved_component` and skipped, so the emit
 * continues and multiple missing components surface together.
 */
function prependComponentImports(
  preamble: string,
  view: string,
  lowered: LoweredTemplateRegion,
  resolve: EmitResolveOptions,
  bag: DiagnosticBag,
): string {
  const report = (
    code: CompilerErrorCode,
    message: string,
    subject: string,
    s: number,
    e: number,
  ) => {
    bag.errorAt(code, message, s, e);
  };

  const tags = lowered.components ?? collectComponentTags(view, lowered.offset, report);

  if (tags.length === 0) {
    return preamble;
  }

  const resolved = resolveComponentTags(tags, resolve, report);
  const lines: string[] = [];
  for (const component of resolved) {
    // Skip a tag already imported in the preamble (idempotence).
    if (preamble.includes(`{ ${component.tag} }`)) {
      continue;
    }
    lines.push(`import { ${component.tag} } from '${component.specifier}';`);
  }
  if (lines.length === 0) {
    return preamble;
  }

  const block = lines.join('\n');
  return preamble.length > 0 ? `${block}\n${preamble}` : block;
}

/**
 * Prepend `import { h } from 'preact'` when the lowered view uses the dynamic
 * component lowering. Idempotent: skipped when the preamble already imports
 * `h`, so re-emitting an already-resolved module is a no-op.
 */
function prependDynamicImport(preamble: string, view: string): string {
  if (!usesDynamicComponent(view) || preamble.includes('{ h }')) {
    return preamble;
  }
  const line = "import { h } from 'preact';";
  return preamble.length > 0 ? `${line}\n${preamble}` : line;
}

/* ------------------------------------------------------------------ */
/*  emitComponent                                                     */
/* ------------------------------------------------------------------ */

/**
 * Compile a component from its extracted regions into the target shape.
 *
 * The caller owns shape selection; this function takes `shape` explicitly. The
 * returned object is frozen.
 *
 * Shape 1 (`single`) and Shape 2 (`inline-server`): reassemble and return
 * only the entry. The `server` region's `'use server'` functions stay inline
 * in the entry for `serverDirectivePlugin` to strip later.
 *
 * Shape 3 (`multi-file`): reassemble, lower directives, then call `planSplit`
 * to split into entry + server parts. The caller receives both parts and owns
 * writing them to disk.
 *
 * When the diagnostic bag collects errors, codegen is skipped: `entry` is `''`,
 * `model`/`style`/`server` are `undefined`.
 *
 * `emitComponent` does not throw for a component-source problem: an unresolved
 * component tag, a view that will not parse, or a component that cannot be split
 * all become positioned diagnostics in `diagnostics`, and `entry` is `''`. Only
 * a genuinely unexpected error (a non-`ConvertComponentError` escaping the split)
 * propagates.
 */
export function emitComponent(options: EmitOptions): EmittedComponent {
  const { name, regions, shape, resolve, source, frames } = options;
  const bag = new DiagnosticBag({ source, frames });

  // Step 1: lower a `<template>` block to JSX (no-op for the raw-JSX dialect).
  // A `<template>` block's directives are already consumed by template lowering,
  // so the raw-JSX `js-*` text transform runs only on the raw-JSX dialect.
  const jsxView = lowerTemplateRegion(regions.view, regions.offsets.view, bag);
  const loweredView = jsxView.wasTemplate
    ? jsxView.code
    : lowerViewRegion(jsxView.code, bag, jsxView.offset);

  // Step 2: resolve capitalized tags to explicit component imports and prepend
  // them to the preamble. Skipped when no resolver is configured.
  const withComponents =
    resolve === undefined
      ? regions.preamble
      : prependComponentImports(regions.preamble, regions.view, jsxView, resolve, bag);

  // Step 3: a dynamic component lowers to `h(...)`, which needs `h` in scope.
  // Inject the import unless the preamble already provides it.
  const preamble = prependDynamicImport(withComponents, loweredView);

  // Step 4: reassemble with the lowered view region. The source map is built
  // from the *original* component source so every verbatim region line resolves
  // back to where the author wrote it.
  const componentSource = source ?? '';
  // Both prependers only ever prepend whole lines, so the line-count delta is
  // exactly the number of compiler-injected import lines.
  const synthesizedPreambleLines =
    regions.preamble.length === 0
      ? preamble.split('\n').length
      : preamble.split('\n').length - regions.preamble.split('\n').length;
  const { code: reassembled, map } = reassemble(
    {
      preamble,
      model: regions.model,
      server: regions.server,
      style: regions.style,
      view: loweredView,
    },
    regions.offsets,
    componentSource,
    lineStartOffsets(componentSource),
    name + '.tsx',
    Math.max(0, synthesizedPreambleLines),
  );

  // Step 5: handle shape. Skip codegen when errors exist.
  if (bag.hasErrors) {
    return Object.freeze({ entry: '', map: null, diagnostics: bag.toList() });
  }

  if (shape === 'multi-file') {
    try {
      const plan = planSplit(reassembled, name + '.tsx');
      return Object.freeze({
        entry: plan.entry,
        model: plan.model,
        style: plan.style,
        server: plan.server,
        // `planSplit` rebuilds the entry from live statements; a reassembly map
        // would not describe the rebuilt output, so it is omitted.
        map: null,
        diagnostics: bag.toList(),
      });
    } catch (error) {
      // A split failure is a component-source problem, not a framework fault:
      // report it as a diagnostic (anchored to the whole component) and return
      // an empty entry, so the caller sees one uniform error contract.
      if (error instanceof ConvertComponentError) {
        const code: CompilerErrorCode =
          error.code === 'unmigratable_reference' ? 'unmigratable_reference' : 'unparseable';
        bag.errorAt(code, error.message, 0, source?.length ?? 0);
        return Object.freeze({ entry: '', map: null, diagnostics: bag.toList() });
      }
      throw error;
    }
  }

  // Shape 'single' or 'inline-server': only the entry.
  return Object.freeze({ entry: reassembled, map, diagnostics: bag.toList() });
}
