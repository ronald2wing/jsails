/**
 * Starter file-map assembly.
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
 * The starter ships three web variants selected by `options.admin`/`options.blog`:
 * the default (`base`) is auth-only (auth + server-components, no admin panel);
 * `admin: true` adds the admin panel; `blog: true` implies admin and adds the
 * first-party blog plugin, the plugin manager in the admin panel, and two blog
 * pages. Only the `jsails.app.js` config and the optional blog pages differ
 * between variants — every other template is shared. `cli: true` is a separate,
 * Laravel-Zero-style CLI-only shape: templates from
 * `templates/starter-cli/` with a real `jsails.app.js` (the same extension
 * seam as the web starter, with `plugins.use: []`), no web surface
 * (`pages/`, `api/`, `public/`, `client/`, auth, admin, blog, or Vite), and
 * a trimmed `tsconfig.json`. `static: true` is a separate static-site (SSG)
 * shape: templates from `templates/starter-static/` with a real
 * `jsails.app.js` (`plugins.use: []`, no marketplace/DB), pages + a Preact
 * island + Vite, and no auth, API, server components, or Jamal. Both `cli` and
 * `static` are mutually exclusive with `admin`/`blog` and with each other.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isPlainObject } from '../../internal/json-safe.js';
import { buildCliGuide, buildGuide, buildStaticGuide } from './guides.js';
import { buildPackageJson, EXTRA_SCRIPTS } from './package-json.js';

/** Absolute path of the package root, resolved from this compiled module. */
const PACKAGE_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

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
   * Include the admin panel (`jsails/admin`) in the generated app config.
   * Defaults to `false`; the base starter is auth-only.
   */
  admin?: boolean;
  /**
   * Include the first-party blog plugin (`jsails/blog`), the plugin manager,
   * and the blog pages. Implies {@link StarterOptions.admin}. Defaults to
   * `false`.
   */
  blog?: boolean;
  /**
   * Generate the CLI-only starter (a Laravel-Zero-style command project with no
   * web surface) instead of the web starter. Defaults to `false`. Mutually
   * exclusive with {@link StarterOptions.admin}, {@link StarterOptions.blog},
   * and {@link StarterOptions.static}.
   */
  cli?: boolean;
  /**
   * Generate the static-site (SSG) starter: pages, a Preact island, and Vite,
   * with no auth, API, server components, or Jamal. Defaults to `false`.
   * Mutually exclusive with {@link StarterOptions.admin},
   * {@link StarterOptions.blog}, and {@link StarterOptions.cli}.
   */
  static?: boolean;
  /**
   * `AGENTS.md` content for the generated project. Defaults to the framework's
   * own bundled guide; when supplied it replaces that guide, with the
   * app-specific starter instructions always prepended.
   */
  guide?: string;
}

/** The generated file set: portable relative path -> file contents. */
export interface StarterFiles {
  readonly files: Readonly<Record<string, string>>;
}

/** Default npm name of the generated project. */
const DEFAULT_NAME = 'jsails-app';

/** The starter variant selected by the `admin`/`blog`/`cli`/`static` option flags. */
type StarterVariant = 'base' | 'admin' | 'blog' | 'cli' | 'static';

/** The web variants that share the `templates/starter/` base and a `jsails.app.js`. */
export type WebStarterVariant = Exclude<StarterVariant, 'cli' | 'static'>;

/**
 * Bundled templates under `templates/starter/`, in deterministic order. Only
 * these paths are ever read; nothing else on disk is touched. The auth,
 * CLI-command, and admin-adjacent templates are folded into this whitelist —
 * the starter always ships them regardless of variant.
 */
const BASE_TEMPLATE_FILES: readonly string[] = [
  // Project-local base modules: thin re-exports of the framework surface so
  // application code imports from `./app/*` instead of a `jsails*` entry.
  'app/application-auth.ts.template',
  'app/application-client.ts.template',
  'app/application-command.ts.template',
  'app/application-component.ts.template',
  'app/application-job.ts.template',
  'app/application-plugin.ts.template',
  'app/application-record.ts.template',
  'app/application-resource.ts.template',
  'app/application-testing.ts.template',
  'app/registry.ts.template',
  'client/main.tsx',
  'components/task-list.tsx',
  '.env.auth.example.template',
  '.gitignore.template',
  'jamal.config.js.template',
  'api/me.ts.template',
  'auth/README.md.template',
  'commands/login.ts.template',
  'commands/logout.ts.template',
  'commands/whoami.ts.template',
  'package.json.template',
  'pages/about.tsx',
  'pages/dashboard.tsx.template',
  'pages/device.tsx.template',
  'pages/index.tsx',
  'pages/login.tsx.template',
  'pages/tasks.tsx',
  'playwright.config.ts.template',
  'scripts/auth-migrate.mjs.template',
  'scripts/create-user.mjs.template',
  'scripts/db-migrate.mjs.template',
  'scripts/run-tests.mjs.template',
  'test/app.test.ts.template',
  'test/auth.test.ts.template',
  'test/browser/auth.spec.ts.template',
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
 * Bundled templates under `templates/starter-cli/`, in deterministic order. The
 * CLI-only shape now ships a real `jsails.app.js` (the same extension seam as
 * the web starter, with `plugins.use: []`) plus the `defineCommand` shim and
 * one sample command — no web surface. `AGENTS.md` is generated (never read from
 * disk) like the web shape. The app config is kept separate in
 * {@link CLI_APP_CONFIG_TEMPLATE} so its type stays narrow. Only these paths
 * (plus the app config template) are ever read.
 */
const CLI_TEMPLATE_FILES: readonly string[] = [
  '.gitignore.template',
  'app/application-command.ts.template',
  'commands/hello.ts.template',
  'package.json.template',
  'tsconfig.json.template',
];

/**
 * Bundled templates under `templates/starter-static/`, in deterministic order.
 * The static-site (SSG) shape ships pages, a Preact island, and Vite, with no
 * auth, API, server components, or Jamal. `AGENTS.md` is generated (never read
 * from disk) like the other shapes. The app config is kept separate in
 * {@link STATIC_APP_CONFIG_TEMPLATE} so its type stays narrow. Only these paths
 * (plus the app config template) are ever read.
 */
const STATIC_TEMPLATE_FILES: readonly string[] = [
  '.gitignore.template',
  'app/application-client.ts.template',
  'client/main.tsx',
  'package.json.template',
  'pages/about.tsx',
  'pages/index.tsx',
  'tsconfig.client.json.template',
  'tsconfig.json.template',
  'ui/components.tsx',
  'ui/counter.tsx',
  'ui/layout.tsx',
  'ui/styles.css',
  'vite.config.js.template',
];

/**
 * The per-variant app config template. The `base` config is auth-only, `admin`
 * adds the admin panel, and `blog` adds the blog plugin, the plugin manager,
 * and the admin CRUD resource. Every variant is written to the same output path
 * (`jsails.app.js`), so the template name is decoupled from the output name.
 * The `cli` shape uses {@link CLI_APP_CONFIG_TEMPLATE}.
 */
const APP_CONFIG_TEMPLATES: Readonly<Record<WebStarterVariant, string>> = {
  base: 'jsails.app.js.template',
  admin: 'jsails.app.admin.js.template',
  blog: 'jsails.app.blog.js.template',
};

/**
 * The CLI-only app config template. The `cli` shape ships a real
 * `jsails.app.js` (the same framework + extension seam as the web starter)
 * with `plugins.use: []` and no web surface, so it is kept separate from
 * the web `APP_CONFIG_TEMPLATES` record rather than widening that type.
 */
const CLI_APP_CONFIG_TEMPLATE = 'jsails.app.js.template';

/**
 * The static-site app config template. The `static` shape ships a real
 * `jsails.app.js` (the same framework + extension seam as the web starter)
 * with `plugins.use: []` and no marketplace/DB block, so it is kept separate
 * from the web `APP_CONFIG_TEMPLATES` record rather than widening that type.
 */
const STATIC_APP_CONFIG_TEMPLATE = 'jsails.app.js.template';

/**
 * The per-variant migration/data-source config template. Every variant writes
 * to the same output path (`jsails.config.js`) consumed by `makemigrations` /
 * `migrate` / `showmigrations`; the `blog` variant adds the blog post entities.
 */
const MIGRATION_CONFIG_TEMPLATES: Readonly<Record<WebStarterVariant, string>> = {
  base: 'jsails.config.js.template',
  admin: 'jsails.config.js.template',
  blog: 'jsails.config.blog.js.template',
};

/** Blog pages shipped only by the `blog` variant. */
const BLOG_TEMPLATE_FILES: readonly string[] = ['pages/blog/index.tsx', 'pages/blog/[slug].tsx'];

/** Resolve the variant from the option flags; `blog` implies `admin`, `cli`/`static` are standalone. */
function resolveVariant(options: {
  admin?: boolean;
  blog?: boolean;
  cli?: boolean;
  static?: boolean;
}): StarterVariant {
  if (options.cli === true) {
    return 'cli';
  }
  if (options.static === true) {
    return 'static';
  }
  if (options.blog === true) {
    return 'blog';
  }
  if (options.admin === true) {
    return 'admin';
  }
  return 'base';
}

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

/** Validate an `admin`/`blog` flag as a boolean (or undefined). */
function assertFlag(value: unknown, label: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'boolean') {
    throw new StarterError(`options.${label} must be a boolean`);
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
 * Rewrite the gitignore template: un-ignore the committed `.env.auth.example`
 * (the template's `.env.*` rule would ignore it).
 */
function buildGitignore(template: string): string {
  return `${template}!.env.auth.example\n`;
}

/**
 * Generate the starter file set. Reads only the bundled templates and, when no
 * override is given, the bundled package version and guide; performs no writes,
 * installs, or subprocesses; and returns a frozen, prototype-free file map.
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
  const admin = assertFlag(options.admin, 'admin');
  const blog = assertFlag(options.blog, 'blog');
  const cli = assertFlag(options.cli, 'cli');
  const staticSite = assertFlag(options.static, 'static');
  if (cli === true && (admin === true || blog === true || staticSite === true)) {
    throw new StarterError(
      'options.cli cannot be combined with options.admin, options.blog, or options.static',
    );
  }
  if (staticSite === true && (admin === true || blog === true)) {
    throw new StarterError('options.static cannot be combined with options.admin or options.blog');
  }
  const variant = resolveVariant({ admin, blog, cli, static: staticSite });
  const guide = options.guide === undefined ? await readBundledGuide() : assertGuide(options.guide);

  const files: Record<string, string> = Object.create(null);
  const addTemplate = async (
    template: string,
    outputPath: string,
    baseDir: 'starter' | 'starter-cli' | 'starter-static',
  ): Promise<void> => {
    const text = await readFile(join(PACKAGE_ROOT, 'templates', baseDir, template), 'utf8');
    if (outputPath === 'package.json') {
      files[outputPath] = buildPackageJson(
        text,
        name,
        dependency,
        baseDir === 'starter' ? EXTRA_SCRIPTS : {},
      );
    } else if (outputPath === '.gitignore' && baseDir === 'starter') {
      files[outputPath] = buildGitignore(text);
    } else {
      files[outputPath] = text;
    }
  };

  if (variant === 'cli') {
    for (const template of CLI_TEMPLATE_FILES) {
      await addTemplate(template, toOutputPath(template), 'starter-cli');
    }
    await addTemplate(CLI_APP_CONFIG_TEMPLATE, 'jsails.app.js', 'starter-cli');
    files['AGENTS.md'] = buildCliGuide(guide);
    return Object.freeze({ files: Object.freeze(files) });
  }

  if (variant === 'static') {
    for (const template of STATIC_TEMPLATE_FILES) {
      await addTemplate(template, toOutputPath(template), 'starter-static');
    }
    await addTemplate(STATIC_APP_CONFIG_TEMPLATE, 'jsails.app.js', 'starter-static');
    files['AGENTS.md'] = buildStaticGuide(guide);
    return Object.freeze({ files: Object.freeze(files) });
  }

  for (const template of BASE_TEMPLATE_FILES) {
    await addTemplate(template, toOutputPath(template), 'starter');
  }
  // Every variant writes its app config to the same output path.
  await addTemplate(APP_CONFIG_TEMPLATES[variant], 'jsails.app.js', 'starter');
  // Every variant writes its migration/data-source config to the same path too.
  await addTemplate(MIGRATION_CONFIG_TEMPLATES[variant], 'jsails.config.js', 'starter');
  if (variant === 'blog') {
    for (const template of BLOG_TEMPLATE_FILES) {
      await addTemplate(template, toOutputPath(template), 'starter');
    }
  }
  files['AGENTS.md'] = buildGuide(guide, variant);

  return Object.freeze({ files: Object.freeze(files) });
}
