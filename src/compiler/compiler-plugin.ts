/**
 * The component-source Vite/Rolldown plugin: a thin `transform` wrapper over the
 * pure region extractor and shape-aware emitter.
 *
 * Two authoring hosts are supported:
 * - `.tsx` / `.mtsx` with `// #region` markers (the region dialect), lowered by
 *   `extractRegions` + `emitComponent`.
 * - `.jsails` single-file components (`<template>`/`<script>`/`<style>`/
 *   `<server>`), lowered by `emitSfc`. The `<style>` body is returned on the
 *   `css` side-channel for the bundler to inject into its stylesheet asset.
 *
 * Construction is inert and bundler-agnostic: the returned object is
 * structurally compatible with any bundler exposing an `enforce`/`transform`
 * hook pair, and imports no bundler code. It runs `enforce: 'pre'` so component
 * syntax is lowered before any other transform sees the source.
 *
 * Composition order: `compilerPlugin` → `serverDirectivePlugin` →
 * `cleanBundlePlugin`. The compiler runs first so it lowers `js-*` directives
 * and reassembles regions before `serverDirectivePlugin` strips `'use server'`
 * bodies; `cleanBundlePlugin` is the final assertion that a `*.server.ts` module
 * never reaches a client chunk.
 *
 * The plugin is OFF by default — it is not wired into `createApplication` or any
 * default build. A project opts in by adding it to its bundler config.
 */

import { readFileSync } from 'node:fs';

import { emitComponent, type EmitShape } from './emit.js';
import { CompilerBuildError, CompilerError, type CompileDiagnostic } from './errors.js';
import { extractRegions } from './regions.js';
import { emitSfc } from './sfc-emit.js';

/** Options for {@link compilerPlugin}. */
export interface CompilerPluginOptions {
  /**
   * Extensions the transform applies to. Defaults to the region component
   * extensions (`.tsx`, `.mtsx`); single-file components (`.jsails`) are always
   * handled. A plain `.ts`/`.js` module is never a component source and is
   * passed through untouched.
   */
  readonly include?: readonly string[];
  /**
   * Project root, used to resolve capitalized template tags to
   * `app/components/` modules. Defaults to `process.cwd()`.
   */
  readonly rootDir?: string;
}

const DEFAULT_INCLUDE = Object.freeze(['.tsx', '.mtsx']);

/** The extension that marks a single-file component. */
const SFC_EXTENSION = '.jsails';

/**
 * The virtual extension a `.jsails` file is published under. Rolldown/Vite pick
 * their parser language from the module id extension, so an id that still ends
 * in `.jsails` is parsed as plain JS and the emitted TSX fails with a JSX parse
 * error. Renaming to `.jsails.tsx` makes the emitted TSX parse correctly while
 * keeping the component's own identity (`sfcSourceId` strips the suffix).
 */
const SFC_VIRTUAL_EXTENSION = '.jsails.tsx';

/** The synthetic id Vite passes for CSS/asset requests that must never be parsed. */
const CSS_QUERY = /\.(css|scss|sass|less|styl)(\?|$)/i;

/** True when `id` (a Vite module id, possibly with a query) matches one of the extensions. */
function applies(id: string, include: readonly string[]): boolean {
  if (CSS_QUERY.test(id)) {
    return false;
  }
  const clean = id.split('?')[0] ?? id;
  return include.some((extension) => clean.endsWith(extension));
}

/** True when `id` is the virtual id our `.jsails` resolver publishes. */
function isSfc(id: string): boolean {
  return (id.split('?')[0] ?? id).endsWith(SFC_VIRTUAL_EXTENSION);
}

/** The real `.jsails` path behind a virtual `.jsails.tsx` id. */
function sfcSourceId(id: string): string {
  return (id.split('?')[0] ?? id).slice(0, -'.tsx'.length);
}

/** The component name derived from a module id: the basename without its extensions. */
function componentName(id: string): string {
  const clean = id.split('?')[0] ?? id;
  const base = clean.split('/').pop() ?? clean;
  if (base.endsWith(SFC_VIRTUAL_EXTENSION)) {
    return base.slice(0, -SFC_VIRTUAL_EXTENSION.length);
  }
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

/** The directory of a module id, for relative component import specifiers. */
function moduleDir(id: string): string {
  const clean = id.split('?')[0] ?? id;
  const slash = clean.lastIndexOf('/');
  return slash > 0 ? clean.slice(0, slash) : '.';
}

/**
 * Whether the view region has anything the compiler must lower: a `<template>`
 * block (the Vue-like dialect), a `js-*` directive, or a capitalized JSX tag (a
 * component reference). A view with none of these is already valid TSX and is
 * passed through untouched.
 *
 * The tag check requires the `<` to be preceded by a non-identifier character
 * so a generic type argument (`defineComponent<TaskListState>`) is not mistaken
 * for a JSX tag.
 */
function needsLowering(view: string): boolean {
  // A `<template>` block is the Vue-like dialect: never valid TSX on its own, so
  // it must always be lowered even when it carries no `js-*` directive and no
  // capitalized tag. Detection is a leading check (the block is the dialect only
  // as the first non-whitespace content), matching `lowerTemplateRegion`.
  if (view.replace(/^\s+/, '').startsWith('<template>')) {
    return true;
  }
  return view.includes('js-') || /(?:^|[^A-Za-z0-9_$])<[A-Z]/.test(view);
}

/**
 * Select the emission shape. This is a deliberate heuristic for U4: a component
 * is treated as `multi-file` only when its server region carries a `'use server'`
 * directive AND an import specifier ending in `.server.js`; every other component
 * is `single`. Shape splitting is opt-in and refined later — the plugin's job is
 * to lower directives and validate, not to decide the split boundary.
 */
function selectShape(server: string): EmitShape {
  if (server.includes("'use server'") && /from\s+['"][^'"]*\.server\.js['"]/.test(server)) {
    return 'multi-file';
  }
  return 'single';
}

/**
 * Render a diagnostic list into a value-free build-log string.
 *
 * `message` and `code` are compiler-authored (never source text); `frame` is the
 * one sanctioned source-text exception, rendered from the author's in-memory
 * source at compile time (see {@link CompileDiagnostic}). `id` is the module id,
 * a path, not source.
 */
export function formatDiagnostics(id: string, diagnostics: readonly CompileDiagnostic[]): string {
  return diagnostics
    .map((diagnostic) => {
      const { line, column } = diagnostic.range.start;
      const head = `${id}:${line}:${column}: ${diagnostic.severity}[${diagnostic.code}]: ${diagnostic.message}`;
      return diagnostic.frame.length > 0 ? `${head}\n${diagnostic.frame}` : head;
    })
    .join('\n\n');
}

/**
 * Decide what a bundler should do with a component's diagnostics.
 *
 * Error-severity diagnostics abort the build: throw a {@link CompilerBuildError}
 * carrying the first error's `.loc`, a message with every rendered frame, and the
 * structured `.diagnostics` list. Warnings-only return normally, surfaced through
 * the bundler's own `warn` hook when it exposes one. Returns `void` — callers
 * proceed to emit only when this does not throw.
 */
export function surfaceDiagnostics(
  id: string,
  diagnostics: readonly CompileDiagnostic[],
  warn?: (message: string) => void,
): void {
  if (diagnostics.length === 0) {
    return;
  }
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
  if (errors.length > 0) {
    throw new CompilerBuildError(id, errors, formatDiagnostics(id, errors));
  }
  warn?.(formatDiagnostics(id, diagnostics));
}

/**
 * Build the plugin.
 *
 * `.jsails` resolution: `resolveId` rewrites a `*.jsails` specifier to a virtual
 * `*.jsails.tsx` id and `load` reads the real file's contents for it. This is
 * required because Rolldown/Vite choose the parser language from the module id
 * extension — a module that still ends in `.jsails` is parsed as plain JS and
 * the emitted TSX fails with a JSX parse error. The `transform` hook then
 * compiles that virtual module.
 *
 * `transform` returns `null` when the file is not a component source or when the
 * emitted entry is byte-identical to the input, so the bundler skips its own
 * re-parse; otherwise it returns the rewritten code. Error-severity diagnostics
 * abort the build with a positioned {@link CompilerBuildError}; warnings ride the
 * bundler's `warn` hook when available. A `.jsails` transform also returns a
 * `css` string carrying the `<style>` body, which the bundler injects into its
 * stylesheet asset.
 */
export function compilerPlugin(options: CompilerPluginOptions = {}): {
  name: string;
  enforce: 'pre';
  resolveId(source: string): string | null;
  load(id: string): string | null;
  transform(code: string, id: string): { code: string; map: object | null; css?: string } | null;
} {
  const include = options.include ?? DEFAULT_INCLUDE;
  const rootDir = options.rootDir ?? process.cwd();

  return {
    name: 'jsails-component-compiler',
    enforce: 'pre',

    resolveId(source) {
      const clean = source.split('?')[0] ?? source;
      return clean.endsWith(SFC_EXTENSION) ? `${source}${'.tsx'}` : null;
    },

    load(id) {
      if (!isSfc(id)) {
        return null;
      }
      return readFileSync(sfcSourceId(id), 'utf-8');
    },

    transform(code, id) {
      // A bundler invokes `transform` with a plugin context as `this`; a test
      // may call it unbound. Read `warn` defensively rather than require it.
      const context = this as unknown as { warn?: (message: string) => void } | undefined;
      const warn = typeof context?.warn === 'function' ? context.warn.bind(context) : undefined;

      if (isSfc(id)) {
        return transformSfc(code, sfcSourceId(id), rootDir, warn);
      }

      if (!applies(id, include)) {
        return null;
      }

      // Region dialect. Cheap prefilter: a component source always carries
      // region markers, so a file without the substring skips the parse.
      if (!code.includes('#region')) {
        return null;
      }

      let regions;
      try {
        regions = extractRegions(code, id);
      } catch (error) {
        // A `.tsx` file that is not a component is passed through untouched; a
        // malformed component (any other CompilerError) is a build error.
        if (error instanceof CompilerError && error.code === 'missing_region') {
          return null;
        }
        throw error;
      }

      // Nothing to lower: the region markers are plain comments, so a component
      // with no `js-*` directive and no capitalized tag is already valid TSX.
      // Reassembling it would only normalize whitespace, so pass it through.
      if (!needsLowering(regions.view)) {
        return null;
      }

      const emitted = emitComponent({
        name: componentName(id),
        regions,
        shape: selectShape(regions.server),
        resolve: { fromDir: moduleDir(id), rootDir },
        source: code,
      });

      surfaceDiagnostics(id, emitted.diagnostics, warn);

      if (emitted.entry === code) {
        return null;
      }
      return { code: emitted.entry, map: emitted.map };
    },
  };
}

/**
 * Lower a `.jsails` single-file component. The `<style>` body rides the `css`
 * side-channel; the returned `code` is the emitted `.tsx` module. Error-severity
 * diagnostics abort the build (see {@link surfaceDiagnostics}).
 */
function transformSfc(
  code: string,
  id: string,
  rootDir: string,
  warn?: (message: string) => void,
): { code: string; map: object | null; css?: string } {
  const emitted = emitSfc(code, id, {
    name: componentName(id),
    fromDir: moduleDir(id),
    rootDir,
  });

  surfaceDiagnostics(id, emitted.diagnostics, warn);

  return emitted.css.length > 0
    ? { code: emitted.code, map: emitted.map, css: emitted.css }
    : { code: emitted.code, map: emitted.map };
}
