/**
 * Jamal planning: `dev`/`harden` dry-run + `--write`, the static/custom
 * `deploy --target` file generation, and the `targets` listing.
 *
 * This is the command's shared core: it also owns the command dependency seam
 * (`JamalDeps`/`defaultJamalDeps`), the `JamalError` type, and the small
 * output/usage helpers the execution verbs (see `exec.ts`) reuse. `dev` and
 * `harden` plan by default and write nothing unless `--write` is set; a static
 * or custom `deploy --target` only generates files and always requires
 * `--write`. The kamal engine (`deploy --target kamal` and `rollback`) lives in
 * `exec.ts` and never reaches this module. No path here spawns a process, runs
 * Docker, kamal, a static host, or a deployment.
 */

import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { DEFAULT_APP_CONFIG_PATH, loadAppConfig } from '../app/config/index.js';
import { BUILTIN_DEPLOYMENT_GENERATOR_IDS } from '../deploy/builtin-generators.js';
import { formatError, isErrno, usageError as reportUsageError } from '../internal/errors.js';
import type { CloudflarePagesOptions } from '../deploy/hosting-config.js';
import {
  createDeploymentGeneratorRegistry,
  type DeploymentGenerator,
  type DeploymentGeneratorRegistry,
} from '../deploy/registry.js';
import { loadJamalConfig, type JamalConfig } from './config.js';
import { defaultCommandRunner, type CommandRunner } from './docker.js';
import {
  appendDeployEntry,
  readDeployHistory,
  type DeployHistory,
  type DeployHistoryEntry,
} from './production/history.js';
import type { HookRunner, HooksFilesystem } from './production/hooks.js';
import {
  createProcessRunner,
  type CommandRunner as ReleaseCommandRunner,
} from './production/command-runner.js';
import { createRemoteRunner, type RemoteRunner } from './production/transport.js';
import type { HealthCheck } from './production/release.js';
import {
  createFetchHealthCheck,
  createHooksFilesystem,
  createProcessHookRunner,
  defaultImageTag,
} from './production/execute.js';

// Re-exported so the jamal command modules keep importing these shared error
// helpers through `plan-command.js` (their established facade) rather than reaching
// into `internal/` directly.
export { formatError, isErrno };

/** Raised for an invalid invocation or a target directory that escapes cwd. */
export class JamalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JamalError';
  }
}

/** Placeholder Cloudflare Pages project name; the user edits it before deploying. */
const EXAMPLE_CLOUDFLARE_PAGES_OPTIONS: CloudflarePagesOptions = {
  name: 'myapp',
};

/** One jamal subcommand: the generator set it plans plus its usage hints. */
interface JamalSet {
  readonly generators: readonly string[];
  readonly hints: readonly string[];
  readonly note?: string;
}

/** Deploy target names accepted by `jamal deploy --target`. */
const DEPLOY_TARGETS = ['kamal', 'vercel', 'netlify', 'cloudflare', 'github'] as const;

/** A valid deploy target. */
type DeployTarget = (typeof DEPLOY_TARGETS)[number];

/** Generator set + usage hints per `--target` on `jamal deploy`. `kamal` is
 * absent: it routes to the execution engine in `exec.ts`, never the generator
 * flow. */
const DEPLOY_TARGET_SETS: Readonly<Partial<Record<DeployTarget, JamalSet>>> = {
  vercel: {
    generators: ['vercel-static'],
    hints: ['npx vercel deploy --prod'],
    note: 'A vercel.json is generated; repos that commit a prebuilt out/ can use no-op build commands instead.',
  },
  netlify: {
    generators: ['netlify-static'],
    hints: ['npx netlify deploy --prod'],
  },
  cloudflare: {
    generators: ['cloudflare-pages'],
    hints: ['npx wrangler pages deploy out'],
    note: 'Example project name only: edit name in wrangler.toml before deploying.',
  },
  github: {
    generators: ['github-pages'],
    hints: ['git push'],
    note: 'Pushes to main deploy via the generated .github/workflows/pages.yml workflow.',
  },
};

/** One-line description per built-in deploy target (shown by `jamal targets`). */
const DEPLOY_TARGET_DESCRIPTIONS: Readonly<Record<DeployTarget, string>> = {
  kamal: 'Docker/SSH engine release (executes by default; --dry-run previews)',
  vercel: 'Vercel static hosting (vercel.json)',
  netlify: 'Netlify static hosting (netlify.toml)',
  cloudflare: 'Cloudflare Pages static hosting (wrangler.toml)',
  github: 'GitHub Pages static workflow (.github/workflows/pages.yml)',
};

/**
 * The `npx` argv that actually deploys a static host's generated config,
 * reused by `deploy --target <host>`. `npx --yes` is used so a first run never
 * hangs on the "install <cli>?" prompt (npm/npx is always present under the
 * Node install JSails requires). `github` is absent: GitHub Pages deploys by
 * pushing, not via a CLI, so it stays a generated-workflow + `git push` hint.
 */
const STATIC_DEPLOY_ARGV: Readonly<Partial<Record<DeployTarget, readonly string[]>>> = {
  vercel: ['npx', '--yes', 'vercel', 'deploy', '--prod'],
  netlify: ['npx', '--yes', 'netlify', 'deploy', '--prod'],
  cloudflare: ['npx', '--yes', 'wrangler', 'pages', 'deploy', 'out'],
};

/** Subcommand -> generator ids. `deploy` resolves per `--target`; `once` is never wired. */
const JAMAL_SUBCOMMANDS: Readonly<Record<string, JamalSet>> = {
  dev: {
    generators: ['valkey-dev', 'database-dev'],
    hints: ['docker compose up -d', 'docker compose -f docker-compose.database.yml up -d'],
  },
  harden: {
    generators: ['harden-server'],
    hints: ['sudo sh config/harden-server.sh'],
    note: 'Review config/harden-server.sh first. Jamal never runs it; a human must run it by hand.',
  },
};

/** Per-generator input; the dev generators resolve their own defaults. */
const GENERATOR_INPUT: Readonly<Record<string, unknown>> = {
  'valkey-dev': undefined,
  'database-dev': undefined,
  'vercel-static': undefined,
  'netlify-static': undefined,
  'cloudflare-pages': EXAMPLE_CLOUDFLARE_PAGES_OPTIONS,
  'github-pages': undefined,
  'harden-server': undefined,
};

/**
 * Dependency seam for the jamal command. Tests inject a stub registry and
 * captured output sinks so no generator runs and nothing touches disk; the
 * defaults are the real built-in registry and the process's stdout/stderr.
 */
export interface JamalDeps {
  /**
   * Build the deploy-generator registry used to plan the file set, seeded with
   * the built-in generators plus any custom deployments from the app config.
   */
  createRegistry(custom?: readonly DeploymentGenerator<unknown>[]): DeploymentGeneratorRegistry;
  /**
   * Load the app config's custom deployment generators (trusted app code).
   * Resolves `undefined` when no `jsails.app.js` config is present and an array
   * (possibly empty) when a config was loaded. Absent in a test seam, the
   * command treats it as "no config".
   */
  loadDeployments?(cwd: string): Promise<readonly DeploymentGenerator<unknown>[] | undefined>;
  /**
   * Load and normalize `jamal.config.js` for the managed Compose project
   * (`up`/`exec`, and `down`/`ps`/`logs` when `.jamal/compose.yml` exists).
   * Injected for tests; absent in a test seam, the real loader is used.
   */
  loadJamalConfig?(configDir: string): Promise<JamalConfig>;
  /** Working directory the target directory resolves against. */
  readonly cwd: string;
  stdout(text: string): void;
  stderr(text: string): void;
  /**
   * Spawn a fixed argv array with a given working directory. Injected for the
   * execution verbs (`up`/`down`/`ps`/`logs`/`exec`) so tests never spawn a real
   * process; defaults to the streaming `docker compose` runner. Absent in a
   * test seam, an execution verb reports "docker compose is unavailable".
   */
  runCommand?: CommandRunner;
  /**
   * Run a production step (build/push) as a fixed argv array with an optional
   * timeout. Injected so tests never spawn a real process; defaults to the
   * captured-output {@link createProcessRunner}.
   */
  processRunner?: ReleaseCommandRunner;
  /** Run a fixed argv array on the production server over ssh. */
  remoteRunner?: RemoteRunner;
  /** Poll the production health URL; defaults to the fetch-based checker. */
  healthCheck?: HealthCheck;
  /**
   * Resolve the image tag for `deploy` when `--tag` is absent.
   * Defaults to `git rev-parse --short HEAD` with a timestamp fallback.
   */
  resolveTag?(cwd: string): Promise<string>;
  /** Filesystem probe for deployment hook scripts. */
  hooksFs?: HooksFilesystem;
  /** Process runner for deployment hook scripts (with cwd/env). */
  hookRunner?: HookRunner;
  /** Read the local deploy history; defaults to `.jamal/deploys.json`. */
  readHistory?(dir: string): Promise<DeployHistory>;
  /** Record one deploy history entry; defaults to the atomic append. */
  appendHistory?(dir: string, entry: DeployHistoryEntry): Promise<DeployHistory>;
}

const defaultProcessRunner = createProcessRunner();
export const defaultRemoteRunner: RemoteRunner = createRemoteRunner({
  processRunner: defaultProcessRunner,
});

export const defaultJamalDeps: JamalDeps = {
  createRegistry: (custom = []) => createDeploymentGeneratorRegistry({ generators: custom }),
  loadDeployments: (cwd) => loadCustomDeployments(cwd),
  loadJamalConfig: (configDir) => loadJamalConfig(configDir),
  cwd: process.cwd(),
  stdout: (text) => process.stdout.write(`${text}\n`),
  stderr: (text) => process.stderr.write(`${text}\n`),
  runCommand: defaultCommandRunner,
  processRunner: defaultProcessRunner,
  remoteRunner: defaultRemoteRunner,
  healthCheck: createFetchHealthCheck(),
  resolveTag: (cwd) => defaultImageTag(cwd),
  hooksFs: createHooksFilesystem(),
  hookRunner: createProcessHookRunner(),
  readHistory: (dir) => readDeployHistory(dir),
  appendHistory: (dir, entry) => appendDeployEntry(dir, entry),
};

/**
 * Load the app config's custom deployments, when a `jsails.app.js` module is
 * present in `cwd`. The config module is trusted app code and is imported for
 * its side effects, exactly as `serve`/`build` do; a missing config returns
 * `undefined` so `jamal targets` can report the absence rather than an error.
 */
async function loadCustomDeployments(
  cwd: string,
): Promise<readonly DeploymentGenerator<unknown>[] | undefined> {
  const configPath = resolve(cwd, DEFAULT_APP_CONFIG_PATH);
  if (!existsSync(configPath)) {
    return undefined;
  }
  const resolved = await loadAppConfig(configPath);
  return resolved.deployments;
}

/** Built-in generator ids are reserved: a custom deployment may not reuse one. */
const RESERVED_GENERATOR_IDS: ReadonlySet<string> = new Set(BUILTIN_DEPLOYMENT_GENERATOR_IDS);

/** Reject a custom deployment whose name collides with a built-in generator id. */
function assertNoBuiltinCollisions(deployments: readonly DeploymentGenerator<unknown>[]): void {
  for (const generator of deployments) {
    if (RESERVED_GENERATOR_IDS.has(generator.name)) {
      throw new JamalError(
        `custom deployment "${generator.name}" collides with a built-in deployment generator name`,
      );
    }
  }
}

/** Print a usage failure to stderr and return the exit code (2). */
export function usageError(deps: JamalDeps, message: string): number {
  return reportUsageError(
    (line) => deps.stderr(line),
    'Run "jsails jamal --help" for usage.',
    message,
  );
}

/**
 * Resolve the target directory from `--dir` (defaulting to `cwd`) and reject a
 * path that escapes the working directory. `..` traversal, an absolute path
 * that lands elsewhere, and any resolution outside `cwd` are refused.
 */
export function resolveTargetDir(cwd: string, dir: string | undefined): string {
  const base = resolve(cwd);
  if (dir === undefined || dir === '') {
    return base;
  }
  const target = resolve(base, dir);
  const rel = relative(base, target);
  if (rel !== '' && (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))) {
    throw new JamalError(
      `--dir ${JSON.stringify(dir)} escapes the working directory; choose a path inside it`,
    );
  }
  return target;
}

/** Plan one entry: relative path plus contents. */
type PlannedFile = readonly [string, string];

/**
 * Run every generator in the set and merge their file maps into one
 * deterministic (sorted) plan. A path emitted by two generators is a hard
 * error rather than a silent overwrite; the error names both contributors.
 */
async function planFiles(
  registry: DeploymentGeneratorRegistry,
  generatorIds: readonly string[],
): Promise<PlannedFile[]> {
  const files = new Map<string, string>();
  const origins = new Map<string, string>();
  const add = (path: string, content: string, origin: string): void => {
    const existing = origins.get(path);
    if (existing !== undefined) {
      throw new JamalError(
        `generated file "${path}" is produced by both ${existing} and ${origin}`,
      );
    }
    files.set(path, content);
    origins.set(path, origin);
  };
  for (const id of generatorIds) {
    const result = await registry.generate(id, GENERATOR_INPUT[id]);
    for (const [path, content] of Object.entries(result.files)) {
      add(path, content, `generator "${id}"`);
    }
  }
  return [...files.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Outcome of a `--write`: every file either written or skipped (never both). */
interface JamalWriteResult {
  readonly written: readonly string[];
  readonly skipped: readonly string[];
  readonly error?: string;
}

/**
 * Materialize the plan into `targetDir` with exclusive creation. Missing parent
 * directories are created first; an `EEXIST` on the file is reported as a skip
 * (never overwritten), while any other failure aborts the run with an error.
 */
async function writeFiles(
  targetDir: string,
  planned: readonly PlannedFile[],
): Promise<JamalWriteResult> {
  const written: string[] = [];
  const skipped: string[] = [];
  for (const [rel, content] of planned) {
    const dest = join(targetDir, ...rel.split('/'));
    try {
      await mkdir(dirname(dest), { recursive: true });
    } catch (error) {
      return {
        written,
        skipped,
        error: `could not create the parent directory for "${rel}": ${formatError(error)}`,
      };
    }
    try {
      await writeFile(dest, content, { flag: 'wx' });
      written.push(rel);
    } catch (error) {
      if (isErrno(error, 'EEXIST')) {
        skipped.push(rel);
        continue;
      }
      return {
        written,
        skipped,
        error: `could not write "${rel}": ${formatError(error)}`,
      };
    }
  }
  return { written, skipped };
}

/** Print the dry-run plan: what, where, and how to use it. Writes nothing. */
function printPlan(
  stdout: (text: string) => void,
  commandLabel: string,
  set: JamalSet,
  planned: readonly PlannedFile[],
  targetDir: string,
  writeCommand: string,
): void {
  stdout(
    `jamal ${commandLabel} - ${planned.length} file(s) planned into ${targetDir} (nothing written).`,
  );
  stdout('');
  for (const [rel] of planned) {
    stdout(`  ${rel}`);
  }
  stdout('');
  stdout(`To write these files, run: ${writeCommand}`);
  stdout('');
  stdout('Next steps:');
  for (const hint of set.hints) {
    stdout(`  ${hint}`);
  }
  if (set.note !== undefined) {
    stdout(`  ${set.note}`);
  }
}

/** Print the write result: written vs skipped, then the usage hints. */
function printWriteResult(
  stdout: (text: string) => void,
  commandLabel: string,
  set: JamalSet,
  result: JamalWriteResult,
): void {
  stdout(
    `jamal ${commandLabel} - wrote ${result.written.length} file(s), skipped ${result.skipped.length}.`,
  );
  for (const rel of result.written) {
    stdout(`  wrote    ${rel}`);
  }
  for (const rel of result.skipped) {
    stdout(`  skipped  ${rel} (already exists)`);
  }
  if (result.written.length > 0) {
    stdout('');
    stdout('Next steps:');
    for (const hint of set.hints) {
      stdout(`  ${hint}`);
    }
    if (set.note !== undefined) {
      stdout(`  ${set.note}`);
    }
  }
}

/**
 * Resolve a deploy target name to its generator set. Built-in aliases win
 * first; a custom deployment name matches second; anything else is `undefined`.
 */
function resolveDeployTarget(
  target: string,
  custom: readonly DeploymentGenerator<unknown>[],
): JamalSet | undefined {
  const builtin = DEPLOY_TARGET_SETS[target as DeployTarget];
  if (builtin !== undefined) {
    return builtin;
  }
  if (custom.some((generator) => generator.name === target)) {
    return {
      generators: [target],
      hints: [],
      note: 'Custom deployment target from the deployments array in jsails.app.js; deploy it with your own tooling.',
    };
  }
  return undefined;
}

/** Deploy target names, built-in aliases first then custom names, for errors. */
function listDeployTargets(custom: readonly DeploymentGenerator<unknown>[]): string[] {
  return [...DEPLOY_TARGETS, ...custom.map((generator) => generator.name)];
}

/** Custom deployments loaded from the app config plus whether a config exists. */
interface LoadedDeployments {
  readonly deployments: readonly DeploymentGenerator<unknown>[];
  readonly hasConfig: boolean;
}

/**
 * Load custom deployments from the app config and reject a name that collides
 * with a built-in generator id. `hasConfig` is `false` only when no
 * `jsails.app.js` module is present (the seam resolved `undefined`).
 */
async function loadDeployments(deps: JamalDeps): Promise<LoadedDeployments> {
  const loaded =
    deps.loadDeployments === undefined ? undefined : await deps.loadDeployments(deps.cwd);
  if (loaded === undefined) {
    return { deployments: [], hasConfig: false };
  }
  assertNoBuiltinCollisions(loaded);
  return { deployments: loaded, hasConfig: true };
}

/** Print the `jamal targets` listing. Never runs a generator. */
function printTargets(stdout: (text: string) => void, loaded: LoadedDeployments): void {
  stdout('Built-in deployment targets:');
  for (const target of DEPLOY_TARGETS) {
    stdout(`  ${target.padEnd(12)}${DEPLOY_TARGET_DESCRIPTIONS[target]}`);
  }
  stdout('');
  if (loaded.deployments.length === 0) {
    stdout(
      loaded.hasConfig
        ? 'No custom deployment targets declared in jsails.app.js.'
        : 'No custom deployment targets (no jsails.app.js config present).',
    );
    return;
  }
  stdout('Custom deployment targets (from jsails.app.js):');
  for (const generator of loaded.deployments) {
    stdout(`  ${generator.name}`);
  }
}

/** `jamal targets`: list built-in and custom targets without running a generator. */
export async function runTargets(deps: JamalDeps): Promise<number> {
  let loaded: LoadedDeployments;
  try {
    loaded = await loadDeployments(deps);
  } catch (error) {
    deps.stderr(`jsails: ${formatError(error)}`);
    return 1;
  }
  printTargets(deps.stdout, loaded);
  return 0;
}

/** The parsed values the plan/`--write` flow reads from the command line. */
interface PlanValues {
  readonly write: boolean;
  readonly dir?: string;
  readonly target?: string;
  readonly dryRun?: boolean;
}

/**
 * Run the generation flow for `dev`, `harden`, and the static/custom
 * `deploy --target` variants: resolve the generator set (per `--target` for
 * `deploy`), plan the file set, then write it. `dev` and `harden` plan by
 * default (printing the plan) and write only with `--write`; a `deploy` target
 * generates files (requiring `--write`) and — for a built-in static host —
 * executes its deploy via `npx` (the `kamal` parity path; `--dry-run` skips
 * the execution). A custom deployment never executes.
 */
export async function runPlanCommand(
  deps: JamalDeps,
  subcommand: string,
  values: PlanValues,
): Promise<number> {
  // `deploy` resolves its generator set from `--target` (built-in aliases
  // first, then custom deployment names); `dev` has a fixed set.
  let set: JamalSet;
  let commandLabel: string;
  let writeCommand: string;
  let registry: DeploymentGeneratorRegistry;
  let requiresWrite = false;
  if (subcommand === 'deploy') {
    let deployments: readonly DeploymentGenerator<unknown>[];
    try {
      deployments = (await loadDeployments(deps)).deployments;
    } catch (error) {
      deps.stderr(`jsails: ${formatError(error)}`);
      return 1;
    }
    const target = values.target ?? 'kamal';
    const resolved = resolveDeployTarget(target, deployments);
    if (resolved === undefined) {
      return usageError(
        deps,
        `unknown --target ${JSON.stringify(target)}; available targets: ${listDeployTargets(deployments).join(', ')}`,
      );
    }
    // Static and custom targets generate files; `--write` materializes them. A
    // built-in static host additionally executes its deploy below.
    requiresWrite = true;
    set = resolved;
    commandLabel = `deploy --target ${target}`;
    writeCommand = `jsails jamal deploy --target ${target} --write`;
    registry = deps.createRegistry(deployments);
  } else {
    const devSet = JAMAL_SUBCOMMANDS[subcommand];
    if (devSet === undefined) {
      return usageError(deps, `unknown subcommand ${JSON.stringify(subcommand)}`);
    }
    set = devSet;
    commandLabel = subcommand;
    writeCommand = `jsails jamal ${subcommand} --write`;
    registry = deps.createRegistry([]);
  }

  let targetDir: string;
  try {
    targetDir = resolveTargetDir(deps.cwd, values.dir);
  } catch (error) {
    deps.stderr(`jsails: ${formatError(error)}`);
    return 1;
  }

  let planned: PlannedFile[];
  try {
    planned = await planFiles(registry, set.generators);
  } catch (error) {
    deps.stderr(`jsails: ${formatError(error)}`);
    return 1;
  }

  if (requiresWrite && !values.write) {
    return usageError(
      deps,
      `${commandLabel} generates files only and never deploys; pass --write to materialize them.`,
    );
  }

  if (!values.write) {
    printPlan(deps.stdout, commandLabel, set, planned, targetDir, writeCommand);
    return 0;
  }

  const result = await writeFiles(targetDir, planned);
  printWriteResult(deps.stdout, commandLabel, set, result);
  if (result.error !== undefined) {
    deps.stderr(`jsails: ${result.error}`);
    return 1;
  }

  // A built-in static deploy target EXECUTES its deploy through `npx`, the
  // same way `deploy --target kamal` executes through ssh/Docker. Custom
  // deployments (unknown here), `--dry-run`, and `dev`/`harden` never execute.
  if (subcommand === 'deploy' && values.dryRun !== true) {
    const deployArgv = STATIC_DEPLOY_ARGV[values.target as DeployTarget];
    if (deployArgv !== undefined) {
      const runner = deps.runCommand;
      if (runner === undefined) {
        deps.stderr('jsails: deploying a static target requires a command runner');
        return 1;
      }
      deps.stdout('');
      deps.stdout(`Deploying ${values.target}…`);
      const commandResult = await runner(deployArgv, { cwd: deps.cwd });
      if (commandResult.stdout) {
        deps.stdout(commandResult.stdout.trimEnd());
      }
      if (commandResult.stderr) {
        deps.stderr(commandResult.stderr.trimEnd());
      }
      return commandResult.exitCode;
    }
    // github (or a custom name with no CLI): push/hint handled by printWriteResult.
    return 0;
  }

  return 0;
}
