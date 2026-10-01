/**
 * Extension foundation entry point.
 *
 * Named re-exports only. `extension.js` references Hono through `import type`,
 * so importing this module never pulls in an ORM or HTTP runtime.
 *
 * Error convention: framework failures are raised as `*Error` classes (e.g.
 * {@link ServiceRegistryError}, {@link InterceptorError}) whose messages are
 * value-free — they never embed user input, credentials, or a raw value, so a
 * caller may surface them verbatim. Structured detail belongs on named fields
 * or a separate `*ErrorCode`, never in the message.
 */

export {
  createServiceRegistry,
  createServiceToken,
  ServiceRegistryError,
  type ProvideOptions,
  type ServiceRegistrar,
  type ServiceRegistry,
  type ServiceRegistryController,
  type ServiceRegistryErrorCode,
  type ServiceToken,
} from './services.js';

export {
  createContractToken,
  isContractToken,
  type ContractToken,
  type ContractTokenProvider,
} from './contracts.js';

export {
  runExtensions,
  type ExtensionCleanup,
  type ExtensionContext,
  type ExtensionRuntime,
  type HttpExtensionHook,
  type JsailsExtension,
  type RunExtensionsOptions,
  type ServeHook,
} from './extension.js';

export type { RouteMiddleware } from '../routing/middleware.js';

export {
  definePlugin,
  type CommandConfigType,
  type CommandContribution,
  type JsailsPlugin,
  type PluginContext,
  type PluginDescription,
} from './plugin-contract.js';

export {
  DeclarativePluginError,
  defineDeclarativePlugin,
  type DeclarativePluginErrorCode,
  type DeclarativePluginSpec,
} from './declarative-plugin.js';

export {
  createInterceptorRegistry,
  defineEvent,
  defineOperation,
  InterceptorError,
  type AfterInterceptor,
  type BeforeInterceptor,
  type EventToken,
  type InterceptOptions,
  type InterceptorContext,
  type InterceptorErrorCode,
  type InterceptorPhase,
  type InterceptorRegistry,
  type ObserveOptions,
  type Observer,
  type OperationToken,
} from './interceptors.js';

export {
  validateExtensionEntries,
  type ExtensionEntryError,
  type ExtensionEntryErrorCode,
} from './validation.js';

// Type-only author interfaces for out-of-tree plugin packages. Every export
// below is erased at compile time, so this entry still imports only the
// extension-foundation modules above (services, extension, plugin, interceptors,
// validation — all type-only or identity helpers) and stays free of
// ORM/HTTP/queue/Socket.IO runtime libraries. The interfaces leak no native
// `Queue` or Socket.IO types: a plugin implements a job runtime adapter,
// broadcast adapter, CLI command, or deploy generator against the neutral
// contracts alone. Runtime construction (createJobsRuntime,
// createBullMQAdapter, ...) lives in the root entry, never here.

export type {
  JobAdapterContext,
  JobDispatchOptions,
  JobsRuntimeAdapter,
  ProcessJob,
  RuntimeJob,
  RuntimeProducer,
  RuntimeWorker,
} from '../jobs/runtime.js';

export type { BroadcastAdapter, BroadcastHandle } from '../broadcast/contracts.js';

export type { CliCommand, CliCommandContext } from '../cli/command-registry.js';

export { createCleanup } from '../internal/cleanup.js';

export type {
  DeploymentFileMap,
  DeploymentGenerator,
  DeploymentGeneratorContext,
} from '../deploy/registry.js';
