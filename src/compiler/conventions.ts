/**
 * The single source of truth for JSails authoring conventions.
 *
 * Every place that maps a symbol name to a file, or a file back to a symbol,
 * reads its rules here: the `make:*` generators, the autoload scan, model
 * resolution, and client-component resolution. When a convention lived in four
 * modules it drifted — a `make:model` file landed in a different directory than
 * the resolver looked, a naming helper disagreed with another on acronym runs.
 * One table removes that class of bug.
 *
 * Two concerns live here, deliberately together because they describe the same
 * authoring surface:
 *
 * - **Naming** — how a name splits into words and rejoins as Pascal/camel/kebab/
 *   snake case. The splitter is acronym-aware (`HTMLParser` → `HTML Parser`,
 *   not `htmlparser`), because a name like `OAuthToken` or `apiURL` is a real
 *   authoring input, not a pathological case.
 * - **Layout** — which directory and extension each artifact kind uses, and
 *   which N1 trees the autoload scan covers.
 *
 * Pure and inert: importing this module walks no directories and opens no
 * connection. The one filesystem read is {@link probeConventionFile}, called
 * explicitly by the resolvers.
 */

import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';

/* ------------------------------------------------------------------ */
/*  Injection context                                                  */
/* ------------------------------------------------------------------ */

/** Injection context: `'app'` is client+server; `'server'` is server-only. */
export type AutoloadContext = 'app' | 'server';

/* ------------------------------------------------------------------ */
/*  Naming                                                             */
/* ------------------------------------------------------------------ */

/**
 * Split a name into words across camelCase boundaries, acronym runs, kebab-,
 * and snake_case separators.
 *
 * `BlogPost` → `['Blog', 'Post']`; `HTMLParser` → `['HTML', 'Parser']`;
 * `getHTMLId` → `['get', 'HTML', 'Id']`; `blog-post`/`blog_post` →
 * `['blog', 'post']`.
 */
export function toWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 0);
}

/** Capitalize a word, lowercasing the remainder (`HTML` → `Html`). */
function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

/** PascalCase (`blog-post` → `BlogPost`). */
export function pascalCase(name: string): string {
  return toWords(name).map(capitalize).join('');
}

/** camelCase (`task-list` → `taskList`). */
export function camelCase(name: string): string {
  const words = toWords(name);
  const first = (words[0] ?? '').toLowerCase();
  const rest = words.slice(1).map(capitalize);
  return first + rest.join('');
}

/** kebab-case (`BlogPost` → `blog-post`). */
export function kebabCase(name: string): string {
  return toWords(name)
    .map((word) => word.toLowerCase())
    .join('-');
}

/** snake_case (`BlogPost` → `blog_post`). */
export function snakeCase(name: string): string {
  return toWords(name)
    .map((word) => word.toLowerCase())
    .join('_');
}

/** The PascalCase class name derived from a file path (`models/blog-post.ts` → `BlogPost`). */
export function classNameFromFile(fileName: string): string {
  const base = basename(fileName).replace(/\.(ts|tsx|mts|mtsx|js|jsx)$/, '');
  return pascalCase(base);
}

/* ------------------------------------------------------------------ */
/*  Layout                                                             */
/* ------------------------------------------------------------------ */

/** Conventional artifact directories, as root-relative posix paths. */
export const CONVENTION_DIRS = {
  pages: 'pages',
  api: 'api',
  jobs: 'jobs',
  models: 'models',
  commands: 'commands',
  serverComponents: 'components',
  clientComponents: 'app/components',
  serializers: 'serializers',
  middleware: 'middleware',
  content: 'content',
  blogContent: 'content/blog',
  docsContent: 'content/docs',
} as const;

/** The `make:*` generator types, in help order. */
export const MAKE_COMMAND_TYPES = [
  'page',
  'api',
  'job',
  'model',
  'command',
  'server-component',
  'serializer',
  'middleware',
  'content',
  'post',
  'doc',
] as const;

/** A supported `make:*` generator type. */
export type MakeCommandType = (typeof MAKE_COMMAND_TYPES)[number];

/** A generator's conventional output directory and file extension. */
export interface GeneratorLayout {
  readonly dir: string;
  readonly extension: string;
}

/** Conventional output directory and file extension for each generator type. */
export const GENERATOR_LAYOUT: Readonly<Record<MakeCommandType, GeneratorLayout>> = {
  page: { dir: CONVENTION_DIRS.pages, extension: '.tsx' },
  api: { dir: CONVENTION_DIRS.api, extension: '.ts' },
  job: { dir: CONVENTION_DIRS.jobs, extension: '.ts' },
  model: { dir: CONVENTION_DIRS.models, extension: '.ts' },
  command: { dir: CONVENTION_DIRS.commands, extension: '.ts' },
  'server-component': { dir: CONVENTION_DIRS.serverComponents, extension: '.tsx' },
  serializer: { dir: CONVENTION_DIRS.serializers, extension: '.ts' },
  middleware: { dir: CONVENTION_DIRS.middleware, extension: '.ts' },
  content: { dir: CONVENTION_DIRS.content, extension: '.md' },
  post: { dir: CONVENTION_DIRS.blogContent, extension: '.md' },
  doc: { dir: CONVENTION_DIRS.docsContent, extension: '.md' },
};

/** Source extensions accepted as modules by the autoload scan. */
export const SOURCE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.mtsx',
  '.js',
  '.jsx',
  '.mjs',
]);

/** Extensions probed for a model module, in order. */
export const MODEL_EXTENSIONS = ['.ts', '.mts', '.tsx', '.mtsx', '.js', '.jsx'] as const;

/** Extensions probed for a client (SFC-dialect) component module, in order. */
export const CLIENT_COMPONENT_EXTENSIONS = ['.tsx', '.ts', '.mtsx', '.mts', '.jsx', '.js'] as const;

/* ------------------------------------------------------------------ */
/*  Autoload scope                                                     */
/* ------------------------------------------------------------------ */

/**
 * N1 directories that define the autoload scan scope. Each entry is
 * `[dirname, context]`. `shared/` maps to `'app'` because its modules are
 * accessible from both client and server.
 *
 * The server-only trees (`models/`, `jobs/`, `commands/`, `extensions/`,
 * `components/`) are scanned so their symbols become autoloadable; `ui/` is
 * shared between the server and client tsconfigs, so it maps to `'app'`.
 * `pages/` and `api/` are deliberately absent: every page exports
 * `metadata`/`load`/`default` and every API module exports HTTP method names,
 * so including them would only manufacture same-context duplicate-symbol
 * errors without contributing an injectable symbol.
 */
export const N1_DIRECTORIES: readonly (readonly [string, AutoloadContext])[] = [
  ['app', 'app'],
  ['server', 'server'],
  ['shared', 'app'],
  ['models', 'server'],
  ['ui', 'app'],
  ['jobs', 'server'],
  ['commands', 'server'],
  ['extensions', 'server'],
  ['components', 'server'],
];

/**
 * Subdirectories whose modules are auto-imported (contribute `symbols`).
 * Checked by prefix match: `app/utils/helpers/foo.js` matches `app/utils`.
 *
 * A whole-tree entry (`models/`) makes every module under it autoloadable; the
 * server-only trees are whole-tree because a model, job, command, extension,
 * server component, or server config module is a top-level artifact, not a
 * helper nested in a utils dir. `shared/` and `server/` are whole-tree for the
 * same reason: a shared site config or a server-only content config sits at the
 * root of its tree, so a nested-only prefix would not reach it.
 */
export const AUTOLOADABLE_PREFIXES: ReadonlySet<string> = new Set([
  'app/composables/',
  'app/utils/',
  'server/',
  'shared/',
  'models/',
  'ui/',
  'jobs/',
  'commands/',
  'extensions/',
  'components/',
]);

/* ------------------------------------------------------------------ */
/*  Resolution                                                         */
/* ------------------------------------------------------------------ */

/**
 * Find the first existing file for a kebab-case base name in `dir`, probing
 * `extensions` in order. Returns `undefined` when no candidate exists.
 *
 * The existence check reads the filesystem; nothing is imported.
 */
export function probeConventionFile(
  dir: string,
  baseName: string,
  extensions: readonly string[],
): string | undefined {
  for (const extension of extensions) {
    const candidate = join(dir, baseName + extension);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}
