/**
 * Deploy subpath (`jsails/deploy`): config generators for Docker Compose,
 * static hosts, ONCE, and server hardening, plus the neutral deployment-generator
 * registry. Every generator returns string-only file maps; the registry validates
 * and freezes them but never writes to disk or opens a connection.
 */
export {
  generateDevValkeyConfig,
  ValkeyConfigError,
  type ValkeyConfigFiles,
  type ValkeyConfigOptions,
} from './valkey-config.js';

export {
  generateDevDatabaseConfig,
  DatabaseConfigError,
  type DatabaseDriver,
  type DevDatabaseFiles,
  type DevDatabaseOptions,
} from './database-config.js';

export {
  generateOnceConfig,
  OnceConfigError,
  type OnceConfigFiles,
  type OnceConfigOptions,
} from './once-config.js';

export {
  generateServerHardeningConfig,
  HardeningConfigError,
  type ServerHardeningFiles,
  type ServerHardeningOptions,
} from './hardening-config.js';

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
} from './hosting-config.js';

export {
  createDeploymentGeneratorRegistry,
  defineDeploymentGenerator,
  DeploymentRegistryError,
  type DeploymentFileMap,
  type DeploymentGenerator,
  type DeploymentGeneratorContext,
  type DeploymentGeneratorRegistry,
  type DeploymentGeneratorRegistryOptions,
} from './registry.js';

export {
  BUILTIN_DEPLOYMENT_GENERATOR_IDS,
  type BuiltinDeploymentGeneratorId,
} from './builtin-generators.js';
