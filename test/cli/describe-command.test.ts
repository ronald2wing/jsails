import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import {
  runDescribe,
  runDescribeCommand,
  type DescribeDeps,
  type DescribeResult,
} from '../../src/cli/describe-command.js';
import type { ResolvedAppConfig } from '../../src/app/config/index.js';
import type { SchemaState } from '../../src/migrations/schema-state.js';

/**
 * Tests for `jsails describe`. Exercises both `runDescribe` (the DI seam) and
 * `runDescribeCommand` (the CLI arg parser) without importing real config
 * modules or opening connections.
 */

const fixturesRoot = mkdtempSync(
  join(fileURLToPath(new URL('..', import.meta.url)), 'describe-fixture-'),
);

after(() => {
  rmSync(fixturesRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveConfig(
  rootDir: string,
  pluginsEnabled?: string[],
  extensions: readonly any[] = [],
): ResolvedAppConfig {
  return {
    rootDir,
    pagesDir: join(rootDir, 'pages'),
    apiDir: join(rootDir, 'api'),
    publicDir: join(rootDir, 'public'),
    outDir: join(rootDir, 'out'),
    storageDir: join(rootDir, 'storage'),
    host: '127.0.0.1',
    port: 3000,
    publicOrigin: undefined,
    healthPath: '/up',
    shutdownTimeoutMs: 5000,
    configPath: join(rootDir, 'jsails.app.js'),
    authorize: undefined,
    resolveSession: undefined,
    maxBodyBytes: 1048576,
    broadcast: undefined,
    setup: undefined,
    extensions,
    renderer: undefined,
    plugins: pluginsEnabled ? { enabled: pluginsEnabled } : undefined,
    deployments: [],
    commands: [],
  };
}

interface DescribeSinks {
  out: string[];
  err: string[];
}

function describeDeps(
  sinks: DescribeSinks,
  config: ResolvedAppConfig,
  overrides: Partial<DescribeDeps> = {},
): DescribeDeps {
  return {
    loadConfig: async () => config,
    stdout: (text) => sinks.out.push(text),
    stderr: (text) => sinks.err.push(text),
    ...overrides,
  };
}

function assertIsDescribeResult(value: unknown): DescribeResult {
  assert.ok(typeof value === 'object' && value !== null, 'result is an object');
  const result = value as Record<string, unknown>;

  // Top-level keys
  assert.ok(typeof result.app === 'object' && result.app !== null, 'app is present');
  assert.ok(Array.isArray(result.routes), 'routes is an array');
  assert.ok(typeof result.plugins === 'object' && result.plugins !== null, 'plugins is present');
  assert.ok(Array.isArray(result.components), 'components is an array');
  assert.ok(typeof result.schema === 'object' && result.schema !== null, 'schema is present');

  // App shape
  const app = result.app as Record<string, unknown>;
  assert.equal(typeof app.rootDir, 'string');
  assert.equal(typeof app.host, 'string');
  assert.equal(typeof app.port, 'number');
  assert.equal(typeof app.pages, 'string');
  assert.equal(typeof app.api, 'string');
  assert.equal(typeof app.public, 'string');
  assert.equal(typeof app.out, 'string');

  // Plugins shape
  const plugins = result.plugins as Record<string, unknown>;
  assert.ok(Array.isArray(plugins.enabled));
  assert.ok(Array.isArray(plugins.conflicts));
  assert.ok(Array.isArray(plugins.disabledManaged));
  assert.ok(typeof plugins.sources === 'object');

  // Schema shape
  const schema = result.schema as Record<string, unknown>;
  assert.ok(Array.isArray(schema.tables));

  return value as DescribeResult;
}

// ---------------------------------------------------------------------------
// runDescribe
// ---------------------------------------------------------------------------

describe('runDescribe', () => {
  it('produces valid JSON with all top-level keys', async () => {
    const dir = join(fixturesRoot, 'describe-json');
    mkdirSync(join(dir, 'pages'), { recursive: true });
    mkdirSync(join(dir, 'api'), { recursive: true });
    writeFileSync(join(dir, 'pages', 'index.js'), '');
    writeFileSync(join(dir, 'api', 'users.js'), '');

    const config = resolveConfig(dir, ['auth', 'cache']);
    const sinks: DescribeSinks = { out: [], err: [] };
    const deps = describeDeps(sinks, config);

    const code = await runDescribe(
      { configPath: config.configPath, options: { json: true } },
      deps,
    );

    assert.equal(code, 0);
    assert.equal(sinks.out.length, 1);
    assert.deepEqual(sinks.err, []);

    const parsed = JSON.parse(sinks.out[0] as string);
    const result = assertIsDescribeResult(parsed);

    // Routes
    assert.equal(result.routes.length, 2);
    const routes = result.routes.map((r) => r.route).sort();
    assert.deepEqual(routes, ['/', '/api/users']);

    // Plugins
    assert.deepEqual([...result.plugins.enabled], ['auth', 'cache']);

    // Components: empty when no server-components extension
    assert.deepEqual(result.components, []);

    // Schema: empty when no db config
    assert.deepEqual(result.schema.tables, []);
  });

  it('routes omit absolute file paths', async () => {
    const dir = join(fixturesRoot, 'describe-no-path');
    mkdirSync(join(dir, 'pages'), { recursive: true });
    writeFileSync(join(dir, 'pages', 'index.js'), '');

    const config = resolveConfig(dir);
    const sinks: DescribeSinks = { out: [], err: [] };
    const deps = describeDeps(sinks, config);

    const code = await runDescribe(
      { configPath: config.configPath, options: { json: true } },
      deps,
    );

    assert.equal(code, 0);
    const parsed = JSON.parse(sinks.out[0] as string) as DescribeResult;
    for (const route of parsed.routes) {
      const entry = route as unknown as Record<string, unknown>;
      assert.ok(entry.file === undefined, 'route must not have a file key');
    }
  });

  it('routes include layoutCount (0 for fixture with no layouts)', async () => {
    const dir = join(fixturesRoot, 'describe-layout-count');
    mkdirSync(join(dir, 'pages'), { recursive: true });
    writeFileSync(join(dir, 'pages', 'index.js'), '');

    const config = resolveConfig(dir);
    const sinks: DescribeSinks = { out: [], err: [] };
    const deps = describeDeps(sinks, config);

    const code = await runDescribe(
      { configPath: config.configPath, options: { json: true } },
      deps,
    );

    assert.equal(code, 0);
    const parsed = JSON.parse(sinks.out[0] as string) as DescribeResult;
    for (const route of parsed.routes) {
      assert.equal(
        typeof route.layoutCount,
        'number',
        `route ${route.route} must have layoutCount`,
      );
      assert.ok(route.layoutCount >= 0, `route ${route.route} layoutCount must be >= 0`);
    }
  });

  it('describe output never contains layouts (absolute paths) in route entries', async () => {
    const dir = join(fixturesRoot, 'describe-no-layout-paths');
    mkdirSync(join(dir, 'pages'), { recursive: true });
    writeFileSync(join(dir, 'pages', 'index.js'), '');

    const config = resolveConfig(dir);
    const sinks: DescribeSinks = { out: [], err: [] };
    const deps = describeDeps(sinks, config);

    const code = await runDescribe(
      { configPath: config.configPath, options: { json: true } },
      deps,
    );

    assert.equal(code, 0);
    const parsed = JSON.parse(sinks.out[0] as string) as DescribeResult;
    // Each route entry must NOT carry `layouts` (it leaks absolute paths).
    // Only `layoutCount` — a non-negative integer — is exposed.
    for (const route of parsed.routes) {
      const entry = route as unknown as Record<string, unknown>;
      assert.ok(entry.layouts === undefined, `route ${route.route} must not have layouts`);
    }
  });

  it('no secrets or env values are leaked', async () => {
    const dir = join(fixturesRoot, 'describe-no-leak');
    mkdirSync(join(dir, 'pages'), { recursive: true });
    writeFileSync(join(dir, 'pages', 'index.js'), '');

    const config = resolveConfig(dir);
    const sinks: DescribeSinks = { out: [], err: [] };
    const deps = describeDeps(sinks, config);

    const code = await runDescribe(
      { configPath: config.configPath, options: { json: true } },
      deps,
    );

    assert.equal(code, 0);
    const raw = sinks.out[0] as string;
    // configPath (the framework-internal config path) must not leak
    assert.ok(!raw.includes('configPath'), 'configPath must not be in output');
    // No session, CSRF, or env tokens
    assert.ok(!raw.includes('csrf'), 'CSRF must not be in output');
    assert.ok(!raw.includes('session'), 'session must not be in output');
    assert.ok(!raw.includes('secret'), 'secrets must not be in output');
    assert.ok(!raw.includes('JSAILS_'), 'env vars must not be in output');
  });

  it('missing config returns 1 with a value-free message', async () => {
    const sinks: DescribeSinks = { out: [], err: [] };
    const deps: DescribeDeps = {
      loadConfig: async () => {
        throw new Error('ENOENT: no such file, open "secret.yml"');
      },
      stdout: (text) => sinks.out.push(text),
      stderr: (text) => sinks.err.push(text),
    };

    const code = await runDescribe({ configPath: '/nonexistent.js', options: {} }, deps);

    assert.equal(code, 1);
    assert.match(sinks.err.join('\n'), /failed to load config/);
    // The original error message must not be echoed
    assert.ok(!sinks.err.join('\n').includes('secret.yml'));
  });

  it('human-readable output is non-empty and mentions the app', async () => {
    const dir = join(fixturesRoot, 'describe-human');
    mkdirSync(join(dir, 'pages'), { recursive: true });
    writeFileSync(join(dir, 'pages', 'index.js'), '');

    const config = resolveConfig(dir, ['auth']);
    const sinks: DescribeSinks = { out: [], err: [] };
    const deps = describeDeps(sinks, config);

    const code = await runDescribe({ configPath: config.configPath, options: {} }, deps);

    assert.equal(code, 0);
    const out = sinks.out.join('\n');
    assert.ok(out.length > 0, 'human-readable output must not be empty');
    assert.match(out, /Application/);
    assert.match(out, /Routes/);
    assert.match(out, /Plugins/);
    assert.match(out, /Components/);
    assert.match(out, /Schema/);
  });

  it('human-readable output shows empty state cleanly', async () => {
    const dir = join(fixturesRoot, 'describe-empty');
    mkdirSync(dir, { recursive: true });

    const config = resolveConfig(dir);
    const sinks: DescribeSinks = { out: [], err: [] };
    const deps = describeDeps(sinks, config);

    const code = await runDescribe({ configPath: config.configPath, options: {} }, deps);

    assert.equal(code, 0);
    const out = sinks.out.join('\n');
    assert.match(out, /\(none\)/);
    assert.match(out, /no entity tables declared/);
  });

  it('includes plugin conflicts', async () => {
    const dir = join(fixturesRoot, 'describe-conflicts');
    mkdirSync(join(dir, 'pages'), { recursive: true });
    writeFileSync(join(dir, 'pages', 'index.js'), '');

    // Config declares a plugin, but no state — so no conflicts here.
    // The pure enablement resolve is covered by plugin tests; here we just
    // verify the describe shape includes the conflicts/differ shapes.
    const config = resolveConfig(dir, []);
    const sinks: DescribeSinks = { out: [], err: [] };
    const deps = describeDeps(sinks, config);

    const code = await runDescribe(
      { configPath: config.configPath, options: { json: true } },
      deps,
    );

    assert.equal(code, 0);
    const parsed = JSON.parse(sinks.out[0] as string) as DescribeResult;
    assert.ok(Array.isArray(parsed.plugins.conflicts));
    assert.ok(Array.isArray(parsed.plugins.disabledManaged));
    assert.ok(Array.isArray(parsed.plugins.sources.code));
  });

  it('loads schema from db config when provided', async () => {
    const dir = join(fixturesRoot, 'describe-schema');
    mkdirSync(dir, { recursive: true });

    const config = resolveConfig(dir);
    const schema: SchemaState = {
      tables: [
        {
          name: 'users',
          columns: [
            { name: 'id', type: 'integer', nullable: false, primaryKey: true },
            { name: 'email', type: 'varchar', nullable: false, length: 255 },
          ],
        },
      ],
    };
    const sinks: DescribeSinks = { out: [], err: [] };
    const deps = describeDeps(sinks, config, {
      loadSchema: async () => schema,
    });

    const code = await runDescribe(
      { configPath: config.configPath, dbConfigPath: 'jsails.config.js', options: { json: true } },
      deps,
    );

    assert.equal(code, 0);
    const parsed = JSON.parse(sinks.out[0] as string) as DescribeResult;
    assert.equal(parsed.schema.tables.length, 1);
    const table = parsed.schema.tables[0]!;
    assert.equal(table.name, 'users');
    assert.equal(table.columns.length, 2);
    assert.equal(table.columns[0]!.name, 'id');
    assert.equal(table.columns[0]!.primaryKey, true);
  });

  it('schema is empty when loadSchema returns undefined', async () => {
    const dir = join(fixturesRoot, 'describe-schema-undefined');
    mkdirSync(dir, { recursive: true });

    const config = resolveConfig(dir);
    const sinks: DescribeSinks = { out: [], err: [] };
    const deps = describeDeps(sinks, config, {
      loadSchema: async () => undefined,
    });

    const code = await runDescribe(
      { configPath: config.configPath, dbConfigPath: 'jsails.config.js', options: { json: true } },
      deps,
    );

    assert.equal(code, 0);
    const parsed = JSON.parse(sinks.out[0] as string) as DescribeResult;
    assert.deepEqual(parsed.schema.tables, []);
  });

  it('schema degrades gracefully when loadSchema throws', async () => {
    const dir = join(fixturesRoot, 'describe-schema-throw');
    mkdirSync(dir, { recursive: true });

    const config = resolveConfig(dir);
    const sinks: DescribeSinks = { out: [], err: [] };
    const deps = describeDeps(sinks, config, {
      loadSchema: async () => {
        throw new Error('cannot load db config');
      },
    });

    const code = await runDescribe(
      { configPath: config.configPath, dbConfigPath: 'jsails.config.js', options: { json: true } },
      deps,
    );

    assert.equal(code, 0);
    const parsed = JSON.parse(sinks.out[0] as string) as DescribeResult;
    assert.deepEqual(parsed.schema.tables, []);
  });

  it('collects components from plugins with a describe() descriptor', async () => {
    const dir = join(fixturesRoot, 'describe-components-from-describe');
    mkdirSync(join(dir, 'pages'), { recursive: true });
    writeFileSync(join(dir, 'pages', 'index.js'), '');

    const config = resolveConfig(
      dir,
      ['server-components'],
      [
        {
          name: 'server-components',
          setup() {},
          describe: () => ({
            components: [
              { name: 'task-list', actions: ['add', 'remove'], writableKeys: ['title'] },
              { name: 'sidebar', actions: [], writableKeys: [] },
            ],
          }),
        } as any,
      ],
    );

    const sinks: DescribeSinks = { out: [], err: [] };
    const deps = describeDeps(sinks, config);

    const code = await runDescribe(
      { configPath: config.configPath, options: { json: true } },
      deps,
    );

    assert.equal(code, 0);
    const parsed = JSON.parse(sinks.out[0] as string) as DescribeResult;
    assert.equal(parsed.components.length, 2);
    assert.deepEqual(parsed.components[0], {
      name: 'task-list',
      actions: ['add', 'remove'],
      writableKeys: ['title'],
    });
    assert.deepEqual(parsed.components[1], {
      name: 'sidebar',
      actions: [],
      writableKeys: [],
    });
  });

  it('components array is empty when plugins have no describe()', async () => {
    const dir = join(fixturesRoot, 'describe-no-describe');
    mkdirSync(join(dir, 'pages'), { recursive: true });
    writeFileSync(join(dir, 'pages', 'index.js'), '');

    const config = resolveConfig(
      dir,
      ['auth'],
      [
        {
          name: 'auth',
          setup() {},
          // No describe() at all
        } as any,
      ],
    );

    const sinks: DescribeSinks = { out: [], err: [] };
    const deps = describeDeps(sinks, config);

    const code = await runDescribe(
      { configPath: config.configPath, options: { json: true } },
      deps,
    );

    assert.equal(code, 0);
    const parsed = JSON.parse(sinks.out[0] as string) as DescribeResult;
    assert.deepEqual(parsed.components, []);
  });

  it('publicOrigin is only included when set', async () => {
    const dir = join(fixturesRoot, 'describe-origin');
    mkdirSync(dir, { recursive: true });

    // Without publicOrigin
    const config1 = resolveConfig(dir);
    const sinks1: DescribeSinks = { out: [], err: [] };
    let code = await runDescribe(
      { configPath: config1.configPath, options: { json: true } },
      describeDeps(sinks1, config1),
    );
    assert.equal(code, 0);
    let parsed = JSON.parse(sinks1.out[0] as string) as DescribeResult;
    assert.ok(!('publicOrigin' in (parsed.app as unknown as Record<string, unknown>)));

    // With publicOrigin
    const config2: ResolvedAppConfig = {
      ...resolveConfig(dir),
      publicOrigin: 'https://example.com',
    };
    const sinks2: DescribeSinks = { out: [], err: [] };
    code = await runDescribe(
      { configPath: config2.configPath, options: { json: true } },
      describeDeps(sinks2, config2),
    );
    assert.equal(code, 0);
    parsed = JSON.parse(sinks2.out[0] as string) as DescribeResult;
    assert.equal(
      (parsed.app as unknown as Record<string, unknown>).publicOrigin,
      'https://example.com',
    );
  });
});

// ---------------------------------------------------------------------------
// runDescribeCommand (arg parsing)
// ---------------------------------------------------------------------------

describe('runDescribeCommand', () => {
  it('prints help for --help without importing a config', async () => {
    const sinks: DescribeSinks = { out: [], err: [] };
    const deps: DescribeDeps = {
      loadConfig: async () => {
        throw new Error('should not be called');
      },
      stdout: (text) => sinks.out.push(text),
      stderr: (text) => sinks.err.push(text),
    };

    const code = await runDescribeCommand(['--help'], deps);

    assert.equal(code, 0);
    assert.match(sinks.out.join('\n'), /describe - compose/);
    assert.match(sinks.out.join('\n'), /Usage:/);
    assert.match(sinks.out.join('\n'), /--json/);
    assert.match(sinks.out.join('\n'), /--config/);
    assert.match(sinks.out.join('\n'), /--db-config/);
  });

  it('rejects unknown flags without importing a config', async () => {
    const sinks: DescribeSinks = { out: [], err: [] };
    const deps: DescribeDeps = {
      loadConfig: async () => {
        throw new Error('should not be called');
      },
      stdout: (text) => sinks.out.push(text),
      stderr: (text) => sinks.err.push(text),
    };

    const code = await runDescribeCommand(['--unknown'], deps);

    assert.equal(code, 2);
    assert.match(sinks.err.join('\n'), /unknown option/);
  });

  it('rejects positional arguments', async () => {
    const sinks: DescribeSinks = { out: [], err: [] };
    const deps: DescribeDeps = {
      loadConfig: async () => {
        throw new Error('should not be called');
      },
      stdout: (text) => sinks.out.push(text),
      stderr: (text) => sinks.err.push(text),
    };

    const code = await runDescribeCommand(['extra'], deps);

    assert.equal(code, 2);
    assert.match(sinks.err.join('\n'), /unexpected argument/);
  });

  it('passes --config and --db-config through', async () => {
    const dir = join(fixturesRoot, 'describe-arg-config');
    mkdirSync(join(dir, 'pages'), { recursive: true });
    writeFileSync(join(dir, 'pages', 'index.js'), '');

    const config = resolveConfig(dir);
    const sinks: DescribeSinks = { out: [], err: [] };
    let loadedConfigPath: string | undefined;
    let loadedDbConfigPath: string | undefined;

    const deps: DescribeDeps = {
      loadConfig: async (path) => {
        loadedConfigPath = path;
        return config;
      },
      loadSchema: async (path) => {
        loadedDbConfigPath = path;
        return undefined;
      },
      stdout: (text) => sinks.out.push(text),
      stderr: (text) => sinks.err.push(text),
    };

    const code = await runDescribeCommand(
      ['--config', 'my-app.js', '--db-config', 'my-db.js', '--json'],
      deps,
    );

    assert.equal(code, 0);
    assert.equal(loadedConfigPath, 'my-app.js');
    assert.equal(loadedDbConfigPath, 'my-db.js');
  });

  it('supports --config= and --db-config= syntax', async () => {
    const dir = join(fixturesRoot, 'describe-eq-config');
    mkdirSync(join(dir, 'pages'), { recursive: true });
    writeFileSync(join(dir, 'pages', 'index.js'), '');

    const config = resolveConfig(dir);
    const sinks: DescribeSinks = { out: [], err: [] };
    let loadedConfigPath: string | undefined;
    let loadedDbConfigPath: string | undefined;

    const deps: DescribeDeps = {
      loadConfig: async (path) => {
        loadedConfigPath = path;
        return config;
      },
      loadSchema: async (path) => {
        loadedDbConfigPath = path;
        return undefined;
      },
      stdout: (text) => sinks.out.push(text),
      stderr: (text) => sinks.err.push(text),
    };

    const code = await runDescribeCommand(
      ['--config=my-app.js', '--db-config=my-db.js', '--json'],
      deps,
    );

    assert.equal(code, 0);
    assert.equal(loadedConfigPath, 'my-app.js');
    assert.equal(loadedDbConfigPath, 'my-db.js');
    assert.equal(sinks.err.length, 0);
  });
});
