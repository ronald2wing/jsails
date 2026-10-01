/**
 * Starter scaffold generator.
 *
 * `createStarterFiles` produces the complete file set for a fresh JSails
 * starter application as an in-memory map of portable relative paths to file
 * contents. It reads a fixed whitelist of bundled text templates from the
 * package root (resolved relative to this compiled module, never the process
 * working directory), strips the `.template` suffix, and rewrites the
 * `package.json` `name` and `jsails` dependency in place. It never writes to
 * disk, never installs dependencies, and never spawns a subprocess — the
 * caller owns every filesystem effect.
 *
 * The generated `AGENTS.md` bundles the framework's own guide (or a caller
 * override) prefixed with starter-specific instructions, so a copied project
 * ships a reader guide without any runtime import of that guide. No template is
 * ever executed: `package.json.template` is JSON-parsed and re-stringified, and
 * every other template is copied verbatim as text.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Absolute path of the package root, resolved from this compiled module. */
const PACKAGE_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** Error raised for any invalid starter option or unreadable bundled file. */
export class StarterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StarterError';
  }
}

/** Options for {@link createStarterFiles}. */
export interface StarterOptions {
  /** npm package name for the generated project. Defaults to `"jsails-app"`. */
  name?: string;
  /**
   * Value of the `jsails` entry in the generated `package.json`. Defaults to
   * the framework's own package version; when supplied it must be a non-empty
   * `file:` specifier (e.g. `"file:../jsails"`).
   */
  jsailsDependency?: string;
  /**
   * `AGENTS.md` content for the generated project. Defaults to the framework's
   * own bundled guide; when supplied it replaces that guide, with the
   * app-specific starter instructions always prepended.
   */
  guide?: string;
  /**
   * Whether to generate the Better Auth variant. When `true`, the auth
   * templates are included, the base `jsails.app.js` is replaced by the auth
   * app config, and the `package.json`/`tsconfig.json`/`.gitignore`/guide
   * gain their auth-specific additions. Defaults to `false`, which produces
   * the plain starter unchanged.
   */
  auth?: boolean;
}

/** The generated file set: portable relative path -> file contents. */
export interface StarterFiles {
  readonly files: Readonly<Record<string, string>>;
}

/** Default npm name of the generated project. */
const DEFAULT_NAME = 'jsails-app';

/**
 * Bundled templates under `templates/starter/`, in deterministic order. Only
 * these paths are ever read; nothing else on disk is touched.
 */
const TEMPLATE_FILES: readonly string[] = [
  'client/main.tsx',
  'components/task-list.tsx',
  '.gitignore.template',
  'jsails.app.js.template',
  'package.json.template',
  'pages/about.tsx',
  'pages/index.tsx',
  'pages/tasks.tsx',
  'playwright.config.ts.template',
  'scripts/run-tests.mjs.template',
  'test/app.test.ts.template',
  'test/browser/fixtures.ts.template',
  'test/browser/home.spec.ts.template',
  'tsconfig.client.json.template',
  'tsconfig.json.template',
  'ui/components.tsx',
  'ui/counter.tsx',
  'ui/layout.tsx',
  'ui/styles.css',
  'vite.config.js.template',
];

/**
 * The base app config template, replaced by the auth variant's own config so
 * the generated project still ships a single `jsails.app.js`.
 */
const BASE_APP_CONFIG_TEMPLATE = 'jsails.app.js.template';

/**
 * Auth-variant templates under `templates/starter/`, in deterministic order.
 * Only these paths are ever read for the auth variant; the base templates are
 * always read as well. `jsails.app.auth.js.template` maps to the same
 * `jsails.app.js` output path as the base config, replacing it.
 */
const AUTH_TEMPLATE_FILES: readonly string[] = [
  '.env.auth.example.template',
  'api/me.ts.template',
  'auth/README.md.template',
  'auth/better-auth.ts.template',
  'auth/cli-client.ts.template',
  'auth/routes.ts.template',
  'commands/login.ts.template',
  'commands/logout.ts.template',
  'commands/whoami.ts.template',
  'jsails.app.auth.js.template',
  'pages/dashboard.tsx.template',
  'pages/device.tsx.template',
  'pages/login.tsx.template',
  'scripts/auth-migrate.mjs.template',
  'scripts/create-user.mjs.template',
  'test/auth.test.ts.template',
  'test/browser/auth.spec.ts.template',
];

/** Extra runtime dependencies merged into `package.json` for the auth variant. */
const AUTH_DEPENDENCIES: Readonly<Record<string, string>> = {
  'better-auth': '^1.7.7',
  'better-sqlite3': '^13.0.3',
  kysely: '^0.29.6',
};

/**
 * Extra dev dependency merged into `package.json` for the auth variant.
 * `better-sqlite3` ships no bundled types (no `types`/`typings` field in its
 * 13.x manifest and no `.d.ts` in the tarball), so `auth/better-auth.ts` needs
 * the DefinitelyTyped definitions to typecheck. Pinned to the latest published
 * `@types/better-sqlite3` at generation time.
 */
const AUTH_DEV_DEPENDENCIES: Readonly<Record<string, string>> = {
  '@types/better-sqlite3': '^9.6.0',
};

/** Extra npm scripts merged into `package.json` for the auth variant. */
const AUTH_SCRIPTS: Readonly<Record<string, string>> = {
  'auth:migrate': 'node scripts/auth-migrate.mjs',
  'user:create': 'node scripts/create-user.mjs',
};

/** C0 controls plus DEL — never valid in a single-token option value. */
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

/** C0 controls except tab/LF/CR, plus DEL — never valid in free-form text. */
const TEXT_CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

/**
 * Conservative npm package name: lowercase, URL-safe, no leading "." or "_",
 * with an optional leading `@scope/`. This accepts the subset of names npm
 * allows for new packages.
 */
const NPM_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

/** Maximum length npm accepts for a package name. */
const MAX_NAME_LENGTH = 214;

/** Whether a value is a plain object (object literal or null-prototype). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Validate the generated project name. Errors never echo the raw value. */
function assertName(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new StarterError('options.name must be a non-empty string');
  }
  if (CONTROL_CHARS.test(value)) {
    throw new StarterError('options.name must not contain control characters');
  }
  if (value.length > MAX_NAME_LENGTH) {
    throw new StarterError('options.name must not exceed 214 characters');
  }
  if (!NPM_NAME_PATTERN.test(value)) {
    throw new StarterError(
      'options.name must be a valid npm package name (lowercase, URL-safe, no leading "." or "_")',
    );
  }
  return value;
}

/** Validate a supplied `jsails` dependency specifier. */
function assertDependency(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new StarterError('options.jsailsDependency must be a non-empty string');
  }
  if (CONTROL_CHARS.test(value)) {
    throw new StarterError('options.jsailsDependency must not contain control characters');
  }
  if (!value.startsWith('file:') || value.length <= 'file:'.length) {
    throw new StarterError('options.jsailsDependency must be a "file:" specifier');
  }
  return value;
}

/** Validate an overriding guide. Newlines/tabs are allowed; other controls are not. */
function assertGuide(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new StarterError('options.guide must be a non-empty string');
  }
  if (TEXT_CONTROL_CHARS.test(value)) {
    throw new StarterError('options.guide must not contain control characters');
  }
  return value;
}

/** The framework's own version, read from the bundled package manifest. */
async function readPackageVersion(): Promise<string> {
  const text = await readFile(join(PACKAGE_ROOT, 'package.json'), 'utf8');
  const pkg = JSON.parse(text) as { version?: unknown };
  if (typeof pkg.version !== 'string' || pkg.version.length === 0) {
    throw new StarterError('the jsails package must declare a non-empty version');
  }
  return pkg.version;
}

/** The framework's own reader guide, bundled at the package root. */
async function readBundledGuide(): Promise<string> {
  return readFile(join(PACKAGE_ROOT, 'AGENTS.md'), 'utf8');
}

/** Strip the `.template` suffix from a bundled template path, if present. */
function toOutputPath(template: string): string {
  return template.endsWith('.template') ? template.slice(0, -'.template'.length) : template;
}

/**
 * Rewrite the parsed package template: set the validated name and the resolved
 * `jsails` dependency, and for the auth variant merge the extra dependencies,
 * dev dependencies, and scripts. The template is JSON-parsed and re-stringified;
 * nothing is executed.
 */
function buildPackageJson(
  template: string,
  name: string,
  dependency: string,
  auth: boolean,
): string {
  const parsed = JSON.parse(template) as {
    name?: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    scripts?: Record<string, string>;
  };
  parsed.name = name;
  if (parsed.dependencies !== undefined) {
    parsed.dependencies['jsails'] = dependency;
  }
  if (auth) {
    parsed.dependencies ??= {};
    Object.assign(parsed.dependencies, AUTH_DEPENDENCIES);
    parsed.devDependencies ??= {};
    Object.assign(parsed.devDependencies, AUTH_DEV_DEPENDENCIES);
    parsed.scripts ??= {};
    Object.assign(parsed.scripts, AUTH_SCRIPTS);
  }
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

/**
 * Rewrite the parsed tsconfig template for the auth variant: add
 * `auth/**\/*.ts` to `include` so the compiled auth modules land in `dist/`.
 * The base variant returns the template verbatim so its output is byte-identical.
 */
function buildTsconfig(template: string, auth: boolean): string {
  if (!auth) {
    return template;
  }
  const parsed = JSON.parse(template) as { include?: string[] };
  const include = parsed.include ?? [];
  if (!include.includes('auth/**/*.ts')) {
    include.push('auth/**/*.ts');
  }
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

/**
 * Rewrite the gitignore template for the auth variant: un-ignore the committed
 * `.env.auth.example` (the base template's `.env.*` rule would ignore it). The
 * base variant returns the template verbatim so its output is byte-identical.
 */
function buildGitignore(template: string, auth: boolean): string {
  if (!auth) {
    return template;
  }
  return `${template}!.env.auth.example\n`;
}

/**
 * Starter-specific instructions prepended to the bundled/override guide. The
 * scripts describe the exact commands the generated `package.json` wires up,
 * and the testing notes document the in-process `node:test` suite, the
 * `jsails/testing` seam, and the optional browser checks.
 */
const STARTER_GUIDE_PREFIX = [
  '# JSails Starter',
  '',
  'Generated by `createStarterFiles`. A small Preact app served by JSails: a',
  'counter island and a tasks page with a stateful server component. No',
  'database and no authentication.',
  '',
  '## Getting started',
  '',
  '- `npm install` — install dependencies.',
  '- `npm run dev` — `jsails dev`: compile the server and client, watch source',
  '  and assets, and restart the server on changes. There is no hot module',
  '  replacement, so reload the browser manually after each change.',
  '- `npm run build` — compile, bundle, and statically export the app.',
  '- `npm test` — type-check the server and run the in-process `node:test` suite',
  '  (see "Testing").',
  '',
  '## Scripts',
  '',
  '- `npm run dev` — `jsails dev`: compile, watch, and restart the server (no',
  '  HMR; reload the browser manually).',
  '- `npm run build` — compile the server sources to `dist/`',
  '  (`tsc -p tsconfig.json`), bundle the browser entry (`vite build`), then',
  '  export into `out/` (`jsails build --config jsails.app.js`).',
  '- `npm run typecheck` — type-check the server (`tsconfig.json`) and client',
  '  (`tsconfig.client.json`) projects without emitting.',
  '- `npm run check` — `typecheck`, then `build`.',
  '- `npm run serve` — `jsails serve --config jsails.app.js`: run the compiled',
  '  app without watching.',
  '- `npm run export` — an alias for `npm run build`; the build already exports.',
  '- `npm test` — `tsc -p tsconfig.json && node scripts/run-tests.mjs`: compile',
  '  the server and run the compiled `node:test` suite in-process.',
  '- `npm run test:report` — `npm test` plus a spec reporter on stdout and a',
  '  JUnit XML report at `test-results/junit.xml`.',
  '- `npm run test:browser` — `npm run build && playwright test`: compile and',
  '  export the app, then run the Playwright browser tests under `test/browser/`',
  '  against a local isolated server (see "Browser tests").',
  '',
  '## Testing',
  '',
  '`npm test` runs the server test suite in-process with the built-in `node:test`',
  'runner and native `node:assert/strict` assertions — no third-party test',
  'framework. Tests are ordinary `*.test.ts` modules: `tsc -p tsconfig.json`',
  'compiles them into `dist/test/`, and `scripts/run-tests.mjs` collects every',
  'compiled `*.test.js` file (never a browser spec) and forwards extra flags to',
  '`node --test`.',
  '',
  '`createTestApp({ lifecycle: t })` from `jsails/testing` assembles the real',
  'application over the same Hono pipeline `serve` uses, then serves requests',
  'in-process through `app.request(path)`: no HTTP server listens, no broadcast',
  'is attached, and no browser is involved. `lifecycle: t` registers teardown on',
  'the `node:test` context so the app closes automatically when its test ends.',
  'Assert with `response.status`, `response.headers`, and `response.text()` or',
  '`response.json()`; the response body is caller-owned — read it explicitly, it',
  'is never consumed for you.',
  '',
  'The `test/app.test.ts` cases are shared by humans and AI agents: plain,',
  'readable `node:test` examples that document the server behavior both',
  'audiences can extend. `npm run test:report` adds a JUnit XML report at',
  '`test-results/junit.xml` (plus a spec reporter on stdout) for CI;',
  '`test-results/` is git-ignored.',
  '',
  'There is no automatic database rollback, no cookie jar, and no shared',
  'fixture teardown. A configured setup — extensions, a database, Valkey, or',
  'other services — connects exactly what the app config selects, so point each',
  'test at isolated fixtures and seeds it owns. Cookies, sessions, and other',
  'state persist across requests only when the test sets them explicitly.',
  '',
  '## Browser tests',
  '',
  '`npm run test:browser` runs `npm run build && playwright test`. Playwright',
  'starts the exported app on an isolated local server on `127.0.0.1:4173` by',
  'default (override the port with `JSAILS_TEST_PORT`) and never reuses an',
  'existing service, so a `dev` or `serve` process on another port is untouched.',
  'There is no automatic browser download: point `JSAILS_BROWSER_PATH` at an',
  'already-installed Chrome/Chromium executable, or run',
  '`npx playwright install chromium` yourself to download one.',
  '',
  'The JSON report lands in `test-results/results.json` and the HTML report in',
  '`playwright-report/`; screenshots of failures are attached to the failing test',
  'in the JSON report. Set `JSAILS_TRACE=1` to opt in to Playwright traces.',
  '`test-results/` and `playwright-report/` are git-ignored because reports,',
  'screenshots, and traces can embed private UI, console, and network data — keep',
  'them out of version control. Specs use the standard Playwright API with',
  'readable, file-path-oriented tests; no bespoke DSL and no LLM service, and',
  'no global MCP configuration is required.',
  '',
  'Browser UI checks are optional, not part of the default test path: `npm test`',
  'runs only the in-process server suite and never opens a browser, while',
  '`npm run test:browser` additionally exercises clicks and hydration.',
  '',
  '## Project layout and config',
  '',
  '`tsconfig.json`, `tsconfig.client.json`, `vite.config.js`, the client entry',
  '(`client/main.tsx`), and `jsails.app.js` are generated for the default layout.',
  'The server project compiles `pages/`, `components/`, `api/`, `ui/`, `models/`,',
  '`jobs/`, `extensions/`, and `test/`, so pages, server components, API routes,',
  'models, jobs, and extensions are picked up automatically;',
  '`experimentalDecorators` and `emitDecoratorMetadata`',
  'are enabled for TypeORM-style entities. Browser code lives under `client/`',
  'and is compiled separately by `tsconfig.client.json`; `test/browser/` is',
  'excluded from the server project because Playwright compiles those specs with',
  'its own TypeScript loader, and the server emits source maps.',
  '',
  '## Islands and server components',
  '',
  'Islands are explicitly registered in the client entry, never auto-discovered.',
  '`client/main.tsx` registers the `counter` island with `registerIsland(...)` and',
  'then calls `startClient()`. The client runtime owns navigation and the island',
  'lifecycle: it loads Turbo Drive, hydrates every `[data-jsails-island]` element',
  'whose name is registered, tears down and restores islands across navigations,',
  'and wires the `[data-jsails-component]` binding layer for server components.',
  'There is no automatic module discovery (an unregistered island stays inert),',
  'no hot module replacement (reload the browser after a change), and no',
  'authentication system.',
  '',
  '## Server components and actions (the tasks demo)',
  '',
  'The tasks page (`pages/tasks.tsx`) mounts a stateful server component',
  '(`components/task-list.tsx`) through `jsails/server-components`. Its state is',
  'carried in an HMAC-signed snapshot rendered onto the component root, and the',
  '`add` action runs server-side; the browser morphs the re-rendered root back',
  'into place over a same-origin POST guarded by a CSRF token.',
  '',
  'The demo component is intentionally public (`authorize: () => true`) and its',
  'state is transient per component instance: no database, no identity, no',
  'exactly-once guarantee, and snapshot state is PUBLIC (integrity, not',
  'confidentiality) — never put a secret in it, and make real actions idempotent.',
  '',
  '`jsails build` (static export) has no request context, so the task component',
  'renders its read-only `staticFallback` (no state, no signing, no actions) and',
  'the exported pages are linked together as static soft links. A live render',
  'needs a signing key: in development/test the extension mints an ephemeral key,',
  'while a plain `jsails serve` in any other environment (including an unset',
  'NODE_ENV) requires JSAILS_COMPONENT_SECRET (>= 32 bytes) or the live render',
  'fails closed.',
  '',
].join('\n');

/**
 * Auth-variant instructions appended between the base starter instructions and
 * the bundled/override guide, only when the auth variant is generated.
 */
const STARTER_GUIDE_AUTH_PREFIX = [
  '## Authentication (Better Auth)',
  '',
  'This project was generated with the optional auth variant: local',
  'email/password sign-in backed by Better Auth and a SQLite database.',
  '',
  '- Requires Node >= 22 (better-sqlite3 is a native module).',
  "- `npm run auth:migrate` — after `npm run build`, create Better Auth's",
  '  tables in `storage/auth.sqlite`. Better Auth owns its tables.',
  '- `npm run user:create -- <email> <password> [name]` — create the first',
  '  account (name is optional).',
  '- Export `BETTER_AUTH_SECRET` (>= 32 bytes) before serving; Better Auth',
  '  fails without it, and JSails never loads `.env` files.',
  '- This is login-only: registration UI, password reset, email verification,',
  '  and OAuth are deferred.',
  '',
  '## CLI login (browser-approved)',
  '',
  'This project also ships a small user-facing CLI. The `commands/*.ts` modules',
  'compile into `dist/commands/` and are discovered by `jsails`, so end users can',
  'sign in from a terminal through the same device flow the web app uses:',
  '',
  '- `jsails login` — request an OAuth 2.0 Device Authorization Grant (RFC 8628)',
  '  code, print it, and open the browser approval page at `/device`. Approve',
  '  the code there while signed in and the CLI stores the session.',
  '- `jsails whoami` — print the signed-in account (`name <email>`, or the email).',
  '- `jsails logout` — delete the stored CLI session credentials (idempotent).',
  '',
  'Credentials are stored under `~/.config/jsails/<app>/credentials.json`',
  '(honoring `$XDG_CONFIG_HOME`) with mode `0600` in a `0700` directory; the',
  'session token is never printed. The `commands/` tree ships with the app for',
  'end users, while the framework builtins (`jamal`, `makemigrations`,',
  '`migrate`, `dev`, `serve`, `build`, and the rest) are developer commands.',
  '',
].join('\n');

/** Prepend the starter instructions (and auth note, when set) to a guide body. */
function buildGuide(guide: string, auth: boolean): string {
  const prefix = auth
    ? `${STARTER_GUIDE_PREFIX}\n${STARTER_GUIDE_AUTH_PREFIX}`
    : STARTER_GUIDE_PREFIX;
  return `${prefix}\n${guide}`;
}

/**
 * Generate the starter file set. Reads only the bundled templates and, when no
 * override is given, the bundled package version and guide; performs no writes,
 * installs, or subprocesses; and returns a frozen, prototype-free file map.
 * With `options.auth`, the auth-variant templates are added (replacing the base
 * app config) and the package/tsconfig/gitignore/guide gains its auth additions.
 */
export async function createStarterFiles(options: StarterOptions = {}): Promise<StarterFiles> {
  if (!isPlainObject(options)) {
    throw new StarterError('options must be a plain object');
  }

  const name = assertName(options.name ?? DEFAULT_NAME);
  const dependency =
    options.jsailsDependency === undefined
      ? await readPackageVersion()
      : assertDependency(options.jsailsDependency);
  const guide = options.guide === undefined ? await readBundledGuide() : assertGuide(options.guide);
  const auth = options.auth === true;

  const files: Record<string, string> = Object.create(null);
  const addTemplate = async (template: string, outputPath: string): Promise<void> => {
    const text = await readFile(join(PACKAGE_ROOT, 'templates', 'starter', template), 'utf8');
    if (outputPath === 'package.json') {
      files[outputPath] = buildPackageJson(text, name, dependency, auth);
    } else if (outputPath === 'tsconfig.json') {
      files[outputPath] = buildTsconfig(text, auth);
    } else if (outputPath === '.gitignore') {
      files[outputPath] = buildGitignore(text, auth);
    } else {
      files[outputPath] = text;
    }
  };

  for (const template of TEMPLATE_FILES) {
    if (auth && template === BASE_APP_CONFIG_TEMPLATE) {
      continue;
    }
    await addTemplate(template, toOutputPath(template));
  }
  if (auth) {
    for (const template of AUTH_TEMPLATE_FILES) {
      const outputPath =
        template === 'jsails.app.auth.js.template' ? 'jsails.app.js' : toOutputPath(template);
      await addTemplate(template, outputPath);
    }
  }
  files['AGENTS.md'] = buildGuide(guide, auth);

  return Object.freeze({ files: Object.freeze(files) });
}
