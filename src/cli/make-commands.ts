/**
 * The `make:*` generators: scaffold a single conventional file for one
 * component of a JSails app — a page, an API route, a job, a model, or a CLI
 * command. Each generator writes exactly one file into the conventional
 * directory (`pages/`, `api/`, `jobs/`, `models/`, `commands/`) using
 * exclusive creation, so an existing file is never overwritten.
 *
 * ```sh
 * jsails make:page about-us            # pages/about-us.tsx
 * jsails make:model blog-post          # models/blog-post.ts
 * jsails make:job send-reminder        # jobs/send-reminder.ts
 * jsails make:command report           # commands/report.ts
 * jsails make:api health --dir src     # src/api/health.ts
 * jsails make:content blog hello-world # content/blog/hello-world.md
 * jsails make:post hello-world         # content/blog/hello-world.md
 * jsails make:doc architecture         # content/docs/architecture.md
 * ```
 *
 * Names must match `[A-Za-z][A-Za-z0-9_-]*`; the case is normalized (a
 * `blog-post` or `BlogPost` input both yield `pages/blog-post.tsx` with a
 * `BlogPostPage` component). The generated files follow the starter's own
 * conventions (imports through `app/*` shims and `ui/layout.js`), so they
 * compile against a fresh scaffold. The command performs no writes beyond the
 * single generated file and never imports application code.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import {
  GENERATOR_LAYOUT,
  MAKE_COMMAND_TYPES,
  camelCase,
  kebabCase,
  pascalCase,
  snakeCase,
  toWords,
  type MakeCommandType,
} from '../compiler/conventions.js';
import { isErrno } from '../internal/errors.js';

/** Raised for an invalid subcommand, name, or an existing target file. */
export class MakeCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MakeCommandError';
  }
}

/** Whether a token after `make:` names a supported generator. */
export function isMakeCommandType(value: string): value is MakeCommandType {
  return (MAKE_COMMAND_TYPES as readonly string[]).includes(value);
}

/** A name must be a leading letter followed by letters, digits, `_` or `-`. */
const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;

/** Title-case a name for a human-facing label (`blog-post` → `Blog Post`). */
function toTitleCase(name: string): string {
  return toWords(name)
    .map((word) => word[0]!.toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

/** Today's local date as `YYYY-MM-DD` — the content layer's `date` field format. */
function todayIsoDate(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

/** Render the one-line `jsails make:<type> --help` summary. */
function makeHelp(type: MakeCommandType): string {
  if (type === 'content') {
    return `content - generate a content entry\n\nUsage:\n  jsails make:content <collection> <name> [--dir <path>]\n`;
  }
  if (type === 'post') {
    return `post - generate a blog post (content/blog/<name>.md)\n\nUsage:\n  jsails make:post <name> [--dir <path>]\n`;
  }
  if (type === 'doc') {
    return `doc - generate a docs page (content/docs/<name>.md)\n\nUsage:\n  jsails make:doc <name> [--dir <path>]\n`;
  }
  if (type === 'server-component') {
    return `server-component - generate a server component\n\nUsage:\n  jsails make:server-component <name> [--dir <path>] [--mfc]\n`;
  }
  return `${type} - generate a ${type} file\n\nUsage:\n  jsails make:${type} <name> [--dir <path>]\n`;
}

export const GLOBAL_MAKE_HELP = `make - generate a single conventional file

Usage:
  jsails make:page <name>    Generate pages/<name>.tsx
  jsails make:api <name>     Generate api/<name>.ts
  jsails make:job <name>     Generate jobs/<name>.ts
  jsails make:model <name>   Generate models/<name>.ts
  jsails make:command <name>            Generate commands/<name>.ts
  jsails make:server-component <name>   Generate components/<name>.tsx [--mfc]
  jsails make:serializer <name>         Generate serializers/<name>.ts
  jsails make:middleware <name>         Generate middleware/<name>.ts
  jsails make:content <collection> <name>  Generate content/<collection>/<name>.md
  jsails make:post <name>               Generate content/blog/<name>.md
  jsails make:doc <name>                Generate content/docs/<name>.md

Options:
  --dir <path>    Base directory (default: the current working directory)
  --mfc           Generate a multi-file component directory (server-component only)
  -h, --help      Show this help
`;

/** The page template: a plain page through the shared document shell. */
function pageTemplate(name: string): string {
  const pascal = pascalCase(name);
  const title = toTitleCase(name);
  return `/**
 * ${title} page.
 *
 * A plain page rendered through the shared document shell. It has no island and
 * no backend action; async props belong in \`load\`. Navigation is owned by the
 * browser client, so links stay ordinary \`<a href>\` elements.
 */

import type { RequestContext } from 'jsails';

import { Layout, loadLayout, type LayoutAssets } from '../ui/layout.js';

export interface ${pascal}PageProps {
  /** Resolved asset URLs, produced in \`load\` and forwarded to the layout. */
  assets?: LayoutAssets;
}

export async function load(context: RequestContext): Promise<${pascal}PageProps> {
  return { assets: await loadLayout(context) };
}

export default function ${pascal}Page({ assets }: ${pascal}PageProps) {
  return (
    <Layout title="${title} — JSails Starter" assets={assets}>
      <header class="text-center">
        <h1 class="text-4xl font-bold tracking-tight">${title}</h1>
      </header>
    </Layout>
  );
}
`;
}

/** The API route template: a read-only GET endpoint. */
function apiTemplate(name: string): string {
  const kebab = kebabCase(name);
  return `/**
 * ${kebab} API route.
 *
 * A read-only \`${kebab}\` endpoint mounted at \`/api/${kebab}\`. Handlers
 * receive the Hono \`Request\` plus a \`RequestContext\` (session, storage
 * path, asset URLs). Filesystem API routes run through the global default-deny
 * \`authorize\`, so add one in \`jsails.app.js\` to make this reachable.
 */

import type { RequestContext } from 'jsails';

export function GET(_request: Request, _context: RequestContext): Response {
  return Response.json({ ok: true });
}
`;
}

/** The job template: a Zod-validated job definition. */
function jobTemplate(name: string): string {
  const camel = camelCase(name);
  const kebab = kebabCase(name);
  return `/**
 * ${pascalCase(name)} job.
 *
 * Register this job in \`app/registry.js\` under \`jobs\` (keyed by name) and
 * dispatch it from the runtime. The Zod schema validates the payload on both
 * the dispatch and the worker side, so the handler's \`data\` is already typed
 * and safe.
 */

import { z } from 'zod';

import { defineJob } from '../app/application-job.js';

export const ${camel}Job = defineJob(
  z.object({}),
  async () => {
    // Define the work here; \`${kebab}\` has passed the schema above.
  },
);
`;
}

/** The model template: a JSails model that declares only its shape. */
function modelTemplate(name: string): string {
  const pascal = pascalCase(name);
  const table = snakeCase(pascal);
  return `/**
 * ${pascal} model.
 *
 * A JSails model declares only the shape of its data; the compiler derives the
 * table (\`${table}\`), columns, foreign keys, and migrations from the class. No
 * TypeORM import, no decorators, no subscriber wiring — add a field and run
 * \`jsails db:push\` to create the table.
 *
 * Customize a field with an inline \`@jsails.*\` decorator when inference cannot
 * know the intent, e.g. \`@jsails.maxLength(200)\`, \`@jsails.unique()\`,
 * \`@jsails.nullable()\`, \`@jsails.encrypts()\`, or a relation behaviour such as
 * \`@jsails.belongsTo(Author, { touch: true })\`.
 */

import { ApplicationRecord } from '../app/application-record.js';

export class ${pascal} extends ApplicationRecord {
  declare name: string;
}
`;
}

/** The command template: a Laravel-Zero-style CLI command. */
function commandTemplate(name: string): string {
  const kebab = kebabCase(name);
  return `/**
 * \`jsails ${kebab}\` command.
 *
 * A user-facing command. Arguments and options are declared in the signature
 * (e.g. \`{name?}\` for an optional argument); \`input\` carries the parsed
 * values and \`ctx\` the output streams and prompter.
 */

import { defineCommand } from '../app/application-command.js';

export default defineCommand({
  signature: '${kebab}',
  summary: '${kebab} command',
  audience: 'user',
  run(_input, ctx) {
    ctx.stdout('${kebab} command');
    return 0;
  },
});
`;
}

/** The server-component template: a minimal stateful component. */
function serverComponentTemplate(name: string): string {
  const pascal = pascalCase(name);
  const kebab = kebabCase(name);
  return `/**
 * ${pascal} server component.
 *
 * A stateful, signed server component authored with the friendly
 * \`defineComponent\` surface. Register it in \`jsails.app.js\` through the
 * \`serverComponentsPlugin\` extension and render it from a page's \`load\` with
 * \`renderServerComponent('${kebab}', context)\`.
 *
 * State is integrity-protected (not encrypted) and carried in a signed snapshot;
 * never place credentials in component state. Add \`writableKeys\` and an
 * \`authorize\` callback before serving. \`actions\` are split by capability: a
 * \`serverAction\` round-trips through the snapshot (authorize + CSRF + schema
 * validation), while a \`localAction\` would be pure and client-runnable.
 */
import { z } from 'zod';

import { defineComponent, serverAction } from 'jsails/server-components';

const stateSchema = z
  .object({
    title: z.string().max(120),
    saved: z.array(z.string().max(120)).max(50),
  })
  .strict();

type ${pascal}State = z.infer<typeof stateSchema>;

export const ${camelCase(name)} = defineComponent<${pascal}State>({
  name: '${kebab}',
  stateSchema,
  writableKeys: ['title'],
  initialState() {
    return { title: '', saved: [] };
  },
  authorize() {
    return true;
  },
  actions: {
    save: serverAction({
      input: z.object({}),
      run(state) {
        const title = state.title.trim();
        if (title === '') {
          return;
        }
        state.saved.push(title);
        state.title = '';
      },
    }),
  },
  derived: {
    count: (state) => state.saved.length,
  },
  render(state, { bind, submit, derived }) {
    const count = derived('count') as number;
    return (
      <div>
        <form {...submit('save')}>
          <input type="text" maxLength={120} {...bind('title')} />
          <button type="submit">Save</button>
        </form>
        <p>Current value: {state.title}</p>
        <p>{count} saved</p>
      </div>
    );
  },
  staticFallback() {
    return <p>The ${kebab} component is not available in the static export.</p>;
  },
});
`;
}

/** The serializer template: a field map for API resource serialisation. */
function serializerTemplate(name: string): string {
  const camel = camelCase(name);
  const pascal = pascalCase(name);
  return `/**
 * ${pascal} serializer.
 *
 * A typed field map consumed by \`createResourceHandlers\` (or any call-site
 * that needs a uniform JSON shape). Import it from \`jsails/api\` and pass it
 * to a resource or a manual \`toRepresentation\` / \`validate\` call.
 *
 * Fields declared as bare schemas are read+write; wrap in
 * \`{ schema, readOnly?, writeOnly? }\` to restrict direction.
 */
import { defineSerializer, string } from 'jsails/api';

export const ${camel}Serializer = defineSerializer({
  name: string({ min: 1 }),
});
`;
}

/** The middleware template: a Hono request-chain handler. */
function middlewareTemplate(name: string): string {
  const camel = camelCase(name);
  return `/**
 * ${pascalCase(name)} middleware.
 *
 * A per-route middleware handler applied before the terminal page or API
 * handler. Register it in \`jsails.app.js\` under \`middleware\` (keyed by
 * name), then reference it by name in a route module's exported \`middleware\`
 * array (or list it in \`globalMiddleware\`). The handler receives a Hono
 * \`Context\` typed to the JSails app env and a \`next\` continuation; call
 * \`next()\` to proceed down the chain (or short-circuit by returning a
 * \`Response\`). Read per-request values set by the pipeline via \`c.var\`.
 */
import type { RouteMiddleware } from 'jsails';

export const ${camel}: RouteMiddleware = async (c, next) => {
  // Inspect \`c.req\`/\`c.var.session\`, then forward or reply.
  return next();
};
`;
}

/**
 * The content template: a markdown entry with YAML frontmatter. The title is
 * derived from the name and the date is today, so a freshly generated entry is
 * immediately discoverable by the content layer (which requires `title` and
 * accepts `tags`/`date`).
 */
function contentTemplate(name: string): string {
  const title = toTitleCase(name);
  return `---
title: ${title}
date: ${todayIsoDate()}
tags: []
---

Start writing here.
`;
}

/** The server-component MFC directory: four files in <name>/ matching the C3 split shape. */
function serverComponentMfcTemplate(name: string): Record<string, string> {
  const pascal = pascalCase(name);
  const kebab = kebabCase(name);
  const camel = camelCase(name);

  const modelTs = `/**
 * ${pascal} state schema.
 *
 * The single source of truth for persisted state, plus the inferred type and the
 * initial-state factory. This module is imported by the entry and the server
 * part; it stays importable from either without pulling in Preact or the
 * component definition.
 */

import { z } from 'zod';

export const stateSchema = z
  .object({
    title: z.string().max(120),
    saved: z.array(z.string().max(120)).max(50),
  })
  .strict();

export type ${pascal}State = z.infer<typeof stateSchema>;

export function initialState(): ${pascal}State {
  return { title: '', saved: [] };
}
`;

  const styleTs = `/**
 * ${pascal} style contract.
 *
 * Named-slot class strings consumed by the entry's \`render\`. Keeping them
 * separate makes the view and the tokens independent: the view asks for a slot,
 * never a raw class literal.
 */

import { defineStyle } from 'jsails/server-components';

export const style = defineStyle({
  card: 'card w-full bg-base-100 shadow-xl',
  body: 'card-body',
  title: 'card-title',
  form: 'flex w-full items-start gap-2',
  input: 'input input-bordered w-full',
  submit: 'btn btn-primary',
  empty: 'text-base-content/60',
  item: 'list-row',
  count: 'text-sm text-base-content/60',
});
`;

  const serverFunctionName = `load${pascal}`;
  const serverTs = `/**
 * Server-only functions for ${pascal}.
 *
 * Every exported function here is marked with \`'use server'\`. The framework
 * build transform strips these bodies from the client bundle, so server-only
 * imports (database, session, crypto) are never shipped to the browser.
 */

import type { ${pascal}State } from './${kebab}.model.js';

export async function ${serverFunctionName}(_state: ${pascal}State): Promise<string[]> {
  'use server';
  // Server-only logic: database queries, file I/O, session reads.
  return [];
}
`;

  const entryTsx = `/**
 * ${pascal} server component.
 *
 * A stateful, signed server component authored with the friendly
 * \`defineComponent\` surface. Register it in \`jsails.app.js\` through the
 * \`serverComponentsPlugin\` extension and render it from a page's \`load\` with
 * \`renderServerComponent('${kebab}', context)\`.
 *
 * State is integrity-protected (not encrypted) and carried in a signed snapshot;
 * never place credentials in component state. Add \`writableKeys\` and an
 * \`authorize\` callback before serving. \`actions\` are split by capability: a
 * \`serverAction\` round-trips through the snapshot (authorize + CSRF + schema
 * validation), while a \`localAction\` would be pure and client-runnable.
 */
import { z } from 'zod';

import { defineComponent, serverAction } from 'jsails/server-components';

import { initialState, stateSchema } from './${kebab}.model.js';
import type { ${pascal}State } from './${kebab}.model.js';
import { style } from './${kebab}.style.js';
export * from './${kebab}.server.js';

export const ${camel} = defineComponent<${pascal}State>({
  name: '${kebab}',
  stateSchema,
  style,
  writableKeys: ['title'],
  initialState,
  authorize() {
    return true;
  },
  actions: {
    save: serverAction({
      input: z.object({}),
      run(state) {
        const title = state.title.trim();
        if (title === '') {
          return;
        }
        state.saved.push(title);
        state.title = '';
      },
    }),
  },
  derived: {
    count: (state) => state.saved.length,
  },
  render(state, { bind, submit, derived }) {
    const count = derived('count') as number;
    return (
      <div class={style.slot('card')}>
        <div class={style.slot('body')}>
          <h2 class={style.slot('title')}>${pascal}</h2>
          <form class={style.slot('form')} {...submit('save')}>
            <input
              type="text"
              class={style.slot('input')}
              maxLength={120}
              {...bind('title')}
            />
            <button type="submit" class={style.slot('submit')}>
              Save
            </button>
          </form>
          <p class={style.slot('count')}>{count} saved</p>
        </div>
      </div>
    );
  },
  staticFallback() {
    return <p>The ${kebab} component is not available in the static export.</p>;
  },
});
`;

  return {
    [`${kebab}.tsx`]: entryTsx,
    [`${kebab}.model.ts`]: modelTs,
    [`${kebab}.style.ts`]: styleTs,
    [`${kebab}.server.ts`]: serverTs,
  };
}

/** Build the generated file body for a type and name. */
function renderTemplate(type: MakeCommandType, name: string): string {
  switch (type) {
    case 'page':
      return pageTemplate(name);
    case 'api':
      return apiTemplate(name);
    case 'job':
      return jobTemplate(name);
    case 'model':
      return modelTemplate(name);
    case 'command':
      return commandTemplate(name);
    case 'server-component':
      return serverComponentTemplate(name);
    case 'serializer':
      return serializerTemplate(name);
    case 'middleware':
      return middlewareTemplate(name);
    case 'content':
    case 'post':
    case 'doc':
      return contentTemplate(name);
  }
}

/** Parse the tokens after `make:<type>` into a name and a base directory. */
interface MakeInvocation {
  readonly name: string;
  /** The content collection, present only for `make:content`. */
  readonly collection: string | undefined;
  readonly baseDir: string;
  /** Generate a multi-file component directory. Server-component only. */
  readonly mfc: boolean;
}

/** Parse the raw tokens: a name, an optional content collection, and one `--dir`. */
function parseMakeArgs(type: MakeCommandType, args: readonly string[]): MakeInvocation | number {
  let collection: string | undefined;
  let name: string | undefined;
  let baseDir: string | undefined;
  let mfc = false;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index] as string;
    if (token === '--dir') {
      const value = args[index + 1];
      if (value === undefined || value === '') {
        return usageError(type, '--dir requires a directory');
      }
      if (baseDir !== undefined) {
        return usageError(type, '--dir specified more than once');
      }
      baseDir = value;
      index += 1;
      continue;
    }
    if (token.startsWith('--dir=')) {
      const value = token.slice('--dir='.length);
      if (value === '') {
        return usageError(type, '--dir requires a directory');
      }
      if (baseDir !== undefined) {
        return usageError(type, '--dir specified more than once');
      }
      baseDir = value;
      continue;
    }
    if (token === '--mfc') {
      if (type !== 'server-component') {
        return usageError(type, '--mfc is only valid for make:server-component');
      }
      mfc = true;
      continue;
    }
    if (token.startsWith('-')) {
      return usageError(type, `unknown option ${JSON.stringify(token)}`);
    }
    // `make:content` takes a collection before the name; every other type has
    // only a name, so the collection slot is skipped.
    if (type === 'content' && collection === undefined) {
      collection = token;
      continue;
    }
    if (name !== undefined) {
      return usageError(type, `unexpected argument ${JSON.stringify(token)}`);
    }
    name = token;
  }

  if (type === 'content' && collection === undefined) {
    return usageError(type, `make:content requires a collection and a name`);
  }
  if (name === undefined) {
    return usageError(type, `make:${type} requires a name`);
  }
  if (!NAME_PATTERN.test(name)) {
    return usageError(
      type,
      `invalid name ${JSON.stringify(name)}; names must match [A-Za-z][A-Za-z0-9_-]*`,
    );
  }
  if (collection !== undefined && !NAME_PATTERN.test(collection)) {
    return usageError(
      type,
      `invalid collection ${JSON.stringify(collection)}; collections must match [A-Za-z][A-Za-z0-9_-]*`,
    );
  }
  return { name, collection, baseDir: baseDir ?? '.', mfc };
}

function usageError(type: MakeCommandType, message: string): number {
  console.error(`jsails make:${type}: ${message}`);
  console.error(`Run "jsails make:${type} --help" for usage.`);
  return 2;
}

/** Write `content` to `path`, refusing to overwrite an existing file. */
export async function writeFileExclusive(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, content, { flag: 'wx' });
  } catch (error) {
    if (isErrno(error, 'EEXIST')) {
      throw new MakeCommandError(`refusing to overwrite existing file ${JSON.stringify(path)}`);
    }
    throw error;
  }
}

/**
 * Dispatch a `make:*` generator: parse the name and `--dir`, render the
 * conventional file, and write it exclusively. Returns the exit code.
 */
export async function runMakeCommand(
  type: MakeCommandType,
  args: readonly string[],
): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    process.stdout.write(makeHelp(type));
    return 0;
  }

  const invocation = parseMakeArgs(type, args);
  if (typeof invocation === 'number') {
    return invocation;
  }

  const layout = GENERATOR_LAYOUT[type];
  const kebabName = kebabCase(invocation.name);

  // Multi-file component: render all four files into a directory.
  if (invocation.mfc) {
    const files = serverComponentMfcTemplate(invocation.name);
    const dir = resolve(invocation.baseDir, layout.dir, kebabName);
    for (const [relative, content] of Object.entries(files)) {
      const path = resolve(dir, relative);
      try {
        await writeFileExclusive(path, content);
      } catch (error) {
        if (error instanceof MakeCommandError) {
          console.error(`jsails make:${type}: ${error.message}`);
          return 1;
        }
        throw error;
      }
    }
    console.log(`Created ${dir}/`);
    return 0;
  }

  const segments = [layout.dir];
  // `make:content` nests under `content/<collection>`; post/doc carry the fixed
  // collection in their layout dir, so their collection stays undefined.
  if (invocation.collection !== undefined) {
    segments.push(kebabCase(invocation.collection));
  }
  const filePath = resolve(
    invocation.baseDir,
    ...segments,
    `${kebabCase(invocation.name)}${layout.extension}`,
  );
  const content = renderTemplate(type, invocation.name);

  try {
    await writeFileExclusive(filePath, content);
  } catch (error) {
    if (error instanceof MakeCommandError) {
      console.error(`jsails make:${type}: ${error.message}`);
      return 1;
    }
    throw error;
  }

  console.log(`Created ${filePath}`);
  return 0;
}
