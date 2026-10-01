/**
 * Serve-child entry point for the dev runtime.
 *
 * nodemon `fork`s this module with its working directory pointed at a private
 * temp directory (so a global `~/.nodemon.json` can never be loaded) and with
 * `HOME`/`HOMEPATH` redirected there too. This module restores the real
 * environment — chdir back to the project, put the real HOME back, and read the
 * app config path from a dedicated environment variable — then delegates to the
 * normal `serve` command. The project path and config path arrive as
 * environment variables, never as shell-interpolated argv.
 *
 * The child also defaults `NODE_ENV` to `development` when it was inherited
 * unset, so the server-components extension may mint an ephemeral signing key in
 * local dev without weakening a deployed `staging`/`production` environment. The
 * default is applied only when undefined, before the app config is imported.
 */

import { pathToFileURL } from 'node:url';

import { runCli } from '../cli.js';
import {
  DEV_CONFIG_ENV,
  DEV_CWD_ENV,
  DEV_REAL_HOME_ENV,
  DEV_REAL_HOMEPATH_ENV,
} from './dev-runtime.js';

/** Environment applied in the serve child when the parent provided none. */
const DEFAULT_DEV_NODE_ENV = 'development';

/**
 * Default `NODE_ENV` to `development` only when it is unset. An explicit value
 * (including `test`, `staging`, or `production`) is preserved. Mutates `env` in
 * place and returns it; callers passing the default argument mutate the child's
 * `process.env`, never the parent's.
 */
export function applyDefaultNodeEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (env.NODE_ENV === undefined) {
    env.NODE_ENV = DEFAULT_DEV_NODE_ENV;
  }
  return env;
}

/** Restore the real HOME/HOMEPATH the parent redirected to the private dir. */
function restoreHome(): void {
  restoreVar('HOME', DEV_REAL_HOME_ENV);
  restoreVar('HOMEPATH', DEV_REAL_HOMEPATH_ENV);
}

/** Put the original value back, or delete the redirect when there was none. */
function restoreVar(name: 'HOME' | 'HOMEPATH', realName: string): void {
  const real = process.env[realName];
  if (real === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = real;
  }
}

/** Run the serve child: restore the project context, then delegate to `serve`. */
async function main(): Promise<void> {
  const cwd = process.env[DEV_CWD_ENV];
  const configPath = process.env[DEV_CONFIG_ENV];

  if (cwd === undefined || configPath === undefined) {
    console.error('jsails dev: the serve child is missing its runtime environment');
    process.exitCode = 1;
    return;
  }

  applyDefaultNodeEnv();

  // chdir and the HOME restore sit inside the guard so a deleted project
  // directory surfaces as a controlled failure instead of an unhandled stack.
  let entered = false;
  try {
    process.chdir(cwd);
    restoreHome();
    entered = true;
  } catch {
    console.error('jsails dev: could not enter the project directory (was it deleted?)');
    process.exitCode = 1;
  }
  if (entered) {
    try {
      process.exitCode = await runCli(['serve', '--config', configPath]);
    } catch {
      console.error('jsails dev: the serve command failed');
      process.exitCode = 1;
    }
  }
}

// Run only when invoked as the entry point; importing this module (as the tests
// do for `applyDefaultNodeEnv`) must not chdir or start a server.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
