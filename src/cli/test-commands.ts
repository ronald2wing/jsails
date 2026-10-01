/**
 * `jsails test` — transactional database testing (Laravel/Rails ergonomics).
 *
 * One command boots the services (`jamal up`), isolates a `*_test` database via
 * the `DATABASE_NAME` environment convention, reconciles the schema, and runs
 * `node --test` under `NODE_ENV=test`. Test files opt into per-test rollback
 * isolation with `withTestTransaction` (see `jsails/testing`) — the
 * `DatabaseTransactions` pattern — so each test's rows are discarded afterward.
 *
 * The development database is never touched: the command re-reads the config
 * with `DATABASE_NAME` overridden to `<database>_test`.
 */

import { spawn } from 'node:child_process';

import { loadDataSourceConfig } from './config-loader.js';
import { reconcileDataSource } from '../migrations/reconciler.js';
import { executeSchemaPlan } from '../migrations/schema-executor.js';
import { formatError } from '../internal/errors.js';

/** Parsed `jsails test` values. */
export interface TestValues {
  readonly config?: string;
  readonly noServices: boolean;
  readonly watch: boolean;
  readonly testFile?: string;
}

/** Dependency seam so boot/run are testable without Docker/Node. */
export interface TestCommandDeps {
  readonly cwd: string;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  readonly env: Record<string, string | undefined>;
  readonly runServices: (cwd: string) => Promise<number>;
  /** Load the data source by config path; injectable for tests. */
  readonly loadDataSource: (configPath: string) => Promise<TestDataSource>;
  /** Initialize + reconcile the test data source; injectable for tests. */
  readonly reconcileDataSource: (dataSource: TestDataSource) => Promise<void>;
  readonly runTests: (
    args: readonly string[],
    env: Readonly<Record<string, string>>,
  ) => Promise<number>;
}

/**
 * The data source the command loads. The default seam returns a real
 * `JsailsDataSource`; tests inject a minimal fake via `as TestDataSource`.
 */
export type TestDataSource = import('../database/data-source.js').JsailsDataSource;

/** Default seam: boot via `jamal up`, run the real `node --test` child. */
export const defaultTestCommandDeps: TestCommandDeps = {
  cwd: process.cwd(),
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
  env: process.env,
  runServices: async () => {
    const { runJamalCommand } = await import('../jamal/command.js');
    return runJamalCommand(['up', '--detach']);
  },
  loadDataSource: (configPath) => loadDataSourceConfig(configPath),
  reconcileDataSource: async (dataSource) => {
    const plan = await reconcileDataSource(dataSource, { allowDestructive: true });
    await dataSource.initialize();
    await executeSchemaPlan(dataSource, plan.operations);
  },
  runTests: (args, env) =>
    new Promise<number>((resolveDone) => {
      const child = spawn(process.execPath, ['--test', ...args], {
        cwd: process.cwd(),
        stdio: 'inherit',
        env: { ...process.env, ...env },
      });
      child.on('exit', (code) => resolveDone(code ?? 0));
    }),
};

const TEST_ENV_DB_NAME = 'DATABASE_NAME';

/**
 * Derive the `*_test` database name from the configured database. The
 * development database is never used by `jsails test`.
 */
export function deriveTestDatabaseName(database: string): string {
  return database === '' ? 'test' : `${database}_test`;
}

/**
 * Run `jsails test`. Returns the process exit code for `node --test`.
 */
export async function runTestCommand(
  values: TestValues,
  deps: TestCommandDeps = defaultTestCommandDeps,
): Promise<number> {
  const configPath = values.config ?? 'jsails.config.js';

  // 1. Boot services (MariaDB/Valkey) unless the caller opts out.
  if (!values.noServices) {
    deps.stdout('Starting services (jamal up)…');
    const code = await deps.runServices(deps.cwd);
    if (code !== 0) {
      deps.stderr('jsails: jamal up failed — is Docker running?');
      deps.stderr(
        'jsails: pass --no-services to skip service boot (the test DB must already exist).',
      );
      return 1;
    }
  }

  // 2. Load the dev data source once to learn the database name, then re-load
  //    with DATABASE_NAME overridden to the *_test convention. The config module
  //    reads DATABASE_NAME via readDatabaseEnvironment, so this isolates tests
  //    without mutating the returned data source.
  const devDataSource = await deps.loadDataSource(configPath);
  const devDatabase = devDataSource.options.database;
  const baseName = typeof devDatabase === 'string' ? devDatabase : 'jsails';
  const testDatabase = baseName === '' ? 'test' : `${baseName}_test`;

  deps.env[TEST_ENV_DB_NAME] = testDatabase;
  const dataSource = await deps.loadDataSource(configPath);
  deps.stdout(`Test database: ${testDatabase}`);

  // 3. Initialize + reconcile the test database schema once.
  try {
    await deps.reconcileDataSource(dataSource);
  } catch (error) {
    deps.stderr(`jsails: ${formatError(error)}`);
    return 1;
  }

  // 4. Run the suite, exposing the test connection to the child process.
  const childEnv: Record<string, string> = {
    NODE_ENV: 'test',
    [TEST_ENV_DB_NAME]: testDatabase,
  };
  const args: string[] = [];
  if (values.watch) args.push('--watch');
  if (values.testFile !== undefined) args.push(values.testFile);

  const code = await deps.runTests(args, childEnv);
  await dataSource.destroy();
  return code;
}
