/**
 * Built-in introspection providers for every section.
 *
 * These providers are assembled deterministically from the inputs the
 * application runtime already holds at assembly time — the route manifest,
 * plugin enablement, the component runtime's `describe()` surface, process
 * health, and optional live sources (data source, diagnostics service, job
 * metrics/failed store). Each provider is self-contained and reports
 * `unavailable` when its source is absent; a provider that throws is caught by
 * the route and yields an `error` section without failing the rest.
 *
 * Providers that require a data source or external service never open a
 * connection or call a factory at construction time — those happen lazily
 * inside `collect`.
 */

import { getMigrationStatus, type MigrationDataSource } from '../migrations/migrator.js';
import type { MigrationHistory } from '../migrations/history.js';
import type { IntrospectProvider } from './sections.js';
import type { RouteManifest } from '../routing/routes.js';
import type { PluginEnablement } from '../plugins/enablement.js';
import type { ServerComponentsRuntime } from '../server-components/runtime.js';
import type { Diagnostics } from '../diagnostics/plugin.js';
import type { FailedJobStore, FailedJobEntry } from '../jobs/failed.js';
import type { JobMetrics } from '../jobs/metrics.js';
import type { JsonValue } from '../contracts/http.js';
import { createServiceToken, type ServiceToken } from '../extensions/services.js';

/**
 * The fixed request-pipeline stages in order. Mirrors the documented ordering
 * invariant (AGENTS.md) and must be updated in lockstep with the pipeline
 * implementation in {@link ../server/request-pipeline.ts}. This is the single
 * source an AI agent reads to understand the runtime pipeline shape without a
 * live request or browser.
 */
export const PIPELINE_STAGES: readonly string[] = [
  'body-limit',
  'method-not-allowed',
  'session',
  'origin-csrf',
  'authorize-global',
  'authorize-module',
  'middleware-global',
  'middleware-route',
  'handler',
];

/**
 * Redacted projection of the resolved application configuration for the
 * `config` introspection section. Carries booleans for callbacks and
 * directory basenames only — never absolute filesystem paths, secrets, or
 * callback identities.
 */
export interface AppConfigIntrospectInput {
  readonly host: string;
  readonly port: number;
  readonly publicOrigin?: string;
  readonly healthPath?: string;
  readonly maxBodyBytes: number;
  readonly shutdownTimeoutMs: number;
  /** Directory basenames only — never absolute paths. */
  readonly dirs: {
    readonly root: string;
    readonly pages: string;
    readonly api: string;
    readonly public: string;
    readonly out: string;
    readonly storage: string;
  };
  readonly hasAuthorize: boolean;
  readonly hasResolveSession: boolean;
  readonly hasSetup: boolean;
  readonly hasRenderer: boolean;
  readonly hasBroadcast: boolean;
  readonly commandCount: number;
  readonly extensionCount: number;
  readonly deploymentCount: number;
  readonly pluginEnabled: readonly string[];
  readonly middlewareNames: readonly string[];
  readonly globalMiddlewareCount: number;
  readonly introspectEnabled: boolean;
}

/**
 * Shape of the `pipeline` section data. All fields are always present when
 * status is `ok`.
 */
export interface PipelineSectionData {
  /** The fixed pipeline stages in execution order. */
  readonly stages: readonly string[];
  /** Registered and active middleware metadata. */
  readonly middleware: {
    /** Sorted names of every named middleware registered in the app config. */
    readonly registered: readonly string[];
    /** Number of resolved global middleware handlers (config + extensions). */
    readonly globalCount: number;
  };
  /** Static export never runs middleware, so this is always `false`. */
  readonly staticExportRunsMiddleware: false;
}

/**
 * Service token for a {@link MigrationDataSource} the introspection route
 * reads for the `migrations` section. Registered by the app or a custom
 * extension; when absent, the section reports `unavailable`.
 */
export const migrationDataSourceToken: ServiceToken<MigrationDataSource> =
  createServiceToken<MigrationDataSource>('migration-data-source');

/**
 * Service token for a {@link JobMetrics} instance the introspection route
 * reads for the `jobs` section. Registered by the jobs plugin or a custom
 * extension; when absent, the `jobs` section reports `unavailable`.
 */
export const jobMetricsToken: ServiceToken<JobMetrics> =
  createServiceToken<JobMetrics>('job-metrics');

/**
 * Service token for a {@link FailedJobStore} instance the introspection route
 * reads for the `jobs` section. Registered together with
 * {@link jobMetricsToken}; when either is absent the section reports
 * `unavailable`.
 */
export const failedJobStoreToken: ServiceToken<FailedJobStore> =
  createServiceToken<FailedJobStore>('failed-job-store');

/** Inputs the factory needs; all are optional because their sources may be absent. */
export interface BuiltinIntrospectProviderInput {
  /** Route manifest from `discoverRoutes`. Omitted means routes are unavailable. */
  readonly manifest?: RouteManifest;
  /** Plugin enablement from `resolvePluginEnablement`. Omitted means plugins are unavailable. */
  readonly plugins?: PluginEnablement;
  /**
   * Server-components runtime resolved from the extension system. When absent
   * the components section reports `unavailable`.
   */
  readonly componentsRuntime?: ServerComponentsRuntime;
  /**
   * Initialized migration data source for reading the tracking table. When
   * absent the migrations section reports `unavailable`. Never opened at
   * provider-construction time.
   */
  readonly dataSource?: MigrationDataSource;
  /**
   * Ordered migration definitions for computing pending migrations. When
   * present it is used to diff the tracking table against the resolved
   * history; when absent, pending is always `[]`.
   */
  readonly history?: MigrationHistory;
  /**
   * Diagnostics service from the extension registry. When absent the
   * diagnostics section reports `unavailable`.
   */
  readonly diagnosticsService?: Diagnostics;
  /**
   * Job metrics collector for per-job counts and durations. When absent the
   * jobs section reports `unavailable` (both metrics and failed store must be
   * present for the section to be available).
   */
  readonly jobMetrics?: JobMetrics;
  /**
   * Failed-job store for the most recent failures. The provider strips the
   * `data` (payload) field from every entry before serializing.
   */
  readonly failedJobStore?: FailedJobStore;
  /**
   * Sorted names of every named middleware registered via the config map
   * (from `middlewareRegistry.names()`). Defaults to `[]` when absent.
   */
  readonly middlewareNames?: readonly string[];
  /**
   * Number of resolved global middleware handlers (config-defined +
   * extension-provided). Defaults to `0` when absent.
   */
  readonly globalMiddlewareCount?: number;
  /**
   * Redacted application config projection for the `config` section. When
   * absent the section reports `unavailable`. Carries booleans for callbacks
   * and directory basenames only — never absolute paths, secrets, or
   * callback identities.
   */
  readonly appConfig?: AppConfigIntrospectInput;
}

/**
 * Build every recognised built-in provider (routes, plugins, components,
 * health, migrations, diagnostics, jobs). Each provider is self-contained
 * and returns its data synchronously or from already-available references;
 * the live sections (migrations, diagnostics, jobs) open no connection and
 * call no factory at construction time.
 */
export function createBuiltinIntrospectProviders(
  input: BuiltinIntrospectProviderInput,
): readonly IntrospectProvider[] {
  return [
    routesProvider(input.manifest),
    pluginsProvider(input.plugins),
    componentsProvider(input.componentsRuntime),
    pipelineProvider(input),
    configProvider(input.appConfig),
    healthProvider(),
    migrationsProvider(input.dataSource, input.history),
    diagnosticsProvider(input.diagnosticsService),
    jobsProvider(input.jobMetrics, input.failedJobStore),
  ];
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

function routesProvider(manifest?: RouteManifest): IntrospectProvider {
  return {
    section: 'routes',
    collect(): JsonValue {
      if (manifest === undefined) {
        return { status: 'unavailable' };
      }
      return {
        status: 'ok',
        data: manifest.entries.map((entry) => ({
          kind: entry.kind,
          route: entry.route,
          dynamic: entry.dynamic,
          catchAll: entry.catchAll,
          params: entry.params,
          // Observability without leaking absolute paths.
          layoutCount: entry.layouts?.length ?? 0,
          // `file` and `layouts` are deliberately omitted — they leak the
          // filesystem layout.
        })),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Plugins
// ---------------------------------------------------------------------------

function pluginsProvider(plugins?: PluginEnablement): IntrospectProvider {
  return {
    section: 'plugins',
    collect(): JsonValue {
      if (plugins === undefined) {
        return { status: 'unavailable' };
      }
      return {
        status: 'ok',
        data: {
          enabled: [...plugins.enabled],
          conflicts: [...plugins.conflicts],
          disabledManaged: [...plugins.disabledManaged],
          sources: {
            codeEnabled: [...plugins.codeEnabled],
            managedEnabled: [...plugins.managedEnabled],
          },
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

function componentsProvider(runtime?: ServerComponentsRuntime): IntrospectProvider {
  return {
    section: 'components',
    collect(): JsonValue {
      if (runtime === undefined) {
        return { status: 'unavailable' };
      }
      try {
        const desc = runtime.describe();
        return { status: 'ok', data: [...desc.components] } as unknown as JsonValue;
      } catch {
        return {
          status: 'error',
          error: { code: 'components_error', message: 'Failed to describe components' },
        };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

function healthProvider(): IntrospectProvider {
  return {
    section: 'health',
    collect(): JsonValue {
      return {
        status: 'ok',
        data: {
          status: 'ok',
          uptimeMs: Math.floor(process.uptime() * 1000),
          nodeVersion: process.version,
          pid: process.pid,
          // No env, no config values, no paths, no secrets.
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

/**
 * Status of the applied-migration prefix as reported by the introspection
 * endpoint. Names and timestamps only — never checksums, raw JSON, or SQL.
 */
interface MigrationIntrospectData {
  applied: Array<{ name: string; appliedAt: number }>;
  pending: string[];
}

function migrationsProvider(
  dataSource?: MigrationDataSource,
  history?: MigrationHistory,
): IntrospectProvider {
  return {
    section: 'migrations',
    async collect(): Promise<JsonValue> {
      if (dataSource === undefined) {
        return { status: 'unavailable' };
      }
      if (!dataSource.isInitialized) {
        return { status: 'unavailable' };
      }

      // When history is present, use getMigrationStatus which validates the
      // tracking table against the resolved history and reports applied/pending.
      // When history is absent, query the tracking table directly for applied
      // names only — pending stays empty.
      if (history !== undefined) {
        const status = await getMigrationStatus(dataSource, history);

        // When the tracking table does not exist yet, report `unavailable`
        // rather than `error` — a freshly migrated app without the table
        // just has no migration state to introspect.
        if (!status.tableExists) {
          return { status: 'unavailable' };
        }

        const data: MigrationIntrospectData = {
          // The tracking table has no timestamp column; appliedAt is 0 as
          // the "unknown" sentinel. This is truthful — we never fabricate
          // a date.
          applied: status.applied.map((name) => ({ name, appliedAt: 0 })),
          pending: status.pending,
        };
        return { status: 'ok', data } as unknown as JsonValue;
      }

      // No history: query the tracking table directly for applied names.
      // Future work could resolve the history from a file-system scan, but
      // for now a read of the tracking table is the minimal safe query.
      // Without history we cannot compute pending, so pending stays `[]`.
      try {
        const queryRunner = dataSource.createQueryRunner();
        let rows: Array<{ name: unknown }> = [];
        try {
          await queryRunner.connect();
          const tableExists = await queryRunner.hasTable('jsails_migrations');
          if (!tableExists) {
            return { status: 'unavailable' };
          }
          const result = await queryRunner.query(
            'SELECT name FROM jsails_migrations WHERE status = ? ORDER BY name',
            ['applied'],
            true,
          );
          rows = result.records as Array<{ name: unknown }>;
        } finally {
          try {
            await queryRunner.release();
          } catch {
            // Release failure is secondary; never obscure the primary result.
          }
        }

        const data: MigrationIntrospectData = {
          applied: rows.map((row) => ({ name: String(row.name), appliedAt: 0 })),
          pending: [],
        };
        return { status: 'ok', data } as unknown as JsonValue;
      } catch {
        return {
          status: 'error',
          error: { code: 'migrations_error', message: 'Failed to read migration status' },
        };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

function diagnosticsProvider(service?: Diagnostics): IntrospectProvider {
  return {
    section: 'diagnostics',
    collect(): JsonValue {
      if (service === undefined) {
        return { status: 'unavailable' };
      }
      try {
        // stats() returns aggregate counts and durations only — never raw
        // entries, which can carry request-derived metadata.
        const stats = service.stats();
        return { status: 'ok', data: stats as unknown as JsonValue };
      } catch {
        return {
          status: 'error',
          error: { code: 'diagnostics_error', message: 'Failed to read diagnostics stats' },
        };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

/**
 * Job introspection data: per-job metrics (counts + durations) and the most
 * recent failed-job entries with payloads stripped. Never includes raw job
 * data or stack traces.
 */
interface JobsIntrospectData {
  metrics: Readonly<Record<string, unknown>>;
  failed: Array<{
    id: string;
    name: string;
    failedAt: number;
    attempts: number;
    error: string;
  }>;
}

function jobsProvider(metrics?: JobMetrics, failedStore?: FailedJobStore): IntrospectProvider {
  return {
    section: 'jobs',
    collect(): JsonValue {
      if (metrics === undefined || failedStore === undefined) {
        return { status: 'unavailable' };
      }
      try {
        const snapshot = metrics.snapshot();
        const failed = failedStore.list();

        // Strip the `data` (payload) field from every failed entry — job
        // payloads can carry user data and must never leak through
        // introspection.
        const safeFailed = failed.map((entry: FailedJobEntry) => ({
          id: entry.id,
          name: entry.name,
          failedAt: entry.failedAt.getTime(),
          attempts: entry.attempts,
          error: entry.error,
        }));

        const data: JobsIntrospectData = {
          metrics: snapshot,
          failed: safeFailed,
        };
        return { status: 'ok', data } as unknown as JsonValue;
      } catch {
        return {
          status: 'error',
          error: { code: 'jobs_error', message: 'Failed to read job metrics' },
        };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

/**
 * The pipeline provider is always available — the stage ordering is fixed and
 * the middleware metadata derives from inputs the assembler always has. Unlike
 * the live sections (migrations, diagnostics, jobs) there is no external
 * dependency that can be absent.
 */
function pipelineProvider(input: BuiltinIntrospectProviderInput): IntrospectProvider {
  return {
    section: 'pipeline',
    collect(): JsonValue {
      const data: PipelineSectionData = {
        stages: PIPELINE_STAGES,
        middleware: {
          registered: input.middlewareNames ?? [],
          globalCount: input.globalMiddlewareCount ?? 0,
        },
        // Static export assembles no middleware chain and runs none.
        staticExportRunsMiddleware: false,
      };
      return { status: 'ok', data } as unknown as JsonValue;
    },
  };
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * The config provider returns a redacted projection of the resolved
 * application configuration. It carries booleans for callbacks (so an
 * agent knows whether `authorize`, `resolveSession`, `setup`, `renderer`,
 * or `broadcast` is configured) and directory basenames only (so the
 * agent sees the layout without absolute filesystem paths). Secrets,
 * the raw config-path string, and callback identities are never included.
 */
function configProvider(appConfig?: AppConfigIntrospectInput): IntrospectProvider {
  return {
    section: 'config',
    collect(): JsonValue {
      if (appConfig === undefined) {
        return { status: 'unavailable' };
      }
      return { status: 'ok', data: appConfig as unknown as JsonValue };
    },
  };
}
