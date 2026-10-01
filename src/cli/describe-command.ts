/**
 * Describe command: compose a single machine-readable snapshot of an app's
 * static definition (no runtime state) so an AI agent can understand an
 * unfamiliar app in one call.
 *
 * ```sh
 * jsails describe --json             # machine-readable JSON
 * jsails describe                     # human-readable summary
 * jsails describe --config jsails.app.js
 * jsails describe --db-config jsails.config.js
 * ```
 *
 * The command is a thin composition over existing pure functions: route
 * discovery, plugin enablement, component introspection, and schema extraction
 * — each delegated to its owning module with no new logic or discovery.
 * Read-only: never imports page/API modules, never opens a connection.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { AppConfigError, loadAppConfig, type ResolvedAppConfig } from '../app/config/index.js';
import { formatError, usageError as reportUsageError } from '../internal/errors.js';
import { resolvePluginEnablement } from '../plugins/enablement.js';
import { discoverRoutes, type RouteManifest, type RouteManifestEntry } from '../routing/routes.js';
import type { JsailsDataSource } from '../database/data-source.js';
import type { SchemaState, TableDefinition } from '../migrations/schema-state.js';
import type { CommandContribution } from '../extensions/plugin-contract.js';

/** Serializable projection of a plugin-contributed command descriptor (no `load` function). */
export interface DescribeCommand {
  readonly name: string;
  readonly summary: string;
  readonly usage?: string;
  readonly audience: string;
  readonly config: string;
}

/** The top-level JSON shape emitted by `--json`. */
export interface DescribeResult {
  readonly app: DescribeApp;
  readonly routes: readonly DescribeRoute[];
  readonly plugins: DescribePlugins;
  readonly commands: readonly DescribeCommand[];
  readonly components: readonly DescribeComponent[];
  readonly schema: DescribeSchema;
}

export interface DescribeApp {
  readonly rootDir: string;
  readonly pages: string;
  readonly api: string;
  readonly public: string;
  readonly out: string;
  readonly host: string;
  readonly port: number;
  readonly healthPath: string | null;
  readonly publicOrigin?: string;
}

export interface DescribeRoute {
  readonly kind: string;
  readonly route: string;
  readonly dynamic: boolean;
  readonly catchAll: boolean;
  readonly params: readonly string[];
  /** Number of layout modules for this route (observability without leaking absolute paths). */
  readonly layoutCount: number;
}

export interface DescribePlugins {
  readonly enabled: readonly string[];
  readonly conflicts: readonly string[];
  readonly disabledManaged: readonly string[];
  readonly sources: DescribePluginSources;
}

export interface DescribePluginSources {
  readonly code: readonly string[];
  readonly managed?: readonly string[];
}

export interface DescribeComponent {
  readonly name: string;
  readonly actions: readonly string[];
  readonly writableKeys: readonly string[];
}

export interface DescribeTable {
  readonly name: string;
  readonly columns: DescribeTableColumn[];
  readonly indexes: DescribeTableIndex[];
  readonly uniques: DescribeTableUnique[];
  readonly foreignKeys: DescribeTableForeignKey[];
}

export interface DescribeTableColumn {
  name: string;
  type: string;
  nullable: boolean;
  primaryKey?: boolean;
  default?: unknown;
  length?: number;
}

export interface DescribeTableIndex {
  name: string;
  columns: string[];
  unique: boolean;
}

export interface DescribeTableUnique {
  name: string;
  columns: string[];
}

export interface DescribeTableForeignKey {
  name: string;
  columns: string[];
  referencedTable: string;
  referencedColumns: string[];
  onDelete?: string;
  onUpdate?: string;
}

export interface DescribeSchema {
  readonly tables: DescribeTable[];
}

/** Options for {@link runDescribe}. */
export interface DescribeOptions {
  readonly json?: boolean;
}

/** CLI input to the describe command. Exported so tests can inject fakes. */
export interface DescribeInput {
  readonly configPath: string;
  /** Path to the compiled migration/JsailsDataSource config module. */
  readonly dbConfigPath?: string;
  readonly options: DescribeOptions;
}

/** Dependency seam for the describe command. */
export interface DescribeDeps {
  /** Load and resolve the app config. */
  loadConfig(configPath: string): Promise<ResolvedAppConfig>;
  /**
   * Build schema from entity metadata without opening a connection.
   * Optional; when absent or returning `undefined`, the schema is empty.
   */
  loadSchema?(dbConfigPath: string): Promise<SchemaState | undefined>;
  stdout(text: string): void;
  stderr(text: string): void;
}

/**
 * Load a JsailsDataSource from a compiled config module, build entity metadata
 * without connecting, and return the portable schema. Returns `undefined` when
 * the file does not exist or cannot be loaded, so the describe command degrades
 * gracefully to empty tables rather than failing.
 */
async function loadSchemaFromConfig(dbConfigPath: string): Promise<SchemaState | undefined> {
  const absolute = resolve(dbConfigPath);
  if (!existsSync(absolute)) return undefined;
  let module: unknown;
  try {
    module = await import(pathToFileURL(absolute).href);
  } catch {
    return undefined;
  }
  const dataSource: unknown = (module as { default?: unknown }).default;
  if (
    dataSource === undefined ||
    dataSource === null ||
    typeof dataSource !== 'object' ||
    typeof (dataSource as { getModelSchema?: unknown }).getModelSchema !== 'function'
  ) {
    return undefined;
  }
  try {
    return await (dataSource as JsailsDataSource).getModelSchema();
  } catch {
    return undefined;
  }
}

const defaultDescribeDeps: DescribeDeps = {
  loadConfig: (configPath) => loadAppConfig(configPath),
  loadSchema: (dbConfigPath) => loadSchemaFromConfig(dbConfigPath),
  stdout: (text) => process.stdout.write(`${text}\n`),
  stderr: (text) => process.stderr.write(`${text}\n`),
};

/** Error types whose messages are safe to echo verbatim. */
function isEchoable(error: unknown): boolean {
  return error instanceof AppConfigError;
}

/**
 * Compose the static definition snapshot from the resolved app config and
 * optional schema, then print it.
 */
export async function runDescribe(
  input: DescribeInput,
  deps: DescribeDeps = defaultDescribeDeps,
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

  const rootDir = config.rootDir;

  // Routes: discovered lexically, never imports page/API modules.
  let manifest: RouteManifest;
  try {
    manifest = discoverRoutes(rootDir, {
      pagesDir: config.pagesDir,
      apiDir: config.apiDir,
    });
  } catch (error) {
    deps.stderr(
      `jsails: ${formatError(error, { allow: isEchoable, fallback: 'route discovery failed' })}`,
    );
    return 1;
  }

  // Plugins: pure enablement from the app config's plugins field.
  const pluginEnablement = resolvePluginEnablement({
    codeEnabled: config.plugins?.enabled,
  });
  // Managed state ids are only available when the config's plugins carry state;
  // the describe command reads only the code list, so managed sources are empty.
  const plugins: DescribePlugins = {
    enabled: freezeCopy(pluginEnablement.enabled),
    conflicts: freezeCopy(pluginEnablement.conflicts),
    disabledManaged: freezeCopy(pluginEnablement.disabledManaged),
    sources: {
      code: freezeCopy(pluginEnablement.enabled),
    },
  };

  // Components: collected from server-components extensions without invoking
  // setup or creating a runtime.
  const components = collectComponents(config);

  // Commands: collected from plugin descriptors without invoking setup or
  // calling any `load()` thunk — the descriptor is pure metadata.
  const commands = collectPluginCommands(config);

  // Schema: extracted from entity metadata without opening a connection.
  let schema: DescribeSchema = { tables: [] };
  if (deps.loadSchema && input.dbConfigPath) {
    try {
      const schemaState = await deps.loadSchema(input.dbConfigPath);
      if (schemaState) {
        schema = convertSchemaState(schemaState);
      }
    } catch {
      // Schema extraction is best-effort: a missing or invalid db config
      // yields empty tables, not a fatal error.
    }
  }

  const result: DescribeResult = {
    app: describeApp(config),
    routes: describeRoutes(manifest.entries),
    plugins,
    commands,
    components,
    schema,
  };

  if (input.options.json === true) {
    deps.stdout(JSON.stringify(result));
  } else {
    for (const line of renderHumanReadable(result)) {
      deps.stdout(line);
    }
  }
  return 0;
}

/** Build the app section from the resolved config. */
function describeApp(config: ResolvedAppConfig): DescribeApp {
  return {
    rootDir: config.rootDir,
    pages: config.pagesDir,
    api: config.apiDir,
    public: config.publicDir,
    out: config.outDir,
    host: config.host,
    port: config.port,
    healthPath: config.healthPath ?? null,
    ...(config.publicOrigin === undefined ? {} : { publicOrigin: config.publicOrigin }),
  };
}

/**
 * Convert route manifest entries to the describe shape, omitting file paths
 * and layout paths. `layoutCount` exposes the number of layout modules for
 * observability without leaking absolute paths.
 */
function describeRoutes(entries: readonly RouteManifestEntry[]): DescribeRoute[] {
  return entries.map((entry) => ({
    kind: entry.kind,
    route: entry.route,
    dynamic: entry.dynamic,
    catchAll: entry.catchAll,
    params: entry.params,
    layoutCount: entry.layouts?.length ?? 0,
  }));
}

/**
 * Collect component metadata from resolved extensions without invoking setup
 * or creating a runtime. Each plugin that exposes a `describe()` descriptor
 * announces its components declaratively; `describe` is pure and never
 * invokes callbacks, signs snapshots, or performs I/O.
 */
function collectComponents(config: ResolvedAppConfig): DescribeComponent[] {
  const results: DescribeComponent[] = [];
  for (const extension of config.extensions) {
    const describe = (
      extension as { describe?: () => { components?: readonly DescribeComponent[] } }
    ).describe;
    if (typeof describe !== 'function') continue;
    const description = describe();
    if (description?.components !== undefined) {
      for (const component of description.components) {
        results.push({
          name: component.name,
          actions: component.actions ?? [],
          writableKeys: component.writableKeys ?? [],
        });
      }
    }
  }
  return results;
}

/**
 * Collect command-contribution descriptors from resolved extensions without
 * invoking setup or resolving any `load()` thunk. Each plugin that exposes a
 * `describe()` descriptor announces its commands declaratively; `describe` is
 * pure and never imports plugin code.
 */
function collectPluginCommands(config: ResolvedAppConfig): DescribeCommand[] {
  const results: DescribeCommand[] = [];
  for (const extension of config.extensions) {
    const describe = (
      extension as { describe?: () => { commands?: readonly CommandContribution[] } }
    ).describe;
    if (typeof describe !== 'function') continue;
    const description = describe();
    if (description?.commands !== undefined) {
      for (const cmd of description.commands) {
        results.push({
          name: cmd.name,
          summary: cmd.summary,
          ...(cmd.usage === undefined ? {} : { usage: cmd.usage }),
          audience: cmd.audience,
          config: cmd.config,
        });
      }
    }
  }
  return results;
}

/** Convert a portable SchemaState into the describe shape. */
function convertSchemaState(state: SchemaState): DescribeSchema {
  const tables: DescribeTable[] = [];
  for (const table of state.tables) {
    tables.push(convertTable(table));
  }
  return { tables };
}

function convertTable(table: TableDefinition): DescribeTable {
  return {
    name: table.name,
    columns: table.columns.map((col) => {
      const c: DescribeTableColumn = {
        name: col.name,
        type: col.type,
        nullable: col.nullable,
      };
      if (col.primaryKey) c.primaryKey = true;
      if (col.default !== undefined) c.default = col.default;
      if (col.length !== undefined) c.length = col.length;
      return c;
    }),
    indexes: (table.indexes ?? []).map((idx) => ({
      name: idx.name,
      columns: idx.columns,
      unique: idx.unique,
    })),
    uniques: (table.uniques ?? []).map((uq) => ({
      name: uq.name,
      columns: uq.columns,
    })),
    foreignKeys: (table.foreignKeys ?? []).map((fk) => {
      const f: DescribeTableForeignKey = {
        name: fk.name,
        columns: fk.columns,
        referencedTable: fk.referencedTable,
        referencedColumns: fk.referencedColumns,
      };
      if (fk.onDelete) f.onDelete = fk.onDelete;
      if (fk.onUpdate) f.onUpdate = fk.onUpdate;
      return f;
    }),
  };
}

/** Render a human-readable summary of the describe result. */
function renderHumanReadable(result: DescribeResult): string[] {
  const lines: string[] = [];

  lines.push('Application');
  lines.push('-----------');
  lines.push(`  root:        ${result.app.rootDir}`);
  lines.push(`  host:        ${result.app.host}:${result.app.port}`);
  if (result.app.publicOrigin) {
    lines.push(`  origin:      ${result.app.publicOrigin}`);
  }
  lines.push(`  health:      ${result.app.healthPath ?? '(disabled)'}`);
  lines.push(`  pages:       ${result.app.pages}`);
  lines.push(`  api:         ${result.app.api}`);
  lines.push(`  public:      ${result.app.public}`);
  lines.push(`  out:         ${result.app.out}`);
  lines.push('');

  lines.push(`Routes (${result.routes.length})`);
  lines.push('------');
  if (result.routes.length === 0) {
    lines.push('  (none)');
  } else {
    for (const route of result.routes) {
      const params = route.params.length > 0 ? ` (params: ${route.params.join(', ')})` : '';
      lines.push(`  ${route.route.padEnd(24)} ${route.kind}${params}`);
    }
  }
  lines.push('');

  lines.push(`Plugins (${result.plugins.enabled.length} enabled)`);
  lines.push('-------');
  if (result.plugins.enabled.length === 0) {
    lines.push('  (none)');
  } else {
    for (const id of result.plugins.enabled) {
      lines.push(`  ${id}`);
    }
  }
  if (result.plugins.conflicts.length > 0) {
    lines.push(`  conflicts: ${result.plugins.conflicts.join(', ')}`);
  }
  lines.push('');

  lines.push(`Commands (${result.commands.length})`);
  lines.push('--------');
  if (result.commands.length === 0) {
    lines.push('  (none)');
  } else {
    for (const cmd of result.commands) {
      const configTag = cmd.config !== 'none' ? ` [config: ${cmd.config}]` : '';
      lines.push(`  ${cmd.name.padEnd(24)} ${cmd.summary}${configTag}`);
    }
  }
  lines.push('');

  lines.push(`Components (${result.components.length})`);
  lines.push('----------');
  if (result.components.length === 0) {
    lines.push('  (none)');
  } else {
    for (const component of result.components) {
      const actions =
        component.actions.length > 0 ? ` [actions: ${component.actions.join(', ')}]` : '';
      lines.push(`  ${component.name}${actions}`);
    }
  }
  lines.push('');

  lines.push(`Schema (${result.schema.tables.length} tables)`);
  lines.push('------');
  if (result.schema.tables.length === 0) {
    lines.push('  (no entity tables declared)');
  } else {
    for (const table of result.schema.tables) {
      const pk = table.columns.find((c) => c.primaryKey);
      const pkLabel = pk ? ` [pk: ${pk.name}]` : '';
      lines.push(
        `  ${table.name}${pkLabel} (${table.columns.length} columns, ` +
          `${table.indexes.length} indexes, ${table.foreignKeys.length} FKs)`,
      );
    }
  }

  return lines;
}

/** Create a frozen copy of a sorted string list. */
function freezeCopy(list: readonly string[]): readonly string[] {
  return Object.freeze([...list]);
}

/** Render usage text for `describe --help`. */
function describeHelp(): string {
  return `describe - compose a machine-readable snapshot of the app's definition

Usage:
  jsails describe [options]

Options:
  -c, --config <path>     Path to the app config module (default: jsails.app.js)
      --db-config <path>  Path to the database config module (default: jsails.config.js)
      --json              Emit a single JSON line instead of a summary
  -h, --help              Show this help

Read-only: never imports page/API modules, never opens a connection.
The schema section is extracted from entity metadata without connecting.
`;
}

/**
 * Parse and run `jsails describe` from the raw arguments after the command name.
 * Owns its own argument parsing like `jamal`/`plugins`/`inspect`, so it is
 * routed before the shared `parseArgs` flag-gating in `cli.ts`.
 */
export async function runDescribeCommand(
  args: readonly string[],
  deps?: DescribeDeps,
): Promise<number> {
  let configPath = 'jsails.app.js';
  let dbConfigPath: string | undefined;
  let json = false;
  let help = false;

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
          (line) => (deps?.stderr ?? defaultDescribeDeps.stderr)(line),
          'Run "jsails describe --help" for usage.',
          '--config requires a value',
        );
      }
      configPath = value;
      index += 1;
    } else if (token.startsWith('--config=')) {
      configPath = token.slice('--config='.length);
    } else if (token === '--db-config') {
      const value = args[index + 1];
      if (value === undefined) {
        return reportUsageError(
          (line) => (deps?.stderr ?? defaultDescribeDeps.stderr)(line),
          'Run "jsails describe --help" for usage.',
          '--db-config requires a value',
        );
      }
      dbConfigPath = value;
      index += 1;
    } else if (token.startsWith('--db-config=')) {
      dbConfigPath = token.slice('--db-config='.length);
    } else if (token.startsWith('-')) {
      return reportUsageError(
        (line) => (deps?.stderr ?? defaultDescribeDeps.stderr)(line),
        'Run "jsails describe --help" for usage.',
        `unknown option ${JSON.stringify(token)}`,
      );
    } else {
      return reportUsageError(
        (line) => (deps?.stderr ?? defaultDescribeDeps.stderr)(line),
        'Run "jsails describe --help" for usage.',
        `unexpected argument: ${token}`,
      );
    }
  }

  if (help) {
    (deps?.stdout ?? defaultDescribeDeps.stdout)(describeHelp());
    return 0;
  }

  return runDescribe({ configPath, dbConfigPath, options: { json } }, deps);
}
