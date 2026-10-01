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
  BATCH_OPTION_KEY,
  CHAIN_OPTION_KEY,
  chainMiddleware,
  CliCommandError,
  composeMiddleware,
  createBatchCoordinator,
  createBatchMiddleware,
  createJobBatch,
  createJobChain,
  DEFAULT_RUNTIME_CONFIG_PATH,
  DatabaseConfigError,
  DeploymentRegistryError,
  EnvironmentError,
  FileDataSource,
  FileDataSourceError,
  isBatchDescriptor,
  JobBatchError,
  JobChainError,
  JobMiddlewareError,
  JobOptionsError,
  JobPayloadError,
  JobsRuntimeClosedError,
  JobsRuntimeError,
  JobNotRegisteredError,
  JsailsDataSource,
  MigrationError,
  MutexError,
  OVERLAP_OPTION_KEY,
  PageRenderError,
  RouteManifestError,
  RuntimeConfigError,
  ScheduleError,
  StaticSiteError,
  UnsupportedSchemaError,
  ValidationError,
  ValkeyConfigError,
  activatePlugins,
  attachBroadcast,
  collectConfigCommands,
  createApp,
  createBullMQAdapter,
  createCliCommandRegistry,
  createDeploymentGeneratorRegistry,
  createHttpServer,
  createJobsRuntime,
  createJobRegistry,
  createMemoryMutexStore,
  createOverlapMiddleware,
  createResourceHandlers,
  createSocketIOBroadcastAdapter,
  createValkeyMutexStore,
  defineDeploymentGenerator,
  defineJob,
  defineSerializer,
  discoverRoutes,
  generateDevDatabaseConfig,
  generateDevValkeyConfig,
  generateMigration,
  generateOnceConfig,
  generateStaticSite,
  getMigrationStatus,
  loadPageModule,
  migrate,
  mutexPlugin,
  mutexToken,
  OnceConfigError,
  readDatabaseEnvironment,
  readEnvironment,
  readJson,
  readValkeyEnvironment,
  renderRoute,
  replayMigrationHistory,
  routeToOutputPath,
  substituteRouteParams,
  validateJobsRuntimeAdapter,
  validatePayload,
  validateRuntimeConfig,
} from '../../src/index.js';
import {
  ServerComponentDefinitionError,
  ServerComponentError,
  defineAction,
  defineServerComponent,
  renderServerComponent,
  renderServerComponentHtml,
  serverComponentsPlugin,
  type ServerComponentDefinition,
  type ServerComponentsOptions,
} from '../../src/index.js';
import type {
  AddColumnOperation,
  AddIndexOperation,
  AddUniqueOperation,
  AlterColumnOperation,
  ApiHandler,
  ApiMethod,
  ApiModule,
  Authorize,
  AppBroadcastConfig,
  AttachBroadcastOptions,
  AutodetectOptions,
  BatchCallbacks,
  BatchCoordinator,
  BatchFailedSummary,
  BatchItem,
  BatchSummary,
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
  BullMQAdapterOptions,
  ChainStep,
  JobsRuntimeOptions,
  DeploymentFileMap,
  DeploymentGenerator,
  DeploymentGeneratorContext,
  DeploymentGeneratorRegistry,
  DeploymentGeneratorRegistryOptions,
  ActivatePluginsInput,
  ActivatePluginsResult,
  JobAdapterContext,
  JobDispatchOptions,
  JobsRuntimeAdapter,
  JobsRuntime,
  ProcessJob,
  RuntimeJob,
  RuntimeProducer,
  RuntimeWorker,
  JobBatch,
  JobChain,
  JobMiddleware,
  JobMiddlewareContext,
  ColumnDefinition,
  ColumnRenameHint,
  AppOptions,
  HttpServerOptions,
  ResourceHandlersOptions,
  CreateTableOperation,
  DatabaseDriver,
  DatabaseEnvironment,
  DatabaseType,
  DetailHandlers,
  DevDatabaseFiles,
  DevDatabaseOptions,
  DiscoverRoutesOptions,
  DropColumnOperation,
  DropIndexOperation,
  DropTableOperation,
  DropUniqueOperation,
  EnvironmentIssue,
  FieldOptions,
  FieldPath,
  FileDataSourceOptions,
  GenerateStaticSiteOptions,
  GenerateStaticSiteResult,
  Infer,
  IndexDefinition,
  JobContext,
  JobDefinition,
  JobHandler,
  JobQueue,
  JobRegistry,
  JobWorker,
  JsonObject,
  JsonValue,
  JsailsDataSourceOptions,
  JsailsSupportedDriver,
  Awaitable,
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
  ScheduleDefinition,
  ScheduleInfo,
  Schema,
  SchemaState,
  Serializer,
  SerializerField,
  SerializerFields,
  Session,
  SessionStore,
  TableDefinition,
  UniqueDefinition,
  ValidateOptions,
  ValidationIssue,
  ValkeyConfigFiles,
  ValkeyConfigOptions,
  ValkeyEnvironment,
  WorkerJob,
  WriteInput,
  RequestContext,
} from '../../src/index.js';
import * as apiBarrel from '../../src/api/index.js';
import {
  AppConfigError,
  DEFAULT_APP_CONFIG_PATH,
  createApplication,
  createEncrypter,
  createInterceptorRegistry,
  createServiceRegistry,
  createServiceToken,
  createSignalBus,
  defineEvent,
  defineOperation,
  definePlugin,
  EncryptionError,
  encryptionPlugin,
  encryptionToken,
  InterceptorError,
  loadAppConfig,
  preactPageRenderer,
  runExtensions,
  ServiceRegistryError,
  SignalError,
  signalsPlugin,
  signalsToken,
  validateAppConfig,
  validateExtensionEntries,
} from '../../src/index.js';
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
  InterceptorRegistry,
  JsailsAppConfig,
  JsailsExtension,
  JsailsPlugin,
  PageRenderer,
  PageRenderOptions,
  PluginContext,
  ResolvedAppConfig,
  ServiceRegistrar,
  ServiceRegistry,
  ServiceRegistryController,
  ServiceRegistryErrorCode,
  ServiceToken,
  ServeHandle,
} from '../../src/index.js';

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
  JobsRuntimeAdapter as ExtJobsRuntimeAdapter,
  ProcessJob as ExtProcessJob,
  RuntimeJob as ExtRuntimeJob,
  RuntimeProducer as ExtRuntimeProducer,
  RuntimeWorker as ExtRuntimeWorker,
} from '../../src/extensions/index.js';

// ---------------------------------------------------------------------------
// New server-component symbols: directives, pagination, downloads, url-binding
// ---------------------------------------------------------------------------
import {
  confirmAttrs,
  loadingTargetAttrs,
  showAttrs,
  textAttrs,
  sortAttrs,
  intersectAttrs,
  refAttrs,
  ignoreAttrs,
  pagerAttrs,
  redirect,
  isRedirect,
  download,
  isDownload,
  DownloadError,
  createDownloadReferenceSigner,
  DOWNLOAD_REFERENCE_TTL_MS,
  seedFromUrl,
} from '../../src/index.js';
import type {
  ServerComponentPagerOptions,
  ServerComponentRedirect,
  DownloadReferenceSigner,
  ServerComponentDownload,
  DownloadReferenceClaims,
  ServerComponentUrlBinding,
} from '../../src/index.js';

// ---------------------------------------------------------------------------
// Pages: streaming and the PageStream type
// ---------------------------------------------------------------------------
import { renderStreamResponse } from '../../src/index.js';
import type { PageStream } from '../../src/index.js';

// ---------------------------------------------------------------------------
// Admin breadth: charts, widgets, advanced actions, relation managers
// ---------------------------------------------------------------------------
import {
  donutChartSvg,
  areaChartSvg,
  defineProgressWidget,
  defineListWidget,
  defineTrendWidget,
  defineReplicateAction,
  defineRestoreAction,
  defineImportAction,
  defineRelationManager,
  renderRelationManager,
  RelationManagerError,
  defineAttachAction,
  defineDetachAction,
  RelationActionError,
} from '../../src/index.js';
import type {
  ProgressWidgetDefinition,
  ListWidgetDefinition,
  TrendWidgetDefinition,
  RelationManager,
  RelationManagerDefinition,
  RelationManagerListContext,
  AttachActionDefinition,
  DetachActionDefinition,
  ResourceColumn,
} from '../../src/index.js';

// ---------------------------------------------------------------------------
// API: filter types (value-widened filter clause/operator)
// ---------------------------------------------------------------------------
import type { FilterOperator, FilterClause, FilterValue } from '../../src/index.js';

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
    const index: IndexDefinition = { name: 'idx_name', columns: ['name'], unique: false };
    const unique: UniqueDefinition = { name: 'uq_email', columns: ['email'] };
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
      index,
      unique,
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
      addIndex: {
        kind: 'add_index',
        table: 't',
        index: { name: 'idx_c', columns: ['c'], unique: false },
      } satisfies AddIndexOperation,
      dropIndex: {
        kind: 'drop_index',
        table: 't',
        index: { name: 'idx_c', columns: ['c'], unique: false },
      } satisfies DropIndexOperation,
      addUnique: {
        kind: 'add_unique',
        table: 't',
        unique: { name: 'uq_c', columns: ['c'] },
      } satisfies AddUniqueOperation,
      dropUnique: {
        kind: 'drop_unique',
        table: 't',
        unique: { name: 'uq_c', columns: ['c'] },
      } satisfies DropUniqueOperation,
    };
    assert.equal(Object.keys(kinds).length, 10);
  });
});

describe('public API surface: jobs', () => {
  it('exposes the jobs runtime values', () => {
    assert.equal(typeof defineJob, 'function');
    assert.equal(typeof createJobRegistry, 'function');
    assert.equal(typeof validatePayload, 'function');
    assert.equal(typeof DEFAULT_RUNTIME_CONFIG_PATH, 'string');
  });

  it('exposes the jobs error classes with their names', () => {
    assert.ok(new JobPayloadError('j', 'msg') instanceof Error);
    assert.equal(new JobPayloadError('j', 'msg').name, 'JobPayloadError');
    assert.ok(new JobNotRegisteredError('j') instanceof Error);
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
    const worker = {} as JobWorker;
    const schedule: ScheduleDefinition = { id: 's', job: 'j', everyMs: 60000 };
    const workerJob = {} as WorkerJob;
    const runtime = {} as RuntimeConfig;
    const resolved = {} as ResolvedRuntimeConfig;

    void [
      registry,
      definition,
      handler,
      context,
      queue,
      worker,
      schedule,
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
    assert.equal(typeof validateJobsRuntimeAdapter, 'function');
    assert.equal(typeof createBullMQAdapter, 'function');
    assert.ok(new JobsRuntimeError('m') instanceof Error);
    assert.ok(new JobsRuntimeClosedError() instanceof JobsRuntimeError);

    const bull = createBullMQAdapter({ redisUrl: 'redis://127.0.0.1:6379' });
    assert.equal(bull.name, 'bullmq');
    // Options fail fast; no Queue/Worker is constructed and nothing connects.
    assert.throws(() => createBullMQAdapter({ redisUrl: 'http://not-redis' }), TypeError);
  });

  it('runs a fake backend through the neutral contract and rejects a bad adapter', async () => {
    const dispatched: Array<{ name: string; data: unknown }> = [];
    let workerClosed = false;
    const adapter: JobsRuntimeAdapter = {
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

    assert.throws(() => validateJobsRuntimeAdapter({ name: 'broken' }), TypeError);
    assert.doesNotThrow(() => validateJobsRuntimeAdapter(adapter));

    const runtime = createJobsRuntime({ registry: fakeRegistry(), adapter });
    assert.equal(await runtime.dispatch('ping', { n: 1 }), 'queued');
    assert.deepEqual(dispatched, [{ name: 'ping', data: { n: 1 } }]);
    await runtime.startWorker();
    await runtime.close();
    assert.equal(workerClosed, true);
  });

  it('selects a custom runtime adapter with no URL via validateRuntimeConfig', () => {
    const adapter: JobsRuntimeAdapter = {
      name: 'no-url',
      createProducer: () => ({ dispatch: async () => undefined, close: async () => {} }),
      createWorker: () => ({ close: async () => {} }),
    };

    const resolved = validateRuntimeConfig({ registry: fakeRegistry(), adapter });
    assert.equal(resolved.adapter, adapter);
    assert.equal(resolved.valkeyUrl, undefined);
    assert.equal(resolved.queueName, 'default');
  });

  it('exposes the job runtime adapter types for consumers', () => {
    const adapter = {} as JobsRuntimeAdapter;
    const context = {} as JobAdapterContext;
    const producer = {} as RuntimeProducer;
    const worker = {} as RuntimeWorker;
    const job = {} as RuntimeJob;
    const processJob: ProcessJob = async () => undefined;
    const dispatchOptions: JobDispatchOptions = {};
    const runtimeOptions = {} as JobsRuntimeOptions;
    const runtime = {} as JobsRuntime;
    const bullOptions: BullMQAdapterOptions = { redisUrl: 'redis://x' };

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

describe('public API surface: job middleware, chaining, and batching', () => {
  it('exposes the middleware, chain, and batch runtime values', () => {
    assert.equal(typeof composeMiddleware, 'function');
    assert.equal(typeof createJobChain, 'function');
    assert.equal(typeof chainMiddleware, 'function');
    assert.equal(typeof createJobBatch, 'function');
    assert.equal(typeof createBatchCoordinator, 'function');
    assert.equal(typeof createBatchMiddleware, 'function');
    assert.equal(typeof isBatchDescriptor, 'function');
    assert.equal(CHAIN_OPTION_KEY, '__jsailsChain');
    assert.equal(BATCH_OPTION_KEY, '__jsailsBatch');
  });

  it('exposes the error classes', () => {
    const mwErr = new JobMiddlewareError('invalid_middleware');
    assert.ok(mwErr instanceof Error);
    assert.equal(mwErr.name, 'JobMiddlewareError');
    assert.equal(mwErr.code, 'invalid_middleware');

    const chainErr = new JobChainError('empty_chain');
    assert.ok(chainErr instanceof Error);
    assert.equal(chainErr.name, 'JobChainError');
    assert.equal(chainErr.code, 'empty_chain');

    const batchErr = new JobBatchError('empty_batch');
    assert.ok(batchErr instanceof Error);
    assert.equal(batchErr.name, 'JobBatchError');
    assert.equal(batchErr.code, 'empty_batch');
  });

  it('exposes the type contracts for consumers', () => {
    const middleware = {} as JobMiddleware;
    const mwContext = {} as JobMiddlewareContext;
    const chainStep = {} as ChainStep;
    const jobChain = {} as JobChain;
    const batchItem = {} as BatchItem;
    const batchSummary = {} as BatchSummary;
    const batchFailedSummary = {} as BatchFailedSummary;
    const batchCallbacks = {} as BatchCallbacks;
    const coordinator = {} as BatchCoordinator;
    const jobBatch = {} as JobBatch;

    void [
      middleware,
      mwContext,
      chainStep,
      jobChain,
      batchItem,
      batchSummary,
      batchFailedSummary,
      batchCallbacks,
      coordinator,
      jobBatch,
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
    const maybe: Awaitable<string> = 'x';

    void [broadcast, handshake, options, maybe];
  });
});

describe('public API surface: deploy generators', () => {
  it('exposes the three deploy generators as functions', () => {
    assert.equal(typeof generateDevValkeyConfig, 'function');
    assert.equal(typeof generateDevDatabaseConfig, 'function');
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

  it('exposes the deploy config types for consumers', () => {
    const valkeyOptions = {} as ValkeyConfigOptions;
    const valkeyFiles = {} as ValkeyConfigFiles;
    const devDbOptions = {} as DevDatabaseOptions;
    const devDbFiles = {} as DevDatabaseFiles;
    const driver: DatabaseDriver = 'mariadb';
    const onceOptions = {} as OnceConfigOptions;
    const onceFiles = {} as OnceConfigFiles;

    void [valkeyOptions, valkeyFiles, devDbOptions, devDbFiles, driver, onceOptions, onceFiles];
  });
});

describe('public API surface: deployment generator registry', () => {
  it('exposes the registry, define helper, error, and built-in ids', () => {
    assert.equal(typeof createDeploymentGeneratorRegistry, 'function');
    assert.equal(typeof defineDeploymentGenerator, 'function');
    assert.ok(new DeploymentRegistryError('m') instanceof Error);
    assert.deepEqual(BUILTIN_DEPLOYMENT_GENERATOR_IDS, [
      'valkey-dev',
      'database-dev',
      'once',
      'harden-server',
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

describe('public API surface: plugin activation', () => {
  it('re-exports activatePlugins and its types from the root entry', () => {
    assert.equal(typeof activatePlugins, 'function');
    const input = {} as ActivatePluginsInput;
    const result = {} as ActivatePluginsResult;
    void [input, result];
  });
});

describe('public API surface: signals', () => {
  it('exposes the signal bus factory, plugin, token, and error', () => {
    assert.equal(typeof createSignalBus, 'function');
    assert.equal(typeof signalsPlugin, 'function');
    assert.ok(signalsToken !== undefined);
    assert.ok(new SignalError('m') instanceof Error);
  });

  it('emits through a bus built over a registry and isolates observer errors', async () => {
    const registry = createInterceptorRegistry();
    const pinged = defineEvent<{ n: number }>('pinged');
    const seen: number[] = [];
    registry.observe(pinged, (payload) => {
      seen.push(payload.n);
    });
    registry.observe(pinged, () => {
      throw new Error('observer boom');
    });
    registry.seal();

    const bus = createSignalBus(registry);
    const results = await bus.emit(pinged, { n: 1 });
    assert.deepEqual(seen, [1]);
    // The throwing observer is isolated: emit resolves and reports its error.
    assert.equal(results.length, 1);
    assert.ok(results[0] instanceof Error);
  });
});

describe('public API surface: encryption', () => {
  it('exposes the encrypter factory, plugin, token, and error', () => {
    assert.equal(typeof createEncrypter, 'function');
    assert.equal(typeof encryptionPlugin, 'function');
    assert.ok(encryptionToken !== undefined);
    assert.ok(new EncryptionError('invalid_key', 'm') instanceof Error);
  });

  it('round-trips a value through the root-entry encrypter', () => {
    const encrypter = createEncrypter({ key: 'k'.repeat(32) });
    const token = encrypter.encrypt('root entry secret');
    assert.equal(encrypter.decrypt(token), 'root entry secret');
  });
});

describe('public API surface: mutex and scheduling', () => {
  it('exposes the mutex store factories, plugin, token, and error', () => {
    assert.equal(typeof createMemoryMutexStore, 'function');
    assert.equal(typeof createValkeyMutexStore, 'function');
    assert.equal(typeof mutexPlugin, 'function');
    assert.ok(mutexToken !== undefined);
    assert.ok(new MutexError('invalid_key', 'm') instanceof Error);
    assert.equal(new MutexError('invalid_key', 'm').name, 'MutexError');
  });

  it('MutexError exposes the expected stable codes', () => {
    const codes: MutexError['code'][] = ['invalid_key', 'invalid_ttl', 'backend_error', 'closed'];
    assert.deepEqual(codes, ['invalid_key', 'invalid_ttl', 'backend_error', 'closed']);
  });

  it('createMemoryMutexStore acquires, releases, and blocks overlapping acquires', async () => {
    const store = createMemoryMutexStore();
    const acquired = await store.acquire('job:daily', 60_000);
    assert.equal(acquired, true);
    // Second acquire on the same key before TTL must fail.
    assert.equal(await store.acquire('job:daily', 60_000), false);
    await store.release('job:daily');
    // After release, acquire succeeds again.
    assert.equal(await store.acquire('job:daily', 60_000), true);
    await store.close();
  });

  it('exposes the overlap middleware and option key', () => {
    assert.equal(typeof createOverlapMiddleware, 'function');
    assert.equal(OVERLAP_OPTION_KEY, '__jsailsOverlap');
  });

  it('overlap middleware skips when the descriptor is absent (fail-safe)', async () => {
    const store = createMemoryMutexStore();
    const middleware = createOverlapMiddleware(store);
    const nextCalled = { value: false };

    // No OVERLAP_OPTION_KEY in options — the middleware must call next()
    // exactly once and return its result unchanged.
    const context = { name: 'testJob', jobId: 'job:42', options: {} } as Parameters<
      typeof middleware
    >[1];
    const result = await middleware({ n: 1 }, context, async () => {
      nextCalled.value = true;
      return 'handler-result';
    });
    assert.equal(nextCalled.value, true);
    assert.equal(result, 'handler-result');
    await store.close();
  });

  it('exposes the ScheduleInfo type contract (type-only import)', () => {
    const info = {} as ScheduleInfo;
    void info;
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
    assert.equal(valkey.valkeyUrl, 'redis://valkey:6379/0');
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
    const renderOptions: PageRenderOptions = { staticMode: true };
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
    const appOptions = {} as AppOptions;
    const serverOptions = {} as HttpServerOptions;
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
    const handlerOptions = {} as ResourceHandlersOptions<unknown, unknown, unknown>;
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
    assert.equal(typeof serverComponentsPlugin, 'function');
    assert.equal(typeof renderServerComponent, 'function');
    assert.equal(typeof renderServerComponentHtml, 'function');
    assert.ok(new ServerComponentDefinitionError('m') instanceof Error);
    assert.ok(new ServerComponentError('m') instanceof Error);
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
    assert.equal(typeof imported.serverComponentsPlugin, 'function');
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
    // Validation metadata and upload/poll markers are on the subpath too.
    assert.equal(typeof imported.extractFieldRules, 'function');
    assert.equal(typeof imported.serializeFieldRules, 'function');
    assert.equal(typeof imported.ValidationMetaError, 'function');
    assert.equal(typeof imported.COMPONENT_UPLOADING_ATTRIBUTE, 'string');
    assert.equal(typeof imported.COMPONENT_UPLOAD_MAX_BYTES_ATTRIBUTE, 'string');
    assert.equal(typeof imported.COMPONENT_UPLOAD_ENDPOINT, 'string');
    assert.equal(typeof imported.COMPONENT_UPLOAD_FILE_FIELD, 'string');
    assert.equal(typeof imported.COMPONENT_UPLOAD_SNAPSHOT_FIELD, 'string');
    assert.equal(typeof imported.POLL_ATTRIBUTE, 'string');
    assert.equal(typeof imported.LOADING_ATTRIBUTE, 'string');
    assert.equal(typeof imported.DIRTY_ATTRIBUTE, 'string');
    assert.equal(typeof imported.DEBOUNCE_ATTRIBUTE, 'string');
  });
});

describe('public API surface: ./admin package subpath', () => {
  it('resolves the admin breadth surface via self-reference', async () => {
    const subpath = ['jsails', 'admin'].join('/');
    const imported = (await import(subpath)) as Record<string, unknown>;
    assert.equal(typeof imported.defineWidget, 'function');
    assert.equal(typeof imported.defineNotice, 'function');
    assert.equal(typeof imported.defineAdminAction, 'function');
    assert.equal(typeof imported.renderGlobalSearch, 'function');
    assert.equal(typeof imported.WidgetError, 'function');
    assert.equal(typeof imported.NoticeError, 'function');
    assert.equal(typeof imported.AdminActionError, 'function');
    assert.equal(typeof imported.ADMIN_ACTION_SUCCESS_CODE, 'string');
    assert.equal(typeof imported.ADMIN_ACTION_SUCCESS_NOTICE, 'object');
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

  it('exposes the plugin and interceptor surface', () => {
    assert.equal(typeof definePlugin, 'function');
    assert.equal(typeof defineOperation, 'function');
    assert.equal(typeof defineEvent, 'function');
    assert.equal(typeof createInterceptorRegistry, 'function');
    assert.equal(typeof validateExtensionEntries, 'function');
    assert.equal(typeof InterceptorError, 'function');
    assert.ok(new InterceptorError('sealed', 'x') instanceof Error);
    assert.equal(new InterceptorError('sealed', 'x').name, 'InterceptorError');

    const plugin = {} as JsailsPlugin;
    const context = {} as PluginContext;
    const registry = {} as InterceptorRegistry;
    void [plugin, context, registry];
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
    const dir = fileURLToPath(new URL('../../src/extensions', import.meta.url));
    for (const file of ['index.js', 'services.js', 'extension.js']) {
      const source = readFileSync(`${dir}/${file}`, 'utf8');
      assert.doesNotMatch(source, bannedImport, `${file} must not import a runtime library`);
    }
  });

  it('exposes type-only adapter/command/generator author interfaces (static import)', () => {
    const jobAdapter = {} as ExtJobsRuntimeAdapter;
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
    const projectRoot = fileURLToPath(new URL('../../..', import.meta.url));
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

// ---------------------------------------------------------------------------
// Server components: directives, pagination, redirect, downloads, url-binding
// ---------------------------------------------------------------------------

describe('public API surface: server-component directives', () => {
  it('exposes every directive builder as a function', () => {
    assert.equal(typeof confirmAttrs, 'function');
    assert.equal(typeof loadingTargetAttrs, 'function');
    assert.equal(typeof showAttrs, 'function');
    assert.equal(typeof textAttrs, 'function');
    assert.equal(typeof sortAttrs, 'function');
    assert.equal(typeof intersectAttrs, 'function');
    assert.equal(typeof refAttrs, 'function');
    assert.equal(typeof ignoreAttrs, 'function');
  });

  it('confirmAttrs returns a non-empty record', () => {
    const attrs = confirmAttrs('Are you sure?');
    assert.equal(typeof attrs, 'object');
    assert.ok(attrs !== null);
    assert.equal(Object.keys(attrs).length, 1);
  });

  it('ignoreAttrs returns a record', () => {
    const attrs = ignoreAttrs();
    assert.equal(typeof attrs, 'object');
    assert.ok(attrs !== null);
  });
});

describe('public API surface: server-component pagination', () => {
  it('exposes pagerAttrs as a function', () => {
    assert.equal(typeof pagerAttrs, 'function');
  });

  it('pagerAttrs returns prev/next structures from a Page', () => {
    const page = { results: [1, 2], count: 5, page: 1, pageSize: 2, previous: null, next: 3 };
    const result = pagerAttrs(page, { action: 'page', pageField: 'p', pageSizeField: 'ps' });
    assert.equal(result.previous, null);
    assert.equal(typeof result.next, 'object');
    assert.ok(result.next !== null);
  });
});

describe('public API surface: server-component redirect', () => {
  it('exposes redirect and isRedirect as functions', () => {
    assert.equal(typeof redirect, 'function');
    assert.equal(typeof isRedirect, 'function');
  });

  it('redirect builds a redirect signal and isRedirect detects it', () => {
    const signal = redirect('/dashboard');
    assert.equal(isRedirect(signal), true);
    assert.equal(signal.url, '/dashboard');
  });

  it('isRedirect returns false for non-redirect values', () => {
    assert.equal(isRedirect(null), false);
    assert.equal(isRedirect(undefined), false);
    assert.equal(isRedirect({}), false);
  });
});

describe('public API surface: server-component downloads', () => {
  it('exposes download, isDownload, DownloadError, and the signer factory', () => {
    assert.equal(typeof download, 'function');
    assert.equal(typeof isDownload, 'function');
    assert.equal(typeof DownloadError, 'function');
    assert.equal(typeof createDownloadReferenceSigner, 'function');
    assert.equal(typeof DOWNLOAD_REFERENCE_TTL_MS, 'number');
    assert.equal(DOWNLOAD_REFERENCE_TTL_MS, 300_000);
  });

  it('download builds a signal and isDownload detects it', () => {
    const dl = download('file-1', { filename: 'report.pdf', contentType: 'application/pdf' });
    assert.equal(isDownload(dl), true);
    assert.equal(dl.id, 'file-1');
    assert.equal(dl.filename, 'report.pdf');
    assert.equal(dl.contentType, 'application/pdf');
  });

  it('DownloadError carries a code and name', () => {
    const err = new DownloadError('invalid_input', 'msg');
    assert.ok(err instanceof Error);
    assert.equal(err.name, 'DownloadError');
    assert.equal(err.code, 'invalid_input');
  });

  it('createDownloadReferenceSigner signs and verifies a reference', () => {
    const signer = createDownloadReferenceSigner({ key: 'k'.repeat(32) });
    const token = signer.sign({
      downloadId: 'abc123',
      component: 'task-list',
      subject: 'user-42',
      filename: 'data.csv',
      contentType: 'text/csv',
    });
    assert.equal(typeof token, 'string');
    const claims = signer.verify(token);
    assert.equal(claims.downloadId, 'abc123');
    assert.equal(claims.component, 'task-list');
    assert.equal(claims.subject, 'user-42');
    assert.equal(claims.filename, 'data.csv');
    assert.equal(claims.contentType, 'text/csv');
  });
});

describe('public API surface: server-component url-binding', () => {
  it('exposes seedFromUrl as a function', () => {
    assert.equal(typeof seedFromUrl, 'function');
  });
});

describe('public API surface: server-component types', () => {
  it('exposes the directive/pagination/download/url-binding types', () => {
    const pagerOpts: ServerComponentPagerOptions = { action: 'page' };
    const redir = {} as ServerComponentRedirect;
    const dl = {} as ServerComponentDownload;
    const signer = {} as DownloadReferenceSigner;
    const claims = {} as DownloadReferenceClaims;
    const urlBinding: ServerComponentUrlBinding = ['page'];
    void [pagerOpts, redir, dl, signer, claims, urlBinding];
  });
});

// ---------------------------------------------------------------------------
// Pages: streaming
// ---------------------------------------------------------------------------

describe('public API surface: page streaming', () => {
  it('exposes renderStreamResponse as a function', () => {
    assert.equal(typeof renderStreamResponse, 'function');
  });

  it('renderStreamResponse wraps a PageStream into a Response', async () => {
    async function* chunks(): AsyncIterable<string> {
      yield 'hello';
    }
    const stream: PageStream = chunks();
    const resp = renderStreamResponse(stream, { 'X-Custom': '1' });
    assert.ok(resp instanceof Response);
    assert.equal(resp.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(resp.headers.get('x-accel-buffering'), 'no');
    assert.equal(resp.headers.get('x-custom'), '1');
    const body = await resp.text();
    assert.equal(body, 'hello');
  });

  it('exposes the PageStream type contract', () => {
    const iterable: PageStream = (async function* () {
      yield 'x';
    })();
    void iterable;
  });
});

// ---------------------------------------------------------------------------
// Admin: charts, widgets, advanced actions, relation managers
// ---------------------------------------------------------------------------

describe('public API surface: admin charts', () => {
  it('exposes the SVG chart helpers as functions', () => {
    assert.equal(typeof donutChartSvg, 'function');
    assert.equal(typeof areaChartSvg, 'function');
  });

  it('donutChartSvg returns valid SVG markup', () => {
    const svg = donutChartSvg([
      { label: 'A', value: 10 },
      { label: 'B', value: 5 },
    ]);
    assert.equal(typeof svg, 'string');
    assert.match(svg, /^<svg /);
  });

  it('areaChartSvg returns valid SVG markup', () => {
    const svg = areaChartSvg([
      { label: 'Jan', value: 10 },
      { label: 'Feb', value: 20 },
    ]);
    assert.equal(typeof svg, 'string');
    assert.match(svg, /^<svg /);
  });
});

describe('public API surface: admin widgets', () => {
  it('exposes the progress, list, and trend widget factories', () => {
    assert.equal(typeof defineProgressWidget, 'function');
    assert.equal(typeof defineListWidget, 'function');
    assert.equal(typeof defineTrendWidget, 'function');
  });

  it('exposes the widget definition types', () => {
    const progress: ProgressWidgetDefinition = {
      name: 'tasks',
      label: 'Tasks',
      value: () => 75,
      max: 100,
    };
    const list: ListWidgetDefinition = {
      name: 'recent',
      label: 'Recent',
      items: () => ['a', 'b'],
    };
    const trend: TrendWidgetDefinition = {
      name: 'signups',
      label: 'Signups',
      value: () => 120,
      delta: () => 12,
    };
    void [progress, list, trend];
  });
});

describe('public API surface: admin advanced actions', () => {
  it('exposes the replicate, restore, and import action factories', () => {
    assert.equal(typeof defineReplicateAction, 'function');
    assert.equal(typeof defineRestoreAction, 'function');
    assert.equal(typeof defineImportAction, 'function');
  });
});

describe('public API surface: admin relation managers', () => {
  it('exposes defineRelationManager, renderRelationManager, and RelationManagerError', () => {
    assert.equal(typeof defineRelationManager, 'function');
    assert.equal(typeof renderRelationManager, 'function');
    assert.ok(new RelationManagerError('m') instanceof Error);
    assert.equal(new RelationManagerError('m').name, 'RelationManagerError');
  });

  it('exposes the relation manager types for consumers', () => {
    const manager = {} as RelationManager;
    const definition = {} as RelationManagerDefinition;
    const listContext = {} as RelationManagerListContext;
    void [manager, definition, listContext];
  });
});

describe('public API surface: admin relation actions', () => {
  it('exposes defineAttachAction, defineDetachAction, and RelationActionError', () => {
    assert.equal(typeof defineAttachAction, 'function');
    assert.equal(typeof defineDetachAction, 'function');
    assert.ok(new RelationActionError('m') instanceof Error);
    assert.equal(new RelationActionError('m').name, 'RelationActionError');
  });

  it('exposes the attach/detach action definition types', () => {
    const stubManager = {
      name: 'x',
      label: 'X',
      foreignKey: 'fk',
      related: {
        slug: 'x',
        label: 'x',
        columns: [],
        fields: [],
        list: async () => ({ rows: [], total: 0 }),
        schema: {},
      },
      list: async () => ({ rows: [], total: 0 }),
    } as unknown as RelationManager;
    const attach: AttachActionDefinition = { manager: stubManager, attach: async () => {} };
    const detach: DetachActionDefinition = { manager: stubManager, detach: async () => {} };
    void [attach, detach];
  });
});

// ---------------------------------------------------------------------------
// Admin: ResourceColumn imageBaseUrl/tagSeparator type coverage
// ---------------------------------------------------------------------------

describe('public API surface: admin ResourceColumn affinity fields', () => {
  it('accommodates imageBaseUrl and tagSeparator on ResourceColumn', () => {
    const imageCol: ResourceColumn = {
      name: 'avatar',
      label: 'Avatar',
      format: 'image',
      imageBaseUrl: '/uploads/',
    };
    const tagsCol: ResourceColumn = {
      name: 'tags',
      label: 'Tags',
      format: 'tags',
      tagSeparator: ';',
    };
    void [imageCol, tagsCol];
  });
});

// ---------------------------------------------------------------------------
// API: filter types (FilterClause, FilterOperator, FilterValue)
// ---------------------------------------------------------------------------

describe('public API surface: API filter types', () => {
  it('exposes the filter type contracts for consumers', () => {
    const op: FilterOperator = 'eq';
    const value: FilterValue = 'search';
    const clause: FilterClause = { field: 'title', operator: 'eq', value: 'hello' };
    void [op, value, clause];
  });
});

// ---------------------------------------------------------------------------
// Client: Turbo Stream message emitters (subpath-only — not root-exported)
// ---------------------------------------------------------------------------

describe('public API surface: ./client Turbo Stream emitters', () => {
  it('exposes every stream emitter via the client subpath', async () => {
    const subpath = ['jsails', 'client'].join('/');
    const imported = (await import(subpath)) as Record<string, unknown>;
    assert.equal(typeof imported.turboStreamMessage, 'function');
    assert.equal(typeof imported.replaceStream, 'function');
    assert.equal(typeof imported.updateStream, 'function');
    assert.equal(typeof imported.appendStream, 'function');
    assert.equal(typeof imported.prependStream, 'function');
    assert.equal(typeof imported.removeStream, 'function');
    assert.equal(typeof imported.beforeStream, 'function');
    assert.equal(typeof imported.afterStream, 'function');
    assert.equal(typeof imported.refreshStream, 'function');
  });

  it('does not leak stream emitters from the root entry', async () => {
    // The root entry deliberately excludes the client runtime — stream emitters
    // are subpath-only and must not pollute the server-side jsails import.
    const root = (await import('../../src/index.js')) as Record<string, unknown>;
    assert.equal(root['turboStreamMessage'], undefined, 'turboStreamMessage must not leak to root');
    assert.equal(root['replaceStream'], undefined, 'replaceStream must not leak to root');
  });
});

// ---------------------------------------------------------------------------
// Testing: server-component test harness (subpath-only — not root-exported)
// ---------------------------------------------------------------------------

describe('public API surface: ./testing server-component harness', () => {
  it('exposes createComponentTestHarness and its types via the testing subpath', async () => {
    const subpath = ['jsails', 'testing'].join('/');
    const imported = (await import(subpath)) as Record<string, unknown>;
    assert.equal(typeof imported.createComponentTestHarness, 'function');
  });
});
