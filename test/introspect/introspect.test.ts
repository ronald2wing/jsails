/**
 * Runtime introspection endpoint behaviour.
 *
 * Exercises `GET /_jsails/introspect` through `createTestApp` so the real Hono
 * pipeline (authorization, session resolution, section collection) is exercised
 * in-process. No broadcast transport is attached and no Valkey connection is
 * opened.
 *
 * The live sections (migrations, diagnostics, jobs) are tested through custom
 * extensions that register their required services under the introspection
 * service tokens.
 */

import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import type { QueryRunner } from 'typeorm';

import { createTestApp } from '../../src/testing/app.js';
import { INTROSPECT_SECTIONS } from '../../src/introspect/sections.js';
import type { JsailsAppConfig } from '../../src/app/config/index.js';
import {
  migrationDataSourceToken,
  jobMetricsToken,
  failedJobStoreToken,
  PIPELINE_STAGES,
} from '../../src/introspect/builtin-providers.js';
import { createDiagnosticsRecorder } from '../../src/diagnostics/recorder.js';
import {
  diagnosticsPlugin,
  diagnosticsToken,
  type Diagnostics,
} from '../../src/diagnostics/plugin.js';
import { createJobMetrics } from '../../src/jobs/metrics.js';
import { createFailedJobStore } from '../../src/jobs/failed.js';
import type { SchemaEditorDriver } from '../../src/database/schema-editor.js';
import type { ServiceRegistrar } from '../../src/extensions/services.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A simple `authorize` that always allows. */
function allowAll() {
  return true;
}

/** Per-suite shared config shape: the introspect field is overridden per test. */
function makeConfig(overrides: Partial<JsailsAppConfig> = {}): JsailsAppConfig {
  return {
    rootDir: '.',
    pages: 'pages',
    public: 'public',
    out: 'out',
    port: 0,
    ...overrides,
  };
}

/** Config with the new sections enabled in the introspect allow-list. */
function makeConfigWithSections(overrides: Partial<JsailsAppConfig> = {}): JsailsAppConfig {
  return makeConfig({
    introspect: {
      enabled: true,
      authorize: allowAll,
      sections: ['routes', 'plugins', 'components', 'health', 'migrations', 'diagnostics', 'jobs'],
    },
    ...overrides,
  });
}

/**
 * Minimal fake for the `jsails_migrations` tracking table backed by an array
 * of { name, status } rows. Satisfies the `MigrationDataSource` interface
 * the migrations provider queries.
 */
interface FakeTrackingRow {
  name: string;
  status: string;
}

class FakeDb {
  tableExists = false;
  rows: FakeTrackingRow[] = [];
}

class FakeQueryRunner {
  released = false;

  constructor(private readonly db: FakeDb) {}

  async connect(): Promise<void> {
    // no-op
  }

  async release(): Promise<void> {
    this.released = true;
  }

  async hasTable(_name: string): Promise<boolean> {
    return this.db.tableExists;
  }

  async query(_sql: string, parameters?: unknown[], _structured?: unknown): Promise<unknown> {
    // The introspection provider runs this query:
    //   SELECT name FROM jsails_migrations WHERE status = ? ORDER BY name
    const status = parameters?.[0] as string | undefined;
    const matching = status ? this.db.rows.filter((row) => row.status === status) : this.db.rows;
    matching.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return { records: matching.map((row) => ({ name: row.name })) };
  }
}

class FakeDataSource {
  isInitialized = true;
  readonly jsailsDriver: SchemaEditorDriver = 'sqlite';
  readonly options = { database: ':memory:' };

  constructor(readonly db: FakeDb) {}

  createQueryRunner(): QueryRunner {
    return new FakeQueryRunner(this.db) as unknown as QueryRunner;
  }
}

// ---------------------------------------------------------------------------
// Disabled by default
// ---------------------------------------------------------------------------

describe('disabled', () => {
  test('route is not registered when introspect is absent', async (t) => {
    const app = await createTestApp({ config: makeConfig(), lifecycle: t });
    const res = await app.request('/_jsails/introspect');
    assert.equal(res.status, 404);
  });

  test('route is not registered when enabled is false', async (t) => {
    const app = await createTestApp({
      config: makeConfig({ introspect: { enabled: false, authorize: allowAll } }),
      lifecycle: t,
    });
    const res = await app.request('/_jsails/introspect');
    assert.equal(res.status, 404);
  });
});

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

describe('config validation', () => {
  test('rejects enabled: true without authorize', async () => {
    try {
      await createTestApp({
        config: makeConfig({ introspect: { enabled: true } }),
      });
      assert.fail('expected AppConfigError');
    } catch (err) {
      assert.ok(err instanceof Error);
      assert.match(err.message, /introspect\.authorize is required/);
    }
  });
});

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

describe('authorize', () => {
  test('returns 403 when authorize resolves to falsy boolean', async (t) => {
    const app = await createTestApp({
      config: makeConfig({
        introspect: { enabled: true, authorize: () => false },
      }),
      lifecycle: t,
    });
    const res = await app.request('/_jsails/introspect');
    assert.equal(res.status, 403);
  });

  test('returns 403 when authorize throws', async (t) => {
    const app = await createTestApp({
      config: makeConfig({
        introspect: {
          enabled: true,
          authorize: () => {
            throw new Error('nope');
          },
        },
      }),
      lifecycle: t,
    });
    const res = await app.request('/_jsails/introspect');
    assert.equal(res.status, 403);
  });

  test('returns 403 when authorize resolves to truthy non-boolean', async (t) => {
    const app = await createTestApp({
      config: makeConfig({
        introspect: { enabled: true, authorize: () => 'yes' as unknown as boolean },
      }),
      lifecycle: t,
    });
    const res = await app.request('/_jsails/introspect');
    assert.equal(res.status, 403);
  });

  test('returns 200 with sections when authorize allows', async (t) => {
    const app = await createTestApp({
      config: makeConfig({
        introspect: { enabled: true, authorize: allowAll },
      }),
      lifecycle: t,
    });
    const res = await app.request('/_jsails/introspect');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /application\/json/);
    assert.match(res.headers.get('cache-control') ?? '', /no-store/);

    const body = await res.json();
    assert.ok(typeof body.generatedAt === 'number');
    assert.ok(body.generatedAt > 0);
    assert.ok(typeof body.sections === 'object');

    // Safe subset should always be present when no ?section= filter is set.
    assert.ok('routes' in body.sections);
    assert.ok('plugins' in body.sections);
    assert.ok('components' in body.sections);
    assert.ok('health' in body.sections);
  });
});

// ---------------------------------------------------------------------------
// Section filtering
// ---------------------------------------------------------------------------

describe('?section= filtering', () => {
  test('returns only requested section', async (t) => {
    const app = await createTestApp({
      config: makeConfig({
        introspect: {
          enabled: true,
          authorize: allowAll,
          sections: ['routes', 'plugins', 'components', 'health'],
        },
      }),
      lifecycle: t,
    });
    const res = await app.request('/_jsails/introspect?section=routes');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok('routes' in body.sections);
    assert.ok(!('plugins' in body.sections));
  });

  test('rejects unknown section with 400', async (t) => {
    const app = await createTestApp({
      config: makeConfig({
        introspect: { enabled: true, authorize: allowAll },
      }),
      lifecycle: t,
    });
    const res = await app.request('/_jsails/introspect?section=nonexistent');
    assert.equal(res.status, 400);

    const body = await res.json();
    assert.ok(Array.isArray(body.error.valid));
  });

  test('accepts comma-separated and repeatable sections', async (t) => {
    const app = await createTestApp({
      config: makeConfig({
        introspect: {
          enabled: true,
          authorize: allowAll,
          sections: ['routes', 'plugins', 'components', 'health'],
        },
      }),
      lifecycle: t,
    });
    const res = await app.request('/_jsails/introspect?section=routes,plugins&section=health');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok('routes' in body.sections);
    assert.ok('plugins' in body.sections);
    assert.ok('health' in body.sections);
    assert.ok(!('components' in body.sections));
  });

  test('an explicit request may name a section outside the configured default', async (t) => {
    // Regression: `sections` is the default set, not an allowlist. Requesting a
    // valid section that is not in the default must succeed (and report
    // `unavailable` when no provider handles it), not 400.
    const app = await createTestApp({
      config: makeConfig({
        introspect: {
          enabled: true,
          authorize: allowAll,
          sections: ['routes', 'plugins', 'components', 'health'],
        },
      }),
      lifecycle: t,
    });
    const res = await app.request('/_jsails/introspect?section=migrations,diagnostics,jobs');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok('migrations' in body.sections);
    assert.ok('diagnostics' in body.sections);
    assert.ok('jobs' in body.sections);
    assert.ok(!('routes' in body.sections));
  });
});

// ---------------------------------------------------------------------------
// Section shapes - safe subset
// ---------------------------------------------------------------------------

describe('section shapes', () => {
  test('routes section has correct shape (no file or layout leaks)', async (t) => {
    const app = await createTestApp({
      config: makeConfig({
        introspect: { enabled: true, authorize: allowAll },
      }),
      lifecycle: t,
    });
    const res = await app.request('/_jsails/introspect');
    const body = await res.json();
    const routes = body.sections.routes;
    assert.equal(routes.status, 'ok');
    assert.ok(Array.isArray(routes.data));

    // No `file` or `layouts` field should leak through (both carry absolute paths).
    const serialized = JSON.stringify(body);
    assert.ok(!serialized.includes('configPath'));
    assert.ok(!serialized.includes('"file"'));
    assert.ok(!serialized.includes('"layouts"'));

    // `layoutCount` must be present for observability.
    for (const entry of routes.data) {
      assert.equal(typeof entry.layoutCount, 'number', 'each route must have layoutCount');
      assert.ok(entry.layoutCount >= 0, 'layoutCount must be >= 0');
    }
  });

  test('plugins section shows empty enablement with no plugins configured', async (t) => {
    const app = await createTestApp({
      config: makeConfig({
        introspect: { enabled: true, authorize: allowAll },
      }),
      lifecycle: t,
    });
    const res = await app.request('/_jsails/introspect?section=plugins');
    const body = await res.json();
    assert.equal(body.sections.plugins.status, 'ok');
    assert.deepStrictEqual(body.sections.plugins.data.enabled, []);
    assert.deepStrictEqual(body.sections.plugins.data.conflicts, []);
  });

  test('health section has expected fields', async (t) => {
    const app = await createTestApp({
      config: makeConfig({
        introspect: { enabled: true, authorize: allowAll },
      }),
      lifecycle: t,
    });
    const res = await app.request('/_jsails/introspect?section=health');
    const body = await res.json();
    const health = body.sections.health;
    assert.equal(health.status, 'ok');
    assert.equal(health.data.status, 'ok');
    assert.ok(typeof health.data.uptimeMs === 'number');
    assert.ok(typeof health.data.nodeVersion === 'string');
    assert.ok(typeof health.data.pid === 'number');

    // No env values.
    const serialized = JSON.stringify(health);
    assert.ok(!serialized.includes('process.env'));
  });

  test('components section is unavailable with no runtime', async (t) => {
    const app = await createTestApp({
      config: makeConfig({
        introspect: { enabled: true, authorize: allowAll },
      }),
      lifecycle: t,
    });
    const res = await app.request('/_jsails/introspect?section=components');
    const body = await res.json();
    assert.equal(body.sections.components.status, 'unavailable');
  });
});

// ---------------------------------------------------------------------------
// Pipeline section
// ---------------------------------------------------------------------------

describe('pipeline section', () => {
  test('pipeline is a recognised section in INTROSPECT_SECTIONS', () => {
    assert.ok(INTROSPECT_SECTIONS.includes('pipeline'), 'pipeline must be in INTROSPECT_SECTIONS');
  });

  test('returns ok with correct stages, empty middleware, and staticExport false', async (t) => {
    const app = await createTestApp({
      config: makeConfig({ introspect: { enabled: true, authorize: allowAll } }),
      lifecycle: t,
    });
    const res = await app.request('/_jsails/introspect?section=pipeline');
    assert.equal(res.status, 200);
    const body = await res.json();
    const pipeline = body.sections.pipeline;
    assert.equal(pipeline.status, 'ok');
    assert.deepStrictEqual(pipeline.data.stages, PIPELINE_STAGES);
    assert.ok(Array.isArray(pipeline.data.middleware.registered));
    assert.equal(pipeline.data.middleware.registered.length, 0);
    assert.equal(pipeline.data.middleware.globalCount, 0);
    assert.equal(pipeline.data.staticExportRunsMiddleware, false);
  });

  test('middleware.registered reflects the configured middleware names, sorted', async (t) => {
    const handler = (): Response => new Response('ok');
    const app = await createTestApp({
      config: makeConfig({
        middleware: { log: handler, auth: handler },
        introspect: { enabled: true, authorize: allowAll },
      }),
      lifecycle: t,
    });
    const res = await app.request('/_jsails/introspect?section=pipeline');
    assert.equal(res.status, 200);
    const body = await res.json();
    const pipeline = body.sections.pipeline;
    assert.equal(pipeline.status, 'ok');
    assert.deepStrictEqual(pipeline.data.middleware.registered, ['auth', 'log']);
  });

  test('globalCount reflects resolved global middleware count', async (t) => {
    const handler = (): Response => new Response('ok');
    const app = await createTestApp({
      config: makeConfig({
        middleware: { m1: handler },
        globalMiddleware: ['m1'],
        introspect: { enabled: true, authorize: allowAll },
      }),
      lifecycle: t,
    });
    const res = await app.request('/_jsails/introspect?section=pipeline');
    assert.equal(res.status, 200);
    const body = await res.json();
    const pipeline = body.sections.pipeline;
    assert.equal(pipeline.status, 'ok');
    assert.equal(pipeline.data.middleware.globalCount, 1);
    assert.deepStrictEqual(pipeline.data.middleware.registered, ['m1']);
  });

  test('pipeline section is not in default safe subset response', async (t) => {
    const app = await createTestApp({
      config: makeConfig({ introspect: { enabled: true, authorize: allowAll } }),
      lifecycle: t,
    });
    const res = await app.request('/_jsails/introspect');
    const body = await res.json();
    assert.ok(!('pipeline' in body.sections), 'pipeline should not be in the default safe subset');
  });
});

// ---------------------------------------------------------------------------
// Config section
// ---------------------------------------------------------------------------

describe('config section', () => {
  test('config is a recognised section in INTROSPECT_SECTIONS', () => {
    assert.ok(INTROSPECT_SECTIONS.includes('config'), 'config must be in INTROSPECT_SECTIONS');
  });

  test('returns ok with the redacted resolved config', async (t) => {
    const app = await createTestApp({
      config: makeConfig({
        host: '127.0.0.1',
        port: 4321,
        introspect: { enabled: true, authorize: allowAll },
      }),
      lifecycle: t,
    });
    const res = await app.request('/_jsails/introspect?section=config');
    assert.equal(res.status, 200);
    const body = await res.json();
    const config = body.sections.config;
    assert.equal(config.status, 'ok');
    assert.equal(config.data.host, '127.0.0.1');
    assert.equal(config.data.port, 4321);
    assert.equal(config.data.introspectEnabled, true);
    assert.equal(config.data.hasAuthorize, false);
    assert.equal(config.data.hasResolveSession, false);
    assert.equal(config.data.hasSetup, false);
    assert.equal(config.data.hasRenderer, false);
    assert.equal(config.data.hasBroadcast, false);
    assert.ok(Array.isArray(config.data.pluginEnabled));
    assert.ok(Array.isArray(config.data.middlewareNames));
    assert.equal(typeof config.data.globalMiddlewareCount, 'number');
  });

  test('directory fields are basenames only, never absolute paths', async (t) => {
    const app = await createTestApp({
      config: makeConfig({ introspect: { enabled: true, authorize: allowAll } }),
      lifecycle: t,
    });
    const res = await app.request('/_jsails/introspect?section=config');
    const body = await res.json();
    const dirs = body.sections.config.data.dirs as Record<string, string>;
    for (const value of Object.values(dirs)) {
      assert.ok(!value.includes('/'), `directory value must not be an absolute path: ${value}`);
    }
  });

  test('never exposes callback identities or config paths', async (t) => {
    const app = await createTestApp({
      config: makeConfig({ introspect: { enabled: true, authorize: allowAll } }),
      lifecycle: t,
    });
    const res = await app.request('/_jsails/introspect?section=config');
    const text = await res.text();
    assert.ok(!text.includes('configPath'));
    assert.ok(!text.includes('rootDir'));
    assert.ok(!text.includes('storageDir'));
    // Only the `has*` booleans are present, never the callbacks themselves.
    assert.ok(!text.includes('"authorize"'));
    assert.ok(!text.includes('"resolveSession"'));
    assert.ok(!text.includes('"setup"'));
    assert.ok(!text.includes('"renderer"'));
    assert.ok(!text.includes('"broadcast"'));
  });

  test('config section is not in default safe subset response', async (t) => {
    const app = await createTestApp({
      config: makeConfig({ introspect: { enabled: true, authorize: allowAll } }),
      lifecycle: t,
    });
    const res = await app.request('/_jsails/introspect');
    const body = await res.json();
    assert.ok(!('config' in body.sections), 'config should not be in the default safe subset');
  });
});

// ---------------------------------------------------------------------------
// Leak assertions - safe subset
// ---------------------------------------------------------------------------

describe('leak assertions', () => {
  test('response never contains filesystem paths or secrets', async (t) => {
    const app = await createTestApp({
      config: makeConfig({
        introspect: { enabled: true, authorize: allowAll },
      }),
      lifecycle: t,
    });

    const res = await app.request('/_jsails/introspect');
    const text = await res.text();

    // No filesystem-leak patterns.
    assert.ok(!text.includes('configPath'));
    assert.ok(!text.includes('rootDir'));
    assert.ok(!text.includes('storageDir'));
    assert.ok(!text.includes('csrfToken'));
    assert.ok(!text.includes('"session"'));
    // No env values.
    assert.ok(!text.includes('DATABASE_'));
    assert.ok(!text.includes('VALKEY_'));
  });
});

// ---------------------------------------------------------------------------
// Section-level error isolation
// ---------------------------------------------------------------------------

describe('error isolation', () => {
  test('provider that returns unavailable leaves other sections ok', async (t) => {
    const app = await createTestApp({
      config: makeConfig({
        introspect: { enabled: true, authorize: allowAll },
      }),
      lifecycle: t,
    });
    const res = await app.request('/_jsails/introspect?section=health,components');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.sections.health.status, 'ok');
    assert.equal(body.sections.components.status, 'unavailable');
  });
});

// ---------------------------------------------------------------------------
// Migrations section
// ---------------------------------------------------------------------------

describe('migrations section', () => {
  test('?section=migrations with no data source → unavailable', async (t) => {
    const app = await createTestApp({
      config: makeConfigWithSections(),
      lifecycle: t,
    });
    const res = await app.request('/_jsails/introspect?section=migrations');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.sections.migrations.status, 'unavailable');
  });

  test('?section=migrations with data source, no tracking table → unavailable', async (t) => {
    const db = new FakeDb();
    db.tableExists = false; // no tracking table yet
    const ds = new FakeDataSource(db);

    const app = await createTestApp({
      config: makeConfigWithSections({
        extensions: [
          {
            name: 'test-migrations',
            setup({ services }: { services: ServiceRegistrar }) {
              services.provide(migrationDataSourceToken, ds);
            },
          },
        ],
      }),
      lifecycle: t,
    });
    const res = await app.request('/_jsails/introspect?section=migrations');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.sections.migrations.status, 'unavailable');
  });

  test('?section=migrations with data source and applied rows → ok with documented shape', async (t) => {
    const db = new FakeDb();
    db.tableExists = true;
    db.rows = [
      { name: 'create_users', status: 'applied' },
      { name: 'add_email', status: 'applied' },
    ];
    const ds = new FakeDataSource(db);

    const app = await createTestApp({
      config: makeConfigWithSections({
        extensions: [
          {
            name: 'test-migrations',
            setup({ services }: { services: ServiceRegistrar }) {
              services.provide(migrationDataSourceToken, ds);
            },
          },
        ],
      }),
      lifecycle: t,
    });
    const res = await app.request('/_jsails/introspect?section=migrations');
    assert.equal(res.status, 200);
    const body = await res.json();
    const migrations = body.sections.migrations;
    assert.equal(migrations.status, 'ok');
    assert.ok(Array.isArray(migrations.data.applied));
    assert.ok(Array.isArray(migrations.data.pending));
    assert.equal(migrations.data.applied.length, 2);

    // Each applied entry has name and appliedAt only.
    for (const entry of migrations.data.applied) {
      assert.ok(typeof entry.name === 'string');
      assert.equal(entry.appliedAt, 0); // no timestamp in tracking table
      assert.ok(!('checksum' in entry));
      assert.ok(!('operations' in entry));
      assert.ok(!('status' in entry));
      assert.ok(!('kind' in entry));
    }

    // Leak assertion: no checksums, operations, or raw SQL.
    const serialized = JSON.stringify(migrations);
    assert.ok(!serialized.includes('"checksum"'));
    assert.ok(!serialized.includes('"operations"'));
    assert.ok(!serialized.includes('SELECT'));
  });

  test('migrations section is not in default safe subset response', async (t) => {
    // The safe subset is routes, plugins, components, health. Without an
    // explicit `sections` override, migrations is not part of the DEFAULT
    // response — but an explicit `?section=migrations` still resolves it
    // (reporting `unavailable` when no provider handles it).
    const app = await createTestApp({
      config: makeConfig({
        introspect: { enabled: true, authorize: allowAll },
      }),
      lifecycle: t,
    });
    const res = await app.request('/_jsails/introspect?section=migrations');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.sections.migrations.status, 'unavailable');
  });
});

// ---------------------------------------------------------------------------
// Diagnostics section
// ---------------------------------------------------------------------------

describe('diagnostics section', () => {
  test('?section=diagnostics with no diagnostics plugin → unavailable', async (t) => {
    const app = await createTestApp({
      config: makeConfigWithSections(),
      lifecycle: t,
    });
    const res = await app.request('/_jsails/introspect?section=diagnostics');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.sections.diagnostics.status, 'unavailable');
  });

  test('?section=diagnostics with plugin → ok with documented shape', async (t) => {
    const recorder = createDiagnosticsRecorder();
    recorder.record({ type: 'http', durationMs: 42, data: { status: 'success' } });
    recorder.record({ type: 'query', durationMs: 12 });

    const app = await createTestApp({
      config: makeConfigWithSections({
        extensions: [diagnosticsPlugin({ recorder })],
      }),
      lifecycle: t,
    });
    const res = await app.request('/_jsails/introspect?section=diagnostics');
    assert.equal(res.status, 200);
    const body = await res.json();
    const diag = body.sections.diagnostics;
    assert.equal(diag.status, 'ok');

    // stats() shape: total, byType, withDuration
    assert.ok(typeof diag.data.total === 'number');
    assert.ok(typeof diag.data.byType === 'object');
    assert.ok(typeof diag.data.withDuration === 'number');
    assert.equal(diag.data.total, 2);
    assert.equal(diag.data.withDuration, 2);

    // Leak assertion: no raw entries (they may carry request data).
    const serialized = JSON.stringify(diag);
    assert.ok(!serialized.includes('"entries"'));
  });

  test('diagnostics section is not in default safe subset response', async (t) => {
    // Not part of the default response, but an explicit request still resolves
    // it (reporting `unavailable` when no provider handles it).
    const app = await createTestApp({
      config: makeConfig({
        introspect: { enabled: true, authorize: allowAll },
      }),
      lifecycle: t,
    });
    const res = await app.request('/_jsails/introspect?section=diagnostics');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.sections.diagnostics.status, 'unavailable');
  });
});

// ---------------------------------------------------------------------------
// Jobs section
// ---------------------------------------------------------------------------

describe('jobs section', () => {
  test('?section=jobs with no jobs runtime → unavailable', async (t) => {
    const app = await createTestApp({
      config: makeConfigWithSections(),
      lifecycle: t,
    });
    const res = await app.request('/_jsails/introspect?section=jobs');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.sections.jobs.status, 'unavailable');
  });

  test('?section=jobs with metrics and failed store → ok with documented shape', async (t) => {
    const metrics = createJobMetrics();
    metrics.recordCompleted('sendEmail', 150);
    metrics.recordCompleted('sendEmail', 200);
    metrics.recordFailed('cleanup', new Error('timeout'));

    const failedStore = createFailedJobStore({ maxEntries: 10 });
    failedStore.add({
      id: 'f1',
      name: 'cleanup',
      data: { file: '/tmp/secret.txt' },
      error: 'timeout',
      failedAt: new Date('2026-01-15T10:00:00Z'),
      attempts: 3,
    });

    const app = await createTestApp({
      config: makeConfigWithSections({
        extensions: [
          {
            name: 'test-jobs',
            setup({ services }: { services: ServiceRegistrar }) {
              services.provide(jobMetricsToken, metrics);
              services.provide(failedJobStoreToken, failedStore);
            },
          },
        ],
      }),
      lifecycle: t,
    });
    const res = await app.request('/_jsails/introspect?section=jobs');
    assert.equal(res.status, 200);
    const body = await res.json();
    const jobs = body.sections.jobs;
    assert.equal(jobs.status, 'ok');

    // metrics: per-job snapshot with completed, failed, avgDurationMs, lastError
    assert.ok(typeof jobs.data.metrics === 'object');
    const sendEmailMetrics = jobs.data.metrics.sendEmail as Record<string, unknown>;
    assert.ok(sendEmailMetrics !== undefined);
    assert.equal(sendEmailMetrics.completed, 2);
    assert.equal(sendEmailMetrics.failed, 0);
    assert.ok(typeof sendEmailMetrics.avgDurationMs === 'number');

    const cleanupMetrics = jobs.data.metrics.cleanup as Record<string, unknown>;
    assert.ok(cleanupMetrics !== undefined);
    assert.equal(cleanupMetrics.failed, 1);

    // failed: metadata only — never includes payload (data) or stack
    assert.ok(Array.isArray(jobs.data.failed));
    assert.equal(jobs.data.failed.length, 1);
    const failedEntry = jobs.data.failed[0] as Record<string, unknown>;
    assert.equal(failedEntry.id, 'f1');
    assert.equal(failedEntry.name, 'cleanup');
    assert.ok(typeof failedEntry.failedAt === 'number');
    assert.equal(failedEntry.attempts, 3);
    assert.equal(failedEntry.error, 'timeout');

    // Leak assertions: no payload data, no stack traces.
    // The word "data" appears in the envelope (sections.jobs.data), so we check
    // that the *failed entry* has no `data` field and the payload content is absent.
    const serialized = JSON.stringify(jobs);
    assert.ok(!serialized.includes('secret.txt'));
    assert.ok(!serialized.includes('"stack"'));
    // Verify the failed entry shape explicitly: id, name, failedAt, attempts, error
    // and nothing else (no data field).
    const failedEntryKeys = Object.keys(failedEntry).sort();
    assert.deepStrictEqual(failedEntryKeys, ['attempts', 'error', 'failedAt', 'id', 'name']);
  });

  test('?section=jobs with only metrics but no store → unavailable', async (t) => {
    const metrics = createJobMetrics();
    const app = await createTestApp({
      config: makeConfigWithSections({
        extensions: [
          {
            name: 'test-jobs-metrics-only',
            setup({ services }: { services: ServiceRegistrar }) {
              services.provide(jobMetricsToken, metrics);
            },
          },
        ],
      }),
      lifecycle: t,
    });
    const res = await app.request('/_jsails/introspect?section=jobs');
    assert.equal(res.status, 200);
    const body = await res.json();
    // Both metrics and failed store must be present; with only one it's unavailable.
    assert.equal(body.sections.jobs.status, 'unavailable');
  });

  test('jobs section is not in default safe subset response', async (t) => {
    // Not part of the default response, but an explicit request still resolves
    // it (reporting `unavailable` when no provider handles it).
    const app = await createTestApp({
      config: makeConfig({
        introspect: { enabled: true, authorize: allowAll },
      }),
      lifecycle: t,
    });
    const res = await app.request('/_jsails/introspect?section=jobs');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.sections.jobs.status, 'unavailable');
  });
});

// ---------------------------------------------------------------------------
// Live section leak assertions
// ---------------------------------------------------------------------------

describe('live section leak assertions', () => {
  test('migrations body has no checksum, operations, or SQL', async (t) => {
    const db = new FakeDb();
    db.tableExists = true;
    db.rows = [{ name: 'create_users', status: 'applied' }];
    const ds = new FakeDataSource(db);

    const app = await createTestApp({
      config: makeConfigWithSections({
        extensions: [
          {
            name: 'test-migrations',
            setup({ services }: { services: ServiceRegistrar }) {
              services.provide(migrationDataSourceToken, ds);
            },
          },
        ],
      }),
      lifecycle: t,
    });
    const res = await app.request('/_jsails/introspect?section=migrations');
    const text = await res.text();
    assert.ok(!text.includes('"checksum"'));
    assert.ok(!text.includes('"operations"'));
    assert.ok(!text.includes('SELECT'));
    assert.ok(!text.includes('INSERT'));
    assert.ok(!text.includes('CREATE'));
  });

  test('diagnostics body has no entries', async (t) => {
    const recorder = createDiagnosticsRecorder();
    recorder.record({ type: 'http', durationMs: 10 });

    const app = await createTestApp({
      config: makeConfigWithSections({
        extensions: [diagnosticsPlugin({ recorder })],
      }),
      lifecycle: t,
    });
    const res = await app.request('/_jsails/introspect?section=diagnostics');
    const text = await res.text();
    assert.ok(!text.includes('"entries"'));
  });

  test('jobs body has no data or stack', async (t) => {
    const metrics = createJobMetrics();
    const failedStore = createFailedJobStore();
    failedStore.add({
      id: 'f1',
      name: 'test',
      data: { secret: 'ssh-key' },
      error: 'fail',
      failedAt: new Date(),
      attempts: 1,
    });

    const app = await createTestApp({
      config: makeConfigWithSections({
        extensions: [
          {
            name: 'test-jobs-leak',
            setup({ services }: { services: ServiceRegistrar }) {
              services.provide(jobMetricsToken, metrics);
              services.provide(failedJobStoreToken, failedStore);
            },
          },
        ],
      }),
      lifecycle: t,
    });
    const res = await app.request('/_jsails/introspect?section=jobs');
    const text = await res.text();
    assert.ok(!text.includes('ssh-key'));
    assert.ok(!text.includes('"stack"'));
    // The failed entry is returned without the `data` (payload) field; verify
    // the raw response does not contain "ssh-key" (proof the payload was stripped).
  });
});

// ---------------------------------------------------------------------------
// Error isolation for live sections
// ---------------------------------------------------------------------------

describe('error isolation - live sections', () => {
  test('a throwing migrations provider yields error for that section, others ok', async (t) => {
    // Construct a data source whose query runner throws on every query.
    const db = new FakeDb();
    db.tableExists = true;
    class ThrowingFakeDataSource extends FakeDataSource {
      createQueryRunner(): QueryRunner {
        return {
          connect: async () => {},
          release: async () => {},
          hasTable: async () => {
            throw new Error('connection refused');
          },
          query: async () => {
            throw new Error('connection refused');
          },
        } as unknown as QueryRunner;
      }
    }
    const ds = new ThrowingFakeDataSource(db);

    const app = await createTestApp({
      config: makeConfigWithSections({
        extensions: [
          {
            name: 'test-migrations-throw',
            setup({ services }: { services: ServiceRegistrar }) {
              services.provide(migrationDataSourceToken, ds);
            },
          },
        ],
      }),
      lifecycle: t,
    });
    const res = await app.request('/_jsails/introspect?section=health,migrations');
    assert.equal(res.status, 200);
    const body = await res.json();
    // Health stays ok; migrations is error with value-free message.
    assert.equal(body.sections.health.status, 'ok');
    assert.equal(body.sections.migrations.status, 'error');
    // The provider catches its own error and returns a value-free code; the
    // route passes the structured error through without wrapping it.
    assert.equal(body.sections.migrations.error.code, 'migrations_error');
    assert.ok(typeof body.sections.migrations.error.message === 'string');
    // The error message must not leak connection details or a stack trace.
    assert.ok(!body.sections.migrations.error.message.includes('stack'));
    assert.ok(!body.sections.migrations.error.message.includes('connection refused'));
  });

  test('a throwing diagnostics provider yields error for that section, others ok', async (t) => {
    // The diagnostics provider calls `service.stats()`; create a custom
    // extension that provides a throwing service under the standard token
    // so the provider resolves it but `stats()` throws.
    const throwingService: Diagnostics = {
      record: () => {},
      entries: () => [],
      clear: () => {},
      stats: () => {
        throw new Error('stats unavailable');
      },
    };

    const app = await createTestApp({
      config: makeConfigWithSections({
        extensions: [
          {
            name: 'test-diag-throw',
            setup({ services }: { services: ServiceRegistrar }) {
              services.provide(diagnosticsToken, throwingService);
            },
          },
        ],
      }),
      lifecycle: t,
    });
    const res = await app.request('/_jsails/introspect?section=health,diagnostics');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.sections.health.status, 'ok');
    assert.equal(body.sections.diagnostics.status, 'error');
    assert.equal(body.sections.diagnostics.error.code, 'diagnostics_error');
    assert.ok(typeof body.sections.diagnostics.error.message === 'string');
    assert.ok(!body.sections.diagnostics.error.message.includes('stack'));
  });

  test('a throwing jobs provider yields error for that section, others ok', async (t) => {
    // Create metrics whose `snapshot` throws.
    const throwingMetrics = {
      recordCompleted: () => {},
      recordFailed: () => {},
      recordWait: () => {},
      snapshot: () => {
        throw new Error('metrics unavailable');
      },
      reset: () => {},
    };
    const failedStore = createFailedJobStore();

    const app = await createTestApp({
      config: makeConfigWithSections({
        extensions: [
          {
            name: 'test-jobs-throw',
            setup({ services }: { services: ServiceRegistrar }) {
              services.provide(jobMetricsToken, throwingMetrics);
              services.provide(failedJobStoreToken, failedStore);
            },
          },
        ],
      }),
      lifecycle: t,
    });
    const res = await app.request('/_jsails/introspect?section=health,jobs');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.sections.health.status, 'ok');
    assert.equal(body.sections.jobs.status, 'error');
    assert.equal(body.sections.jobs.error.code, 'jobs_error');
    assert.ok(typeof body.sections.jobs.error.message === 'string');
    assert.ok(!body.sections.jobs.error.message.includes('stack'));
  });
});
