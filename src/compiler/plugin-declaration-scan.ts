/**
 * Inert discovery of per-plugin declarations (`jsails.plugin.json`).
 *
 * `build:meta` must fold every plugin's autoload surface — and the framework's
 * own curated surface — into the emitted ambient declarations, but it must not
 * import plugin code (a plugin's top-level side effects must never run at scan
 * time). This slice locates and parses the inert declaration files only — never
 * the plugin modules.
 *
 * **Where declarations live.** A first-party plugin (jsails/auth, admin, blog,
 * admin-plugin-manager, plugin-tools) is a subpath of the framework package, so
 * its declaration is colocated with its source: `src/<plugin>/jsails.plugin.json`
 * in-repo, `dist/src/<plugin>/jsails.plugin.json` against an installed framework.
 * The **framework core** ships its own declaration at the package root
 * (`jsails.plugin.json`), discoverable here alongside first-party plugins.
 * A third-party plugins.use plugin ships its declaration beside its entry. This
 * slice scans the framework package's own root, src, and dist/src directories,
 * plus a caller-supplied set of third-party declaration paths.
 *
 * The scan is pure: it reads and parses files, returns frozen data, and never
 * imports a module or opens a connection.
 */

import { existsSync, readFileSync, readdirSync, type Dirent } from 'node:fs';
import { join } from 'node:path';

import {
  PLUGIN_DECLARATION_FILENAME,
  parsePluginDeclaration,
  type PluginDeclaration,
} from '../plugins/declaration.js';
import { NONE_SYMBOL_DECLARATION, type SymbolDeclaration } from '../symbols/framework-symbols.js';

/** The framework-rooted directories that hold first-party plugin source. */
const FIRST_PARTY_SOURCE_DIR = 'src';
const FIRST_PARTY_DIST_DIR = join('dist', 'src');

/** Options for {@link scanPluginDeclarations}. */
export interface ScanPluginDeclarationsOptions {
  /** Absolute path to the framework package root. */
  readonly frameworkRootDir: string;
  /** Additional third-party declaration file paths (absolute). */
  readonly extra?: readonly string[];
}

/** A discovered declaration with its source location. */
export interface DiscoveredDeclaration {
  /** The plugin id. */
  readonly id: string;
  /** The parsed declaration. */
  readonly declaration: PluginDeclaration;
  /** Absolute path to the `jsails.plugin.json` it was read from. */
  readonly file: string;
}

/**
 * Discover and parse every first-party plugin declaration (and any extra
 * third-party declarations) inertly. Deterministic: sorted by plugin id.
 */
export function scanPluginDeclarations(
  options: ScanPluginDeclarationsOptions,
): readonly DiscoveredDeclaration[] {
  const found: DiscoveredDeclaration[] = [];

  // The framework core ships its declaration at the package root.
  collectFile(join(options.frameworkRootDir, PLUGIN_DECLARATION_FILENAME), found);

  const baseDir = existsSync(join(options.frameworkRootDir, FIRST_PARTY_SOURCE_DIR))
    ? FIRST_PARTY_SOURCE_DIR
    : FIRST_PARTY_DIST_DIR;

  collectFrom(join(options.frameworkRootDir, baseDir), found);

  for (const path of options.extra ?? []) {
    collectFile(path, found);
  }

  found.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return Object.freeze(found);
}

/**
 * Read the framework's own `jsails.plugin.json` and return its autoload surface
 * as a {@link SymbolDeclaration}. The result is the same curated set the build
 * derives from the scan — provided as a standalone synchronous read so tests
 * and other consumers can derive a framework-symbol catalog without importing
 * or scanning plugin code.
 *
 * Returns {@link NONE_SYMBOL_DECLARATION} when the declaration file is missing
 * or unreadable (the framework may not ship one, or the path may not contain a
 * framework package).
 */
export function loadFrameworkAutoloadDeclaration(frameworkRootDir: string): SymbolDeclaration {
  const scanned = scanPluginDeclarations({ frameworkRootDir });
  const frameworkDecl = scanned.find((d) => d.id === 'jsails');
  if (frameworkDecl === undefined || frameworkDecl.declaration.autoload === undefined) {
    return NONE_SYMBOL_DECLARATION;
  }
  const autoload = frameworkDecl.declaration.autoload;
  if (autoload.mode === 'none') {
    return NONE_SYMBOL_DECLARATION;
  }
  if (autoload.mode === 'all') {
    return Object.freeze({ mode: 'all' as const });
  }
  return Object.freeze({
    mode: 'selected' as const,
    specifiers: Object.freeze([...(autoload.specifiers ?? [])]),
  });
}

/** Walk one directory, collecting every `<dir>/<plugin>/jsails.plugin.json`. */
function collectFrom(dir: string, found: DiscoveredDeclaration[]): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // no framework source dir — nothing to declare.
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    collectFile(join(dir, entry.name, PLUGIN_DECLARATION_FILENAME), found);
  }
}

/** Parse one declaration file if it exists; a missing file is a silent no-op. */
function collectFile(path: string, found: DiscoveredDeclaration[]): void {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  const declaration = parsePluginDeclaration(JSON.parse(raw) as unknown);
  found.push(Object.freeze({ id: declaration.id, declaration, file: path }));
}
