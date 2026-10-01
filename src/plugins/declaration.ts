/**
 * Plugin declaration contract: the inert per-plugin framework-citizen surface.
 *
 * `jsails.plugin.json` is the `module.xml` analog — the *declaration* file that
 * states what a plugin is to the framework, distinct from `package.json` (npm
 * packaging) and `manifest.json` (marketplace install/verify). It is the single
 * inert source the *compiler* reads at `build:meta` and the runtime reads at
 * assembly, so plugin bare names type-check and project without importing plugin
 * code.
 *
 * The declared facts are the *static* half of a plugin's surface: identity, the
 * autoload opt-in, the name→specifier resolution registry, the public subpath
 * inventory (`provides`), and declared plugin-to-plugin dependencies. Runtime-only
 * facts (constructed components/interceptors that need the module to run) stay on
 * `describe()` — never here.
 *
 * JSON (not JS/TS) so the file is inert by construction: `build:meta` parses it
 * without executing plugin code. `parsePluginDeclaration` is value-free, mirroring
 * {@link parsePluginManifest}.
 */

import { z } from 'zod';

import { mapZodIssues, type ZodIssueEntry } from '../internal/zod.js';
import type { AutoloadDeclaration } from '../symbols/framework-symbols.js';
import { PLUGIN_ID_PATTERN } from './manifest/schema.js';

/** The per-plugin declaration filename, beside the plugin's own source. */
export const PLUGIN_DECLARATION_FILENAME = 'jsails.plugin.json';

/** Upper bound on the declared public subpath inventory. */
const MAX_PROVIDES = 100;
/** Upper bound on the resolution registry. */
const MAX_SYMBOLS = 100;
/** Upper bound on declared dependencies. */
const MAX_DEPENDENCIES = 100;
/** Upper bound on an id. */
const MAX_ID_LENGTH = 214;

/**
 * One entry of the `symbols` resolution registry: a bare name the plugin
 * resolves from the named public subpath.
 */
export interface PluginSymbol {
  /** The bare identifier a consumer writes (no import). */
  readonly name: string;
  /** The public subpath the name resolves from, e.g. `jsails/auth`. */
  readonly specifier: string;
}

/** A declared plugin-to-plugin dependency id. */
export interface PluginDeclarationDependency {
  /** Required plugin id matching {@link PLUGIN_ID_PATTERN}. */
  readonly id: string;
}

/** A validated plugin declaration. */
export interface PluginDeclaration {
  /** Unique plugin id matching {@link PLUGIN_ID_PATTERN}. */
  readonly id: string;
  /** Public subpaths this plugin provides (the `autoload: all` inventory). */
  readonly provides: readonly string[];
  /** Autoload declaration (default `none`): which surface becomes bare. */
  readonly autoload?: AutoloadDeclaration;
  /** Name→specifier resolution registry. Defaults to `[]`. */
  readonly symbols?: readonly PluginSymbol[];
  /** Declared plugin-to-plugin dependencies. Defaults to `[]`. */
  readonly plugins?: readonly PluginDeclarationDependency[];
}

/** A value-free declaration validation failure. */
export interface PluginDeclarationIssue {
  readonly path: readonly (string | number)[];
  readonly code: string;
  readonly message: string;
}

/** Raised when a declaration fails shape validation. */
export class PluginDeclarationError extends Error {
  readonly issues: readonly PluginDeclarationIssue[];

  constructor(issues: readonly PluginDeclarationIssue[]) {
    super(issues.map(formatIssue).join('; '));
    this.name = 'PluginDeclarationError';
    this.issues = issues;
  }
}

function formatIssue(issue: PluginDeclarationIssue): string {
  const location = issue.path.length > 0 ? issue.path.join('.') : '(declaration)';
  return `${location}: ${issue.message}`;
}

const autoloadDeclarationSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('none') }).strict(),
  z.object({ mode: z.literal('all') }).strict(),
  z
    .object({
      mode: z.literal('selected'),
      plugins: z
        .array(z.string().min(1).max(MAX_ID_LENGTH).regex(PLUGIN_ID_PATTERN))
        .max(MAX_DEPENDENCIES)
        .optional(),
      specifiers: z.array(z.string().min(1)).max(MAX_PROVIDES).optional(),
    })
    .strict(),
]);

/** The declaration schema: id, inventory, autoload, resolution registry, deps. */
const pluginDeclarationSchema = z
  .object({
    id: z.string().min(1).max(MAX_ID_LENGTH).regex(PLUGIN_ID_PATTERN),
    provides: z.array(z.string().min(1)).max(MAX_PROVIDES).default([]),
    autoload: autoloadDeclarationSchema.optional(),
    symbols: z
      .array(z.object({ name: z.string().min(1), specifier: z.string().min(1) }).strict())
      .max(MAX_SYMBOLS)
      .optional(),
    plugins: z
      .array(
        z.object({ id: z.string().min(1).max(MAX_ID_LENGTH).regex(PLUGIN_ID_PATTERN) }).strict(),
      )
      .max(MAX_DEPENDENCIES)
      .optional(),
  })
  .strict();

function mapDeclarationIssues(error: z.ZodError): PluginDeclarationIssue[] {
  return mapZodIssues(error).map((entry: ZodIssueEntry): PluginDeclarationIssue => {
    const path = entry.path === '_root' ? [] : splitDottedPath(entry.path);
    return { path, code: entry.code, message: entry.message };
  });
}

/** Split `"symbols.0.name"` into `["symbols", 0, "name"]`. */
function splitDottedPath(dotted: string): readonly (string | number)[] {
  return dotted.split('.').map((seg) => {
    const n = Number(seg);
    return String(n) === seg && seg !== '' ? n : seg;
  });
}

/**
 * Validate and parse a raw declaration value. Throws {@link PluginDeclarationError}
 * with value-free issues; the raw input is never echoed or mutated.
 */
export function parsePluginDeclaration(raw: unknown): PluginDeclaration {
  const result = pluginDeclarationSchema.safeParse(raw);
  if (!result.success) {
    throw new PluginDeclarationError(mapDeclarationIssues(result.error));
  }
  return result.data;
}
