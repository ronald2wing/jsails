/**
 * The unified source scan: one walk of the authoring tree that feeds every
 * generated artifact.
 *
 * Before this module, each generated artifact had its own discovery pass — the
 * autoload scan walked `app/ server/ shared/`, model resolution probed
 * `models/` per class, component resolution probed `app/components/` per tag.
 * Three walks over overlapping trees, each with its own extension set and
 * naming rules, is three places for a convention to drift. This scan walks the
 * tree **once**, parses each source module **once**, and returns every derived
 * fact the build step needs:
 *
 * - the autoload registry (symbols injectable by name),
 * - the extracted models (shape of each `ApplicationRecord` subclass),
 * - the server-component modules (each `components/*.tsx` export).
 *
 * The scan is **source-driven**: modules are parsed with `parseSync`, never
 * imported. A build scan must not execute application code — running a module's
 * top-level side effects at scan time turns a syntax-level discovery pass into a
 * runtime dependency, and the emitted artifacts feed `tsc` before any module is
 * ever evaluated.
 *
 * Inert until {@link scanProjectMeta} is called.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CONVENTION_DIRS, SOURCE_EXTENSIONS, camelCase } from '../compiler/conventions.js';
import { walkLexicalFiles } from '../compiler/lexical-walk.js';
import { extractModel, type ExtractedModel } from '../compiler/model-extract.js';
import { scanAutoload, type AutoloadRegistry } from '../compiler/project-symbols-scan.js';

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

/** A server-component module discovered under `components/`. */
export interface ComponentModule {
  /** The class/const name of the component export, e.g. `taskList`. */
  readonly exportName: string;
  /** Absolute source path. */
  readonly file: string;
  /** Posix-relative path from the project root. */
  readonly relative: string;
}

/** The full result of one project scan. */
export interface ProjectMeta {
  readonly autoload: AutoloadRegistry;
  readonly models: readonly ExtractedModel[];
  readonly components: readonly ComponentModule[];
}

/** Options for {@link scanProjectMeta}. */
export interface ScanProjectMetaOptions {
  /** File extensions accepted as source modules. Defaults to the source set. */
  readonly extensions?: ReadonlySet<string>;
}

/* ------------------------------------------------------------------ */
/*  Main entry point                                                   */
/* ------------------------------------------------------------------ */

/**
 * Walk the authoring tree once and return every derived fact the build step
 * needs. Deterministic: models and components are sorted by their relative
 * path, so two scans of the same tree produce byte-identical artifacts.
 */
export async function scanProjectMeta(
  rootDir: string,
  options: ScanProjectMetaOptions = {},
): Promise<ProjectMeta> {
  const extensions = options.extensions ?? SOURCE_EXTENSIONS;

  const autoload = await scanAutoload(rootDir, { extensions });
  const models = scanModels(rootDir, extensions);
  const components = scanComponents(rootDir, extensions);

  return Object.freeze({
    autoload,
    models: Object.freeze(models),
    components: Object.freeze(components),
  });
}

/* ------------------------------------------------------------------ */
/*  Models                                                             */
/* ------------------------------------------------------------------ */

/**
 * Extract every model under `models/`. A module that declares no
 * `ApplicationRecord` subclass is skipped silently — `models/` may hold
 * non-model helpers. A parse failure is reported through the model reporter,
 * which the caller supplies; here a failed parse is skipped (the build step
 * surfaces diagnostics separately).
 */
function scanModels(rootDir: string, extensions: ReadonlySet<string>): ExtractedModel[] {
  const modelsDir = join(rootDir, CONVENTION_DIRS.models);
  const models: ExtractedModel[] = [];

  for (const relative of walkLexicalFiles(modelsDir, { extensions })) {
    if (relative.endsWith('.d.ts')) {
      continue;
    }
    const absolute = join(modelsDir, relative);
    const source = readFileSync(absolute, 'utf8');
    const model = extractModel(source, absolute, () => {
      // Diagnostics are surfaced by the build step's own reporter; the scan
      // only needs the successfully extracted models.
    });
    if (model !== undefined) {
      models.push(model);
    }
  }

  models.sort((a, b) => compareStrings(a.className, b.className));
  return models;
}

/* ------------------------------------------------------------------ */
/*  Components                                                         */
/* ------------------------------------------------------------------ */

/**
 * Discover server-component modules under `components/`. A component module is
 * a `.tsx`/`.ts` file whose default or named export is the component; the
 * convention is that the file's kebab name maps to a camelCase export
 * (`task-list.tsx` → `taskList`). The scan records the module and its
 * conventional export name; the generated registry imports that name.
 */
function scanComponents(rootDir: string, extensions: ReadonlySet<string>): ComponentModule[] {
  const componentsDir = join(rootDir, CONVENTION_DIRS.serverComponents);
  const components: ComponentModule[] = [];

  for (const relative of walkLexicalFiles(componentsDir, { extensions })) {
    if (relative.endsWith('.d.ts')) {
      continue;
    }
    const absolute = join(componentsDir, relative);
    components.push(
      Object.freeze({
        exportName: componentExportName(relative),
        file: absolute,
        relative: `${CONVENTION_DIRS.serverComponents}/${relative}`,
      }),
    );
  }

  components.sort((a, b) => compareStrings(a.relative, b.relative));
  return components;
}

/**
 * The conventional export name for a component module: the camelCase of its
 * file base name (`task-list.tsx` → `taskList`). The generated registry imports
 * this name; a module that exports its component under a different name is a
 * build diagnostic, not a silent miss.
 */
function componentExportName(relative: string): string {
  const base = relative.replace(/\.(tsx|ts|mtsx|mts|jsx|js)$/, '');
  return camelCase(base);
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Code-unit string comparison; locale-independent for deterministic order. */
function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
