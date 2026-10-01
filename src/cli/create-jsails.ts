#!/usr/bin/env node
/**
 * `create-jsails` entry point — the `npm create jsails` / `npx create-jsails`
 * convention.
 *
 * npm maps `npm create jsails <dir>` → `create-jsails <dir>`. This entry simply
 * prepends the `create` subcommand so `<dir>` becomes the target directory with
 * no `jsails` subcommand required, then delegates to the same {@link runCli}
 * the `jsails` bin drives. It imports nothing heavy — the delegate stays lazy.
 */

import { runCli } from '../cli.js';
import { formatError } from '../internal/errors.js';

runCli(['create', ...process.argv.slice(2)])
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(`jsails: ${formatError(error)}`);
    process.exitCode = 1;
  });
