import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import {
  BUILTIN_DEPLOYMENT_GENERATOR_IDS,
  BaseEntity,
  BROADCAST_PATH,
  CliCommandError,
  DEFAULT_RUNTIME_CONFIG_PATH,
  DatabaseConfigError,
  DeploymentRegistryError,
  EnvironmentError,
  FileDataSource,
  FileDataSourceError,
  JobOptionsError,
  JobPayloadError,
  JobRuntimeClosedError,
  JobRuntimeError,
  JobUnknownError,
  JsailsDataSource,
  MigrationError,
  PageRenderError,
  RouteManifestError,
  RuntimeConfigError,
  ScheduleError,
  StaticSiteError,
  UnsupportedSchemaError,
  ValidationError,
  ValkeyConfigError,
  attachBroadcast,
  collectConfigCommands,
  createApp,
  createBullMQAdapter,
  createCliCommandRegistry,
  createDeploymentGeneratorRegistry,
  createHttpServer,
  createJobQueue,
  createJobsRuntime,
  createRegistry,
  createResourceHandlers,
  createSocketIOBroadcastAdapter,
  defineDeploymentGenerator,
  defineJob,
  defineSerializer,
  discoverRoutes,
  generateDevDatabaseConfig,
  generateDevValkeyConfig,
  generateKamalDatabaseConfig,
  generateKamalValkeyConfig,
  generateMigration,
  generateOnceConfig,
  generateStaticSite,
  getMigrationStatus,
  loadPageModule,
  migrate,
  OnceConfigError,
  readDatabaseEnvironment,
  readEnvironment,
  readJson,
  readValkeyEnvironment,
  renderRoute,
  replayMigrationHistory,
  routeToOutputPath,
  startJobWorker,
  substituteRouteParams,
  upsertSchedules,
  validateJobRuntimeAdapter,
  validatePayload,
  validateRuntimeConfig,
} from '../src/index.js';
import {
  ServerComponentDefinitionError,
  ServerComponentsError,
  defineAction,
  defineServerComponent,
  renderServerComponent,
  renderServerComponentHtml,
  serverComponents,
  type ServerComponentDefinition,
  type ServerComponentsOptions,
} from '../src/index.js';
import type {
  AddColumnOperation,
  AlterColumnOperation,
  ApiHandler,
  ApiMethod,
  ApiModule,
  Authorize,
  AppBroadcastConfig,
  AttachBroadcastOptions,
  AutodetectOptions,
  Broadcast,
  BroadcastAdapter,
  BroadcastHandle,
  BroadcastHandshake,
  BroadcastOptions,
  BuiltinDeploymentGeneratorId,
  CliCommand,
  CliCommandContext,
  CliCommandErrorCode,
  CliCommandMetadata,
  CliCommandRegistry,
  CliCommandRegistryOptions,
  CollectionHandlers,
  CreateBullMQAdapterOptions,
  CreateJobsRuntimeOptions,
  DeploymentFileMap,
  DeploymentGenerator,
  DeploymentGeneratorContext,
  DeploymentGeneratorRegistry,
  DeploymentGeneratorRegistryOptions,
  JobAdapterContext,
  JobDispatchOptions,
  JobRuntimeAdapter,
  JobsRuntime,
  ProcessJob,
  RuntimeJob,
  RuntimeProducer,
  RuntimeWorker,
  ColumnDefinition,
  ColumnRenameHint,
  CreateAppOptions,
  CreateHttpServerOptions,
  CreateJobQueueOptions,
  CreateResourceHandlersOptions,
  CreateTableOperation,
  DatabaseDriver,
  DatabaseEnvironment,
  DatabaseType,
  DetailHandlers,
  DevDatabaseFiles,
  DevDatabaseOptions,
  DiscoverRoutesOptions,
  DropColumnOperation,
  DropTableOperation,
  EnvironmentIssue,
  FieldOptions,
  FieldPath,
  FileDataSourceOptions,
  GenerateStaticSiteOptions,
  GenerateStaticSiteResult,
  Infer,
  JobContext,
  JobDefinition,
  JobHandler,
  JobQueue,
  JobQueueHandle,
  JobRegistry,
  JobWorker,
  JobWorkerHandle,
  JsonObject,
  JsonValue,
  JsailsDataSourceOptions,
  JsailsSupportedDriver,
  KamalDatabaseFiles,
  KamalDatabaseOptions,
  KamalValkeyFiles,
  KamalValkeyOptions,
  MaybePromise,
  MigrationDataSource,
  MigrationDefinition,
  MigrationHistory,
  MigrationRunResult,
  MigrationStatus,
  NormalizedPagination,
  OnceConfigFiles,
  OnceConfigOptions,
  Operation,
  Page,
  PageComponent,
  PageModule,
  PageProps,
  PaginationOptions,
  QueryAdapter,
  ReadOutput,
  RenderPage,
  RenderRouteOptions,
  RenameColumnOperation,
  ResolveSession,
  ResourceAction,
  ResourceAuthorize,
  ResourceHandler,
  ResourceHandlers,
  ResourceStore,
  ResolvedRuntimeConfig,
  RouteManifest,
  RouteManifestEntry,
  RuntimeConfig,
  ScalarColumnType,
  ScalarLiteral,
  ScheduleSpec,
  Schema,
  SchemaState,
  SchedulerQueue,
  Serializer,
  SerializerField,
  SerializerFields,
  Session,
  SessionStore,
  StartJobWorkerOptions,
  TableDefinition,
  ValidateOptions,
  ValidationIssue,
  ValkeyConfigFiles,
  ValkeyConfigOptions,
  ValkeyEnvironment,
  WorkerJob,
  WriteInput,
  RequestContext,
} from '../src/index.js';
import * as apiBarrel from '../src/api/index.js';
import {
  AppConfigError,
  DEFAULT_APP_CONFIG_PATH,
  createApplication,
  createServiceRegistry,
  createServiceToken,
  loadAppConfig,
  preactPageRenderer,
  runExtensions,
  ServiceRegistryError,
  validateAppConfig,
} from '../src/index.js';
import type {
  AppBroadcastOptions,
  AppCleanup,
  AppConfigLoadOptions,
  AppConfigValidationOptions,
  Application,
  AppSetup,
  ExtensionCleanup,
  ExtensionContext,
  ExtensionRuntime,
  HttpExtensionHook,
  JsailsAppConfig,
  JsailsExtension,
  PageRenderer,
  PageRenderOptions,
  ResolvedAppConfig,
  ServiceRegistrar,
  ServiceRegistry,
  ServiceRegistryController,
  ServiceRegistryErrorCode,
  ServiceToken,
  ServeHandle,
} from '../src/index.js';

// Type-only author interfaces exposed by the clean `jsails/extensions` subpath.
// A static type import here proves the subpath carries the plugin contracts
// without pulling in a provider runtime library.
import type {
  BroadcastAdapter as ExtBroadcastAdapter,
  BroadcastHandle as ExtBroadcastHandle,
  CliCommand as ExtCliCommand,
  CliCommandContext as ExtCliCommandContext,
  DeploymentFileMap as ExtDeploymentFileMap,
  DeploymentGenerator as ExtDeploymentGenerator,
  DeploymentGeneratorContext as ExtDeploymentGeneratorContext,
  JobAdapterContext as ExtJobAdapterContext,
  JobDispatchOptions as ExtJobDispatchOptions,
  JobRuntimeAdapter as ExtJobRuntimeAdapter,
  ProcessJob as ExtProcessJob,
  RuntimeJob as ExtRuntimeJob,
  RuntimeProducer as ExtRuntimeProducer,
  RuntimeWorker as ExtRuntimeWorker,
} from '../src/extensions/index.js';

/**
 * A unique BaseEntity subclass so the public FileDataSource smoke test binds
 * its own entity and does not leak a data-source binding to another test.
 */
@Entity('public_api_widgets')
class PublicApiWidget extends BaseEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'varchar', length: 64, nullable: false })
  name!: string;

  @Column({ type: 'boolean', default: true })
  active!: boolean;
}

describe('public API surface', () => {
  it('exposes the supported runtime values', () => {
    assert.equal(typeof BaseEntity, 'function');
    assert.equal(typeof JsailsDataSource, 'function');
    assert.equal(typeof generateMigration, 'function');
    assert.equal(typeof replayMigrationHistory, 'function');
    assert.equal(typeof migrate, 'function');
    assert.equal(typeof getMigrationStatus, 'function');
    assert.equal(typeof MigrationError, 'function');
    assert.equal(typeof UnsupportedSchemaError, 'function');
    assert.ok(new UnsupportedSchemaError('x') instanceof MigrationError);
  });

  it('exposes the core types for consumers', () => {
    const column: ColumnDefinition = {
      name: 'id',
      type: 'integer',
      nullable: false,
      primaryKey: true,
    };
    const table: TableDefinition = { name: 'users', columns: [column] };
    const schema: SchemaState = { tables: [table] };
    const operation: Operation = { kind: 'create_table', table };
    const definition: MigrationDefinition = {
      name: 'm',
      dependencies: [],
      operations: [operation],
    };
    const history: MigrationHistory = [definition];
    const options: AutodetectOptions = { allowDestructive: false };
    const scalar: ScalarColumnType = 'integer';
    const literal: ScalarLiteral = 1;
    const driver: JsailsSupportedDriver = 'postgres';
    const status: MigrationStatus = { tableExists: false, applied: [], pending: [], dirty: [] };
    const runResult: MigrationRunResult = { applied: [] };
    const hint: ColumnRenameHint = { table: 'users', from: 'a', to: 'b' };
    const dataSourceOptions = {} as JsailsDataSourceOptions;
    const runner = {} as MigrationDataSource;

    void [
      column,
      table,
      schema,
      operation,
      definition,
      history,
      options,
      scalar,
      literal,
      driver,
      status,
      runResult,
      hint,
      dataSourceOptions,
      runner,
    ];
  });

  it('exposes every operation kind type', () => {
    const kinds: Record<string, Operation> = {
      create: {
        kind: 'create_table',
        table: { name: 't', columns: [] },
      } satisfies CreateTableOperation,
      drop: { kind: 'drop_table', table: { name: 't', columns: [] } } satisfies DropTableOperation,
      add: {
        kind: 'add_column',
        table: 't',
        column: { name: 'c', type: 'integer', nullable: true },
      } satisfies AddColumnOperation,
      dropCol: {
        kind: 'drop_column',
        table: 't',
        column: { name: 'c', type: 'integer', nullable: true },
      } satisfies DropColumnOperation,
      rename: {
        kind: 'rename_column',
        table: 't',
        from: 'a',
        to: 'b',
      } satisfies RenameColumnOperation,
      alter: {
        kind: 'alter_column',
        table: 't',
        column: { name: 'c', type: 'text', nullable: true },
        previous: { name: 'c', type: 'varchar', length: 10, nullable: true },
      } satisfies AlterColumnOperation,
    };
    assert.equal(Object.keys(kinds).length, 6);
  });
});

describe('public API surface: jobs', () => {
  it('exposes the jobs runtime values', () => {
    assert.equal(typeof defineJob, 'function');
    assert.equal(typeof createRegistry, 'function');
    assert.equal(typeof createJobQueue, 'function');
    assert.equal(typeof startJobWorker, 'function');
    assert.equal(typeof upsertSchedules, 'function');
    assert.equal(typeof validatePayload, 'function');
    assert.equal(typeof DEFAULT_RUNTIME_CONFIG_PATH, 'string');
  });

  it('exposes the jobs error classes with their names', () => {
    assert.ok(new JobPayloadError('j', 'msg') instanceof Error);
    assert.equal(new JobPayloadError('j', 'msg').name, 'JobPayloadError');
    assert.ok(new JobUnknownError('j') instanceof Error);
    assert.ok(new JobOptionsError('msg') instanceof Error);
    assert.ok(new ScheduleError('msg') instanceof Error);
    assert.ok(new RuntimeConfigError('msg') instanceof Error);
  });

  it('exposes the jobs types for consumers', () => {
    const registry = {} as JobRegistry;
    const definition = {} as JobDefinition;
    const handler: JobHandler<{ n: number }> = async (_data) => {};
    const context = {} as JobContext;
    const queue = {} as JobQueue;
    const handle = {} as JobQueueHandle;
    const worker = {} as JobWorker;
    const workerHandle = {} as JobWorkerHandle;
    const schedule: ScheduleSpec = { id: 's', job: 'j', everyMs: 60000 };
    const schedulerQueue = {} as SchedulerQueue;
    const queueOptions = {} as CreateJobQueueOptions;
    const workerOptions = {} as StartJobWorkerOptions;
    const workerJob = {} as WorkerJob;
    const runtime = {} as RuntimeConfig;
    const resolved = {} as ResolvedRuntimeConfig;

    void [
      registry,
      definition,
      handler,
      context,
      queue,
      handle,
      worker,
      workerHandle,
      schedule,
      schedulerQueue,
      queueOptions,
      workerOptions,
      workerJob,
      runtime,
      resolved,
    ];
  });
});

describe('public API surface: jobs runtime adapter', () => {
  /** A minimal fake registry: the runtime only calls `schema.safeParse`. */
  function fakeRegistry(): JobRegistry {
    return {
      ping: {
        schema: { safeParse: (value: unknown) => ({ success: true, data: value }) },
        handler: async () => {},
      },
    } as unknown as JobRegistry;
  }

  it('exposes the neutral controller, adapter validator, errors, and BullMQ adapter', () => {
    assert.equal(typeof createJobsRuntime, 'function');
    assert.equal(typeof validateJobRuntimeAdapter, 'function');
    assert.equal(typeof createBullMQAdapter, 'function');
    assert.ok(new JobRuntimeError('m') instanceof Error);
    assert.ok(new JobRuntimeClosedError() instanceof JobRuntimeError);

    const bull = createBullMQAdapter({ redisUrl: 'redis://127.0.0.1:6379' });
    assert.equal(bull.name, 'bullmq');
    // Options fail fast; no Queue/Worker is constructed and nothing connects.
    assert.throws(() => createBullMQAdapter({ redisUrl: 'http://not-redis' }), TypeError);
  });

  it('runs a fake backend through the neutral contract and rejects a bad adapter', async () => {
    const dispatched: Array<{ name: string; data: unknown }> = [];
    let workerClosed = false;
    const adapter: JobRuntimeAdapter = {
      name: 'fake',
      createProducer: () => ({
        dispatch: async (name, data) => {
          dispatched.push({ name, data });
          return 'queued';
        },
        close: async () => {},
      }),
      createWorker: () => ({
        close: async () => {
          workerClosed = true;
        },
      }),
    };

    assert.throws(() => validateJobRuntimeAdapter({ name: 'broken' }), TypeError);
    assert.doesNotThrow(() => validateJobRuntimeAdapter(adapter));

    const runtime = createJobsRuntime({ registry: fakeRegistry(), adapter });
    assert.equal(await runtime.dispatch('ping', { n: 1 }), 'queued');
    assert.deepEqual(dispatched, [{ name: 'ping', data: { n: 1 } }]);
    await runtime.startWorker();
    await runtime.close();
    assert.equal(workerClosed, true);
  });

  it('selects a custom runtime adapter with no URL via validateRuntimeConfig', () => {
    const adapter: JobRuntimeAdapter = {
      name: 'no-url',
      createProducer: () => ({ dispatch: async () => undefined, close: async () => {} }),
      createWorker: () => ({ close: async () => {} }),
    };

    const resolved = validateRuntimeConfig({ registry: fakeRegistry(), adapter });
    assert.equal(resolved.selectedAdapter, adapter);
    assert.equal(resolved.redisUrl, undefined);
    assert.equal(resolved.queueName, 'default');
  });

  it('exposes the job runtime adapter types for consumers', () => {
    const adapter = {} as JobRuntimeAdapter;
    const context = {} as JobAdapterContext;
    const producer = {} as RuntimeProducer;
    const worker = {} as RuntimeWorker;
    const job = {} as RuntimeJob;
    const processJob: ProcessJob = async () => undefined;
    const dispatchOptions: JobDispatchOptions = {};
    const runtimeOptions = {} as CreateJobsRuntimeOptions;
    const runtime = {} as JobsRuntime;
    const bullOptions: CreateBullMQAdapterOptions = { redisUrl: 'redis://x' };

    void [
      adapter,
      context,
      producer,
      worker,
      job,
      processJob,
      dispatchOptions,
      runtimeOptions,
      runtime,
      bullOptions,
    ];
  });
});

describe('public API surface: broadcast', () => {
  it('exposes the broadcast server runtime values', () => {
    assert.equal(typeof attachBroadcast, 'function');
    assert.equal(typeof BROADCAST_PATH, 'string');
  });

  it('exposes the pluggable adapter factory and contract types', () => {
    assert.equal(typeof createSocketIOBroadcastAdapter, 'function');
    const socketAdapter = createSocketIOBroadcastAdapter({
      allowedOrigins: ['https://app.example'],
      authenticate: () => 'user',
    });
    assert.equal(socketAdapter.name, 'socket.io');
    assert.equal(typeof socketAdapter.attach, 'function');

    const custom = {} as BroadcastAdapter;
    const handle = {} as BroadcastHandle;
    const attachOptions: AttachBroadcastOptions = { adapter: custom };
    const appBroadcast = {} as AppBroadcastConfig;

    void [handle, attachOptions, appBroadcast];
  });

  it('exposes the broadcast types for consumers', () => {
    const broadcast = {} as Broadcast;
    const handshake = {} as BroadcastHandshake;
    const options = {} as BroadcastOptions;
    const maybe: MaybePromise<string> = 'x';

    void [broadcast, handshake, options, maybe];
  });
});

describe('public API surface: deploy generators', () => {
  it('exposes the five deploy generators as functions', () => {
    assert.equal(typeof generateDevValkeyConfig, 'function');
    assert.equal(typeof generateKamalValkeyConfig, 'function');
    assert.equal(typeof generateDevDatabaseConfig, 'function');
    assert.equal(typeof generateKamalDatabaseConfig, 'function');
    assert.equal(typeof generateOnceConfig, 'function');
    assert.ok(new ValkeyConfigError('m') instanceof Error);
    assert.ok(new DatabaseConfigError('m') instanceof Error);
    assert.ok(new OnceConfigError('m') instanceof Error);
  });

  it('generates the dev Valkey files as strings with defaults (no connection)', () => {
    const files = generateDevValkeyConfig();
    assert.equal(typeof files.compose, 'string');
    assert.equal(typeof files.valkeyConfig, 'string');
    assert.equal(typeof files.startupScript, 'string');
    assert.equal(typeof files.envExample, 'string');
    assert.match(files.compose, /services:/);
  });

  it('generates the dev database files as strings with defaults (no connection)', () => {
    const files = generateDevDatabaseConfig();
    assert.equal(typeof files.compose, 'string');
    assert.equal(typeof files.envExample, 'string');
    assert.match(files.compose, /services:/);
  });

  it('generates the Kamal Valkey files as strings for a minimal single host', () => {
    const files = generateKamalValkeyConfig({
      service: 'app',
      image: 'ghcr.io/org/app:1.0.0',
      registry: { server: 'ghcr.io' },
      hosts: { web: ['1.2.3.4'], worker: ['1.2.3.4'] },
      valkeyHost: '1.2.3.4',
    });
    assert.equal(typeof files.deploy, 'string');
    assert.equal(typeof files.valkeyConfig, 'string');
    assert.equal(typeof files.startupScript, 'string');
    assert.equal(typeof files.secretsExample, 'string');
    assert.match(files.deploy, /accessories:/);
  });

  it('generates the Kamal database files as strings for a minimal host', () => {
    const files = generateKamalDatabaseConfig({
      service: 'app',
      host: '1.2.3.4',
      databaseName: 'prod',
      username: 'app',
    });
    assert.equal(typeof files.accessory, 'string');
    assert.equal(typeof files.envExample, 'string');
    assert.equal(typeof files.secretsExample, 'string');
    assert.match(files.accessory, /accessories:/);
  });

  it('exposes the deploy config types for consumers', () => {
    const valkeyOptions = {} as ValkeyConfigOptions;
    const valkeyFiles = {} as ValkeyConfigFiles;
    const kamalValkeyOptions = {} as KamalValkeyOptions;
    const kamalValkeyFiles = {} as KamalValkeyFiles;
    const devDbOptions = {} as DevDatabaseOptions;
    const devDbFiles = {} as DevDatabaseFiles;
    const kamalDbOptions = {} as KamalDatabaseOptions;
    const kamalDbFiles = {} as KamalDatabaseFiles;
    const driver: DatabaseDriver = 'mariadb';
    const onceOptions = {} as OnceConfigOptions;
    const onceFiles = {} as OnceConfigFiles;

    void [
      valkeyOptions,
      valkeyFiles,
      kamalValkeyOptions,
      kamalValkeyFiles,
      devDbOptions,
      devDbFiles,
      kamalDbOptions,
      kamalDbFiles,
      driver,
      onceOptions,
      onceFiles,
    ];
  });
});

describe('public API surface: deployment generator registry', () => {
  it('exposes the registry, define helper, error, and built-in ids', () => {
    assert.equal(typeof createDeploymentGeneratorRegistry, 'function');
    assert.equal(typeof defineDeploymentGenerator, 'function');
    assert.ok(new DeploymentRegistryError('m') instanceof Error);
    assert.deepEqual(BUILTIN_DEPLOYMENT_GENERATOR_IDS, [
      'valkey-dev',
      'valkey-kamal',
      'database-dev',
      'database-kamal',
      'once',
      'vercel-static',
      'netlify-static',
      'cloudflare-pages',
      'github-pages',
    ]);
  });

  it('runs a pure custom generator through a custom-only registry', async () => {
    const generator = defineDeploymentGenerator<{ name: string }>('sample', (input) => ({
      files: { 'sample.txt': `hello ${input.name}` },
    }));
    const registry = createDeploymentGeneratorRegistry({
      includeBuiltins: false,
      generators: [generator],
    });

    assert.deepEqual(registry.list(), ['sample']);
    const result = await registry.generate('sample', { name: 'world' });
    assert.equal(result.files['sample.txt'], 'hello world');
  });

  it('exposes the deployment generator types for consumers', () => {
    const id: BuiltinDeploymentGeneratorId = 'valkey-dev';
    const generator = {} as DeploymentGenerator;
    const context: DeploymentGeneratorContext = {};
    const files = {} as DeploymentFileMap;
    const registry = {} as DeploymentGeneratorRegistry;
    const options: DeploymentGeneratorRegistryOptions = { includeBuiltins: false };

    void [id, generator, context, files, registry, options];
  });
});

describe('public API surface: user-defined CLI commands', () => {
  it('exposes the pure command registry, config collector, and error', () => {
    assert.equal(typeof createCliCommandRegistry, 'function');
    assert.equal(typeof collectConfigCommands, 'function');
    assert.ok(new CliCommandError('invalid_command', 'm') instanceof Error);
  });

  it('registers a command and collects commands from a raw config', async () => {
    const registry = createCliCommandRegistry([
      { name: 'hello', summary: 'say hello', run: () => 0 },
    ]);
    assert.equal(registry.list()[0]?.name, 'hello');
    assert.equal(registry.has('hello'), true);
    assert.equal(
      await registry.run('hello', [], {
        configPath: 'x',
        cwd: '.',
        stdout: () => {},
        stderr: () => {},
      }),
      0,
    );

    const collected = collectConfigCommands({
      commands: [{ name: 'extra', summary: 'x', run: () => {} }],
      extensions: [],
    });
    assert.equal(collected.length, 1);
    assert.equal(collected[0]?.name, 'extra');

    // A builtin name is reserved and cannot be shadowed.
    assert.throws(
      () => createCliCommandRegistry([{ name: 'build', summary: 'x', run: () => {} }]),
      CliCommandError,
    );
  });

  it('exposes the CLI command types for consumers', () => {
    const command = {} as CliCommand;
    const context = {} as CliCommandContext;
    const metadata: CliCommandMetadata = { name: 'x', summary: 'y' };
    const registry = {} as CliCommandRegistry;
    const code: CliCommandErrorCode = 'reserved_name';
    const options: CliCommandRegistryOptions = { reservedNames: ['x'] };

    void [command, context, metadata, registry, code, options];
  });
});

describe('public API surface: environment', () => {
  it('exposes the environment readers and error class', () => {
    assert.equal(typeof readEnvironment, 'function');
    assert.equal(typeof readDatabaseEnvironment, 'function');
    assert.equal(typeof readValkeyEnvironment, 'function');
    assert.ok(new EnvironmentError([]) instanceof Error);
    assert.equal(new EnvironmentError([]).name, 'EnvironmentError');
  });

  it('reads isolated database and Valkey config without any services', () => {
    const database: DatabaseEnvironment = readDatabaseEnvironment({
      DATABASE_TYPE: 'postgres',
      DATABASE_HOST: 'db.internal',
      DATABASE_PORT: '5432',
      DATABASE_USER: 'app',
      DATABASE_PASSWORD: 'secret',
      DATABASE_NAME: 'app_db',
    });
    assert.equal(database.type, 'postgres');
    assert.equal(database.port, 5432);

    const valkey: ValkeyEnvironment = readValkeyEnvironment({
      VALKEY_URL: 'redis://valkey:6379/0',
    });
    assert.equal(valkey.redisUrl, 'redis://valkey:6379/0');
  });

  it('exposes the environment types for consumers', () => {
    const driver: DatabaseType = 'mariadb';
    const database = {} as DatabaseEnvironment;
    const valkey = {} as ValkeyEnvironment;
    const issue: EnvironmentIssue = { path: [], code: 'required', message: 'x' };

    void [driver, database, valkey, issue];
  });
});

describe('public API surface: FileDataSource', () => {
  it('exposes the read-only data source and its error', () => {
    assert.equal(typeof FileDataSource, 'function');
    assert.equal(typeof FileDataSourceError, 'function');
    assert.ok(new FileDataSourceError('x') instanceof Error);
    assert.equal(new FileDataSourceError('x').name, 'FileDataSourceError');
  });

  it('queries seeded rows through the public root entry', async () => {
    const options: FileDataSourceOptions = {
      models: [{ entity: PublicApiWidget, rows: [{ name: 'alpha' }, { name: 'beta' }] }],
    };
    const source = await FileDataSource.create(options);
    try {
      assert.equal(source.isReadOnly, true);
      assert.equal(source.isInitialized, true);

      const found = await PublicApiWidget.findOneBy({ name: 'alpha' });
      assert.equal(found?.name, 'alpha');
      assert.equal(found?.active, true);
      assert.equal(await PublicApiWidget.count(), 2);
    } finally {
      await source.close();
    }
  });
});

describe('public API surface: routing, pages, and server', () => {
  it('exposes the route, page, static-site, and server functions', () => {
    assert.equal(typeof discoverRoutes, 'function');
    assert.equal(typeof routeToOutputPath, 'function');
    assert.equal(typeof substituteRouteParams, 'function');
    assert.equal(typeof loadPageModule, 'function');
    assert.equal(typeof renderRoute, 'function');
    assert.equal(typeof generateStaticSite, 'function');
    assert.equal(typeof createApp, 'function');
    assert.equal(typeof createHttpServer, 'function');
    assert.equal(typeof readJson, 'function');
  });

  it('exposes the routing/page/server error classes', () => {
    assert.ok(new RouteManifestError('m') instanceof Error);
    assert.ok(new PageRenderError('m') instanceof Error);
    assert.ok(new StaticSiteError('m') instanceof Error);
  });

  it('exposes the routing/page/server types for consumers', () => {
    const entry = {} as RouteManifestEntry;
    const manifest = {} as RouteManifest;
    const discoverOptions: DiscoverRoutesOptions = { pagesDir: 'pages', apiDir: 'api' };
    const renderOptions: RenderRouteOptions = { staticMode: true };
    const staticOptions = {} as GenerateStaticSiteOptions;
    const staticResult = {} as GenerateStaticSiteResult;
    const pageModule = {} as PageModule;
    const pageProps: PageProps = {};
    const pageComponent = {} as PageComponent;
    const authorize: Authorize = () => true;
    const resolveSession: ResolveSession = () => null;
    const renderPage: RenderPage = () => new Response(null, { status: 200 });
    const handler: ApiHandler = () => new Response(null, { status: 204 });
    const method: ApiMethod = 'GET';
    const apiModule: ApiModule = { GET: handler };
    const appOptions = {} as CreateAppOptions;
    const serverOptions = {} as CreateHttpServerOptions;
    const context = {} as RequestContext;
    const session = {} as Session;
    const sessionStore = {} as SessionStore;
    const json: JsonValue = { ok: true };
    const jsonObject: JsonObject = { ok: true };

    void [
      entry,
      manifest,
      discoverOptions,
      renderOptions,
      staticOptions,
      staticResult,
      pageModule,
      pageProps,
      pageComponent,
      authorize,
      resolveSession,
      renderPage,
      handler,
      method,
      apiModule,
      appOptions,
      serverOptions,
      context,
      session,
      sessionStore,
      json,
      jsonObject,
    ];
  });
});

describe('public API surface: API resources', () => {
  it('exposes the resource and serializer functions and errors', () => {
    assert.equal(typeof createResourceHandlers, 'function');
    assert.equal(typeof defineSerializer, 'function');
    assert.equal(typeof ValidationError, 'function');
    assert.ok(new ValidationError([{ path: [], code: 'type', message: 'x' }]) instanceof Error);
  });

  it('exposes the resource/serializer types for consumers', () => {
    const schema = {} as Schema<string>;
    const inferred: Infer<Schema<string>> = 'x';
    const fieldOptions: FieldOptions<string> = { optional: true };
    const path: FieldPath = ['a', 0];
    const issue: ValidationIssue = { path: [], code: 'type', message: 'x' };
    const serializerField: SerializerField<string> = schema;
    const serializerFields: SerializerFields = { name: serializerField };
    const writeInput = {} as WriteInput<{ name: Schema<string> }>;
    const readOutput = {} as ReadOutput<{ name: Schema<string> }>;
    const validateOptions: ValidateOptions = { partial: true };
    const serializer = {} as Serializer<{ name: string }, { name: string }>;
    const resourceAuthorize: ResourceAuthorize<string> = () => true;
    const store = {} as ResourceStore;
    const action: ResourceAction = 'list';
    const resourceHandler = {} as ResourceHandler;
    const collection = {} as CollectionHandlers;
    const detail = {} as DetailHandlers;
    const handlers = {} as ResourceHandlers;
    const handlerOptions = {} as CreateResourceHandlersOptions<unknown, unknown, unknown>;
    const paginationOptions: PaginationOptions = { defaultPageSize: 10 };
    const page = {} as Page<number>;
    const normalized = {} as NormalizedPagination;
    const adapter = {} as QueryAdapter<number>;

    void [
      schema,
      inferred,
      fieldOptions,
      path,
      issue,
      serializerField,
      serializerFields,
      writeInput,
      readOutput,
      validateOptions,
      serializer,
      resourceAuthorize,
      store,
      action,
      resourceHandler,
      collection,
      detail,
      handlers,
      handlerOptions,
      paginationOptions,
      page,
      normalized,
      adapter,
    ];
  });
});

describe('public API surface: browser-agnostic ./api barrel', () => {
  it('builds and uses schemas and serializers from the barrel', () => {
    assert.equal(typeof apiBarrel.string, 'function');
    assert.equal(typeof apiBarrel.integer, 'function');
    assert.equal(typeof apiBarrel.boolean, 'function');
    assert.equal(typeof apiBarrel.object, 'function');
    assert.equal(typeof apiBarrel.array, 'function');
    assert.equal(typeof apiBarrel.optional, 'function');
    assert.equal(typeof apiBarrel.defineSerializer, 'function');
    assert.equal(typeof apiBarrel.createResourceHandlers, 'function');
    assert.equal(typeof apiBarrel.normalizePagination, 'function');
    assert.equal(typeof apiBarrel.paginateArray, 'function');
    assert.equal(typeof apiBarrel.paginate, 'function');

    const name = apiBarrel.string({ min: 1 });
    assert.equal(name.validate('ok'), 'ok');
    assert.throws(() => name.validate(1), apiBarrel.ValidationError);

    const tags = apiBarrel.array(apiBarrel.string());
    assert.deepEqual(tags.validate(['a', 'b']), ['a', 'b']);

    const serializer: apiBarrel.Serializer<{ name: string }, { name: string }> =
      apiBarrel.defineSerializer({ name: apiBarrel.string({ min: 1 }) });
    assert.deepEqual(serializer.validate({ name: 'x' }), { name: 'x' });

    const page = apiBarrel.paginateArray([1, 2, 3], { page: 1, pageSize: 2 });
    assert.equal(page.count, 3);
    assert.deepEqual(page.results, [1, 2]);
    assert.equal(page.next, 2);
  });

  it('resolves the compiled ./api package subpath via self-reference', async () => {
    // Computed specifier so TypeScript does not try to resolve dist/*.d.ts at
    // typecheck time; this exercises the actual package.json "exports" mapping.
    const subpath = ['jsails', 'api'].join('/');
    const imported = (await import(subpath)) as Record<string, unknown>;
    assert.equal(typeof imported.string, 'function');
    assert.equal(typeof imported.defineSerializer, 'function');
    assert.equal(typeof imported.createResourceHandlers, 'function');
    assert.equal(typeof imported.paginateArray, 'function');
  });
});

describe('public API surface: application config and runtime', () => {
  it('exposes the app config loader, validator, and error class', () => {
    assert.equal(typeof loadAppConfig, 'function');
    assert.equal(typeof validateAppConfig, 'function');
    assert.equal(typeof createApplication, 'function');
    assert.equal(typeof DEFAULT_APP_CONFIG_PATH, 'string');
    assert.ok(new AppConfigError('m') instanceof Error);
    assert.equal(new AppConfigError('m').name, 'AppConfigError');
  });

  it('validates and resolves a minimal app config', () => {
    const resolved = validateAppConfig({ port: 0 }, { cwd: '/tmp/anchor' });
    assert.equal(resolved.port, 0);
    assert.equal(resolved.rootDir, '/tmp/anchor');
    assert.deepEqual(resolved.extensions, []);
    assert.equal(resolved.renderer, undefined);
  });

  it('exposes the app config and runtime types for consumers', () => {
    const raw = {} as JsailsAppConfig;
    const resolved = {} as ResolvedAppConfig;
    const loadOptions = {} as AppConfigLoadOptions;
    const validateOptions = {} as AppConfigValidationOptions;
    const cleanup: AppCleanup = () => {};
    const setup: AppSetup = () => cleanup;
    const broadcast = {} as AppBroadcastOptions;
    const application = {} as Application;
    const handle = {} as ServeHandle;

    void [
      raw,
      resolved,
      loadOptions,
      validateOptions,
      cleanup,
      setup,
      broadcast,
      application,
      handle,
    ];
  });
});

describe('public API surface: page renderer seam', () => {
  it('exposes the built-in Preact page renderer', () => {
    assert.equal(typeof preactPageRenderer, 'object');
    assert.equal(typeof preactPageRenderer.render, 'function');
  });

  it('exposes the renderer contract types for consumers', () => {
    const renderer = {} as PageRenderer;
    const options: PageRenderOptions = { staticMode: true };

    void [renderer, options];
  });
});

describe('public API surface: server components', () => {
  it('exposes the curated author surface on the root entry', () => {
    assert.equal(typeof defineServerComponent, 'function');
    assert.equal(typeof defineAction, 'function');
    assert.equal(typeof serverComponents, 'function');
    assert.equal(typeof renderServerComponent, 'function');
    assert.equal(typeof renderServerComponentHtml, 'function');
    assert.ok(new ServerComponentDefinitionError('m') instanceof Error);
    assert.ok(new ServerComponentsError('m') instanceof Error);
  });

  it('exposes the author-facing types for consumers', () => {
    const definition = {} as ServerComponentDefinition<JsonObject>;
    const options = {} as ServerComponentsOptions;

    void [definition, options];
  });
});

describe('public API surface: ./server-components package subpath', () => {
  it('resolves the compiled subpath via self-reference', async () => {
    const subpath = ['jsails', 'server-components'].join('/');
    const imported = (await import(subpath)) as Record<string, unknown>;
    assert.equal(typeof imported.defineServerComponent, 'function');
    assert.equal(typeof imported.defineAction, 'function');
    assert.equal(typeof imported.serverComponents, 'function');
    assert.equal(typeof imported.renderServerComponent, 'function');
    assert.equal(typeof imported.renderServerComponentHtml, 'function');
    // Advanced signer/runtime construction lives only here, not on the root.
    assert.equal(typeof imported.createServerComponentsRuntime, 'function');
    assert.equal(typeof imported.createComponentSigner, 'function');
    assert.equal(typeof imported.ServerComponentRuntimeError, 'function');
    assert.equal(typeof imported.SnapshotError, 'function');
    // Wire protocol constants are runtime strings.
    assert.equal(typeof imported.COMPONENT_UPDATE_ENDPOINT, 'string');
    assert.equal(typeof imported.COMPONENT_ATTRIBUTE, 'string');
    assert.equal(typeof imported.COMPONENT_CSRF_HEADER, 'string');
  });
});

describe('public API surface: ./client package subpath', () => {
  it('resolves the compiled browser client via self-reference', async () => {
    const subpath = ['jsails', 'client'].join('/');
    const imported = (await import(subpath)) as Record<string, unknown>;
    assert.equal(typeof imported.startClient, 'function');
    assert.equal(typeof imported.registerIsland, 'function');
    assert.equal(typeof imported.morphComponent, 'function');
    assert.equal(typeof imported.ISLAND_ATTRIBUTE, 'string');
    assert.equal(typeof imported.FRAME_MISSING_MESSAGE, 'string');
    assert.equal(typeof imported.JSAILS_BEFORE_NAVIGATION, 'string');
    assert.equal(typeof imported.IslandPropsError, 'function');
    assert.equal(typeof imported.IslandRegistryError, 'function');
    assert.equal(typeof imported.ClientEnvironmentError, 'function');
  });

  it('does not leak the internal DOM binding/controller factories', async () => {
    const subpath = ['jsails', 'client'].join('/');
    const imported = (await import(subpath)) as Record<string, unknown>;
    for (const name of [
      'createClientRuntime',
      'createComponentController',
      'createComponentBindings',
      'decodePublicSnapshot',
      'createIslandManager',
      'parseIslandProps',
    ]) {
      assert.equal(imported[name], undefined, `${name} must stay internal`);
    }
  });
});

describe('public API surface: extensions', () => {
  it('exposes the service token, registry, runner, and error class', () => {
    assert.equal(typeof createServiceToken, 'function');
    assert.equal(typeof createServiceRegistry, 'function');
    assert.equal(typeof runExtensions, 'function');
    assert.equal(typeof ServiceRegistryError, 'function');
    assert.ok(new ServiceRegistryError('not_found', 'x', 'm') instanceof Error);
    assert.equal(new ServiceRegistryError('not_found', 'x', 'm').name, 'ServiceRegistryError');
  });

  it('provides and resolves a typed service through the registry', () => {
    const token = createServiceToken<string>('db');
    const controller = createServiceRegistry();
    controller.registrar.provide(token, 'memory://db');
    assert.equal(controller.services.get(token), 'memory://db');
    assert.equal(controller.services.has(token), true);
    assert.equal(controller.services.tryGet(createServiceToken('db')), undefined);
  });

  it('runs extensions in order and provides services to later extensions', async () => {
    const token = createServiceToken<string>('greeting');
    const order: string[] = [];
    const extensions: JsailsExtension[] = [
      {
        name: 'provider',
        setup(context) {
          order.push('provider');
          context.services.provide(token, 'hello');
          return () => {
            order.push('dispose-provider');
          };
        },
      },
      {
        name: 'consumer',
        requires: [token],
        setup(context) {
          order.push(`consumer:${context.services.get(token)}`);
        },
      },
    ];

    const runtime = await runExtensions(extensions);
    assert.deepEqual(order, ['provider', 'consumer:hello']);
    assert.equal(runtime.services.get(token), 'hello');
    await runtime.close();
    assert.deepEqual(order, ['provider', 'consumer:hello', 'dispose-provider']);
  });

  it('exposes the extension and registry types for consumers', () => {
    const token = {} as ServiceToken<string>;
    const registry = {} as ServiceRegistry;
    const registrar = {} as ServiceRegistrar;
    const controller = {} as ServiceRegistryController;
    const code: ServiceRegistryErrorCode = 'not_found';
    const extension = {} as JsailsExtension;
    const context = {} as ExtensionContext;
    const runtime = {} as ExtensionRuntime;
    const cleanup: ExtensionCleanup = () => {};
    const hook: HttpExtensionHook = () => {};

    void [token, registry, registrar, controller, code, extension, context, runtime, cleanup, hook];
  });
});

describe('public API surface: ./extensions package subpath (ORM/Hono-free)', () => {
  const bannedImport =
    /from\s+["'](hono|@hono\/node-server|typeorm|mysql2|pg|sql\.js|bullmq|ioredis|socket\.io|socket\.io-client|@socket\.io\/redis-adapter|preact|preact-render-to-string|@preact\/signals|reflect-metadata|zod)["']/;

  it('resolves the compiled ./extensions subpath via self-reference', async () => {
    const subpath = ['jsails', 'extensions'].join('/');
    const imported = (await import(subpath)) as Record<string, unknown>;
    assert.equal(typeof imported.createServiceToken, 'function');
    assert.equal(typeof imported.createServiceRegistry, 'function');
    assert.equal(typeof imported.runExtensions, 'function');
    assert.equal(typeof imported.ServiceRegistryError, 'function');
  });

  it('compiled entry never imports an ORM or HTTP runtime library', () => {
    // The subpath must be importable without pulling in Hono or an ORM; the
    // type-only Hono reference in extension.ts is erased at compile time, as
    // are the type-only adapter/command/generator author interfaces.
    const dir = fileURLToPath(new URL('../src/extensions', import.meta.url));
    for (const file of ['index.js', 'services.js', 'extension.js']) {
      const source = readFileSync(`${dir}/${file}`, 'utf8');
      assert.doesNotMatch(source, bannedImport, `${file} must not import a runtime library`);
    }
  });

  it('exposes type-only adapter/command/generator author interfaces (static import)', () => {
    const jobAdapter = {} as ExtJobRuntimeAdapter;
    const jobContext = {} as ExtJobAdapterContext;
    const producer = {} as ExtRuntimeProducer;
    const worker = {} as ExtRuntimeWorker;
    const job = {} as ExtRuntimeJob;
    const processJob: ExtProcessJob = async () => undefined;
    const dispatchOptions: ExtJobDispatchOptions = {};
    const broadcast = {} as ExtBroadcastAdapter;
    const handle = {} as ExtBroadcastHandle;
    const command = {} as ExtCliCommand;
    const commandContext = {} as ExtCliCommandContext;
    const generator = {} as ExtDeploymentGenerator;
    const generatorContext: ExtDeploymentGeneratorContext = {};
    const files = {} as ExtDeploymentFileMap;

    void [
      jobAdapter,
      jobContext,
      producer,
      worker,
      job,
      processJob,
      dispatchOptions,
      broadcast,
      handle,
      command,
      commandContext,
      generator,
      generatorContext,
      files,
    ];
  });

  it('imports and uses the subpath in a clean child process without runtime adapters', () => {
    const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
    const script = `
      const mod = await import('jsails/extensions');
      const token = mod.createServiceToken('db');
      const registry = mod.createServiceRegistry();
      registry.registrar.provide(token, { url: 'memory' });
      if (registry.services.get(token).url !== 'memory') throw new Error('round-trip failed');
      for (const name of ['createServiceToken', 'createServiceRegistry', 'runExtensions', 'ServiceRegistryError']) {
        if (typeof mod[name] !== 'function') throw new Error('missing ' + name);
      }
      // Type-only author interfaces must not appear as runtime values, so the
      // subpath exports no adapter/command/generator construction surface.
      for (const name of ['createJobsRuntime', 'createBullMQAdapter', 'createSocketIOBroadcastAdapter', 'createCliCommandRegistry', 'createDeploymentGeneratorRegistry']) {
        if (mod[name] !== undefined) throw new Error('unexpected runtime export ' + name);
      }
      console.log('extensions-ok');
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: projectRoot,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /extensions-ok/);
  });
});
