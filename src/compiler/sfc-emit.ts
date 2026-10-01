/**
 * Emission of a `.jsails` single-file component into a `.tsx` module plus a CSS
 * side-band.
 *
 * The `.jsails` host is a Vue-inspired file: `<template>` (view grammar),
 * `<script>` (component config), `<style>` (real CSS), `<server>` (`'use
 * server'` functions). This module is the assembler that lowers those blocks
 * onto the existing `defineComponent(...)` authoring surface — the same target
 * the `#region` compiler emits. No new runtime and no second state authority:
 * the emitted module is a plain `.tsx` module.
 *
 * The `<template>` is lowered through the shared U5 grammar (`parseTemplate` +
 * `lowerTemplate`); the `<script>` body is carried verbatim as the component
 * config source; the `<style>` body is returned in a separate `css` band for
 * the bundler to inject into its stylesheet asset, so the compiler never has to
 * build a CSS pipeline of its own.
 */

import { DiagnosticBag } from './diagnostics.js';
import type { CompileDiagnostic, CompilerErrorCode } from './errors.js';
import { collectTemplateComponents, resolveComponentTags } from './resolve-components.js';
import { parseSfc } from './sfc.js';
import { lineStartOffsets } from './source-lines.js';
import { SourceMapBuilder, type ComponentSourceMap } from './source-map.js';
import type { TemplateNode } from './template-ast.js';
import { parseTemplate } from './template-ast.js';
import { lowerTemplate, usesDynamicComponent } from './template-lower.js';

/** Options for {@link emitSfc}. */
export interface EmitSfcOptions {
  /** The component name, e.g. `'task-list'` (the filename basename, kebab-case). */
  readonly name: string;
  /** Directory of the emitted module, for relative component import specifiers. */
  readonly fromDir: string;
  /** Project root, used to resolve capitalized template tags to `app/components/`. */
  readonly rootDir: string;
}

/** The emitter's result: a `.tsx` module plus the CSS side-band and diagnostics. */
export interface SfcEmitResult {
  readonly code: string;
  readonly css: string;
  /** The source map for `code`; `null` only when codegen was skipped (errors). */
  readonly map: ComponentSourceMap | null;
  readonly diagnostics: readonly CompileDiagnostic[];
}

/**
 * The `defineComponent` config keys the `<script>` block may declare. Names are
 * referenced from the emitted `defineComponent({...})` call by the same
 * identifier, so the script author must `export const` them.
 */
const CONFIG_KEYS: readonly string[] = [
  'stateSchema',
  'writableKeys',
  'initialState',
  'authorize',
  'actions',
  'derived',
  'staticFallback',
  'urlBinding',
];

/**
 * Compile a `.jsails` source into a `.tsx` module plus a CSS band.
 *
 * The emitted module is:
 *
 * ```tsx
 * import { defineComponent } from 'jsails/server-components';
 * <script body verbatim>
 * export const widget = defineComponent({
 *   name: 'widget',
 *   stateSchema, writableKeys, initialState, authorize, // only declared keys
 *   render(state, tools) { return (<lowered template>); },
 * });
 * ```
 *
 * The `<style>` body is returned in `css`; the `<server>` body is appended to
 * the module (its `'use server'` functions ride the existing Shape-2 seam). A
 * capitalized tag in the template resolves to an explicit component import via
 * `resolveComponentTags`, and a dynamic component (`<component :is>`) gets an
 * injected `import { h } from 'preact'`.
 *
 * When the template lowering produces errors, `code` is `''` and
 * `diagnostics` carries the error list.
 *
 * @throws CompilerError `missing_region` when `<script>`/`<template>` is absent.
 */
export function emitSfc(source: string, fileName: string, options: EmitSfcOptions): SfcEmitResult {
  const blocks = parseSfc(source, fileName);

  // Step 1: lower the template to JSX through the shared U5 grammar.
  const bag = new DiagnosticBag({ source });
  const baseOffset = blocks.offsets.template;
  const report = (
    code: CompilerErrorCode,
    message: string,
    subject: string,
    s: number,
    e: number,
  ) => {
    bag.errorAt(code, message, baseOffset + s, baseOffset + e);
  };
  const nodes = parseTemplate(blocks.template, report);
  const ctx = { bag, baseOffset };
  const jsx = bag.hasErrors ? '' : lowerTemplate(nodes, ctx);

  if (bag.hasErrors) {
    return Object.freeze({ code: '', css: blocks.style, map: null, diagnostics: bag.toList() });
  }

  // Step 2: resolve capitalized tags to explicit component imports. Positions
  // come from the parsed tree, which already carries body-absolute offsets.
  const componentImports = resolveBlocks(nodes, baseOffset, options, bag);

  // Step 3: the dynamic-component `h(...)` lowering needs `h` in scope.
  const hImport = usesDynamicComponent(jsx) ? "import { h } from 'preact';" : '';

  // Step 4: assemble the module. The script body carries the config exports;
  // the emitted defineComponent references only the keys the script declared.
  const definition = buildDefinition(options.name, jsx, declaredConfigKeys(blocks.script));

  // Each chunk carries its origin: `null` for synthesized lines (imports and the
  // defineComponent skeleton) or a 0-based source line for verbatim block bodies.
  // `jsxOffset` names the chunk/line within `definition` that holds the template.
  const lineStarts = lineStartOffsets(source);
  const chunks: readonly SfcChunk[] = [
    { text: "import { defineComponent } from 'jsails/server-components';", srcLine: null },
    { text: hImport, srcLine: null },
    { text: componentImports, srcLine: null },
    { text: blocks.script.trim(), srcLine: sourceLineAt(lineStarts, blocks.offsets.script) },
    {
      text: definition.text,
      srcLine: null,
      jsx: {
        offset: definition.jsxStartLine,
        count: definition.jsxLineCount,
        templateLine: sourceLineAt(lineStarts, baseOffset),
      },
    },
    { text: blocks.server.trim(), srcLine: sourceLineAt(lineStarts, blocks.offsets.server) },
  ];

  const rendered = chunks.filter((chunk) => chunk.text.length > 0);
  const code = rendered.map((chunk) => chunk.text).join('\n') + '\n';
  const map = buildSfcMap(source, fileName, lineStarts, rendered);

  return Object.freeze({ code, css: blocks.style, map, diagnostics: bag.toList() });
}

/**
 * One chunk of the assembled SFC module. `srcLine` is the 0-based source line of
 * the chunk's first generated line, or `null` when the chunk is synthesized.
 * `jsx` marks the `defineComponent` chunk, whose embedded template lines map to
 * the `<template>` block.
 */
interface SfcChunk {
  readonly text: string;
  readonly srcLine: number | null;
  readonly jsx?: {
    /** 0-based line within the chunk where the embedded template begins. */
    readonly offset: number;
    /** Number of embedded template lines. */
    readonly count: number;
    /** 0-based `<template>` source line the first embedded line maps to. */
    readonly templateLine: number;
  };
}

/** The 0-based source line of `offset`, or 0 when the file has no lines. */
function sourceLineAt(lineStarts: readonly number[], offset: number): number {
  let line = 0;
  for (let index = 0; index < lineStarts.length; index += 1) {
    const start = lineStarts[index];
    if (start !== undefined && start <= offset) {
      line = index;
    } else {
      break;
    }
  }
  return line;
}

/**
 * Build the source map for the assembled SFC module. Verbatim block bodies
 * (script, server) and the embedded template lines map one-to-one to their
 * source lines; synthesized import lines and the `defineComponent` skeleton are
 * marked unmapped. Mapping is line-granular: the template is indented by six
 * spaces inside `render`, so column-level precision would be fabricated.
 */
function buildSfcMap(
  source: string,
  fileName: string,
  lineStarts: readonly number[],
  chunks: readonly SfcChunk[],
): ComponentSourceMap | null {
  const builder = new SourceMapBuilder(source, fileName, lineStarts);
  let genLine = 0;
  for (const chunk of chunks) {
    // Chunks are joined by a single newline, so each chunk's first line lands on
    // the very next generated line — no generated line is skipped between them.
    const lines = chunk.text.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      if (
        chunk.jsx !== undefined &&
        index >= chunk.jsx.offset &&
        index < chunk.jsx.offset + chunk.jsx.count
      ) {
        builder.addMapping(genLine, 0, chunk.jsx.templateLine + (index - chunk.jsx.offset), 0);
      } else if (chunk.srcLine !== null) {
        builder.addMapping(genLine, 0, chunk.srcLine + index, 0);
      } else {
        builder.markUnmapped(genLine, 0);
      }
      genLine += 1;
    }
  }
  return builder.build({ file: fileName });
}

/**
 * Resolve capitalized template tags to explicit `import { Tag } from …`
 * declarations, or return `''` when the template references no component. Tag
 * positions come from the parsed template tree via `collectTemplateComponents`.
 */
function resolveBlocks(
  nodes: readonly TemplateNode[],
  baseOffset: number,
  options: EmitSfcOptions,
  bag: DiagnosticBag,
): string {
  const tags = collectTemplateComponents(nodes, baseOffset);
  if (tags.length === 0) {
    return '';
  }
  const report = (
    code: CompilerErrorCode,
    message: string,
    subject: string,
    s: number,
    e: number,
  ) => {
    bag.errorAt(code, message, s, e);
  };
  const resolved = resolveComponentTags(
    tags,
    { fromDir: options.fromDir, rootDir: options.rootDir },
    report,
  );
  return resolved.map((c) => `import { ${c.tag} } from '${c.specifier}';`).join('\n');
}

/**
 * The config keys the `<script>` block actually exports, in `CONFIG_KEYS` order.
 *
 * Only declared keys are emitted into the `defineComponent({...})` call: an
 * undeclared key would reference an undefined identifier and fail to typecheck.
 * The script is plain TS, so a targeted scan for `export const <key>` /
 * `export function <key>` / `export { <key> }` is sufficient and dependency-free.
 */
function declaredConfigKeys(script: string): readonly string[] {
  return CONFIG_KEYS.filter((key) => {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const declaration = new RegExp(
      `\\bexport\\s+(?:const|let|var|function|async\\s+function)\\s+${escaped}\\b`,
    );
    const reExport = new RegExp(`\\bexport\\s*\\{[^}]*\\b${escaped}\\b[^}]*\\}`);
    return declaration.test(script) || reExport.test(script);
  });
}

/**
 * Build the `export const <binding> = defineComponent({...})` declaration from
 * the lowered JSX, referencing the script's `export const` config keys by name.
 * `name` is the runtime identity (kebab-case filename); the binding is its
 * identifier form (`task-list` → `taskList`).
 *
 * Returns the block plus the 0-based line index (within the block) at which the
 * embedded template's first line lands, and its line count, so the caller can
 * map those generated lines back to the `<template>` source.
 */
function buildDefinition(
  name: string,
  jsx: string,
  configKeys: readonly string[],
): { readonly text: string; readonly jsxStartLine: number; readonly jsxLineCount: number } {
  // The runtime identity stays the kebab-case filename (`name: 'task-list'`),
  // but the `export const` binding must be a valid JS identifier, so a
  // `task-card.jsails` component is bound as `taskCard` and referenced by name.
  const binding = toIdentifier(name);
  const configEntries = configKeys.map((key) => `  ${key},`).join('\n');
  // A template may have several top-level elements; JSX requires a single root,
  // so the lowered view is always wrapped in a fragment.
  const wrapped = `<>${jsx}</>`;
  const rendered = indent(wrapped, 6);
  const lines = [
    `export const ${binding} = defineComponent({`,
    `  name: '${name}',`,
    configEntries,
    `  render(state, tools) {`,
    `    return (${rendered});`,
    `  },`,
    `});`,
  ];
  const head = lines.slice(0, 4).join('\n');
  const jsxStartLine = head.split('\n').length;
  return { text: lines.join('\n'), jsxStartLine, jsxLineCount: rendered.split('\n').length };
}

/**
 * Derive a valid JS identifier binding from a filename-derived component name.
 * A kebab-case name (`task-list`) becomes camelCase (`taskList`); any character
 * that cannot appear in an identifier is a word boundary. This matches the
 * authoring convention (runtime `name: 'task-list'`, binding `taskList`).
 */
function toIdentifier(name: string): string {
  const words = name.split(/[^A-Za-z0-9_$]+/).filter((word) => word.length > 0);
  if (words.length === 0) {
    return name;
  }
  return words
    .map((word, index) => (index === 0 ? word : word.charAt(0).toUpperCase() + word.slice(1)))
    .join('');
}

/** Indent each line of `source` by `spaces`. */
function indent(source: string, spaces: number): string {
  const pad = ' '.repeat(spaces);
  return source
    .split('\n')
    .map((line) => (line.length === 0 ? line : pad + line))
    .join('\n');
}
