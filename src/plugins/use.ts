/**
 * Declarative plugin resolver: turn `plugins.use` entries into constructed
 * `JsailsPlugin` objects. This is the third slice of the declarative boot
 * pipeline — it imports module specifiers and invokes their default-export
 * factories, but never runs `setup` (the extension runner does that later).
 *
 * First-party subpaths export factories (`authPlugin(options)`, etc.), so the
 * primary convention is that a module's default export is a factory function.
 * A module whose default export is already a `JsailsPlugin` object is accepted
 * as-is for forward-compatibility.
 *
 * This module is pure: it only imports module code. It never opens a
 * connection, reads the filesystem, or calls `setup`.
 */

import type { JsailsPlugin } from '../extensions/plugin-contract.js';
import type { PluginUseEntry } from '../app/config/schema.js';
import type { PluginIssue } from './discovery.js';

/** Input to {@link resolvePluginUse}. */
export interface ResolvePluginUseInput {
  /** Declarative plugin entries from the app config. */
  readonly entries: readonly PluginUseEntry[];
}

/** The result of resolving declarative plugin entries. */
export interface ResolvePluginUseResult {
  /** Constructed plugins, in the same order as the entries. One bad entry never aborts the rest. */
  readonly plugins: readonly JsailsPlugin[];
  /** Value-free issues for entries that failed to import, had an invalid export, or threw. */
  readonly issues: readonly PluginIssue[];
}

/**
 * Resolve `plugins.use` entries into constructed `JsailsPlugin` objects.
 *
 * Per entry:
 * 1. Normalize: a string becomes `[specifier, {}]`; a tuple stays as-is.
 * 2. `await import(specifier)` — the specifier is imported directly, so it
 *    must be a bare package name or a `file://` URL resolvable by Node.
 * 3. If the module's default export is already a `JsailsPlugin` (object with
 *    a non-empty `name` and a `setup` function), accept it as-is.
 * 4. Otherwise, the default export must be a function (the factory). Call it
 *    with `options` and await the result. The result must be a `JsailsPlugin`.
 * 5. On any failure — import error, missing/invalid default export, factory
 *    throw, or invalid result — push a value-free `PluginIssue` and continue.
 *    One bad entry never aborts the rest.
 * 6. Preserve entry order in `plugins` — the caller decides ordering.
 */
export async function resolvePluginUse(
  input: ResolvePluginUseInput,
): Promise<ResolvePluginUseResult> {
  const plugins: JsailsPlugin[] = [];
  const issues: PluginIssue[] = [];

  for (const entry of input.entries) {
    const [specifier, options] = normalizeUseEntry(entry);

    let namespace: unknown;
    try {
      namespace = await import(specifier);
    } catch {
      issues.push(useLoadFailure(specifier));
      continue;
    }

    const plugin = await extractPluginFromUse(namespace, specifier, options);
    if (plugin === undefined) {
      issues.push(useLoadFailure(specifier));
      continue;
    }
    plugins.push(plugin);
  }

  return Object.freeze({
    plugins: Object.freeze([...plugins]),
    issues: Object.freeze([...issues]),
  });
}

// ---------------------------------------------------------------------------
// Exported helpers — pure logic, not `import()`, for direct unit testing
// ---------------------------------------------------------------------------

/**
 * Normalize a `PluginUseEntry` into a `[specifier, options]` tuple.
 * A bare string gets an empty options object; a tuple is returned as-is.
 */
export function normalizeUseEntry(
  entry: PluginUseEntry,
): readonly [string, Readonly<Record<string, unknown>>] {
  if (typeof entry === 'string') {
    return [entry, Object.freeze({})];
  }
  return entry;
}

/**
 * Extract a `JsailsPlugin` from an imported module namespace.
 *
 * The module's default export is checked first:
 * - If it is already a `JsailsPlugin` object (non-empty string `name` and
 *   a `setup` function), it is returned as-is (forward-compat for modules that
 *   export a ready plugin instead of a factory).
 * - Otherwise it must be a factory function. The factory is called with
 *   `options`, the result is awaited, and it must be a valid `JsailsPlugin`.
 *
 * Returns `undefined` when the default export is missing, not a
 * function/plugin, the factory throws, or the factory returns an invalid value.
 */
export async function extractPluginFromUse(
  namespace: unknown,
  _specifier: string, // diagnostic only; never echoed in errors
  options: Readonly<Record<string, unknown>>,
): Promise<JsailsPlugin | undefined> {
  if (namespace === null || typeof namespace !== 'object') {
    return undefined;
  }
  const record = namespace as Record<string, unknown>;
  const defaultExport = record['default'];

  // Forward-compat: the default export is already a plugin object.
  if (isPluginObject(defaultExport)) {
    return defaultExport;
  }

  // Primary convention: the default export is a factory function.
  if (typeof defaultExport !== 'function') {
    return undefined;
  }

  let constructed: unknown;
  try {
    constructed = (defaultExport as (opts: Record<string, unknown>) => unknown)(options);
  } catch {
    return undefined; // factory threw — value-free
  }

  // Await in case the factory is async.
  if (constructed instanceof Promise) {
    try {
      constructed = await constructed;
    } catch {
      return undefined; // async factory rejected — value-free
    }
  }

  if (!isPluginObject(constructed)) {
    return undefined; // factory returned invalid value
  }

  return constructed;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Structural check: an object with a non-empty string `name` and a function `setup`. */
function isPluginObject(value: unknown): value is JsailsPlugin {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record['name'] === 'string' &&
    record['name'].trim() !== '' &&
    typeof record['setup'] === 'function'
  );
}

/**
 * Build a value-free `plugin_load_failed` issue for a declarative `use` entry.
 * The specifier is echoed in the message (it is a config value the developer
 * wrote, not a secret); no module contents, option values, or error messages
 * are included.
 */
function useLoadFailure(specifier: string): PluginIssue {
  return {
    source: 'package',
    code: 'plugin_load_failed',
    message: `plugin "${specifier}" failed to load`,
    path: specifier,
  };
}
