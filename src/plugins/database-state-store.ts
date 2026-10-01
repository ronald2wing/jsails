/**
 * Database-backed plugin state and the managed/non-managed enablement switch.
 *
 * {@link createDatabasePluginStateStore} persists plugin state in the
 * framework-owned `jsails_plugin_state` table through the injected TypeORM
 * `DataSource`'s repository — no raw SQL and no runtime DDL. The table must
 * already exist: an app includes {@link pluginStateEntities} in its
 * `JsailsDataSource` entities and creates the table through the normal
 * `makemigrations`/`migrate` history. A missing table fails with a clear,
 * value-free {@link PluginStateError} telling the caller to run those commands;
 * the store never creates it. `load`/`save` map table rows to and from a
 * {@link PluginState}, validating every id and active version value-free: an id
 * that does not match {@link PLUGIN_ID_PATTERN} or a version that is not valid
 * semver is rejected without ever echoing the value. A data source that is not
 * initialized fails with a clear {@link PluginStateError} before any repository
 * query runs.
 *
 * {@link loadPluginEnablement} is the managed/non-managed switch. A
 * **non-managed** deployment performs no I/O and resolves enablement from the
 * code list only (`state` stays `undefined`); a **managed** deployment requires
 * a state source (a clear, value-free error when one is missing), loads it,
 * then merges it with the code list through {@link resolvePluginEnablement}.
 * The static export is always non-managed.
 */

import type { DataSource } from 'typeorm';

import {
  PluginEnablementError,
  resolvePluginEnablement,
  type PluginEnablement,
} from './enablement.js';
import { isValidSemverVersion, PLUGIN_ID_PATTERN } from './manifest.js';
import {
  PluginStateError,
  PLUGIN_STATE_VERSION,
  pluginStateSchema,
  type PluginState,
  type PluginStateSource,
} from './state-store.js';
import {
  ACTIVE_VERSION_COLUMN_LENGTH,
  PLUGIN_ID_COLUMN_LENGTH,
  PLUGIN_STATE_TABLE,
  JsailsPluginState,
} from './database-state-entity.js';

/** Options for {@link createDatabasePluginStateStore}. */
export interface DatabasePluginStateStoreOptions {
  /** The initialized TypeORM data source backing plugin state. */
  readonly dataSource: DataSource;
}

/** Validate a stored id/version pair value-free (never echoes the value). */
function assertValidEntry(id: string, active: string): void {
  if (!PLUGIN_ID_PATTERN.test(id) || id.length > PLUGIN_ID_COLUMN_LENGTH) {
    throw new PluginStateError('plugin state contains an invalid plugin id');
  }
  if (!isValidSemverVersion(active) || active.length > ACTIVE_VERSION_COLUMN_LENGTH) {
    throw new PluginStateError('plugin state contains an invalid active version');
  }
}

/**
 * Parse a stored `settings` text column back into an object. `null` (or an
 * empty string) yields `undefined`; anything that is not a JSON object raises a
 * value-free {@link PluginStateError} (the raw text is never echoed).
 */
function parseSettings(text: string | null): Record<string, unknown> | undefined {
  if (text === null || text === '') {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new PluginStateError('plugin state contains invalid settings');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new PluginStateError('plugin state contains invalid settings');
  }
  return parsed as Record<string, unknown>;
}

/** Serialize settings to the stored text column (`null` when unset). */
function serializeSettings(settings: Record<string, unknown> | undefined): string | null {
  if (settings === undefined) {
    return null;
  }
  try {
    return JSON.stringify(settings);
  } catch {
    throw new PluginStateError('plugin settings cannot be serialized');
  }
}

/** Validate an inbound {@link PluginState} before it is written, value-free. */
function assertValidState(state: PluginState): void {
  if (!pluginStateSchema.safeParse(state).success) {
    throw new PluginStateError('plugin state is invalid');
  }
  for (const [id, entry] of Object.entries(state.plugins)) {
    assertValidEntry(id, entry.active);
  }
}

/**
 * Build a database-backed {@link PluginStateSource} over an initialized TypeORM
 * data source. The `jsails_plugin_state` table must already exist (created by
 * the migration history); `save` replaces its contents in a single transaction.
 * See the module doc for the exact contract.
 */
export function createDatabasePluginStateStore(
  options: DatabasePluginStateStoreOptions,
): PluginStateSource {
  const dataSource = options.dataSource;
  const repository = dataSource.getRepository(JsailsPluginState);

  /** Fail with a clear error when the table is missing; never create it. */
  async function assertTableExists(): Promise<void> {
    if (!dataSource.isInitialized) {
      throw new PluginStateError('the plugin state data source must be initialized');
    }
    const queryRunner = dataSource.createQueryRunner();
    try {
      await queryRunner.connect();
      if (!(await queryRunner.hasTable(PLUGIN_STATE_TABLE))) {
        throw new PluginStateError(
          'the managed plugin state table does not exist; ' +
            'run makemigrations and migrate to create it',
        );
      }
    } finally {
      await queryRunner.release();
    }
  }

  async function load(): Promise<PluginState> {
    await assertTableExists();
    const rows = await repository.find();
    const plugins: Record<
      string,
      { active: string; enabled: boolean; settings?: Record<string, unknown> }
    > = {};
    for (const row of rows) {
      assertValidEntry(row.pluginId, row.activeVersion);
      const settings = parseSettings(row.settings);
      plugins[row.pluginId] = {
        active: row.activeVersion,
        enabled: row.enabled,
        ...(settings === undefined ? {} : { settings }),
      };
    }
    return { version: PLUGIN_STATE_VERSION, plugins };
  }

  async function save(state: PluginState): Promise<void> {
    assertValidState(state);
    await assertTableExists();
    const updatedAt = new Date();
    await dataSource.transaction(async (manager) => {
      const transactionRepository = manager.getRepository(JsailsPluginState);
      await transactionRepository.clear();
      await transactionRepository.save(
        Object.entries(state.plugins).map(([id, entry]) =>
          transactionRepository.create({
            pluginId: id,
            activeVersion: entry.active,
            enabled: entry.enabled,
            settings: serializeSettings(entry.settings),
            updatedAt,
          }),
        ),
      );
    });
  }

  return { load, save };
}

/** Inputs to {@link loadPluginEnablement}. */
export interface LoadPluginEnablementInput {
  /** Plugin ids enabled in the app config (`plugins.enabled`). */
  readonly codeEnabled?: readonly string[];
  /** Whether plugin state is managed in the database. Defaults to `false`. */
  readonly managed?: boolean;
  /** The state source for a managed deployment. Required when `managed` is true. */
  readonly stateSource?: PluginStateSource;
}

/**
 * Resolve plugin enablement through the managed/non-managed switch. When
 * `managed` is not exactly `true`, no state source is consulted (zero I/O) and
 * the result is the code-only enablement; when it is `true`, a state source is
 * required (a value-free {@link PluginEnablementError} otherwise) and its state
 * is loaded before {@link resolvePluginEnablement} merges it with the code list.
 */
export async function loadPluginEnablement(
  input: LoadPluginEnablementInput,
): Promise<PluginEnablement> {
  if (input.managed !== true) {
    return resolvePluginEnablement({
      codeEnabled: input.codeEnabled,
      state: undefined,
    });
  }
  if (input.stateSource === undefined) {
    throw new PluginEnablementError('managed plugin state requires a state source');
  }
  const state = await input.stateSource.load();
  return resolvePluginEnablement({ codeEnabled: input.codeEnabled, state });
}
