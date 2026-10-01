import 'reflect-metadata';

export { BaseEntity } from 'typeorm';

export {
  JsailsDataSource,
  type JsailsDataSourceOptions,
  type JsailsSupportedDriver,
} from './database/jsails-data-source.js';

export { UnsupportedSchemaError } from './database/model-schema.js';

export {
  FileDataSource,
  FileDataSourceError,
  type FileDataSourceEntity,
  type FileDataSourceModel,
  type FileDataSourceOptions,
} from './database/file-data-source.js';

export {
  MigrationError,
  type ScalarColumnType,
  type ScalarLiteral,
  type ColumnDefinition,
  type TableDefinition,
  type SchemaState,
} from './migrations/schema-state.js';

export type {
  CreateTableOperation,
  DropTableOperation,
  AddColumnOperation,
  DropColumnOperation,
  RenameColumnOperation,
  AlterColumnOperation,
  Operation,
} from './migrations/operations.js';

export {
  replayMigrationHistory,
  type MigrationDefinition,
  type MigrationHistory,
} from './migrations/history.js';

export {
  generateMigration,
  type AutodetectOptions,
  type ColumnRenameHint,
} from './migrations/autodetector.js';

export {
  migrate,
  getMigrationStatus,
  type MigrationDataSource,
  type MigrationRunResult,
  type MigrationStatus,
} from './migrations/runner.js';

// ---------------------------------------------------------------------------
// Jobs (BullMQ-backed bounded queue, worker, and scheduler)
// ---------------------------------------------------------------------------

export {
  createRegistry,
  defineJob,
  JobPayloadError,
  JobUnknownError,
  validatePayload,
  type JobContext,
  type JobDefinition,
  type JobHandler,
  type JobRegistry,
} from './jobs/registry.js';

export {
  createJobQueue,
  DEFAULT_ATTEMPTS,
  DEFAULT_BACKOFF_MS,
  JobOptionsError,
  MAX_ATTEMPTS,
  validateJobOptions,
  type CreateJobQueueOptions,
  type JobQueue,
  type JobQueueHandle,
} from './jobs/queue.js';

export {
  DEFAULT_TIMEZONE,
  MAX_SCHEDULES,
  MIN_INTERVAL_MS,
  ScheduleError,
  startJobWorker,
  upsertSchedules,
  type JobWorker,
  type JobWorkerHandle,
  type ScheduleSpec,
  type SchedulerQueue,
  type StartJobWorkerOptions,
  type WorkerJob,
} from './jobs/scheduler.js';

export {
  DEFAULT_RUNTIME_CONFIG_PATH,
  RuntimeConfigError,
  assertRedisUrl,
  loadRuntimeConfigModule,
  resolveRuntimeRedisUrl,
  validateRuntimeConfig,
  type ResolvedRuntimeConfig,
  type RuntimeConfig,
} from './jobs/runtime-config.js';

// Provider-neutral job runtime controller and its author-facing contract. The
// controller performs job-level policy; a transport-specific adapter owns the
// connection/protocol/retry semantics. No BullMQ/ioredis type leaks here.
export {
  createJobsRuntime,
  validateJobRuntimeAdapter,
  JobRuntimeError,
  JobRuntimeClosedError,
  type CreateJobsRuntimeOptions,
  type JobAdapterContext,
  type JobDispatchOptions,
  type JobRuntimeAdapter,
  type JobsRuntime,
  type ProcessJob,
  type RuntimeJob,
  type RuntimeProducer,
  type RuntimeWorker,
} from './jobs/runtime.js';

// Built-in BullMQ adapter: the default transport for the neutral runtime.
export { createBullMQAdapter, type CreateBullMQAdapterOptions } from './jobs/bullmq-adapter.js';

// ---------------------------------------------------------------------------
// Broadcast (server-side Socket.IO channel + pluggable transport contract)
// ---------------------------------------------------------------------------

export {
  attachBroadcast,
  BROADCAST_PATH,
  type AttachBroadcastOptions,
  type Broadcast,
  type BroadcastAdapter,
  type BroadcastHandle,
  type BroadcastHandshake,
  type BroadcastOptions,
  type MaybePromise,
} from './broadcast/server.js';

export { createSocketIOBroadcastAdapter } from './broadcast/socketio-adapter.js';

// ---------------------------------------------------------------------------
// Deploy config generators (Docker Compose / Kamal, strings only)
// ---------------------------------------------------------------------------

export {
  generateDevValkeyConfig,
  ValkeyConfigError,
  type ValkeyConfigFiles,
  type ValkeyConfigOptions,
} from './deploy/valkey-config.js';

export {
  generateKamalValkeyConfig,
  type KamalValkeyFiles,
  type KamalValkeyOptions,
} from './deploy/kamal-config.js';

export {
  generateDevDatabaseConfig,
  generateKamalDatabaseConfig,
  DatabaseConfigError,
  type DatabaseDriver,
  type DevDatabaseFiles,
  type DevDatabaseOptions,
  type KamalDatabaseFiles,
  type KamalDatabaseOptions,
} from './deploy/database-config.js';

export {
  generateOnceConfig,
  OnceConfigError,
  type OnceConfigFiles,
  type OnceConfigOptions,
} from './deploy/once-config.js';

export {
  generateCloudflarePagesConfig,
  generateGitHubPagesConfig,
  generateNetlifyStaticConfig,
  generateVercelStaticConfig,
  HostingConfigError,
  type CloudflarePagesFiles,
  type CloudflarePagesOptions,
  type GitHubPagesFiles,
  type GitHubPagesOptions,
  type NetlifyStaticFiles,
  type NetlifyStaticOptions,
  type VercelStaticFiles,
  type VercelStaticOptions,
} from './deploy/hosting-config.js';

// ---------------------------------------------------------------------------
// Deployment generator registry (neutral container; generators are pure)
// ---------------------------------------------------------------------------

export {
  createDeploymentGeneratorRegistry,
  defineDeploymentGenerator,
  DeploymentRegistryError,
  type DeploymentFileMap,
  type DeploymentGenerator,
  type DeploymentGeneratorContext,
  type DeploymentGeneratorRegistry,
  type DeploymentGeneratorRegistryOptions,
} from './deploy/registry.js';

export {
  BUILTIN_DEPLOYMENT_GENERATOR_IDS,
  type BuiltinDeploymentGeneratorId,
} from './deploy/builtin-generators.js';

// ---------------------------------------------------------------------------
// User-defined CLI commands (pure registry + structural config collection)
// ---------------------------------------------------------------------------

export {
  createCliCommandRegistry,
  collectConfigCommands,
  CliCommandError,
  type CliCommand,
  type CliCommandContext,
  type CliCommandErrorCode,
  type CliCommandMetadata,
  type CliCommandRegistry,
  type CliCommandRegistryOptions,
  type CommandAudience,
} from './cli/commands.js';

export {
  createPrompter,
  defineCommand,
  parseSignature,
  renderSignatureUsage,
  SignatureError,
  type CommandContext,
  type CommandRunner,
  type DefineCommandOptions,
  type ParsedCommandInput,
  type ParsedSignature,
  type Prompter,
  type SignatureArgument,
  type SignatureOption,
} from './cli/command-kit.js';

// ---------------------------------------------------------------------------
// Environment configuration (bounded readers over a plain string source)
// ---------------------------------------------------------------------------

export {
  EnvironmentError,
  readDatabaseEnvironment,
  readEnvironment,
  readValkeyEnvironment,
  type DatabaseEnvironment,
  type DatabaseType,
  type EnvironmentIssue,
  type ValkeyEnvironment,
} from './config/environment.js';

// ---------------------------------------------------------------------------
// Routing (filesystem route discovery, lexical only, no connections)
// ---------------------------------------------------------------------------

export {
  discoverRoutes,
  routeToOutputPath,
  substituteRouteParams,
  RouteManifestError,
  type DiscoverRoutesOptions,
  type RouteManifest,
  type RouteManifestEntry,
} from './routing/manifest.js';

// ---------------------------------------------------------------------------
// Pages (compiled page loading, server rendering, static site generation)
// ---------------------------------------------------------------------------

export {
  loadPageModule,
  renderRoute,
  PageRenderError,
  type RenderRouteOptions,
} from './pages/page.js';

export {
  generateStaticSite,
  StaticSiteError,
  type GenerateStaticSiteOptions,
  type GenerateStaticSiteResult,
} from './pages/static-site.js';

export type { PageComponent, PageModule, PageProps } from './contracts/render.js';

// ---------------------------------------------------------------------------
// HTTP application and Node server (never opens a port at build/import time)
// ---------------------------------------------------------------------------

export {
  createApp,
  readJson,
  CSRF_HEADER,
  DEFAULT_MAX_BODY_BYTES,
  HTTP_METHODS,
  type ApiHandler,
  type ApiMethod,
  type ApiModule,
  type Authorize,
  type CreateAppOptions,
  type RenderPage,
  type ResolveSession,
} from './server/app.js';

export { createHttpServer, type CreateHttpServerOptions } from './server/http.js';

export type {
  JsonObject,
  JsonValue,
  RequestContext,
  Session,
  SessionStore,
} from './contracts/http.js';

// ---------------------------------------------------------------------------
// API resources (serializers and resource handlers; schema builders live in
// the browser-agnostic `jsails/api` subpath)
//
// `Authorize` here is the server-level global API authorization. The resource
// `Authorize` has a different signature (action + optional resource), so it is
// root-exported under the explicit alias `ResourceAuthorize`.
// ---------------------------------------------------------------------------

export {
  createResourceHandlers,
  type Authorize as ResourceAuthorize,
  type CollectionHandlers,
  type CreateResourceHandlersOptions,
  type DetailHandlers,
  type ResourceAction,
  type ResourceHandler,
  type ResourceHandlers,
  type ResourceStore,
} from './api/resource.js';

export {
  defineSerializer,
  type ReadOutput,
  type Serializer,
  type SerializerField,
  type SerializerFields,
  type ValidateOptions,
  type WriteInput,
} from './api/serialization.js';

export {
  ValidationError,
  type FieldOptions,
  type FieldPath,
  type Infer,
  type Schema,
  type ValidationIssue,
} from './api/validation.js';

export type {
  NormalizedPagination,
  Page,
  PaginationOptions,
  QueryAdapter,
} from './api/pagination.js';

// ---------------------------------------------------------------------------
// Application runtime (config loader + inert app assembly)
// ---------------------------------------------------------------------------

export { createApplication, type Application, type ServeHandle } from './app/application.js';

export {
  AppConfigError,
  DEFAULT_APP_CONFIG_PATH,
  loadAppConfig,
  validateAppConfig,
  type AppBroadcastConfig,
  type AppBroadcastOptions,
  type AppCleanup,
  type AppConfigLoadOptions,
  type AppConfigValidationOptions,
  type AppSetup,
  type JsailsAppConfig,
  type ResolvedAppConfig,
} from './app/config.js';

// ---------------------------------------------------------------------------
// Page renderer seam (built-in Preact renderer + the renderer contract)
// ---------------------------------------------------------------------------

export { preactPageRenderer } from './pages/page.js';

export type { PageRenderer, PageRenderOptions } from './contracts/render.js';

// ---------------------------------------------------------------------------
// Server components (curated author surface)
//
// The root entry carries the author-facing seam: `defineServerComponent` /
// `defineAction` plus their safe definition types, and the `serverComponents`
// extension with the `renderServerComponent` / `renderServerComponentHtml`
// page-author helpers. The advanced signer/runtime construction and the wire
// protocol live in the server-only `jsails/server-components` subpath.
// ---------------------------------------------------------------------------

export {
  defineAction,
  defineServerComponent,
  ServerComponentDefinitionError,
  type ServerComponentAction,
  type ServerComponentActionInput,
  type ServerComponentCallAttrs,
  type ServerComponentDefinition,
  type ServerComponentModelAttrs,
  type ServerComponentRenderTools,
  type ServerComponentState,
  type ServerComponentSubmitAttrs,
} from './server-components/component.js';

export {
  renderServerComponent,
  renderServerComponentHtml,
  ServerComponentsError,
  serverComponents,
  type ServerComponentsOptions,
} from './server-components/extension.js';

// ---------------------------------------------------------------------------
// Extensions (service tokens, registry, ordered setup runner)
// ---------------------------------------------------------------------------

export {
  createServiceRegistry,
  createServiceToken,
  runExtensions,
  ServiceRegistryError,
  type ExtensionCleanup,
  type ExtensionContext,
  type ExtensionRuntime,
  type HttpExtensionHook,
  type JsailsExtension,
  type ServiceRegistrar,
  type ServiceRegistry,
  type ServiceRegistryController,
  type ServiceRegistryErrorCode,
  type ServiceToken,
} from './extensions/index.js';

// ---------------------------------------------------------------------------
// Starter scaffold generator (in-memory file map; no writes/installs/subprocess)
// ---------------------------------------------------------------------------

export {
  createStarterFiles,
  StarterError,
  type StarterFiles,
  type StarterOptions,
} from './app/starter.js';
