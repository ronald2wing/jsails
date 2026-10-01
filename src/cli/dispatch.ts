/**
 * Heavy CLI dispatch module: all TypeORM/BullMQ/Hono/Preact/Vite/Jamal
 * dependencies live here. The thin {@link ../cli} entry dynamically imports
 * this module only when an actual command must execute (never for `--help`,
 * `inspect`, `describe`, `explain`, custom-command discovery, or early-routed
 * paths like `jamal`/`plugins`/`make`).
 *
 * This file is intentionally kept in the same `src/cli/` directory so relative
 * imports stay consistent; the separation is an import-graph concern, not a
 * topical one.
 *
 * As of T3.3 phase 3, dispatch is driven by the contribution index in
 * {@link ./command-catalog} rather than a hardcoded name-to-runner map.
 */

// DEFAULT config paths are inlined in cli.ts to avoid importing their
// heavy source modules; see that file for the canonical values.

import { formatError, usageError as reportUsageError } from '../internal/errors.js';

import { createBuiltinCommandIndex } from './command-catalog.js';
import { formatAppError } from './app-commands.js';

// Build the index once at module load (never at import time of cli.ts —
// this module is only loaded when a command must execute).
const builtinIndex = createBuiltinCommandIndex();

// ---------------------------------------------------------------------------
// Public value re-exports (consumed by tests and dev tooling that already
// need the heavy modules for their own purposes).
// ---------------------------------------------------------------------------

export { runAppCommand, runDevCommand } from './app-commands.js';
export { runRuntimeCommand } from './runtime-commands.js';
export { runCreateCommand, npmInstallSpawn } from './create.js';

// Public type re-exports.
export type { AppDeps, DevCommandDeps } from './app-commands.js';
export type { CreateDeps, CreateOptions } from './create.js';
export type { RuntimeDeps } from './runtime-commands.js';
export type { ShutdownSignal } from './shutdown.js';

function usageError(message: string): number {
  return reportUsageError((line) => console.error(line), 'Run "jsails --help" for usage.', message);
}

/**
 * Run the heavy dispatch for the given command. All flag validation must
 * already have passed by the time this is called; this function resolves
 * the command through the contribution catalog, loads its runner, and
 * invokes it.
 */
export async function runDispatch(
  command: string,
  configPath: string,
  values: Record<string, unknown>,
  migrateMode: Record<string, unknown> | undefined,
  rest: readonly string[],
): Promise<number> {
  const entry = builtinIndex.get(command);
  if (entry === undefined) {
    return usageError(`unknown command ${JSON.stringify(command)}`);
  }

  // Attach migrate mode to values for the migrate runner to pick up.
  if (migrateMode !== undefined) {
    values.__migrateMode = migrateMode;
  }

  try {
    const runner = await entry.load();
    return await runner(configPath, values, rest);
  } catch (error) {
    const isApp = entry.config === 'app';
    console.error(`jsails: ${isApp ? formatAppError(error) : formatError(error)}`);
    return 1;
  }
}
