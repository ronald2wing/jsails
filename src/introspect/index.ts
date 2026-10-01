/**
 * Introspect subpath (`jsails/introspect`): runtime introspection endpoint types,
 * providers, built-in providers, route registration, and config schema types.
 */

export {
  INTROSPECT_SECTIONS,
  introspectProvidersToken,
  type IntrospectProvider,
  type IntrospectSection,
  type IntrospectSectionError,
  type IntrospectSectionResult,
  type IntrospectSectionStatus,
} from './sections.js';

export {
  createBuiltinIntrospectProviders,
  PIPELINE_STAGES,
  migrationDataSourceToken,
  jobMetricsToken,
  failedJobStoreToken,
  type AppConfigIntrospectInput,
  type BuiltinIntrospectProviderInput,
  type PipelineSectionData,
} from './builtin-providers.js';

export {
  INTROSPECT_ENDPOINT,
  registerIntrospectRoute,
  assertNoIntrospectRouteCollision,
  type IntrospectRouteConfig,
} from './route.js';

export type { IntrospectConfig, ResolvedIntrospectConfig } from '../app/config/index.js';
