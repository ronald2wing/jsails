/**
 * `jsails i18n:missing` — report translation keys used in compiled page/API
 * modules but absent from every locale catalog (and, with `--unused`, the
 * inverse). Read-only, value-free (keys and file locations are reported, never
 * translation text), and exit-code gated for CI: exit 1 when keys are missing.
 *
 * ```sh
 * jsails i18n:missing [--config jsails.app.js] [--json] [--unused]
 * ```
 *
 * Only static string-literal keys are detectable; dynamic keys
 * (`t(someVar)`) are counted and surfaced as `dynamic`, never guessed. `scope`
 * options are folded into the resolved key. Bare `t`/`choice` are matched only
 * when imported from `jsails/i18n/server` (import-aware), so a `node:test`
 * `t` context is never mistaken for the i18n helper.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

import { AppConfigError, loadAppConfig, type ResolvedAppConfig } from '../app/config/index.js';
import { formatError, usageError as reportUsageError } from '../internal/errors.js';
import { createArrayLoader, createFileLoader, type Loader, type Messages } from '../i18n/loader.js';
import { extractTranslationKeys } from '../i18n/extract.js';
import { flattenMessageKeys } from '../i18n/flatten.js';

/** A single missing-key finding: the key plus every code site referencing it. */
export interface MissingKeyRef {
  readonly key: string;
  readonly refs: readonly { readonly file: string; readonly line: number }[];
}

/** The full result of the check. */
export interface I18nMissingResult {
  readonly missing: readonly MissingKeyRef[];
  readonly unused: readonly string[];
  /** Dynamic call sites that could not be statically scanned. */
  readonly dynamic: number;
  readonly scannedFiles: number;
  readonly locales: readonly string[];
}

/** CLI input to the command. Exported so tests can inject fakes. */
export interface I18nMissingInput {
  readonly configPath: string;
  readonly options: { readonly json?: boolean; readonly unused?: boolean };
}

/** Dependency seam for the command. */
export interface I18nMissingDeps {
  loadConfig(configPath: string): Promise<ResolvedAppConfig>;
  /** List compiled `.js`/`.mjs` files under a directory, recursively. */
  listFiles(dir: string): readonly string[];
  readFile(path: string): string;
  stdout(text: string): void;
  stderr(text: string): void;
}

const defaultDeps: I18nMissingDeps = {
  loadConfig: (configPath) => loadAppConfig(configPath),
  listFiles: listCompiledFiles,
  readFile: (path) => readFileSync(path, 'utf8'),
  stdout: (text) => process.stdout.write(`${text}\n`),
  stderr: (text) => process.stderr.write(`${text}\n`),
};

/** Recursively collect `.js`/`.mjs` files, skipping symlinks and dotfiles. */
function listCompiledFiles(dir: string): string[] {
  const results: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...listCompiledFiles(full));
    } else if (
      entry.isFile() &&
      (extname(entry.name) === '.js' || extname(entry.name) === '.mjs')
    ) {
      results.push(full);
    }
  }
  return results;
}

/** Build a loader from the resolved i18n config, or `undefined` when absent. */
function loaderFor(config: ResolvedAppConfig): Loader | undefined {
  const i18n = config.i18n;
  if (i18n === undefined) return undefined;
  if (i18n.loadPaths !== undefined) {
    return createFileLoader({ loadPaths: i18n.loadPaths });
  }
  if (i18n.catalogs !== undefined) {
    return createArrayLoader(i18n.catalogs as Readonly<Record<string, Messages>>);
  }
  return undefined;
}

/** The set of translation keys present in any locale's catalog. */
async function catalogKeys(loader: Loader): Promise<{ keys: Set<string>; locales: string[] }> {
  const locales = [...(await loader.availableLocales())].sort();
  const keys = new Set<string>();
  for (const locale of locales) {
    const catalog = await loader.load(locale);
    if (catalog !== undefined) {
      for (const key of flattenMessageKeys(catalog)) keys.add(key);
    }
  }
  return { keys, locales };
}

/** Run the check and return the result, throwing only for config-load failures. */
export async function runI18nMissing(
  input: I18nMissingInput,
  deps: I18nMissingDeps = defaultDeps,
): Promise<{ result: I18nMissingResult; exitCode: number }> {
  const config = await deps.loadConfig(input.configPath);

  const loader = loaderFor(config);
  if (loader === undefined) {
    deps.stderr(
      'jsails: i18n is not configured — declare `i18n` (with `loadPaths` or `catalogs`) in the app config',
    );
    return { result: emptyResult(), exitCode: 1 };
  }

  // Scan compiled page/API modules for translation keys. A missing directory
  // yields an empty list from `listFiles` (its readdir failure is swallowed),
  // so no existence guard is needed here.
  const scannedFiles: string[] = [];
  for (const dir of [config.pagesDir, config.apiDir]) {
    scannedFiles.push(...deps.listFiles(dir));
  }

  const keyRefs = new Map<string, { file: string; line: number }[]>();
  let dynamic = 0;
  for (const file of scannedFiles) {
    const source = deps.readFile(file);
    const extraction = extractTranslationKeys(source);
    dynamic += extraction.dynamic;
    const rel = relative(config.rootDir, file);
    for (const ref of extraction.refs) {
      const list = keyRefs.get(ref.key);
      if (list === undefined) {
        keyRefs.set(ref.key, [{ file: rel, line: ref.line }]);
      } else {
        list.push({ file: rel, line: ref.line });
      }
    }
  }

  const { keys: catalogKeySet, locales } = await catalogKeys(loader);

  // Missing: referenced in code, absent from every catalog.
  const missing: MissingKeyRef[] = [];
  for (const [key, refs] of [...keyRefs.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (!catalogKeySet.has(key)) {
      missing.push({ key, refs: Object.freeze(refs) });
    }
  }

  // Unused: present in a catalog, never referenced in code.
  const unused = [...catalogKeySet]
    .filter((key) => !keyRefs.has(key))
    .sort((a, b) => a.localeCompare(b));

  const result: I18nMissingResult = {
    missing: Object.freeze(missing),
    unused: Object.freeze(unused),
    dynamic,
    scannedFiles: scannedFiles.length,
    locales: Object.freeze(locales),
  };

  return { result, exitCode: missing.length > 0 ? 1 : 0 };
}

function emptyResult(): I18nMissingResult {
  return {
    missing: Object.freeze([]),
    unused: Object.freeze([]),
    dynamic: 0,
    scannedFiles: 0,
    locales: Object.freeze([]),
  };
}

/** Render the human-readable report. */
function renderHumanReadable(result: I18nMissingResult, showUnused: boolean): string[] {
  const lines: string[] = [];
  lines.push(
    `i18n: scanned ${result.scannedFiles} files across ${result.locales.length} locale(s)`,
  );

  if (result.missing.length === 0) {
    lines.push('Missing keys: none');
  } else {
    lines.push(`Missing keys (${result.missing.length}):`);
    for (const item of result.missing) {
      lines.push(`  ${item.key}`);
      for (const ref of item.refs) {
        lines.push(`    at ${ref.file}:${ref.line}`);
      }
    }
  }

  if (showUnused) {
    if (result.unused.length === 0) {
      lines.push('Unused keys: none');
    } else {
      lines.push(`Unused keys (${result.unused.length}):`);
      for (const key of result.unused) {
        lines.push(`  ${key}`);
      }
    }
  }

  if (result.dynamic > 0) {
    lines.push(`Dynamic call sites (unscanned): ${result.dynamic}`);
  }

  return lines;
}

/** Render usage text for `i18n:missing --help`. */
function i18nMissingHelp(): string {
  return `i18n:missing - report translation keys used in code but absent from catalogs

Usage:
  jsails i18n:missing [options]

Options:
  -c, --config <path>   Path to the app config module (default: jsails.app.js)
      --json            Emit a single JSON line instead of a summary
      --unused          Also report catalog keys never referenced in code
  -h, --help            Show this help

Read-only: never imports page/API modules, never opens a connection.
Only static string-literal keys are scanned; dynamic keys are counted, not guessed.
Exit code 1 when keys are missing (CI-gateable).
`;
}

/** Error types whose messages are safe to echo verbatim. */
function isEchoable(error: unknown): boolean {
  return error instanceof AppConfigError;
}

/**
 * Parse and run `jsails i18n:missing` from the raw arguments after the command
 * name. Owns its own argument parsing like `describe`, so it is routed before
 * the shared flag-gating.
 */
export async function runI18nMissingCommand(
  args: readonly string[],
  deps?: I18nMissingDeps,
): Promise<number> {
  let configPath = 'jsails.app.js';
  let json = false;
  let unused = false;
  let help = false;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index] as string;
    if (token === '--help' || token === '-h') {
      help = true;
    } else if (token === '--json') {
      json = true;
    } else if (token === '--unused') {
      unused = true;
    } else if (token === '--config') {
      const value = args[index + 1];
      if (value === undefined) {
        return reportUsageError(
          (line) => (deps?.stderr ?? defaultDeps.stderr)(line),
          'Run "jsails i18n:missing --help" for usage.',
          '--config requires a value',
        );
      }
      configPath = value;
      index += 1;
    } else if (token.startsWith('--config=')) {
      configPath = token.slice('--config='.length);
    } else if (token.startsWith('-')) {
      return reportUsageError(
        (line) => (deps?.stderr ?? defaultDeps.stderr)(line),
        'Run "jsails i18n:missing --help" for usage.',
        `unknown option ${JSON.stringify(token)}`,
      );
    } else {
      return reportUsageError(
        (line) => (deps?.stderr ?? defaultDeps.stderr)(line),
        'Run "jsails i18n:missing --help" for usage.',
        `unexpected argument: ${token}`,
      );
    }
  }

  if (help) {
    (deps?.stdout ?? defaultDeps.stdout)(i18nMissingHelp());
    return 0;
  }

  try {
    const { result, exitCode } = await runI18nMissing(
      { configPath, options: { json, unused } },
      deps,
    );
    if (json) {
      (deps?.stdout ?? defaultDeps.stdout)(JSON.stringify(result));
    } else {
      for (const line of renderHumanReadable(result, unused)) {
        (deps?.stdout ?? defaultDeps.stdout)(line);
      }
    }
    return exitCode;
  } catch (error) {
    (deps?.stderr ?? defaultDeps.stderr)(
      `jsails: ${formatError(error, { allow: isEchoable, fallback: 'i18n:missing failed' })}`,
    );
    return 1;
  }
}

// Re-exported for tests that need the path helpers.
export { listCompiledFiles };
