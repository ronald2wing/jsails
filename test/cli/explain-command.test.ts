import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import {
  matchRoute,
  runExplain,
  runExplainCommand,
  type ExplainDeps,
  type ExplainResult,
} from '../../src/cli/explain-command.js';
import { discoverRoutes } from '../../src/routing/routes.js';
import { PIPELINE_STAGES } from '../../src/introspect/builtin-providers.js';
import type { ResolvedAppConfig } from '../../src/app/config/index.js';

/**
 * Tests for `jsails explain`. Exercises `matchRoute`, `runExplain` (the DI
 * seam), and `runExplainCommand` (the CLI arg parser) without importing real
 * config modules or opening connections.
 */

const fixturesRoot = mkdtempSync(
  join(fileURLToPath(new URL('..', import.meta.url)), 'explain-fixture-'),
);

after(() => {
  rmSync(fixturesRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveConfig(
  rootDir: string,
  overrides: Partial<ResolvedAppConfig> = {},
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
    extensions: [],
    renderer: undefined,
    plugins: undefined,
    deployments: [],
    commands: [],
    ...overrides,
  };
}

interface Sinks {
  out: string[];
  err: string[];
}

function explainDeps(sinks: Sinks, config: ResolvedAppConfig): ExplainDeps {
  return {
    loadConfig: async () => config,
    stdout: (text) => sinks.out.push(text),
    stderr: (text) => sinks.err.push(text),
  };
}

// ---------------------------------------------------------------------------
// matchRoute
// ---------------------------------------------------------------------------

describe('matchRoute', () => {
  function manifestForRoutes(...routeStrings: string[]) {
    const dir = join(fixturesRoot, 'match-manifest');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, 'pages'), { recursive: true });
    mkdirSync(join(dir, 'api'), { recursive: true });

    for (const route of routeStrings) {
      if (route === '/') {
        writeFileSync(join(dir, 'pages', 'index.js'), '');
      } else if (route.includes(':')) {
        // Dynamic route: e.g. /blog/:slug -> pages/blog/[slug].js
        const parts = route.split('/').filter(Boolean);
        const dirParts: string[] = [];
        let isApi = false;
        for (const part of parts) {
          if (part.startsWith(':')) {
            dirParts.push(`[${part.slice(1)}]`);
            if (dirParts[0]?.startsWith('api')) isApi = true;
          } else {
            dirParts.push(part);
          }
        }
        const base = isApi ? join(dir, 'api') : join(dir, 'pages');
        mkdirSync(join(base, ...dirParts.slice(0, -1)), { recursive: true });
        writeFileSync(join(base, ...dirParts) + '.js', '');
      } else if (route.startsWith('/api/')) {
        const parts = route.replace('/api/', '').split('/');
        mkdirSync(join(dir, 'api', ...parts.slice(0, -1)), { recursive: true });
        writeFileSync(join(dir, 'api', ...parts) + '.js', '');
      } else {
        const parts = route.split('/').filter(Boolean);
        mkdirSync(join(dir, 'pages', ...parts.slice(0, -1)), { recursive: true });
        writeFileSync(join(dir, 'pages', ...parts) + '.js', '');
      }
    }

    return discoverRoutes(dir, { pagesDir: join(dir, 'pages'), apiDir: join(dir, 'api') });
  }

  it('matches a static page route', () => {
    const manifest = manifestForRoutes('/about');
    const result = matchRoute(manifest, '/about');
    assert.ok(result);
    assert.equal(result.entry.route, '/about');
    assert.equal(result.entry.kind, 'page');
    assert.deepEqual(result.paramValues, {});
  });

  it('matches the root /', () => {
    const manifest = manifestForRoutes('/');
    const result = matchRoute(manifest, '/');
    assert.ok(result);
    assert.equal(result.entry.route, '/');
  });

  it('matches a dynamic [slug] route and captures paramValues', () => {
    const manifest = manifestForRoutes('/blog/:slug');
    const result = matchRoute(manifest, '/blog/hello-world');
    assert.ok(result);
    assert.equal(result.entry.route, '/blog/:slug');
    assert.equal(result.entry.dynamic, true);
    assert.deepEqual(result.paramValues, { slug: 'hello-world' });
  });

  it('matches an API route', () => {
    const manifest = manifestForRoutes('/api/users');
    const result = matchRoute(manifest, '/api/users');
    assert.ok(result);
    assert.equal(result.entry.route, '/api/users');
    assert.equal(result.entry.kind, 'api');
  });

  it('returns undefined when no route matches (wrong segment count)', () => {
    const manifest = manifestForRoutes('/blog/:slug');
    const result = matchRoute(manifest, '/blog/a/b');
    assert.equal(result, undefined);
  });

  it('returns undefined when no route matches (wrong static segment)', () => {
    const manifest = manifestForRoutes('/about');
    const result = matchRoute(manifest, '/contact');
    assert.equal(result, undefined);
  });

  it('normalises trailing slash', () => {
    const manifest = manifestForRoutes('/about');
    const result = matchRoute(manifest, '/about/');
    assert.ok(result);
    assert.equal(result.entry.route, '/about');
  });

  it('normalises missing leading slash', () => {
    const manifest = manifestForRoutes('/about');
    const result = matchRoute(manifest, 'about');
    assert.ok(result);
    assert.equal(result.entry.route, '/about');
  });

  it('strips query string', () => {
    const manifest = manifestForRoutes('/about');
    const result = matchRoute(manifest, '/about?foo=bar');
    assert.ok(result);
    assert.equal(result.entry.route, '/about');
  });

  it('strips hash fragment', () => {
    const manifest = manifestForRoutes('/about');
    const result = matchRoute(manifest, '/about#section');
    assert.ok(result);
    assert.equal(result.entry.route, '/about');
  });

  it('returns first match in manifest order', () => {
    // Two routes with same segment count; static before dynamic is the rule.
    // We construct files so /users comes first, /:id second.
    const manifest = manifestForRoutes('/users', '/:id');
    const result = matchRoute(manifest, '/users');
    assert.ok(result);
    assert.equal(result.entry.route, '/users');

    const dynamicResult = matchRoute(manifest, '/something');
    assert.ok(dynamicResult);
    assert.equal(dynamicResult.entry.route, '/:id');
  });

  it('decodes percent-encoded path segments in param values', () => {
    const manifest = manifestForRoutes('/blog/:slug');
    const result = matchRoute(manifest, '/blog/caf%C3%A9');
    assert.ok(result);
    assert.equal(result.paramValues?.slug, 'café');
  });

  it('does not throw on malformed percent encoding (uses raw segment)', () => {
    // %ZZ is malformed and decodeURIComponent throws; fall back to raw segment.
    const manifest = manifestForRoutes('/blog/:slug');
    const result = matchRoute(manifest, '/blog/%ZZ');
    assert.ok(result);
    assert.equal(result.paramValues?.slug, '%ZZ');
  });

  it('returns undefined for empty path segments in dynamic positions', () => {
    // No "//" should match a single-segment dynamic route.
    const manifest = manifestForRoutes('/blog/:slug');
    const result = matchRoute(manifest, '/blog/');
    assert.equal(result, undefined);
  });
});

// ---------------------------------------------------------------------------
// runExplain
// ---------------------------------------------------------------------------

describe('runExplain', () => {
  it('matched page route produces correct result', async () => {
    const dir = join(fixturesRoot, 'explain-matched');
    mkdirSync(join(dir, 'pages'), { recursive: true });
    writeFileSync(join(dir, 'pages', 'index.js'), '');
    writeFileSync(join(dir, 'pages', 'about.js'), '');
    mkdirSync(join(dir, 'pages', 'blog'), { recursive: true });
    writeFileSync(join(dir, 'pages', 'blog', '[slug].js'), '');

    const config = resolveConfig(dir);
    const sinks: Sinks = { out: [], err: [] };
    const deps = explainDeps(sinks, config);

    const code = await runExplain(
      { configPath: config.configPath, path: '/blog/hello', json: true },
      deps,
    );

    assert.equal(code, 0);
    assert.equal(sinks.out.length, 1);
    assert.deepEqual(sinks.err, []);

    const result = JSON.parse(sinks.out[0] as string) as ExplainResult;
    assert.equal(result.path, '/blog/hello');
    assert.equal(result.matched, true);
    assert.ok(result.route);
    assert.equal(result.route.kind, 'page');
    assert.equal(result.route.route, '/blog/:slug');
    assert.equal(result.route.dynamic, true);
    assert.deepEqual(result.route.params, ['slug']);
    assert.deepEqual(result.paramValues, { slug: 'hello' });
    assert.deepEqual(result.stages, PIPELINE_STAGES);
    assert.equal(result.reserved, false);
  });

  it('unmatched path produces matched: false with stages still present', async () => {
    const dir = join(fixturesRoot, 'explain-unmatched');
    mkdirSync(join(dir, 'pages'), { recursive: true });
    writeFileSync(join(dir, 'pages', 'index.js'), '');

    const config = resolveConfig(dir);
    const sinks: Sinks = { out: [], err: [] };
    const deps = explainDeps(sinks, config);

    const code = await runExplain(
      { configPath: config.configPath, path: '/nonexistent', json: true },
      deps,
    );

    assert.equal(code, 0);
    const result = JSON.parse(sinks.out[0] as string) as ExplainResult;
    assert.equal(result.path, '/nonexistent');
    assert.equal(result.matched, false);
    assert.equal(result.route, undefined);
    assert.equal(result.paramValues, undefined);
    assert.deepEqual(result.stages, PIPELINE_STAGES);
    assert.equal(result.reserved, false);
  });

  it('/_jsails path is reserved and not matched', async () => {
    const dir = join(fixturesRoot, 'explain-reserved');
    mkdirSync(join(dir, 'pages'), { recursive: true });
    writeFileSync(join(dir, 'pages', 'index.js'), '');

    const config = resolveConfig(dir);
    const sinks: Sinks = { out: [], err: [] };
    const deps = explainDeps(sinks, config);

    const code = await runExplain(
      { configPath: config.configPath, path: '/_jsails/introspect', json: true },
      deps,
    );

    assert.equal(code, 0);
    const result = JSON.parse(sinks.out[0] as string) as ExplainResult;
    assert.equal(result.path, '/_jsails/introspect');
    assert.equal(result.matched, false);
    assert.equal(result.reserved, true);
    assert.equal(result.route, undefined);
    assert.deepEqual(result.stages, PIPELINE_STAGES);
  });

  it('human-readable output is non-empty and mentions key sections', async () => {
    const dir = join(fixturesRoot, 'explain-human');
    mkdirSync(join(dir, 'pages'), { recursive: true });
    writeFileSync(join(dir, 'pages', 'index.js'), '');

    const config = resolveConfig(dir);
    const sinks: Sinks = { out: [], err: [] };
    const deps = explainDeps(sinks, config);

    const code = await runExplain({ configPath: config.configPath, path: '/' }, deps);

    assert.equal(code, 0);
    const out = sinks.out.join('\n');
    assert.match(out, /Path:/);
    assert.match(out, /Matched:/);
    assert.match(out, /Reserved:/);
    assert.match(out, /Route/);
    assert.match(out, /Pipeline stages/);
    assert.match(out, /body-limit/);
  });

  it('config load failure returns 1 with value-free message', async () => {
    const sinks: Sinks = { out: [], err: [] };
    const deps: ExplainDeps = {
      loadConfig: async () => {
        throw new Error('ENOENT: no such file, open "secret.yml"');
      },
      stdout: (text) => sinks.out.push(text),
      stderr: (text) => sinks.err.push(text),
    };

    const code = await runExplain({ configPath: '/nonexistent.js', path: '/' }, deps);

    assert.equal(code, 1);
    assert.match(sinks.err.join('\n'), /failed to load config/);
    assert.ok(!sinks.err.join('\n').includes('secret.yml'));
  });
});

// ---------------------------------------------------------------------------
// runExplainCommand (arg parsing)
// ---------------------------------------------------------------------------

describe('runExplainCommand', () => {
  it('prints help for --help without importing a config', async () => {
    const sinks: Sinks = { out: [], err: [] };
    const deps: ExplainDeps = {
      loadConfig: async () => {
        throw new Error('should not be called');
      },
      stdout: (text) => sinks.out.push(text),
      stderr: (text) => sinks.err.push(text),
    };

    const code = await runExplainCommand(['--help'], deps);

    assert.equal(code, 0);
    assert.match(sinks.out.join('\n'), /explain - resolve/);
    assert.match(sinks.out.join('\n'), /Usage:/);
    assert.match(sinks.out.join('\n'), /--json/);
    assert.match(sinks.out.join('\n'), /--config/);
  });

  it('prints help for -h', async () => {
    const sinks: Sinks = { out: [], err: [] };
    const deps: ExplainDeps = {
      loadConfig: async () => {
        throw new Error('should not be called');
      },
      stdout: (text) => sinks.out.push(text),
      stderr: (text) => sinks.err.push(text),
    };

    const code = await runExplainCommand(['-h'], deps);

    assert.equal(code, 0);
    assert.match(sinks.out.join('\n'), /explain - resolve/);
  });

  it('missing path returns usage error', async () => {
    const sinks: Sinks = { out: [], err: [] };
    const deps: ExplainDeps = {
      loadConfig: async () => {
        throw new Error('should not be called');
      },
      stdout: (text) => sinks.out.push(text),
      stderr: (text) => sinks.err.push(text),
    };

    const code = await runExplainCommand(['--json'], deps);

    assert.equal(code, 2);
    assert.match(sinks.err.join('\n'), /a path argument is required/);
  });

  it('unknown option returns usage error', async () => {
    const sinks: Sinks = { out: [], err: [] };
    const deps: ExplainDeps = {
      loadConfig: async () => {
        throw new Error('should not be called');
      },
      stdout: (text) => sinks.out.push(text),
      stderr: (text) => sinks.err.push(text),
    };

    const code = await runExplainCommand(['/about', '--unknown'], deps);

    assert.equal(code, 2);
    assert.match(sinks.err.join('\n'), /unknown option/);
  });

  it('more than one positional returns usage error', async () => {
    const sinks: Sinks = { out: [], err: [] };
    const deps: ExplainDeps = {
      loadConfig: async () => {
        throw new Error('should not be called');
      },
      stdout: (text) => sinks.out.push(text),
      stderr: (text) => sinks.err.push(text),
    };

    const code = await runExplainCommand(['/a', '/b'], deps);

    assert.equal(code, 2);
    assert.match(sinks.err.join('\n'), /explain takes exactly one path argument/);
  });

  it('--json emits one JSON line', async () => {
    const dir = join(fixturesRoot, 'explain-cmd-json');
    mkdirSync(join(dir, 'pages'), { recursive: true });
    writeFileSync(join(dir, 'pages', 'index.js'), '');

    const config = resolveConfig(dir);
    const sinks: Sinks = { out: [], err: [] };
    const deps: ExplainDeps = {
      loadConfig: async () => config,
      stdout: (text) => sinks.out.push(text),
      stderr: (text) => sinks.err.push(text),
    };

    const code = await runExplainCommand(['/', '--json'], deps);

    assert.equal(code, 0);
    assert.equal(sinks.out.length, 1);
    const result = JSON.parse(sinks.out[0] as string) as ExplainResult;
    assert.equal(result.path, '/');
    assert.equal(result.matched, true);
    assert.deepEqual(result.stages, PIPELINE_STAGES);
  });

  it('passes --config and path through', async () => {
    const dir = join(fixturesRoot, 'explain-arg-config');
    mkdirSync(join(dir, 'pages'), { recursive: true });
    writeFileSync(join(dir, 'pages', 'index.js'), '');

    const config = resolveConfig(dir);
    const sinks: Sinks = { out: [], err: [] };
    let loadedConfigPath: string | undefined;

    const deps: ExplainDeps = {
      loadConfig: async (path) => {
        loadedConfigPath = path;
        return config;
      },
      stdout: (text) => sinks.out.push(text),
      stderr: (text) => sinks.err.push(text),
    };

    const code = await runExplainCommand(['--config', 'my-app.js', '/', '--json'], deps);

    assert.equal(code, 0);
    assert.equal(loadedConfigPath, 'my-app.js');
    const result = JSON.parse(sinks.out[0] as string) as ExplainResult;
    assert.equal(result.path, '/');
  });

  it('supports --config= syntax', async () => {
    const dir = join(fixturesRoot, 'explain-eq-config');
    mkdirSync(join(dir, 'pages'), { recursive: true });
    writeFileSync(join(dir, 'pages', 'index.js'), '');

    const config = resolveConfig(dir);
    const sinks: Sinks = { out: [], err: [] };
    let loadedConfigPath: string | undefined;

    const deps: ExplainDeps = {
      loadConfig: async (path) => {
        loadedConfigPath = path;
        return config;
      },
      stdout: (text) => sinks.out.push(text),
      stderr: (text) => sinks.err.push(text),
    };

    const code = await runExplainCommand(['--config=my-app.js', '/', '--json'], deps);

    assert.equal(code, 0);
    assert.equal(loadedConfigPath, 'my-app.js');
    assert.equal(sinks.err.length, 0);
  });

  it('--config without value returns usage error', async () => {
    const sinks: Sinks = { out: [], err: [] };
    const deps: ExplainDeps = {
      loadConfig: async () => {
        throw new Error('should not be called');
      },
      stdout: (text) => sinks.out.push(text),
      stderr: (text) => sinks.err.push(text),
    };

    const code = await runExplainCommand(['--config'], deps);

    assert.equal(code, 2);
    assert.match(sinks.err.join('\n'), /--config requires a value/);
  });
});
