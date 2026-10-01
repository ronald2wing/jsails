import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { StarterError, createStarterFiles } from '../src/app/starter.js';

/** Package root, resolved from the compiled test module (not the cwd). */
const PACKAGE_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** The framework's own version, for the default-dependency assertion. */
const FRAMEWORK_VERSION = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'))
  .version as string;

/** Every key `createStarterFiles` must produce, order-independent. */
const EXPECTED_KEYS = [
  'AGENTS.md',
  '.gitignore',
  'client/main.tsx',
  'components/task-list.tsx',
  'jsails.app.js',
  'package.json',
  'pages/about.tsx',
  'pages/index.tsx',
  'pages/tasks.tsx',
  'playwright.config.ts',
  'scripts/run-tests.mjs',
  'test/app.test.ts',
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

/** Auth-variant keys added on top of the base set (`jsails.app.js` is replaced, not added). */
const AUTH_EXTRA_KEYS = [
  '.env.auth.example',
  'api/me.ts',
  'auth/README.md',
  'auth/better-auth.ts',
  'auth/cli-client.ts',
  'auth/routes.ts',
  'commands/login.ts',
  'commands/logout.ts',
  'commands/whoami.ts',
  'pages/dashboard.tsx',
  'pages/device.tsx',
  'pages/login.tsx',
  'scripts/auth-migrate.mjs',
  'scripts/create-user.mjs',
  'test/auth.test.ts',
  'test/browser/auth.spec.ts',
];

/** Every key the auth variant must produce, order-independent. */
const AUTH_EXPECTED_KEYS = [...EXPECTED_KEYS, ...AUTH_EXTRA_KEYS].sort();

/** Read a generated file, failing the test if the key is absent. */
function file(files: Readonly<Record<string, string>>, key: string): string {
  const value = files[key];
  assert.ok(typeof value === 'string', `expected generated file "${key}"`);
  return value;
}

describe('createStarterFiles', () => {
  it('returns exactly the expected file set', async () => {
    const { files } = await createStarterFiles();
    assert.deepStrictEqual(Object.keys(files).sort(), [...EXPECTED_KEYS].sort());
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
    assert.match(appTest, /from 'jsails\/testing'/);
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
    for (const dir of ['pages', 'api', 'ui', 'models', 'jobs', 'extensions', 'commands', 'test']) {
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
    assert.match(guide, /no authentication/i);
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

  it('auth variant includes the auth files and replaces the base app config', async () => {
    const { files } = await createStarterFiles({ auth: true });

    assert.deepStrictEqual(Object.keys(files).sort(), AUTH_EXPECTED_KEYS);

    // The base pages/components/test files still ship alongside the auth ones.
    for (const key of [
      'pages/about.tsx',
      'pages/index.tsx',
      'pages/tasks.tsx',
      'components/task-list.tsx',
      'test/app.test.ts',
      'test/browser/home.spec.ts',
    ]) {
      assert.ok(file(files, key).length > 0, `${key} must remain in the auth variant`);
    }

    // `jsails.app.js` is the auth config, not the base one.
    const appConfig = file(files, 'jsails.app.js');
    assert.match(appConfig, /createAuth/);
    assert.match(appConfig, /better-auth/);
    assert.doesNotMatch(appConfig, /jsails.app.js.template/);
  });

  it('auth variant merges dependencies, scripts, tsconfig include, and env example', async () => {
    const { files } = await createStarterFiles({ auth: true });

    const pkg = JSON.parse(file(files, 'package.json')) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
      scripts: Record<string, string>;
    };
    assert.equal(pkg.dependencies['better-auth'], '^1.7.7');
    assert.equal(pkg.dependencies['kysely'], '^0.29.6');
    assert.equal(pkg.dependencies['better-sqlite3'], '^13.0.3');
    assert.equal(pkg.devDependencies['@types/better-sqlite3'], '^9.6.0');
    assert.equal(pkg.scripts['auth:migrate'], 'node scripts/auth-migrate.mjs');
    assert.equal(pkg.scripts['user:create'], 'node scripts/create-user.mjs');
    // Existing dependencies and scripts survive the merge.
    assert.equal(pkg.dependencies['zod'], '^4.6.5');
    assert.equal(pkg.scripts['dev'], 'jsails dev');

    const tsconfig = JSON.parse(file(files, 'tsconfig.json')) as {
      include: string[];
    };
    assert.ok(tsconfig.include.includes('auth/**/*.ts'), 'tsconfig must include auth/**/*.ts');
    assert.ok(
      tsconfig.include.includes('commands/**/*.ts'),
      'tsconfig must include commands/**/*.ts',
    );

    // The env example ships only for the auth variant.
    assert.match(file(files, '.env.auth.example'), /BETTER_AUTH_SECRET/);

    // The generated gitignore un-ignores the committed env example.
    const gitignore = file(files, '.gitignore');
    assert.ok(
      gitignore.includes('!.env.auth.example'),
      '.gitignore must un-ignore .env.auth.example',
    );
  });

  it('auth variant documents the auth workflow in the guide', async () => {
    const { files } = await createStarterFiles({ auth: true });
    const guide = file(files, 'AGENTS.md');
    assert.match(guide, /npm run auth:migrate/);
    assert.match(guide, /npm run user:create/);
    assert.match(guide, /BETTER_AUTH_SECRET/);
    assert.match(guide, /Node >= 22/);
  });

  it('auth variant documents the user-facing CLI login flow', async () => {
    const { files } = await createStarterFiles({ auth: true });
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

  it('auth variant keeps the file map frozen and null-prototype', async () => {
    const result = await createStarterFiles({ auth: true });
    assert.ok(Object.isFrozen(result));
    assert.ok(Object.isFrozen(result.files));
    assert.equal(Object.getPrototypeOf(result.files), null);
  });

  it('base and auth variants are byte-identical for the base file set', async () => {
    const base = await createStarterFiles();
    const explicitFalse = await createStarterFiles({ auth: false });
    assert.deepStrictEqual(explicitFalse, base);

    // The base variant never ships auth files, and its tsconfig/gitignore stay
    // untouched by the auth additions.
    const auth = await createStarterFiles({ auth: true });
    const baseTsconfig = JSON.parse(file(base.files, 'tsconfig.json')) as {
      include: string[];
    };
    const authTsconfig = JSON.parse(file(auth.files, 'tsconfig.json')) as {
      include: string[];
    };
    assert.ok(!baseTsconfig.include.includes('auth/**/*.ts'));
    assert.ok(authTsconfig.include.includes('auth/**/*.ts'));
    assert.ok(!file(base.files, '.gitignore').includes('!.env.auth.example'));
    assert.equal(file(base.files, 'jsails.app.js').includes('createAuth'), false);
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
});
