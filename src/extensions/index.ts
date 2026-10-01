/**
 * Extension foundation entry point.
 *
 * Named re-exports only. `extension.js` references Hono through `import type`,
 * so importing this module never pulls in an ORM or HTTP runtime.
 */

export {
  createServiceRegistry,
  createServiceToken,
  ServiceRegistryError,
  type ServiceRegistrar,
  type ServiceRegistry,
  type ServiceRegistryController,
  type ServiceRegistryErrorCode,
  type ServiceToken,
} from './services.js';

export {
  runExtensions,
  type ExtensionCleanup,
  type ExtensionContext,
  type ExtensionRuntime,
  type HttpExtensionHook,
  type JsailsExtension,
} from './extension.js';

// Type-only author interfaces for out-of-tree plugin packages. Every export
// below is erased at compile time, so this entry still imports only
// `./services.js` and `./extension.js` and stays free of ORM/HTTP/queue/Socket.IO
// runtime libraries. The interfaces leak no native `Queue` or Socket.IO types:
// a plugin implements a job runtime adapter, broadcast adapter, CLI command, or
// deploy generator against the neutral contracts alone. Runtime construction
// (createJobsRuntime, createBullMQAdapter, ...) lives in the root entry, never
// here.

export type {
  JobAdapterContext,
  JobDispatchOptions,
  JobRuntimeAdapter,
  ProcessJob,
  RuntimeJob,
  RuntimeProducer,
  RuntimeWorker,
} from '../jobs/runtime.js';

export type { BroadcastAdapter, BroadcastHandle } from '../broadcast/contracts.js';

export type { CliCommand, CliCommandContext } from '../cli/commands.js';

export type {
  DeploymentFileMap,
  DeploymentGenerator,
  DeploymentGeneratorContext,
} from '../deploy/registry.js';
