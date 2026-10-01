import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { StarterError, createStarterFiles } from '../../src/app/starter/index.js';

/** Package root, resolved from the compiled test module (not the cwd). */
const PACKAGE_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/** The framework's own version, for the default-dependency assertion. */
const FRAMEWORK_VERSION = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'))
  .version as string;

/**
 * Every key `createStarterFiles` must produce for the default (`base`) variant,
 * order-independent. The base starter is auth-only: base pages + components +
 * tests, plus the always-shipped auth and CLI-command files (47 files,
 * `AGENTS.md` included). The `admin` variant swaps the app config (still 47
 * files); the `blog` variant adds two blog pages (49 files).
 */
const EXPECTED_KEYS = [
  '.env.auth.example',
  '.gitignore',
  'AGENTS.md',
  'api/me.ts',
  'app/application-auth.ts',
  'app/application-client.ts',
  'app/application-command.ts',
  'app/application-component.ts',
  'app/application-job.ts',
  'app/application-plugin.ts',
  'app/application-record.ts',
  'app/application-resource.ts',
  'app/application-testing.ts',
  'app/registry.ts',
  'auth/README.md',
  'client/main.tsx',
  'commands/login.ts',
  'commands/logout.ts',
  'commands/whoami.ts',
  'components/task-list.tsx',
  'jamal.config.js',
  'jsails.app.js',
  'jsails.config.js',
  'package.json',
  'pages/about.tsx',
  'pages/dashboard.tsx',
  'pages/device.tsx',
  'pages/index.tsx',
  'pages/login.tsx',
  'pages/tasks.tsx',
  'playwright.config.ts',
  'scripts/auth-migrate.mjs',
  'scripts/create-user.mjs',
  'scripts/db-migrate.mjs',
  'scripts/run-tests.mjs',
  'test/app.test.ts',
  'test/auth.test.ts',
  'test/browser/auth.spec.ts',
  'test/browser/fixtures.ts',
  'test/browser/home.spec.ts',
  'tsconfig.client.json',
  'tsconfig.json',
  'ui/components.tsx',
  'ui/counter.tsx',
  'ui/layout.tsx',
  'ui/styles.css',
  'vite.config.js',
];

/**
 * Every key `createStarterFiles({ cli: true })` must produce, order-independent.
 * The CLI-only shape is a separate Laravel-Zero-style project with no web
 * surface: project metadata, the TypeScript project, the `defineCommand` shim,
 * one sample command, a real app config (`jsails.app.js`) declaring an extension
 * seam and a config-registered `about` command, and the generated `AGENTS.md` (7 files).
 */
const EXPECTED_CLI_KEYS = [
  '.gitignore',
  'AGENTS.md',
  'app/application-command.ts',
  'commands/hello.ts',
  'jsails.app.js',
  'package.json',
  'tsconfig.json',
];

/**
 * Every key `createStarterFiles({ static: true })` must produce, order-independent.
 * The static-site (SSG) shape is a separate project with pages, a Preact island,
 * and Vite, but no auth, API, server components, or Jamal: project metadata, the
 * server and client TypeScript projects, the client shim, the browser entry, the
 * shared UI, two pages, a real app config (`jsails.app.js` with `plugins.use: []`),
 * and the generated `AGENTS.md` (14 files).
 */
const EXPECTED_STATIC_KEYS = [
  '.gitignore',
  'AGENTS.md',
  'app/application-client.ts',
  'client/main.tsx',
  'jsails.app.js',
  'package.json',
  'pages/about.tsx',
  'pages/index.tsx',
  'tsconfig.client.json',
  'tsconfig.json',
  'ui/components.tsx',
  'ui/counter.tsx',
  'ui/layout.tsx',
  'ui/styles.css',
  'vite.config.js',
];

/** Read a generated file, failing the test if the key is absent. */
function file(files: Readonly<Record<string, string>>, key: string): string {
  const value = files[key];
  assert.ok(typeof value === 'string', `expected generated file "${key}"`);
  return value;
}

describe('createStarterFiles', () => {
  it('returns exactly the expected 47-file set', async () => {
    const { files } = await createStarterFiles();
    assert.deepStrictEqual(Object.keys(files).sort(), [...EXPECTED_KEYS].sort());
    assert.equal(Object.keys(files).length, 47);
  });

  it('emits a valid, rewritten package.json with the default name and version', async () => {
    const { files } = await createStarterFiles();
    const pkgText = file(files, 'package.json');
    assert.doesNotMatch(pkgText, /__JSAILS_DEPENDENCY__/);

    const pkg = JSON.parse(pkgText) as {
      name: string;
      dependencies: Record<string, string>;
    };
    assert.equal(pkg.name, 'jsails-app');
    assert.equal(pkg.dependencies['jsails'], FRAMEWORK_VERSION);
  });

  it('ships zod as a runtime dependency (task component imports it) and no direct Turbo', async () => {
    const { files } = await createStarterFiles();
    const pkg = JSON.parse(file(files, 'package.json')) as {
      dependencies: Record<string, string>;
    };
    // `components/task-list.tsx` imports zod for its state/action schemas.
    assert.equal(pkg.dependencies['zod'], '^4.6.5');
    // Turbo is a framework client dependency, never a direct starter dependency.
    assert.equal(pkg.dependencies['@hotwired/turbo'], undefined);
  });

  it('never ships a direct SQLite or Better Auth dependency (auth lives in the framework)', async () => {
    const { files } = await createStarterFiles();
    const pkg = JSON.parse(file(files, 'package.json')) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
      scripts: Record<string, string>;
    };
    // Better Auth + Kysely + mysql2 ship inside the framework's `auth` plugin,
    // never as direct starter dependencies.
    assert.equal(pkg.dependencies['better-auth'], undefined);
    assert.equal(pkg.dependencies['kysely'], undefined);
    assert.equal(pkg.dependencies['mysql2'], undefined);
    assert.equal(pkg.dependencies['better-sqlite3'], undefined);
    assert.equal(pkg.devDependencies['@types/better-sqlite3'], undefined);
    assert.equal(pkg.scripts['auth:migrate'], 'node scripts/auth-migrate.mjs');
    assert.equal(pkg.scripts['user:create'], 'node scripts/create-user.mjs');
    assert.equal(pkg.scripts['db:migrate'], 'node scripts/db-migrate.mjs');
  });

  it('overrides the name and jsails dependency', async () => {
    const { files } = await createStarterFiles({
      name: 'my-counter',
      jsailsDependency: 'file:../jsails',
    });
    const pkg = JSON.parse(file(files, 'package.json')) as {
      name: string;
      dependencies: Record<string, string>;
    };
    assert.equal(pkg.name, 'my-counter');
    assert.equal(pkg.dependencies['jsails'], 'file:../jsails');
  });

  it('wires human-first scripts with no recursive build loop', async () => {
    const { files } = await createStarterFiles();
    const pkg = JSON.parse(file(files, 'package.json')) as {
      scripts: Record<string, string>;
    };
    assert.equal(pkg.scripts['dev'], 'jsails dev');
    assert.equal(
      pkg.scripts['build'],
      'tsc -p tsconfig.json && vite build && jsails build --config jsails.app.js',
    );
    assert.equal(
      pkg.scripts['typecheck'],
      'tsc -p tsconfig.json --noEmit && tsc -p tsconfig.client.json --noEmit',
    );
    assert.equal(pkg.scripts['check'], 'npm run typecheck && npm run build');
    assert.equal(pkg.scripts['test'], 'tsc -p tsconfig.json && node scripts/run-tests.mjs');
    assert.equal(
      pkg.scripts['test:report'],
      'npm test -- --test-reporter=spec --test-reporter-destination=stdout --test-reporter=junit --test-reporter-destination=test-results/junit.xml',
    );
    assert.equal(pkg.scripts['test:browser'], 'npm run build && playwright test');
    assert.equal(pkg.scripts['serve'], 'jsails serve --config jsails.app.js');
    assert.equal(pkg.scripts['export'], 'npm run build');
    assert.equal(pkg.scripts['auth:migrate'], 'node scripts/auth-migrate.mjs');
    assert.equal(pkg.scripts['user:create'], 'node scripts/create-user.mjs');
    assert.equal(pkg.scripts['db:migrate'], 'node scripts/db-migrate.mjs');

    // check -> build and export -> build; build never re-enters check/export.
    assert.doesNotMatch(pkg.scripts['build'], /npm run (build|check|export)/);
    assert.doesNotMatch(pkg.scripts['typecheck'], /npm run (build|check|export)/);
    assert.doesNotMatch(pkg.scripts['check'], /npm run check/);
    assert.doesNotMatch(pkg.scripts['export'], /npm run export/);
    // The default test path is server-only: no Vite build, no browser.
    assert.doesNotMatch(pkg.scripts['test'], /vite|playwright|test:browser/);
  });

  it('ships the Playwright browser wiring: files, devDependency, script, and privacy guards', async () => {
    const { files } = await createStarterFiles();

    // The three browser-test files are emitted with their `.template` suffix stripped.
    for (const key of [
      'playwright.config.ts',
      'test/browser/fixtures.ts',
      'test/browser/home.spec.ts',
      'test/browser/auth.spec.ts',
    ]) {
      assert.ok(file(files, key).length > 0, `${key} must be a non-empty generated file`);
    }

    const pkg = JSON.parse(file(files, 'package.json')) as {
      scripts: Record<string, string>;
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    assert.equal(pkg.scripts['test:browser'], 'npm run build && playwright test');
    assert.equal(pkg.devDependencies['@playwright/test'], '^1.63.0');
    // Browser tooling is dev-only: it never leaks into runtime dependencies.
    assert.equal(pkg.dependencies['@playwright/test'], undefined);

    const gitignore = file(files, '.gitignore');
    assert.ok(gitignore.includes('test-results/'), '.gitignore must ignore test-results/');
    assert.ok(
      gitignore.includes('playwright-report/'),
      '.gitignore must ignore playwright-report/',
    );
  });

  it('documents the browser workflow without LLM/MCP dependencies', async () => {
    const { files } = await createStarterFiles();
    const guide = file(files, 'AGENTS.md');
    assert.match(guide, /npm run test:browser/);
    assert.match(guide, /test-results\/results\.json/);
    assert.match(guide, /playwright-report\//);
    assert.match(guide, /JSAILS_BROWSER_PATH/);
    assert.match(guide, /npx playwright install chromium/);
    assert.match(guide, /no automatic browser download/i);
    assert.match(guide, /JSAILS_TRACE=1/);
    assert.match(guide, /JSAILS_TEST_PORT/);
    assert.match(guide, /4173/);
    assert.match(guide, /standard Playwright API/);
    assert.match(guide, /no global MCP configuration/i);
    assert.match(guide, /no LLM service/i);
  });

  it('documents the in-process node:test suite and the jsails/testing seam', async () => {
    const { files } = await createStarterFiles();
    const guide = file(files, 'AGENTS.md');
    assert.match(guide, /npm test/);
    assert.match(guide, /node:test/);
    assert.match(guide, /node:assert\/strict/);
    assert.match(guide, /createTestApp\(\{ lifecycle: t \}\)/);
    assert.match(guide, /jsails\/testing/);
    assert.match(guide, /test-results\/junit\.xml/);
    assert.match(guide, /shared by humans and AI agents/i);
    assert.match(guide, /no HTTP server listens/i);
    assert.match(guide, /no broadcast/i);
    assert.match(guide, /caller-owned/i);
    assert.match(guide, /no automatic database rollback/i);
    assert.match(guide, /no cookie jar/i);
    assert.match(guide, /isolated fixtures/i);
  });

  it('ships the in-process test suite and runner as ready templates', async () => {
    const { files } = await createStarterFiles();

    const appTest = file(files, 'test/app.test.ts');
    assert.match(appTest, /from '\.\.\/app\/application-testing\.js'/);
    assert.doesNotMatch(appTest, /from 'jsails\/testing'/);
    assert.match(appTest, /createTestApp\(\{ lifecycle: t \}\)/);
    assert.match(appTest, /app\.request\(/);

    const runner = file(files, 'scripts/run-tests.mjs');
    assert.match(runner, /--enable-source-maps/);
    assert.match(runner, /--test/);
    assert.match(runner, /test-results/);
    // The runner defaults the child's NODE_ENV to test only when it was unset.
    assert.match(runner, /childEnv\.NODE_ENV === undefined/);
    assert.match(runner, /childEnv\.NODE_ENV = 'test'/);
    assert.match(runner, /env: childEnv/);
  });

  it('compiles the common server source folders with decorator metadata and source maps', async () => {
    const { files } = await createStarterFiles();
    const tsconfig = JSON.parse(file(files, 'tsconfig.json')) as {
      compilerOptions: Record<string, unknown>;
      include: string[];
      exclude: string[];
    };
    const include = tsconfig.include.join('\n');
    for (const dir of [
      'pages',
      'api',
      'app',
      'ui',
      'models',
      'jobs',
      'extensions',
      'commands',
      'test',
    ]) {
      assert.ok(include.includes(`${dir}/**/*.ts`), `tsconfig must include ${dir}/`);
    }
    assert.doesNotMatch(include, /client\//);
    assert.equal(tsconfig.compilerOptions['experimentalDecorators'], true);
    assert.equal(tsconfig.compilerOptions['emitDecoratorMetadata'], true);
    assert.equal(tsconfig.compilerOptions['sourceMap'], true);

    // Browser specs use Playwright's own TS loader and stay out of the server build.
    assert.ok(tsconfig.exclude.includes('test/browser'), 'tsconfig must exclude test/browser');
    for (const dir of ['node_modules', 'dist', 'public', 'out']) {
      assert.ok(tsconfig.exclude.includes(dir), `tsconfig must exclude ${dir}`);
    }
  });

  it('ships the project-local app base modules and rewrites app imports to them', async () => {
    const { files } = await createStarterFiles();

    // Every base module is a non-empty thin re-export of one framework symbol.
    const shims: Array<[string, RegExp]> = [
      ['app/application-record.ts', /BaseEntity as ApplicationRecord/],
      ['app/application-component.ts', /defineServerComponent/],
      ['app/application-component.ts', /defineAction/],
      ['app/application-resource.ts', /defineResource/],
      ['app/application-job.ts', /defineJob/],
      ['app/application-plugin.ts', /definePlugin/],
      ['app/application-command.ts', /defineCommand/],
      ['app/application-client.ts', /registerIsland/],
      ['app/application-client.ts', /startClient/],
      ['app/application-testing.ts', /createTestApp/],
      ['app/application-auth.ts', /createAuth/],
      ['app/application-auth.ts', /login/],
      ['app/application-auth.ts', /getAuthMigrations/],
      ['app/application-auth.ts', /from 'jsails\/auth'/],
    ];
    for (const [key, pattern] of shims) {
      assert.match(file(files, key), pattern, `${key} must re-export ${String(pattern)}`);
    }

    // Application code imports from `./app/*`, never from a `jsails*` entry.
    const taskList = file(files, 'components/task-list.tsx');
    assert.match(taskList, /from '\.\.\/app\/application-component\.js'/);
    assert.doesNotMatch(taskList, /from 'jsails\/server-components'/);
    for (const key of ['commands/login.ts', 'commands/logout.ts', 'commands/whoami.ts']) {
      assert.match(file(files, key), /from '\.\.\/app\/application-command\.js'/);
      assert.doesNotMatch(file(files, key), /from 'jsails'/);
    }
    const client = file(files, 'client/main.tsx');
    assert.match(client, /from '\.\.\/app\/application-client\.js'/);
    assert.doesNotMatch(client, /from 'jsails\/client'/);
    const authTest = file(files, 'test/auth.test.ts');
    assert.match(authTest, /from '\.\.\/app\/application-testing\.js'/);
    assert.doesNotMatch(authTest, /from 'jsails\/testing'/);
    // The auth suite resolves migrations through the project-local auth shim,
    // never through Better Auth's transitive `db/migration` subpath.
    assert.match(authTest, /getAuthMigrations/);
    assert.match(authTest, /import\('\.\.\/app\/application-auth\.js'\)/);
    assert.doesNotMatch(authTest, /better-auth\/db\/migration/);

    // The registry collects the component map (and a jobs seam) for the config.
    const registry = file(files, 'app/registry.ts');
    assert.match(registry, /from '\.\.\/components\/task-list\.js'/);
    assert.match(registry, /export const components/);
    assert.match(registry, /'task-list': taskList/);
    assert.match(registry, /export const jobs/);
  });

  it('strips the .template suffix and keeps plain template names', async () => {
    const { files } = await createStarterFiles();
    assert.ok(file(files, '.gitignore').includes('node_modules/'));
    assert.ok(file(files, 'jsails.app.js').includes("pages: 'dist/pages'"));
    assert.ok(file(files, 'ui/components.tsx').includes('export function Field'));
    for (const key of Object.keys(files)) {
      assert.ok(!key.endsWith('.template'), `${key} must not keep a .template suffix`);
    }
  });

  it('ships the Tailwind + daisyUI stylesheet', async () => {
    const { files } = await createStarterFiles();
    assert.match(file(files, 'ui/styles.css'), /@import 'tailwindcss'/);
    assert.match(file(files, 'ui/styles.css'), /@plugin "daisyui"/);
  });

  it('documents explicit island registration and the framework-owned lifecycle', async () => {
    const { files } = await createStarterFiles();
    const guide = file(files, 'AGENTS.md');
    assert.match(guide, /explicitly registered in the client entry/i);
    assert.match(guide, /client\/main\.tsx/);
    assert.match(guide, /registerIsland/);
    assert.match(guide, /startClient/);
    assert.match(guide, /no automatic module discovery/i);
    assert.match(guide, /no hot module replacement/i);
    assert.match(guide, /jsails serve --config jsails\.app\.js/);
    assert.match(guide, /jsails build --config jsails\.app\.js/);
    assert.match(guide, /Working with JSails/);
  });

  it('documents the server-components task demo and its limits', async () => {
    const { files } = await createStarterFiles();
    const guide = file(files, 'AGENTS.md');
    assert.match(guide, /jsails\/server-components/);
    assert.match(guide, /HMAC-signed snapshot/i);
    assert.match(guide, /staticFallback/);
    assert.match(guide, /static soft links/i);
    assert.match(guide, /ephemeral key/i);
    assert.match(guide, /JSAILS_COMPONENT_SECRET/);
    assert.match(guide, /PUBLIC/);
    assert.match(guide, /exactly-once/i);
  });

  it('documents dev, build, and no-HMR behavior truthfully', async () => {
    const { files } = await createStarterFiles();
    const guide = file(files, 'AGENTS.md');
    assert.match(guide, /npm install/);
    assert.match(guide, /npm run dev/);
    assert.match(guide, /jsails dev/);
    assert.match(guide, /no hot module[\s\S]*replacement/i);
    assert.match(guide, /HMR/);
    assert.match(guide, /reload the browser manually/i);
    assert.match(guide, /npm run build/);
    assert.match(guide, /alias for `npm run build`/);
    assert.doesNotMatch(guide, /jsails init/);
  });

  it('accepts a guide override while still prepending starter instructions', async () => {
    const { files } = await createStarterFiles({ guide: '# Custom Guide\n' });
    const guide = file(files, 'AGENTS.md');
    assert.match(guide, /# Custom Guide/);
    assert.match(guide, /explicitly registered in the client entry/i);
    assert.doesNotMatch(guide, /Working with JSails/);
  });

  it('is independent of the cwd and performs no filesystem writes', async () => {
    const before = await createStarterFiles();
    const dir = mkdtempSync(join(tmpdir(), 'jsails-starter-'));
    const previous = process.cwd();
    try {
      process.chdir(dir);
      const after = await createStarterFiles();
      assert.deepStrictEqual(after, before);
      assert.deepStrictEqual(readdirSync(dir), []);
    } finally {
      process.chdir(previous);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns a frozen, null-prototype file map', async () => {
    const result = await createStarterFiles();
    assert.ok(Object.isFrozen(result));
    assert.ok(Object.isFrozen(result.files));
    assert.equal(Object.getPrototypeOf(result.files), null);
  });

  it('ships the auth files and the auth-only app config', async () => {
    const { files } = await createStarterFiles();

    for (const key of [
      'app/application-auth.ts',
      'auth/README.md',
      'pages/login.tsx',
      'pages/dashboard.tsx',
      'pages/device.tsx',
      'api/me.ts',
      'commands/login.ts',
      'commands/logout.ts',
      'commands/whoami.ts',
      'scripts/auth-migrate.mjs',
      'scripts/create-user.mjs',
      '.env.auth.example',
      'test/auth.test.ts',
      'test/browser/auth.spec.ts',
    ]) {
      assert.ok(file(files, key).length > 0, `${key} must be generated`);
    }

    // `jsails.app.js` wires the first-party `auth` plugin, not a hand-rolled
    // auth extension, and the default variant ships no admin panel. The
    // cache/filesystem/mail plugins are wired in every web variant.
    const appConfig = file(files, 'jsails.app.js');
    assert.match(appConfig, /from 'jsails\/auth'/);
    assert.match(appConfig, /jsails\/auth/);
    assert.match(appConfig, /resolveSessionFromRequest\(createAuth\(\), request\)/);
    assert.match(appConfig, /jsails\/server-components/);
    assert.match(appConfig, /jsails\/cache/);
    assert.match(appConfig, /jsails\/filesystem/);
    assert.match(appConfig, /jsails\/mail/);
    assert.match(
      appConfig,
      /enabled: \['plugin-tools', 'auth', 'cache', 'filesystem', 'mail', 'server-components'\]/,
    );
    assert.match(appConfig, /jsails\/plugin-tools/);
    assert.doesNotMatch(appConfig, /defineAdminPanel/);
    assert.doesNotMatch(appConfig, /jsails\/admin/);
    assert.doesNotMatch(appConfig, /authSessionToken/);
    assert.doesNotMatch(appConfig, /jsails.app.js.template/);

    // The migration script resolves the plan through the framework's
    // `jsails/auth` barrel, never through Better Auth's transitive
    // `db/migration` subpath (which npm hoisting does not guarantee).
    const authMigrate = file(files, 'scripts/auth-migrate.mjs');
    assert.match(authMigrate, /from 'jsails\/auth'/);
    assert.match(authMigrate, /getAuthMigrations/);
    assert.doesNotMatch(authMigrate, /better-auth\/db\/migration/);
  });

  it('the --admin variant wires the admin plugin with a default-deny signed-in gate', async () => {
    const { files } = await createStarterFiles({ admin: true });
    const appConfig = file(files, 'jsails.app.js');
    assert.match(appConfig, /from 'jsails\/admin'/);
    assert.match(appConfig, /defineAdminPanel/);
    assert.match(appConfig, /jsails\/admin/);
    assert.match(appConfig, /authorize/);
    // The panel derives its session resolver from the auth plugin's service.
    assert.match(appConfig, /auth: authSessionToken/);
    assert.match(appConfig, /authorize: \(session\) => session !== null/);
    // The global session seam still resolves through the memoized instance.
    assert.match(appConfig, /resolveSessionFromRequest\(createAuth\(\), request\)/);
    // Auth, admin, and server-components are enabled out of the box, alongside
    // the always-wired cache/filesystem/mail plugins; managed installs live in
    // the DB. The list also gates the built-in extensions.
    assert.match(
      appConfig,
      /enabled: \['plugin-tools', 'auth', 'admin', 'cache', 'filesystem', 'mail', 'server-components'\]/,
    );
    assert.match(appConfig, /jsails\/plugin-tools/);
    assert.match(appConfig, /managed: true/);
    assert.match(appConfig, /pluginStateEntities/);
    assert.match(appConfig, /jsails\/cache/);
    assert.match(appConfig, /jsails\/filesystem/);
    assert.match(appConfig, /jsails\/mail/);
    // The task-list server component is mounted from the project-local registry.
    assert.match(appConfig, /import \{ components \} from '\.\/dist\/app\/registry\.js'/);
    assert.match(appConfig, /jsails\/server-components.*\{ components \}/);
    assert.doesNotMatch(appConfig, /dist\/components\/task-list\.js/);
    // The admin variant shares the 47-file base set (no extra files).
    assert.equal(Object.keys(files).length, 47);
  });

  it('the --blog variant adds the blog plugin, admin, plugin manager, and two pages', async () => {
    const { files } = await createStarterFiles({ blog: true });

    // The blog variant ships the two extra blog pages (49 files total).
    assert.equal(Object.keys(files).length, 49);
    assert.ok(file(files, 'pages/blog/index.tsx').length > 0);
    assert.ok(file(files, 'pages/blog/[slug].tsx').length > 0);

    const appConfig = file(files, 'jsails.app.js');
    assert.match(appConfig, /from 'jsails\/blog'/);
    assert.match(appConfig, /from 'jsails\/plugin-manager'/);
    assert.match(appConfig, /jsails\/blog/);
    assert.match(appConfig, /blogAdmin\(/);
    assert.match(appConfig, /createDatabaseBlogStore\(/);
    assert.match(appConfig, /blogPostEntities/);
    assert.match(appConfig, /getDataSource/);
    assert.doesNotMatch(appConfig, /createBlogStore\(/);
    assert.match(appConfig, /pluginManagerPlugin\(/);
    assert.match(appConfig, /defineAdminPanel/);
    assert.match(appConfig, /jsails\/admin/);
    assert.match(
      appConfig,
      /enabled: \['plugin-tools', 'auth', 'admin', 'blog', 'cache', 'filesystem', 'mail', 'server-components'\]/,
    );
    assert.match(appConfig, /managed: true/);

    // The blog guide section documents the database-backed module.
    const guide = file(files, 'AGENTS.md');
    assert.match(guide, /jsails\/blog/);
    assert.match(guide, /blogPlugin/);
    assert.match(guide, /blogAdmin/);
    assert.match(guide, /blogPostsToken/);
    assert.match(guide, /createDatabaseBlogStore/);
    assert.match(guide, /db:migrate/);
  });

  it('emits the env example and un-ignores it in the gitignore', async () => {
    const { files } = await createStarterFiles();
    const envExample = file(files, '.env.auth.example');
    assert.match(envExample, /BETTER_AUTH_SECRET/);
    assert.match(envExample, /DATABASE_HOST/);
    assert.match(envExample, /DATABASE_NAME/);
    assert.match(envExample, /DATABASE_USER/);
    assert.match(envExample, /BETTER_AUTH_URL/);

    const gitignore = file(files, '.gitignore');
    assert.ok(
      gitignore.includes('!.env.auth.example'),
      '.gitignore must un-ignore .env.auth.example',
    );
  });

  it('documents the auth workflow in the guide', async () => {
    const { files } = await createStarterFiles();
    const guide = file(files, 'AGENTS.md');
    assert.match(guide, /npm run auth:migrate/);
    assert.match(guide, /npm run user:create/);
    assert.match(guide, /BETTER_AUTH_SECRET/);
    assert.match(guide, /MariaDB/);
    assert.match(guide, /jamal up/);
    assert.match(guide, /DATABASE_HOST/);
    assert.match(guide, /DATABASE_NAME/);
  });

  it('documents the user-facing CLI login flow', async () => {
    const { files } = await createStarterFiles();
    const guide = file(files, 'AGENTS.md');
    assert.match(guide, /jsails login/);
    assert.match(guide, /jsails whoami/);
    assert.match(guide, /jsails logout/);
    assert.match(guide, /\/device/);
    assert.match(guide, /RFC 8628/);
    assert.match(guide, /~\/\.config\/jsails\/<app>\/credentials\.json/);
    assert.match(guide, /0600/);
    assert.match(guide, /0700/);
    assert.match(guide, /commands\/\*\.ts/);
    assert.match(guide, /framework builtins/);
    assert.match(guide, /jamal/);
    assert.match(guide, /developer commands/);
  });

  it('documents the admin panel, plugin enablement, and jamal in the guide', async () => {
    const { files } = await createStarterFiles();
    const guide = file(files, 'AGENTS.md');
    assert.match(guide, /admin/);
    assert.match(guide, /plugins/);
    assert.match(guide, /plugins\.enabled/);
    assert.match(guide, /jsails_plugin_state/);
    assert.match(guide, /pluginStateEntities/);
    assert.match(guide, /jamal/);
    assert.match(guide, /restrict it to an admin role/i);
  });

  it('rejects non-object options', async () => {
    await assert.rejects(createStarterFiles('nope' as unknown as never), StarterError);
    await assert.rejects(createStarterFiles(42 as unknown as never), StarterError);
    await assert.rejects(createStarterFiles(null as unknown as never), StarterError);
    await assert.rejects(createStarterFiles([] as unknown as never), StarterError);
  });

  it('rejects invalid names with StarterError', async () => {
    await assert.rejects(createStarterFiles({ name: 42 as unknown as string }), StarterError);
    await assert.rejects(createStarterFiles({ name: '' }), StarterError);
    await assert.rejects(createStarterFiles({ name: 'Invalid Name' }), StarterError);
    await assert.rejects(createStarterFiles({ name: '.hidden' }), StarterError);
    await assert.rejects(createStarterFiles({ name: 'my\u0000app' }), StarterError);
  });

  it('rejects invalid jsails dependency specs', async () => {
    await assert.rejects(
      createStarterFiles({ jsailsDependency: 42 as unknown as string }),
      StarterError,
    );
    await assert.rejects(createStarterFiles({ jsailsDependency: '' }), StarterError);
    await assert.rejects(createStarterFiles({ jsailsDependency: '^0.1.0' }), StarterError);
    await assert.rejects(createStarterFiles({ jsailsDependency: 'file:' }), StarterError);
    await assert.rejects(createStarterFiles({ jsailsDependency: 'file:x\u0000y' }), StarterError);
  });

  it('rejects invalid guide values', async () => {
    await assert.rejects(createStarterFiles({ guide: 42 as unknown as string }), StarterError);
    await assert.rejects(createStarterFiles({ guide: '' }), StarterError);
    await assert.rejects(createStarterFiles({ guide: 'bad\u0000guide' }), StarterError);
  });

  it('the --cli variant returns exactly the 7-file CLI-only set', async () => {
    const { files } = await createStarterFiles({ cli: true });
    assert.deepStrictEqual(Object.keys(files).sort(), [...EXPECTED_CLI_KEYS].sort());
    assert.equal(Object.keys(files).length, 7);
    // No web surface: the CLI-only shape never ships web directories.
    for (const key of Object.keys(files)) {
      assert.ok(!key.startsWith('pages/'), `cli variant must not ship ${key}`);
      assert.ok(!key.startsWith('api/'), `cli variant must not ship ${key}`);
      assert.ok(!key.startsWith('client/'), `cli variant must not ship ${key}`);
      assert.ok(!key.startsWith('ui/'), `cli variant must not ship ${key}`);
    }
    const appConfig = file(files, 'jsails.app.js');
    assert.match(appConfig, /plugins: \{ use: \[\] \}/);
    assert.match(appConfig, /use: \[\]/);
    assert.match(appConfig, /name: 'about'/);
    assert.doesNotMatch(appConfig, /from 'jsails/);
    assert.doesNotMatch(appConfig, /\.\/dist\//);
  });

  it('the --cli variant emits a minimal private package.json with no web scripts', async () => {
    const { files } = await createStarterFiles({ cli: true, name: 'my-cli' });
    const pkg = JSON.parse(file(files, 'package.json')) as {
      name: string;
      private: boolean;
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
      scripts: Record<string, string>;
    };
    assert.equal(pkg.name, 'my-cli');
    assert.equal(pkg.private, true);
    assert.equal(pkg.dependencies['jsails'], FRAMEWORK_VERSION);
    // Minimal scripts: no dev/serve/export/test/browser/auth surface.
    assert.equal(pkg.scripts['build'], 'tsc -p tsconfig.json');
    assert.equal(pkg.scripts['typecheck'], 'tsc -p tsconfig.json --noEmit');
    assert.equal(pkg.scripts['check'], 'npm run typecheck && npm run build');
    for (const key of ['dev', 'serve', 'export', 'test', 'test:browser', 'test:report']) {
      assert.equal(pkg.scripts[key], undefined, `cli variant must not define ${key}`);
    }
    assert.equal(pkg.scripts['auth:migrate'], undefined);
    assert.equal(pkg.scripts['user:create'], undefined);
    // The web-only auth/UI tooling never ships in the CLI-only shape.
    assert.equal(pkg.dependencies['zod'], undefined);
    assert.equal(pkg.dependencies['preact'], undefined);
    assert.equal(pkg.devDependencies['vite'], undefined);
    assert.equal(pkg.devDependencies['@playwright/test'], undefined);
    assert.equal(pkg.devDependencies['typescript'], '^7.0.2');
  });

  it('the --cli variant compiles only commands/ and app/ with NodeNext and no JSX/DOM', async () => {
    const { files } = await createStarterFiles({ cli: true });
    const tsconfig = JSON.parse(file(files, 'tsconfig.json')) as {
      compilerOptions: Record<string, unknown>;
      include: string[];
      exclude: string[];
    };
    assert.equal(tsconfig.compilerOptions['module'], 'NodeNext');
    assert.equal(tsconfig.compilerOptions['moduleResolution'], 'NodeNext');
    assert.equal(tsconfig.compilerOptions['jsx'], undefined, 'no JSX in the CLI-only project');
    assert.equal(tsconfig.compilerOptions['jsxImportSource'], undefined);
    assert.deepEqual(tsconfig.compilerOptions['lib'], ['ES2023'], 'no DOM lib');
    assert.equal(tsconfig.compilerOptions['experimentalDecorators'], undefined);
    assert.deepEqual(tsconfig.include, ['commands/**/*.ts', 'app/**/*.ts']);
    assert.ok(tsconfig.exclude.includes('node_modules'));
    assert.ok(tsconfig.exclude.includes('dist'));
    for (const dir of ['pages', 'api', 'public', 'client', 'ui', 'test']) {
      assert.ok(
        !tsconfig.include.some((entry) => entry.startsWith(`${dir}/`)),
        `${dir} not included`,
      );
    }
  });

  it('the --cli variant ships the defineCommand shim and the hello sample command', async () => {
    const { files } = await createStarterFiles({ cli: true });

    const shim = file(files, 'app/application-command.ts');
    assert.match(shim, /export \{ defineCommand \} from 'jsails'/);

    const hello = file(files, 'commands/hello.ts');
    assert.match(hello, /from '\.\.\/app\/application-command\.js'/);
    assert.doesNotMatch(hello, /from 'jsails'/);
    assert.match(hello, /defineCommand\(\{/);
    assert.match(hello, /signature: 'hello \{name\?\}'/);
    assert.match(hello, /summary: 'Greet someone by name'/);
    assert.match(hello, /audience: 'user'/);
    assert.match(hello, /ctx\.prompter\.text\(/);
    assert.match(hello, /ctx\.stdout\(`Hello, \$\{name\}!`\)/);

    const appConfig = file(files, 'jsails.app.js');
    assert.match(appConfig, /name: 'about'/);
    assert.match(appConfig, /audience: 'developer'/);
  });

  it('the --cli variant documents the build-then-run workflow in AGENTS.md', async () => {
    const { files } = await createStarterFiles({ cli: true });
    const guide = file(files, 'AGENTS.md');
    assert.match(guide, /# JSails CLI Starter/);
    assert.match(guide, /no web surface/i);
    assert.match(guide, /npm run build/);
    assert.match(guide, /npx jsails hello/);
    assert.match(guide, /npx jsails about/);
    assert.match(guide, /plugins\.enabled/);
    assert.match(guide, /plugins\.use/);
    assert.match(guide, /jsails\.app\.js/);
    assert.match(guide, /dist\/commands/);
    assert.match(guide, /node:readline\/promises/);
    // The framework's own guide is still bundled underneath.
    assert.match(guide, /Working with JSails/);
  });

  it('the --cli variant ships an app config with the extension seam and a config command', async () => {
    const { files } = await createStarterFiles({ cli: true });
    const appConfig = file(files, 'jsails.app.js');
    assert.match(appConfig, /rootDir: '\.'/);
    assert.match(appConfig, /plugins: \{ use: \[\] \}/);
    assert.match(appConfig, /use: \[\]/);
    assert.match(appConfig, /commands: \[/);
    assert.match(appConfig, /name: 'about'/);
    assert.match(appConfig, /summary: 'Show framework and project information'/);
    assert.match(appConfig, /audience: 'developer'/);
    // A CLI project has no web surface: the config declares no web keys.
    assert.doesNotMatch(appConfig, /pages:/);
    assert.doesNotMatch(appConfig, /api:/);
    assert.doesNotMatch(appConfig, /public:/);
  });

  it('the --cli variant ships a gitignore without the web-specific paths', async () => {
    const { files } = await createStarterFiles({ cli: true });
    const gitignore = file(files, '.gitignore');
    assert.ok(gitignore.includes('node_modules/'));
    assert.ok(gitignore.includes('dist/'));
    assert.doesNotMatch(gitignore, /public\/assets/);
    assert.doesNotMatch(gitignore, /test-results/);
    assert.doesNotMatch(gitignore, /playwright-report/);
    assert.doesNotMatch(gitignore, /\.env\.auth\.example/);
  });

  it('rejects --cli combined with --admin or --blog', async () => {
    await assert.rejects(
      createStarterFiles({ cli: true, admin: true }),
      /options\.cli cannot be combined with options\.admin, options\.blog, or options\.static/,
    );
    await assert.rejects(
      createStarterFiles({ cli: true, blog: true }),
      /options\.cli cannot be combined with options\.admin, options\.blog, or options\.static/,
    );
    await assert.rejects(
      createStarterFiles({ cli: true, admin: true, blog: true }),
      /options\.cli cannot be combined/,
    );
  });

  it('rejects an invalid cli flag value', async () => {
    await assert.rejects(createStarterFiles({ cli: 'yes' as unknown as boolean }), StarterError);
  });

  it('the --static variant returns exactly the 15-file static-site set', async () => {
    const { files } = await createStarterFiles({ static: true });
    assert.deepStrictEqual(Object.keys(files).sort(), [...EXPECTED_STATIC_KEYS].sort());
    assert.equal(Object.keys(files).length, 15);
  });

  it('the --static variant ships no auth, API, server-component, or Jamal files', async () => {
    const { files } = await createStarterFiles({ static: true });
    const keys = Object.keys(files);
    for (const forbidden of [
      'api/me.ts',
      'components/task-list.tsx',
      'pages/tasks.tsx',
      'pages/login.tsx',
      'pages/dashboard.tsx',
      'pages/device.tsx',
      'jamal.config.js',
      'jsails.config.js',
      '.env.auth.example',
      'auth/README.md',
      'commands/login.ts',
      'playwright.config.ts',
    ]) {
      assert.ok(!keys.includes(forbidden), `static starter must not ship ${forbidden}`);
    }
  });

  it('the --static variant emits a private package.json with build/serve scripts and no auth scripts', async () => {
    const { files } = await createStarterFiles({ static: true, name: 'my-static' });
    const pkg = JSON.parse(file(files, 'package.json')) as {
      name: string;
      private: boolean;
      scripts: Record<string, string>;
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    assert.equal(pkg.name, 'my-static');
    assert.equal(pkg.private, true);
    const build = pkg.scripts.build ?? '';
    assert.match(build, /tsc -p tsconfig\.json/);
    assert.match(build, /vite build/);
    assert.match(build, /jsails build --config jsails\.app\.js/);
    assert.equal(pkg.scripts['auth:migrate'], undefined);
    assert.equal(pkg.scripts['db:migrate'], undefined);
    assert.equal(pkg.scripts['user:create'], undefined);
    assert.equal(pkg.dependencies['jsails'], FRAMEWORK_VERSION);
    assert.equal(pkg.dependencies['preact'] !== undefined, true);
    assert.equal(pkg.dependencies['zod'], undefined);
  });

  it('the --static variant compiles pages/app/ui with JSX and a separate client project', async () => {
    const { files } = await createStarterFiles({ static: true });
    const server = JSON.parse(file(files, 'tsconfig.json')) as {
      compilerOptions: Record<string, unknown>;
      include: string[];
    };
    assert.equal(server.compilerOptions['jsx'], 'react-jsx');
    assert.equal(server.compilerOptions['jsxImportSource'], 'jsails');
    assert.ok(server.include.some((entry) => entry.startsWith('pages/')));
    assert.ok(server.include.some((entry) => entry.startsWith('ui/')));

    const client = JSON.parse(file(files, 'tsconfig.client.json')) as {
      compilerOptions: Record<string, unknown>;
      include: string[];
    };
    assert.equal(client.compilerOptions['jsxImportSource'], 'preact');
    assert.ok(client.include.some((entry) => entry.startsWith('client/')));
  });

  it('the --static variant ships an app config with an empty plugins.use and no marketplace block', async () => {
    const { files } = await createStarterFiles({ static: true });
    const config = file(files, 'jsails.app.js');
    assert.match(config, /plugins:\s*\{/);
    assert.match(config, /use:\s*\[\]/);
    assert.doesNotMatch(config, /enabled:/);
    assert.doesNotMatch(config, /managed:/);
    assert.doesNotMatch(config, /jsails\/auth/);
    assert.doesNotMatch(config, /jsails\/server-components/);
  });

  it('the --static variant ships the client shim, browser entry, and island markup', async () => {
    const { files } = await createStarterFiles({ static: true });
    const shim = file(files, 'app/application-client.ts');
    assert.match(shim, /from 'jsails\/client'/);
    assert.match(shim, /registerIsland/);
    assert.match(shim, /startClient/);

    const entry = file(files, 'client/main.tsx');
    assert.match(entry, /registerIsland\('counter'/);
    assert.match(entry, /startClient\(\)/);

    const index = file(files, 'pages/index.tsx');
    assert.match(index, /data-jsails-island="counter"/);
    assert.match(index, /loadLayout/);
  });

  it('the --static variant documents the build-and-deploy workflow in AGENTS.md', async () => {
    const { files } = await createStarterFiles({ static: true });
    const guide = file(files, 'AGENTS.md');
    assert.match(guide, /# JSails Static Starter/);
    assert.match(guide, /deploy `out\/`/);
    assert.match(guide, /plugins\.use: \[\]/);
  });

  it('the --static variant ships a gitignore without the auth env un-ignore', async () => {
    const { files } = await createStarterFiles({ static: true });
    const gitignore = file(files, '.gitignore');
    assert.match(gitignore, /node_modules\//);
    assert.match(gitignore, /out\//);
    assert.doesNotMatch(gitignore, /\.env\.auth\.example/);
  });

  it('rejects --static combined with --admin, --blog, or --cli', async () => {
    await assert.rejects(
      createStarterFiles({ static: true, admin: true }),
      /options\.static cannot be combined with options\.admin or options\.blog/,
    );
    await assert.rejects(
      createStarterFiles({ static: true, blog: true }),
      /options\.static cannot be combined with options\.admin or options\.blog/,
    );
    await assert.rejects(
      createStarterFiles({ static: true, cli: true }),
      /options\.cli cannot be combined with options\.admin, options\.blog, or options\.static/,
    );
  });

  it('rejects an invalid static flag value', async () => {
    await assert.rejects(createStarterFiles({ static: 'yes' as unknown as boolean }), StarterError);
  });
});
