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

import { isErrno } from '../internal/errors.js';

/** Raised for an invalid subcommand, name, or an existing target file. */
class MakeCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MakeCommandError';
  }
}

/** The generator types `make:*` supports, in help order. */
const MAKE_COMMAND_TYPES = [
  'page',
  'api',
  'job',
  'model',
  'command',
  'server-component',
  'serializer',
  'middleware',
] as const;

/** A generator type (the token after `make:`). */
export type MakeCommandType = (typeof MAKE_COMMAND_TYPES)[number];

/** Whether a token after `make:` names a supported generator. */
export function isMakeCommandType(value: string): value is MakeCommandType {
  return (MAKE_COMMAND_TYPES as readonly string[]).includes(value);
}

/** A name must be a leading letter followed by letters, digits, `_` or `-`. */
const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;

/** Conventional output directory and file extension for each type. */
const TYPE_LAYOUT: Readonly<
  Record<MakeCommandType, { readonly dir: string; readonly extension: string }>
> = {
  page: { dir: 'pages', extension: '.tsx' },
  api: { dir: 'api', extension: '.ts' },
  job: { dir: 'jobs', extension: '.ts' },
  model: { dir: 'models', extension: '.ts' },
  command: { dir: 'commands', extension: '.ts' },
  'server-component': { dir: 'components', extension: '.tsx' },
  serializer: { dir: 'serializers', extension: '.ts' },
  middleware: { dir: 'middleware', extension: '.ts' },
};

/** Split a name into words across camelCase, kebab-, and snake_case. */
function toWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 0);
}

function toPascalCase(name: string): string {
  return toWords(name)
    .map((word) => word[0]!.toUpperCase() + word.slice(1).toLowerCase())
    .join('');
}

function toCamelCase(name: string): string {
  const words = toWords(name);
  const first = (words[0] ?? '').toLowerCase();
  const rest = words.slice(1).map((word) => word[0]!.toUpperCase() + word.slice(1).toLowerCase());
  return first + rest.join('');
}

function toKebabCase(name: string): string {
  return toWords(name)
    .map((word) => word.toLowerCase())
    .join('-');
}

function toSnakeCase(name: string): string {
  return toKebabCase(name).replace(/-/g, '_');
}

/** Render the one-line `jsails make:<type> --help` summary. */
function makeHelp(type: MakeCommandType): string {
  return `${type} - generate a ${type} file\n\nUsage:\n  jsails make:${type} <name> [--dir <path>]\n`;
}

export const GLOBAL_MAKE_HELP = `make - generate a single conventional file

Usage:
  jsails make:page <name>    Generate pages/<name>.tsx
  jsails make:api <name>     Generate api/<name>.ts
  jsails make:job <name>     Generate jobs/<name>.ts
  jsails make:model <name>   Generate models/<name>.ts
  jsails make:command <name>            Generate commands/<name>.ts
  jsails make:server-component <name>   Generate components/<name>.tsx
  jsails make:serializer <name>         Generate serializers/<name>.ts
  jsails make:middleware <name>         Generate middleware/<name>.ts

Options:
  --dir <path>    Base directory (default: the current working directory)
  -h, --help      Show this help
`;

/** The page template: a plain page through the shared document shell. */
function pageTemplate(name: string): string {
  const pascal = toPascalCase(name);
  const title = toPascalCase(name).replace(/([a-z0-9])([A-Z])/g, '$1 $2');
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
  const kebab = toKebabCase(name);
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
  const camel = toCamelCase(name);
  const kebab = toKebabCase(name);
  return `/**
 * ${toPascalCase(name)} job.
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

/** The model template: an Active Record entity. */
function modelTemplate(name: string): string {
  const pascal = toPascalCase(name);
  const table = toSnakeCase(name);
  return `/**
 * ${pascal} model.
 *
 * An Active Record entity mapping the \`${table}\` table (the name is derived
 * from the model name; adjust it to match your schema). Register it on the
 * \`JsailsDataSource\` \`entities\` list in \`jsails.config.js\`, then run
 * \`makemigrations\`/\`migrate\` to create the table. \`ApplicationRecord\`
 * re-exports the framework \`BaseEntity\`, so repository queries (find, save,
 * create) are available as static methods.
 */

import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

import { ApplicationRecord } from '../app/application-record.js';

@Entity('${table}')
export class ${pascal} extends ApplicationRecord {
  @PrimaryGeneratedColumn()
  id!: number;
}
`;
}

/** The command template: a Laravel-Zero-style CLI command. */
function commandTemplate(name: string): string {
  const kebab = toKebabCase(name);
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
  const pascal = toPascalCase(name);
  const kebab = toKebabCase(name);
  return `/**
 * ${pascal} server component.
 *
 * A stateful, signed server component with a minimal Zod state schema. Register
 * it in \`jsails.app.js\` through the \`serverComponentsPlugin\` extension and
 * render it from a page's \`load\` with \`renderServerComponent('${kebab}', context)\`.
 *
 * State is integrity-protected (not encrypted) and carried in a signed snapshot;
 * never place credentials in component state. Add \`writableKeys\` and an
 * \`authorize\` callback before serving.
 */
import { z } from 'zod';

import { defineServerComponent } from 'jsails/server-components';

const stateSchema = z
  .object({
    title: z.string().max(120),
  })
  .strict();

type ${pascal}State = z.infer<typeof stateSchema>;

export const ${toCamelCase(name)} = defineServerComponent<${pascal}State>({
  name: '${kebab}',
  stateSchema,
  initialState() {
    return { title: '' };
  },
  authorize() {
    return true;
  },
  render(state, { bind }) {
    return (
      <div>
        <input type="text" maxLength={120} {...bind('title')} />
        <p>Current value: {state.title}</p>
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
  const camel = toCamelCase(name);
  const pascal = toPascalCase(name);
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

/** The middleware template: a request-chain handler. */
function middlewareTemplate(name: string): string {
  const camel = toCamelCase(name);
  return `/**
 * ${toPascalCase(name)} middleware.
 *
 * A per-route middleware handler applied before the terminal page or API
 * handler. Register it in \`jsails.app.js\` under \`middleware\` (keyed by
 * name), then reference it by name in a route module's exported \`middleware\`
 * array. The handler receives the request context and a \`next\` continuation;
 * calling \`next()\` yields the downstream \`Response\` (or short-circuit by
 * returning a \`Response\` directly).
 */
import type { RequestContext, RouteMiddleware } from 'jsails';

export const ${camel}: RouteMiddleware = (context: RequestContext, next) => {
  // Inspect \`context\` (session, params, route), then forward or reply.
  return next();
};
`;
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
  }
}

/** Parse the tokens after `make:<type>` into a name and a base directory. */
interface MakeInvocation {
  readonly name: string;
  readonly baseDir: string;
}

/** Parse the raw tokens: at most one positional name and one `--dir`. */
function parseMakeArgs(type: MakeCommandType, args: readonly string[]): MakeInvocation | number {
  let name: string | undefined;
  let baseDir: string | undefined;

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
    if (token.startsWith('-')) {
      return usageError(type, `unknown option ${JSON.stringify(token)}`);
    }
    if (name !== undefined) {
      return usageError(type, `unexpected argument ${JSON.stringify(token)}`);
    }
    name = token;
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
  return { name, baseDir: baseDir ?? '.' };
}

function usageError(type: MakeCommandType, message: string): number {
  console.error(`jsails make:${type}: ${message}`);
  console.error(`Run "jsails make:${type} --help" for usage.`);
  return 2;
}

/** Write `content` to `path`, refusing to overwrite an existing file. */
async function writeFileExclusive(path: string, content: string): Promise<void> {
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

  const layout = TYPE_LAYOUT[type];
  const filePath = resolve(
    invocation.baseDir,
    layout.dir,
    `${toKebabCase(invocation.name)}${layout.extension}`,
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
