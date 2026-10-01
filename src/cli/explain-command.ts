/**
 * Explain command: answer "which route handles this path, and what pipeline
 * stages would run?" — so an AI agent can understand request routing without
 * a browser or a live server.
 *
 * ```sh
 * jsails explain /blog/hello --json    # machine-readable JSON
 * jsails explain /blog/hello            # human-readable summary
 * jsails explain / --config jsails.app.js
 * ```
 *
 * Pure composition over `discoverRoutes` + `PIPELINE_STAGES`. Never imports
 * page/API modules and never opens a connection.
 */

import { AppConfigError, loadAppConfig, type ResolvedAppConfig } from '../app/config/index.js';
import { formatError, usageError as reportUsageError } from '../internal/errors.js';
import { PIPELINE_STAGES } from '../introspect/builtin-providers.js';
import { discoverRoutes, type RouteManifest, type RouteManifestEntry } from '../routing/routes.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** The JSON shape emitted by `--json`. */
export interface ExplainResult {
  readonly path: string;
  readonly matched: boolean;
  readonly route?: {
    readonly kind: 'page' | 'api';
    readonly route: string;
    readonly dynamic: boolean;
    readonly params: readonly string[];
    readonly layoutCount: number;
  };
  /** Resolved param values when matched (e.g. { slug: 'hello' }). */
  readonly paramValues?: Readonly<Record<string, string>>;
  /** The fixed pipeline stages that would run for this request. */
  readonly stages: readonly string[];
  /** True when the path is under the reserved `/_jsails` namespace. */
  readonly reserved: boolean;
}

/** CLI input to the explain command. Exported so tests can inject fakes. */
export interface ExplainInput {
  readonly configPath: string;
  readonly path: string;
  readonly json?: boolean;
}

/** Dependency seam for the explain command. */
export interface ExplainDeps {
  loadConfig(configPath: string): Promise<ResolvedAppConfig>;
  stdout(text: string): void;
  stderr(text: string): void;
}

// ---------------------------------------------------------------------------
// Path matching (pure, exported for tests)
// ---------------------------------------------------------------------------

/**
 * Match a concrete request path against the route manifest using the same
 * Hono-style segment rules as the runtime: static segments must match exactly,
 * `[name]` segments capture one non-empty segment. Segment counts must be
 * equal — catch-all routes do not exist because {@link discoverRoutes} rejects
 * them.
 *
 * Returns `undefined` when no route matches. Prefers the first match in
 * manifest order (deterministic; `discoverRoutes` is lexical).
 */
export function matchRoute(
  manifest: RouteManifest,
  path: string,
): { entry: RouteManifestEntry; paramValues: Record<string, string> } | undefined {
  // Normalize: strip query/hash, trailing slash (except root), ensure leading slash.
  let normalised = path;
  const queryIndex = normalised.indexOf('?');
  if (queryIndex !== -1) normalised = normalised.slice(0, queryIndex);
  const hashIndex = normalised.indexOf('#');
  if (hashIndex !== -1) normalised = normalised.slice(0, hashIndex);

  if (normalised.length > 1 && normalised.endsWith('/')) {
    normalised = normalised.slice(0, -1);
  }
  if (!normalised.startsWith('/')) {
    normalised = '/' + normalised;
  }
  if (normalised === '') normalised = '/';

  const pathSegments = normalised === '/' ? [] : normalised.slice(1).split('/');

  for (const entry of manifest.entries) {
    const routeSegments = entry.route === '/' ? [] : entry.route.slice(1).split('/');
    if (routeSegments.length !== pathSegments.length) continue;

    const paramValues: Record<string, string> = {};
    let matched = true;

    for (let index = 0; index < routeSegments.length; index++) {
      const routeSegment = routeSegments[index]!;
      const pathSegment = pathSegments[index]!;

      if (routeSegment.startsWith(':')) {
        // Dynamic segment: capture one non-empty path segment.
        const name = routeSegment.slice(1);
        if (pathSegment === '') {
          matched = false;
          break;
        }
        // decodeURIComponent; on malformed encoding, fall back to raw segment.
        let decoded = pathSegment;
        try {
          decoded = decodeURIComponent(pathSegment);
        } catch {
          // Malformed percent encoding — use raw segment as-is.
        }
        paramValues[name] = decoded;
      } else if (routeSegment !== pathSegment) {
        matched = false;
        break;
      }
    }

    if (matched) {
      return { entry, paramValues };
    }
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Reserved namespace
// ---------------------------------------------------------------------------

/** Framework-owned path prefix that is never in the filesystem manifest. */
const RESERVED_PREFIX = '/_jsails';

// ---------------------------------------------------------------------------
// runExplain
// ---------------------------------------------------------------------------

const defaultExplainDeps: ExplainDeps = {
  loadConfig: (configPath) => loadAppConfig(configPath),
  stdout: (text) => process.stdout.write(`${text}\n`),
  stderr: (text) => process.stderr.write(`${text}\n`),
};

/** Error types whose messages are safe to echo verbatim. */
function isEchoable(error: unknown): boolean {
  return error instanceof AppConfigError;
}

/**
 * Load config, discover routes, match the path, and print the result.
 * Returns 0 on success, 1 on failure.
 */
export async function runExplain(
  input: ExplainInput,
  deps: ExplainDeps = defaultExplainDeps,
): Promise<number> {
  let config: ResolvedAppConfig;
  try {
    config = await deps.loadConfig(input.configPath);
  } catch (error) {
    deps.stderr(
      `jsails: ${formatError(error, { allow: isEchoable, fallback: 'failed to load config' })}`,
    );
    return 1;
  }

  let manifest: RouteManifest;
  try {
    manifest = discoverRoutes(config.rootDir, {
      pagesDir: config.pagesDir,
      apiDir: config.apiDir,
    });
  } catch (error) {
    deps.stderr(
      `jsails: ${formatError(error, { allow: isEchoable, fallback: 'route discovery failed' })}`,
    );
    return 1;
  }

  const isReserved = input.path.startsWith(RESERVED_PREFIX);

  let matchedEntry: RouteManifestEntry | undefined;
  let paramValues: Record<string, string> | undefined;

  // Framework-owned paths are never in the filesystem manifest.
  if (!isReserved) {
    const match = matchRoute(manifest, input.path);
    if (match) {
      matchedEntry = match.entry;
      paramValues = match.paramValues;
    }
  }

  const result: ExplainResult = {
    path: input.path,
    matched: matchedEntry !== undefined,
    ...(matchedEntry
      ? {
          route: {
            kind: matchedEntry.kind,
            route: matchedEntry.route,
            dynamic: matchedEntry.dynamic,
            params: matchedEntry.params,
            layoutCount: matchedEntry.layouts?.length ?? 0,
          },
          paramValues,
        }
      : {}),
    stages: PIPELINE_STAGES,
    reserved: isReserved,
  };

  if (input.json === true) {
    deps.stdout(JSON.stringify(result));
  } else {
    for (const line of renderHumanReadable(result)) {
      deps.stdout(line);
    }
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Human-readable output
// ---------------------------------------------------------------------------

function renderHumanReadable(result: ExplainResult): string[] {
  const lines: string[] = [];

  lines.push(`Path:      ${result.path}`);
  lines.push(`Matched:   ${result.matched ? 'yes' : 'no'}`);
  lines.push(`Reserved:  ${result.reserved ? 'yes (/ _jsails namespace)' : 'no'}`);
  lines.push('');

  if (result.route) {
    lines.push('Route');
    lines.push('-----');
    lines.push(`  pattern:      ${result.route.route}`);
    lines.push(`  kind:         ${result.route.kind}`);
    lines.push(`  dynamic:      ${result.route.dynamic ? 'yes' : 'no'}`);
    if (result.route.params.length > 0) {
      lines.push(`  params:       ${result.route.params.join(', ')}`);
    }
    lines.push(`  layouts:      ${result.route.layoutCount}`);
    if (result.paramValues && Object.keys(result.paramValues).length > 0) {
      lines.push(`  param values:`);
      for (const [key, value] of Object.entries(result.paramValues)) {
        lines.push(`    ${key} = ${value}`);
      }
    }
    lines.push('');
  }

  lines.push('Pipeline stages (in order)');
  lines.push('-----------------------');
  for (let index = 0; index < result.stages.length; index++) {
    lines.push(`  ${index + 1}. ${result.stages[index]}`);
  }

  return lines;
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

/** Render usage text for `explain --help`. */
function explainHelp(): string {
  return `explain - resolve which route handles a path and show its pipeline stages

Usage:
  jsails explain <path> [options]

Arguments:
  <path>                  The request path to explain (required)

Options:
  -c, --config <path>     Path to the app config module (default: jsails.app.js)
      --json              Emit a single JSON line instead of a summary
  -h, --help              Show this help

Read-only: never imports page/API modules, never opens a connection.

The result shows whether the path matches a route, any resolved parameter
values, and the fixed pipeline stages that would run for that request.
Framework-owned paths under /_jsails are reported as reserved and never
matched against the manifest.
`;
}

/**
 * Parse and run `jsails explain` from the raw arguments after the command name.
 * Owns its own argument parsing, so it is routed before the shared `parseArgs`
 * flag-gating in `cli.ts`.
 */
export async function runExplainCommand(
  args: readonly string[],
  deps?: ExplainDeps,
): Promise<number> {
  let configPath = 'jsails.app.js';
  let json = false;
  let help = false;
  let inputPath: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index] as string;
    if (token === '--help' || token === '-h') {
      help = true;
    } else if (token === '--json') {
      json = true;
    } else if (token === '--config') {
      const value = args[index + 1];
      if (value === undefined) {
        return reportUsageError(
          (line) => (deps?.stderr ?? defaultExplainDeps.stderr)(line),
          'Run "jsails explain --help" for usage.',
          '--config requires a value',
        );
      }
      configPath = value;
      index += 1;
    } else if (token.startsWith('--config=')) {
      configPath = token.slice('--config='.length);
    } else if (token.startsWith('-')) {
      return reportUsageError(
        (line) => (deps?.stderr ?? defaultExplainDeps.stderr)(line),
        'Run "jsails explain --help" for usage.',
        `unknown option ${JSON.stringify(token)}`,
      );
    } else if (inputPath === undefined) {
      inputPath = token;
    } else {
      return reportUsageError(
        (line) => (deps?.stderr ?? defaultExplainDeps.stderr)(line),
        'Run "jsails explain --help" for usage.',
        'explain takes exactly one path argument',
      );
    }
  }

  if (help) {
    (deps?.stdout ?? defaultExplainDeps.stdout)(explainHelp());
    return 0;
  }

  if (inputPath === undefined || inputPath === '') {
    return reportUsageError(
      (line) => (deps?.stderr ?? defaultExplainDeps.stderr)(line),
      'Run "jsails explain --help" for usage.',
      'a path argument is required',
    );
  }

  return runExplain({ configPath, path: inputPath, json }, deps);
}
