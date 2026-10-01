/**
 * App commands: `build` (static export into the configured output directory),
 * `serve` (HTTP server until SIGINT/SIGTERM), and `dev` (compile + watch +
 * serve). Their config module defaults to `jsails.app.js` and default-exports
 * an app config object; host, port, and output directory are set in the config,
 * not via extra flags.
 */

import { createApplication, type Application } from '../app/application.js';
import { PageRenderError } from '../pages/page.js';
import { StaticSiteError, type GenerateStaticSiteResult } from '../pages/static-site/index.js';
import { RouteManifestError } from '../routing/routes.js';
import { runDev, type DevOptions } from '../dev/dev-runtime.js';

import { formatError } from '../internal/errors.js';
import { waitForShutdownSignal, type ShutdownSignal } from './shutdown.js';

import { AppConfigError, loadAppConfig, type ResolvedAppConfig } from './config-loader.js';

/**
 * Dependency seam for the app commands. Tests inject fakes so no HTTP server is
 * bound and no config module is imported; the defaults are the real factories.
 */
export interface AppDeps {
  loadConfig(configPath: string): Promise<ResolvedAppConfig>;
  createApplication(config: ResolvedAppConfig): Promise<Application>;
  /** Install SIGINT/SIGTERM handlers and resolve on the first signal. */
  waitForShutdown?(): ShutdownSignal;
}

const defaultAppDeps: AppDeps = {
  loadConfig: (configPath) => loadAppConfig(configPath),
  createApplication,
  waitForShutdown: waitForShutdownSignal,
};

/** Report one completed static build: outputs written plus any skipped APIs. */
function printBuildResult(result: GenerateStaticSiteResult): void {
  const outputs = result.written.length + result.copied.length;
  console.log(
    `Built ${outputs} output file(s) (${result.written.length} page(s), ${result.copied.length} asset(s)).`,
  );
  if (result.skipped.length > 0) {
    console.log(
      `Skipped ${result.skipped.length} API route(s): a static site build does not serve API routes.`,
    );
  }
}

/**
 * `build`: load the config, assemble the app, render the static site, and close.
 * The app is closed exactly once in a `finally`, whether the build succeeds or
 * throws. A failed `createApplication` owns nothing the CLI must close (its
 * extensions are already torn down by the assembler).
 */
async function runBuildCommand(configPath: string, deps: AppDeps): Promise<number> {
  const config = await deps.loadConfig(configPath);
  const app = await deps.createApplication(config);
  try {
    printBuildResult(await app.build());
  } finally {
    await app.close();
  }
  return 0;
}

/**
 * `serve`: load the config, install shutdown signal handlers, assemble the app,
 * listen, print the actual URL, and wait for SIGINT/SIGTERM before closing.
 *
 * Signal handlers are installed before `createApplication` so a signal arriving
 * during startup (extension setup or listen) is captured and leads to a clean
 * shutdown instead of the default immediate termination. They are disposed on
 * every path (shutdown, startup failure, and config failure), and never at
 * import time. The app is closed exactly once in the `finally`.
 */
async function runServeCommand(configPath: string, deps: AppDeps): Promise<number> {
  const config = await deps.loadConfig(configPath);
  const signal = (deps.waitForShutdown ?? waitForShutdownSignal)();
  let app: Application | undefined;
  try {
    app = await deps.createApplication(config);
    const handle = await app.serve();
    console.log(`Serving at ${handle.url}`);
    await signal.promise;
  } finally {
    signal.dispose();
    if (app !== undefined) {
      await app.close();
    }
  }
  return 0;
}

/**
 * Dispatch an app command (`build` / `serve`) with the given dependencies.
 * Exported for tests: inject fake factories to exercise lifecycle, close
 * ordering, and signal disposal without a real server or config module.
 */
export async function runAppCommand(
  command: 'build' | 'serve',
  configPath: string,
  deps: AppDeps = defaultAppDeps,
): Promise<number> {
  if (command === 'build') {
    return runBuildCommand(configPath, deps);
  }
  return runServeCommand(configPath, deps);
}

/**
 * Sanitize an app-command failure for the CLI. Framework errors carry value-free
 * messages and are echoed; anything else (an extension `setup`, a custom
 * renderer, an API module) is untrusted user code whose message may embed a
 * payload or credentials, so it is replaced with a generic message.
 */
export function formatAppError(error: unknown): string {
  return formatError(error, {
    allow: isValueFreeError,
    fallback: 'the application command failed',
  });
}

/** Errors whose messages are value-free by construction and safe to echo. */
function isValueFreeError(error: unknown): boolean {
  return (
    error instanceof AppConfigError ||
    error instanceof RouteManifestError ||
    error instanceof StaticSiteError ||
    error instanceof PageRenderError
  );
}

/** Dependency seam for the `dev` command: inject a fake toolchain for tests. */
export interface DevCommandDeps {
  runDev(options: DevOptions): Promise<number>;
}

const defaultDevCommandDeps: DevCommandDeps = {
  runDev: (options) => runDev(options),
};

/**
 * `dev`: lazily invoke the development toolchain with the resolved config path.
 * No host/port/output flags are accepted; those live in the app config. The
 * toolchain starts here, never at import time.
 */
export async function runDevCommand(
  configPath: string,
  deps: DevCommandDeps = defaultDevCommandDeps,
): Promise<number> {
  return deps.runDev({ configPath });
}
