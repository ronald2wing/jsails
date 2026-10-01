/**
 * The `plugins resolve` subcommand: resolve plugin enablement from the code
 * list and the managed state source without installing or activating anything.
 *
 * This wraps `loadPluginEnablement` and prints the merged result. When the
 * app is not managed (`plugins.managed` absent or `false`), the result is the
 * code-only enablement with zero state-source I/O. When the app is managed, the
 * database-backed state store is loaded and merged. The command never imports
 * plugin code, never runs `setup`, and never mutates state.
 *
 * This is a pure two-source enablement merge (code list + managed state) and is
 * architecturally blind to installation/discovery state: `loadPluginEnablement`
 * never reads the filesystem or discovery, so an enabled or disabled id is not
 * necessarily installed. For discovered/installed plugins use
 * `jsails plugins list`.
 *
 * ```sh
 * jsails plugins resolve --json                # machine-readable
 * jsails plugins resolve                       # human-readable
 * jsails plugins resolve --config jsails.app.js --db-config jsails.config.js
 * ```
 */

import { resolve } from 'node:path';

import { AppConfigError, loadAppConfig } from '../../app/config/index.js';
import { PluginEnablementError, type PluginEnablement } from '../../plugins/enablement.js';
import {
  createDatabasePluginStateStore,
  loadPluginEnablement,
} from '../../plugins/database-state-store.js';
import { PluginStateError } from '../../plugins/state-store.js';

import { formatError } from '../../internal/errors.js';
import type { ParsedValues, PluginsDeps } from '../plugins-command.js';
import { defaultLoadDataSource, fail, safeMessage } from './state.js';

/**
 * JSON shape for `plugins resolve --json` (stable; keep in sync with the usage
 * help in plugins-command.ts):
 * ```
 * {
 *   "enabled": ["id1", "id2"],
 *   "conflicts": ["id3"],
 *   "disabledManaged": ["id4"],
 *   "sources": {
 *     "code": ["id1", "id3"],
 *     "managed": ["id2", "id4"]
 *   }
 * }
 * ```
 */

/** Render the enablement result as output lines. */
function renderEnablement(enablement: PluginEnablement, asJson: boolean): string[] {
  if (asJson) {
    return [
      JSON.stringify({
        enabled: enablement.enabled,
        conflicts: enablement.conflicts,
        disabledManaged: enablement.disabledManaged,
        sources: {
          code: enablement.codeEnabled,
          managed: enablement.managedEnabled,
        },
      }),
    ];
  }

  const lines: string[] = ['Plugin enablement:'];

  if (enablement.enabled.length === 0) {
    lines.push('  enabled: (none)');
  } else {
    lines.push(`  enabled (${enablement.enabled.length}):`);
    for (const id of enablement.enabled) {
      const source = enablement.codeEnabled.includes(id) ? 'code' : 'managed';
      lines.push(`    ${id}  [${source}]`);
    }
  }

  if (enablement.conflicts.length > 0) {
    lines.push('');
    lines.push(`  conflicts (${enablement.conflicts.length}):`);
    for (const id of enablement.conflicts) {
      lines.push(`    ${id}  (both code and managed; excluded from enabled)`);
    }
  }

  if (enablement.disabledManaged.length > 0) {
    lines.push('');
    lines.push(`  disabled managed (${enablement.disabledManaged.length}):`);
    for (const id of enablement.disabledManaged) {
      lines.push(`    ${id}`);
    }
  }

  return lines;
}

/** Error types whose messages are safe to echo verbatim. */
function isEchoable(error: unknown): boolean {
  return (
    error instanceof AppConfigError ||
    error instanceof PluginEnablementError ||
    error instanceof PluginStateError
  );
}

/**
 * Run the `plugins resolve` subcommand.
 *
 * Accepts `--config` (app config, default `jsails.app.js`), `--db-config`
 * (database config, default `jsails.config.js`), and `--json`. When the app is
 * not managed the database config is never loaded and zero state-source I/O is
 * performed.
 */
export async function runResolve(values: ParsedValues, deps: PluginsDeps): Promise<number> {
  const configPath = resolve(deps.cwd, values.config ?? 'jsails.app.js');

  // Load the app config and extract plugin settings.
  let codeEnabled: readonly string[] | undefined;
  let managed: boolean | undefined;
  try {
    const config = await loadAppConfig(configPath);
    codeEnabled = config.plugins?.enabled;
    managed = config.plugins?.managed;
  } catch (error) {
    return fail(deps, safeMessage(error, 'failed to load app config'));
  }

  // Build the state source only when managed. The db config is only consulted
  // when the app config declares plugin state is managed.
  let stateSource;
  let dataSourceToClose: Awaited<ReturnType<typeof defaultLoadDataSource>> | undefined;
  if (managed === true) {
    const dbConfigPath = resolve(deps.cwd, values['db-config'] ?? 'jsails.config.js');
    let dataSource;
    try {
      dataSource = await (deps.loadDataSource ?? defaultLoadDataSource)(dbConfigPath);
    } catch (error) {
      return fail(
        deps,
        safeMessage(error, 'failed to load database config for managed plugin state'),
      );
    }

    try {
      await dataSource.initialize();
    } catch {
      return fail(deps, 'the plugin state database could not be initialized');
    }

    dataSourceToClose = dataSource;
    const store = (deps.createStateStore ?? createDatabasePluginStateStore)({ dataSource });
    stateSource = store;
  }

  try {
    const enablement = await loadPluginEnablement({
      codeEnabled,
      managed,
      stateSource,
    });
    const lines = renderEnablement(enablement, values.json === true);
    for (const line of lines) {
      deps.stdout(line);
    }
    return 0;
  } catch (error) {
    return fail(
      deps,
      formatError(error, {
        allow: isEchoable,
        fallback: 'plugin enablement could not be resolved',
      }),
    );
  } finally {
    if (dataSourceToClose !== undefined) {
      try {
        await dataSourceToClose.destroy();
      } catch {
        // Best-effort teardown.
      }
    }
  }
}
