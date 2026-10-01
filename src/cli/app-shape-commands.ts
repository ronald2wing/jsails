/**
 * App:shape command: a read-only transition report that, for a given target
 * `shape`, lists which enabled plugins are `needsLive` (and therefore would be
 * excluded under `static`).
 *
 * ```sh
 * jsails app:shape static --json      # machine-readable JSON
 * jsails app:shape static              # human-readable summary
 * jsails app:shape full --config jsails.app.js
 * ```
 *
 * Pure composition over the resolved app config + plugins' pure `describe()`.
 * Never imports page/API modules, never opens a connection, and never runs setup.
 */

import { loadAppConfig, type ResolvedAppConfig } from '../app/config/index.js';
import { formatError, usageError as reportUsageError } from '../internal/errors.js';
import { resolvePluginEnablement } from '../plugins/enablement.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** The three deployment shapes. */
export type AppShape = 'static' | 'full' | 'cli';

/** The JSON shape emitted by `--json`. */
export interface AppShapeResult {
  /** The target shape the report was requested for. */
  readonly target: AppShape;
  /**
   * The currently-active shape from the resolved config (defaults to `'full'`).
   * Informational — the report is always computed from the resolved extensions
   * list, not gated by the current shape.
   */
  readonly current: AppShape;
  /** Plugins that declare `needsLive: true` (would be excluded under `static`). */
  readonly liveOnly: readonly string[];
  /** Total enabled plugin count. */
  readonly enabledCount: number;
  /** Count of live-only plugins. */
  readonly liveOnlyCount: number;
  /**
   * Under a `static` target, how many of the currently-enabled plugins would be
   * dropped. `null` when the target is `full` or `cli` (no filtering).
   */
  readonly wouldDrop: number | null;
}

/** CLI input to the app:shape command. Exported so tests can inject fakes. */
export interface AppShapeInput {
  readonly shape: AppShape;
  readonly configPath: string;
  readonly json?: boolean;
}

/** Dependency seam for the app:shape command. */
export interface AppShapeDeps {
  /** Load and resolve the app config. */
  loadConfig(configPath: string): Promise<ResolvedAppConfig>;
  stdout(text: string): void;
  stderr(text: string): void;
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

const defaultAppShapeDeps: AppShapeDeps = {
  loadConfig: (configPath) => loadAppConfig(configPath),
  stdout: (text) => process.stdout.write(`${text}\n`),
  stderr: (text) => process.stderr.write(`${text}\n`),
};

/**
 * Read a plugin's `needsLive` declaration from its side-effect-free
 * `describe()`. `needsLive: true` → live-only; anything else (no descriptor,
 * absent flag, or a throwing `describe()`) → `false` (fail-closed: a
 * misbehaving plugin is not reported as live-only when absent).
 */
function isLiveOnly(plugin: { describe?: () => { needsLive?: boolean } }): boolean {
  try {
    return plugin.describe?.().needsLive === true;
  } catch {
    return false;
  }
}

/**
 * Collect the live-only plugin ids from the resolved config's extensions.
 *
 * We resolve the enabled plugin set the same way `buildDescribeResult` does:
 * from `config.plugins.enabled` (the code list). For the `needsLive` check we
 * iterate all extensions in the config (both `config.extensions` and the
 * resolved `plugins.use` list which `loadAppConfig` does not resolve — it only
 * carries the raw specifier entries). The `describe()` check is run against
 * every extension that has a `describe`, which covers first-party plugins
 * (auth, jobs, broadcast, server-components) plus any plugin manually added
 * as an extension.
 *
 * Fallback for `plugins.use`: `loadAppConfig` does NOT resolve `plugins.use`
 * specifiers (that's done in `createApplication`). For a command that only
 * loads the config, we cannot call `describe()` on a specifier string. So we
 * fall back to checking only what is in `config.extensions`. In practice the
 * four live-only plugins (auth, jobs, broadcast, server-components) appear
 * either as resolved extensions or via `plugins.use` entries in the starter.
 *
 * The describe command likewise operates purely from `config.extensions`
 * (see collectComponents / collectPluginCommands), so this is consistent.
 */
function collectLiveOnlyPlugins(config: ResolvedAppConfig): readonly string[] {
  const liveOnly: string[] = [];
  for (const extension of config.extensions) {
    // `JsailsExtension` (config.extensions) does not statically declare
    // `describe`, but a plugin-shaped extension does; narrow structurally so the
    // live check reads the descriptor with no runtime import.
    const plugin = extension as { name?: unknown; describe?: () => { needsLive?: boolean } };
    if (isLiveOnly(plugin) && typeof plugin.name === 'string' && plugin.name.trim() !== '') {
      liveOnly.push(plugin.name.trim());
    }
  }
  return Object.freeze([...liveOnly]);
}

/**
 * Build the transition report for a target shape.
 */
export async function runAppShape(
  input: AppShapeInput,
  deps: AppShapeDeps = defaultAppShapeDeps,
): Promise<number> {
  let config: ResolvedAppConfig;
  try {
    config = await deps.loadConfig(input.configPath);
  } catch (error) {
    deps.stderr(
      `jsails: ${formatError(error, { allow: () => false, fallback: 'failed to load config' })}`,
    );
    return 1;
  }

  const currentShape: AppShape = config.shape ?? 'full';

  // Enabled plugin ids from the code-enabled list (same as describe).
  const pluginEnablement = resolvePluginEnablement({
    codeEnabled: config.plugins?.enabled,
  });
  const enabledIds = pluginEnablement.enabled;

  // Live-only plugins collected from extensions with describe().
  const liveOnly = collectLiveOnlyPlugins(config);

  // Intersect: only plugins that are both enabled AND live-only.
  const liveOnlySet = new Set(liveOnly);
  const enabledLiveOnly = enabledIds.filter((id) => liveOnlySet.has(id));

  const result: AppShapeResult = {
    target: input.shape,
    current: currentShape,
    liveOnly: enabledLiveOnly,
    enabledCount: enabledIds.length,
    liveOnlyCount: enabledLiveOnly.length,
    wouldDrop: input.shape === 'static' ? enabledLiveOnly.length : null,
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

function renderHumanReadable(result: AppShapeResult): string[] {
  const lines: string[] = [];

  lines.push(`Shape: ${result.target} (requested) / ${result.current} (current)`);
  lines.push(`Plugins`);
  lines.push(`-------`);
  lines.push(`  enabled:   ${result.enabledCount}`);
  lines.push(`  live-only: ${result.liveOnlyCount}`);

  if (result.liveOnly.length === 0) {
    lines.push(`  (none)`);
  } else {
    for (const id of result.liveOnly) {
      lines.push(`  ${id}`);
    }
  }
  lines.push('');

  if (result.wouldDrop !== null) {
    if (result.wouldDrop === 0) {
      lines.push(`Changing to ${result.target}: no plugins would be dropped.`);
    } else {
      lines.push(`Changing to ${result.target}: ${result.wouldDrop} plugin(s) would be dropped:`);
      for (const id of result.liveOnly) {
        lines.push(`  ${id}`);
      }
    }
  } else {
    lines.push(`No live-only filtering for ${result.target} shape.`);
  }

  return lines;
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

/** Valid shape values for the command argument. */
const VALID_SHAPES = new Set<string>(['static', 'full', 'cli']);

/** Render usage text for `app:shape --help`. */
function appShapeHelp(): string {
  return `app:shape - report which plugins are live-only and would be excluded under a static shape

Usage:
  jsails app:shape <static|full|cli> [options]

Arguments:
  <shape>                 The target shape to report against (static, full, cli)

Options:
  -c, --config <path>     Path to the app config module (default: jsails.app.js)
      --json              Emit a single JSON line instead of a summary
  -h, --help              Show this help

Read-only: never imports page/API modules, never opens a connection.

The report lists which of the currently-enabled plugins declare \`needsLive: true\`
(and would therefore be excluded under a static shape). For \`full\` and \`cli\`
targets the would-drop count is null (no live-only filtering applies).
`;
}

/**
 * Parse and run `jsails app:shape` from raw arguments after the command name.
 * Owns its own argument parsing, so it is routed before shared flag-gating.
 */
export async function runAppShapeCommand(
  args: readonly string[],
  deps?: AppShapeDeps,
): Promise<number> {
  let configPath = 'jsails.app.js';
  let json = false;
  let help = false;
  let shape: AppShape | undefined;

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
          (line) => (deps?.stderr ?? defaultAppShapeDeps.stderr)(line),
          'Run "jsails app:shape --help" for usage.',
          '--config requires a value',
        );
      }
      configPath = value;
      index += 1;
    } else if (token.startsWith('--config=')) {
      configPath = token.slice('--config='.length);
    } else if (token.startsWith('-')) {
      return reportUsageError(
        (line) => (deps?.stderr ?? defaultAppShapeDeps.stderr)(line),
        'Run "jsails app:shape --help" for usage.',
        `unknown option ${JSON.stringify(token)}`,
      );
    } else if (shape === undefined) {
      if (VALID_SHAPES.has(token)) {
        shape = token as AppShape;
      } else {
        return reportUsageError(
          (line) => (deps?.stderr ?? defaultAppShapeDeps.stderr)(line),
          'Run "jsails app:shape --help" for usage.',
          `invalid shape ${JSON.stringify(token)}; must be static, full, or cli`,
        );
      }
    } else {
      return reportUsageError(
        (line) => (deps?.stderr ?? defaultAppShapeDeps.stderr)(line),
        'Run "jsails app:shape --help" for usage.',
        'app:shape takes exactly one shape argument',
      );
    }
  }

  if (help) {
    (deps?.stdout ?? defaultAppShapeDeps.stdout)(appShapeHelp());
    return 0;
  }

  if (shape === undefined) {
    return reportUsageError(
      (line) => (deps?.stderr ?? defaultAppShapeDeps.stderr)(line),
      'Run "jsails app:shape --help" for usage.',
      'a shape argument is required (static, full, or cli)',
    );
  }

  return runAppShape({ shape, configPath, json }, deps);
}
