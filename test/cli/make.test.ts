import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { runMakeCommand } from '../../src/cli/make-commands.js';

/**
 * The `make:*` generators write into a temp directory (via `--dir`), so the
 * repo tree is never touched. Each case asserts the generated path, its
 * exclusive-creation semantics, and the rendered content (name normalization,
 * conventional imports, and the per-type scaffold). No generated file is ever
 * compiled here — the starter owns compilation.
 */

const tmpRoot = mkdtempSync(join(fileURLToPath(new URL('..', import.meta.url)), 'make-fixture-'));

after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

let dirSeq = 0;

function freshDir(): string {
  const dir = join(tmpRoot, `make-${dirSeq++}`);
  return dir;
}

function read(dir: string, relative: string): string {
  return readFileSync(join(dir, relative), 'utf8');
}

describe('runMakeCommand: file generation', () => {
  it('generates a page with normalized name and layout wiring', async () => {
    const dir = freshDir();
    const code = await runMakeCommand('page', ['BlogPost', '--dir', dir]);

    assert.equal(code, 0);
    const content = read(dir, 'pages/blog-post.tsx');
    assert.match(
      content,
      /import \{ Layout, loadLayout, type LayoutAssets \} from '\.\.\/ui\/layout\.js'/,
    );
    assert.match(content, /export default function BlogPostPage/);
    assert.match(content, /<Layout title="Blog Post — JSails Starter"/);
  });

  it('generates an API route under api/', async () => {
    const dir = freshDir();
    const code = await runMakeCommand('api', ['health', '--dir', dir]);

    assert.equal(code, 0);
    const content = read(dir, 'api/health.ts');
    assert.match(content, /export function GET\(_request: Request, _context: RequestContext\)/);
    assert.match(content, /Response\.json\(\{ ok: true \}\)/);
  });

  it('generates a job with a camelCase definition name', async () => {
    const dir = freshDir();
    const code = await runMakeCommand('job', ['send-reminder', '--dir', dir]);

    assert.equal(code, 0);
    const content = read(dir, 'jobs/send-reminder.ts');
    assert.match(content, /export const sendReminderJob = defineJob/);
    assert.match(content, /import \{ defineJob \} from '\.\.\/app\/application-job\.js'/);
    assert.match(content, /import \{ z \} from 'zod'/);
  });

  it('generates a model that declares only its shape', async () => {
    const dir = freshDir();
    const code = await runMakeCommand('model', ['blog_post', '--dir', dir]);

    assert.equal(code, 0);
    const content = read(dir, 'models/blog-post.ts');
    assert.match(content, /export class BlogPost extends ApplicationRecord/);
    // The implicit shape: a bare `declare` field, no TypeORM decorators.
    assert.match(content, /declare name: string;/);
    assert.doesNotMatch(content, /@Entity|@Column|@PrimaryGeneratedColumn/);
    // One import: the base class from the project-local `application-record`
    // shim (which re-exports `jsails/models`).
    assert.match(
      content,
      /import \{ ApplicationRecord \} from '\.\.\/app\/application-record\.js'/,
    );
  });

  it('generates a command with the kebab signature', async () => {
    const dir = freshDir();
    const code = await runMakeCommand('command', ['report', '--dir', dir]);

    assert.equal(code, 0);
    const content = read(dir, 'commands/report.ts');
    assert.match(content, /signature: 'report'/);
    assert.match(content, /import \{ defineCommand \} from '\.\.\/app\/application-command\.js'/);
  });

  it('generates a server component with a Zod state schema', async () => {
    const dir = freshDir();
    const code = await runMakeCommand('server-component', ['form-card', '--dir', dir]);

    assert.equal(code, 0);
    const content = read(dir, 'components/form-card.tsx');
    assert.match(content, /import \{ z \} from 'zod'/);
    assert.match(
      content,
      /import \{ defineComponent, serverAction \} from 'jsails\/server-components'/,
    );
    assert.match(content, /defineComponent<FormCardState>/);
    assert.match(content, /name: 'form-card'/);
    assert.match(content, /staticFallback/);
  });

  it('generates a multi-file server component directory with --mfc', async () => {
    const dir = freshDir();
    const code = await runMakeCommand('server-component', ['form-card', '--mfc', '--dir', dir]);

    assert.equal(code, 0);
    // Four files must exist in the components/form-card/ directory.
    const entryPath = join(dir, 'components', 'form-card', 'form-card.tsx');
    const modelPath = join(dir, 'components', 'form-card', 'form-card.model.ts');
    const stylePath = join(dir, 'components', 'form-card', 'form-card.style.ts');
    const serverPath = join(dir, 'components', 'form-card', 'form-card.server.ts');
    assert.equal(existsSync(entryPath), true);
    assert.equal(existsSync(modelPath), true);
    assert.equal(existsSync(stylePath), true);
    assert.equal(existsSync(serverPath), true);

    // Entry: imports from parts and defines the component.
    const entry = readFileSync(entryPath, 'utf8');
    assert.match(entry, /import \{ initialState, stateSchema \} from '\.\/form-card\.model\.js';/);
    assert.match(entry, /import type \{ FormCardState \} from '\.\/form-card\.model\.js';/);
    assert.match(entry, /import \{ style \} from '\.\/form-card\.style\.js';/);
    assert.match(entry, /export \* from '\.\/form-card\.server\.js';/);
    assert.match(entry, /export const formCard = defineComponent<FormCardState>/);

    // Model: stateSchema + type + initialState.
    const model = readFileSync(modelPath, 'utf8');
    assert.match(model, /export const stateSchema/);
    assert.match(model, /export type FormCardState = z\.infer<typeof stateSchema>/);
    assert.match(model, /export function initialState/);

    // Style: defineStyle export.
    const style = readFileSync(stylePath, 'utf8');
    assert.match(style, /import \{ defineStyle \} from 'jsails\/server-components'/);
    assert.match(style, /export const style = defineStyle/);

    // Server: 'use server' function.
    const server = readFileSync(serverPath, 'utf8');
    assert.match(server, /'use server'/);
    assert.match(server, /export async function loadFormCard/);
  });

  it('rejects --mfc for a non-server-component type', async () => {
    const dir = freshDir();
    const code = await runMakeCommand('page', ['home', '--mfc', '--dir', dir]);
    assert.equal(code, 2);
  });

  it('generates a serializer with a field map', async () => {
    const dir = freshDir();
    const code = await runMakeCommand('serializer', ['user-profile', '--dir', dir]);

    assert.equal(code, 0);
    const content = read(dir, 'serializers/user-profile.ts');
    assert.match(content, /import \{ defineSerializer, string \} from 'jsails\/api'/);
    assert.match(content, /export const userProfileSerializer = defineSerializer/);
    assert.match(content, /name: string\(\{ min: 1 \}\)/);
  });

  it('generates a middleware handler', async () => {
    const dir = freshDir();
    const code = await runMakeCommand('middleware', ['log-visit', '--dir', dir]);

    assert.equal(code, 0);
    const content = read(dir, 'middleware/log-visit.ts');
    assert.match(content, /import type \{ RouteMiddleware \} from 'jsails'/);
    assert.match(content, /export const logVisit: RouteMiddleware = async \(c, next\)/);
    assert.match(content, /return next\(\)/);
  });
});

describe('runMakeCommand: name normalization and dir', () => {
  it('normalizes PascalCase input to a kebab file name', async () => {
    const dir = freshDir();
    const code = await runMakeCommand('model', ['BlogPost', '--dir', dir]);

    assert.equal(code, 0);
    assert.equal(existsSync(join(dir, 'models/blog-post.ts')), true);
  });

  it('writes into a nested --dir, creating missing directories', async () => {
    const dir = freshDir();
    const nested = join(dir, 'src', 'server');
    const code = await runMakeCommand('api', ['ping', '--dir', nested]);

    assert.equal(code, 0);
    assert.equal(existsSync(join(nested, 'api/ping.ts')), true);
  });
});

describe('runMakeCommand: validation and exclusive creation', () => {
  it('refuses to overwrite an existing file and leaves it intact', async () => {
    const dir = freshDir();
    const code = await runMakeCommand('api', ['health', '--dir', dir]);
    assert.equal(code, 0);

    const path = join(dir, 'api/health.ts');
    writeFileSync(path, '// my custom route\n');
    const second = await runMakeCommand('api', ['health', '--dir', dir]);

    assert.equal(second, 1);
    assert.equal(read(dir, 'api/health.ts'), '// my custom route\n');
  });

  it('rejects an invalid name', async () => {
    const dir = freshDir();
    const code = await runMakeCommand('api', ['9bad', '--dir', dir]);
    assert.equal(code, 2);
    assert.equal(existsSync(join(dir, 'api/9bad.ts')), false);
  });

  it('requires a name', async () => {
    const dir = freshDir();
    const code = await runMakeCommand('page', ['--dir', dir]);
    assert.equal(code, 2);
  });

  it('rejects an unknown option', async () => {
    const dir = freshDir();
    const code = await runMakeCommand('page', ['home', '--bogus', '--dir', dir]);
    assert.equal(code, 2);
  });
});

describe('runMakeCommand: content generators', () => {
  it('generates a content entry with YAML frontmatter', async () => {
    const dir = freshDir();
    const code = await runMakeCommand('content', ['blog', 'hello-world', '--dir', dir]);

    assert.equal(code, 0);
    const content = read(dir, 'content/blog/hello-world.md');
    assert.match(content, /^---\ntitle: Hello World\ndate: \d{4}-\d{2}-\d{2}\ntags: \[\]\n---\n/m);
    assert.match(content, /Start writing here\./);
  });

  it('generates a blog post via make:post', async () => {
    const dir = freshDir();
    const code = await runMakeCommand('post', ['my-first-post', '--dir', dir]);

    assert.equal(code, 0);
    assert.equal(existsSync(join(dir, 'content/blog/my-first-post.md')), true);
    assert.match(read(dir, 'content/blog/my-first-post.md'), /title: My First Post/);
  });

  it('generates a docs page via make:doc', async () => {
    const dir = freshDir();
    const code = await runMakeCommand('doc', ['getting-started', '--dir', dir]);

    assert.equal(code, 0);
    assert.equal(existsSync(join(dir, 'content/docs/getting-started.md')), true);
    assert.match(read(dir, 'content/docs/getting-started.md'), /title: Getting Started/);
  });

  it('normalizes a PascalCase name to a kebab path and Title Case title', async () => {
    const dir = freshDir();
    const code = await runMakeCommand('content', ['blog', 'HelloWorld', '--dir', dir]);

    assert.equal(code, 0);
    assert.equal(existsSync(join(dir, 'content/blog/hello-world.md')), true);
    assert.match(read(dir, 'content/blog/hello-world.md'), /title: Hello World/);
  });

  it('honors --dir as the base directory', async () => {
    const dir = freshDir();
    const nested = join(dir, 'src', 'site');
    const code = await runMakeCommand('post', ['hello', '--dir', nested]);

    assert.equal(code, 0);
    assert.equal(existsSync(join(nested, 'content/blog/hello.md')), true);
  });

  it('rejects an invalid content name without writing', async () => {
    const dir = freshDir();
    const code = await runMakeCommand('content', ['blog', '9bad', '--dir', dir]);

    assert.equal(code, 2);
    assert.equal(existsSync(join(dir, 'content/blog/9bad.md')), false);
  });

  it('rejects a missing collection or name for make:content', async () => {
    const dir = freshDir();
    assert.equal(await runMakeCommand('content', ['--dir', dir]), 2);
    assert.equal(await runMakeCommand('content', ['blog', '--dir', dir]), 2);
  });

  it('refuses to overwrite an existing content entry and leaves it intact', async () => {
    const dir = freshDir();
    const code = await runMakeCommand('content', ['blog', 'hello', '--dir', dir]);
    assert.equal(code, 0);

    const path = join(dir, 'content/blog/hello.md');
    writeFileSync(path, '---\ntitle: Mine\n---\n');
    const second = await runMakeCommand('content', ['blog', 'hello', '--dir', dir]);

    assert.equal(second, 1);
    assert.equal(read(dir, 'content/blog/hello.md'), '---\ntitle: Mine\n---\n');
  });
});

// ---------------------------------------------------------------------------
// subprocess: CLI wiring
// ---------------------------------------------------------------------------

const cliPath = fileURLToPath(new URL('../../src/cli/index.js', import.meta.url));

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], cwd: string): CliResult {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('cli: make subprocess', () => {
  it('prints the make listing for a bare make', () => {
    const result = runCli(['make'], tmpRoot);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /make:model <name>/);
    assert.match(result.stdout, /make:server-component <name>/);
    assert.match(result.stdout, /make:serializer <name>/);
    assert.match(result.stdout, /make:middleware <name>/);
    assert.match(result.stdout, /make:content <collection> <name>/);
    assert.match(result.stdout, /make:post <name>/);
    assert.match(result.stdout, /make:doc <name>/);
    assert.match(result.stdout, /--dir <path>/);
  });

  it('prints per-type help for make:page --help', () => {
    const result = runCli(['make:page', '--help'], tmpRoot);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /jsails make:page <name>/);
  });

  it('prints per-type help for make:content --help', () => {
    const result = runCli(['make:content', '--help'], tmpRoot);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /jsails make:content <collection> <name>/);
  });

  it('rejects an unknown make type', () => {
    const result = runCli(['make:bogus', 'x'], tmpRoot);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /unknown command "make:bogus"/);
  });

  it('creates a file through the CLI end to end', () => {
    const dir = join(tmpRoot, 'make-subprocess');
    const result = runCli(['make:command', 'hello', '--dir', dir], tmpRoot);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(dir, 'commands/hello.ts')), true);
    assert.match(result.stdout, /Created .*commands\/hello\.ts/);
  });

  it('creates a server-component file through the CLI end to end', () => {
    const dir = join(tmpRoot, 'make-subprocess-sc');
    const result = runCli(['make:server-component', 'card', '--dir', dir], tmpRoot);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(dir, 'components/card.tsx')), true);
    assert.match(result.stdout, /Created .*components\/card\.tsx/);
  });

  it('creates a content entry through the CLI end to end', () => {
    const dir = join(tmpRoot, 'make-subprocess-content');
    const result = runCli(['make:post', 'first-post', '--dir', dir], tmpRoot);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(dir, 'content/blog/first-post.md')), true);
    assert.match(result.stdout, /Created .*content\/blog\/first-post\.md/);
  });

  it('creates a multi-file server-component directory through the CLI end to end', () => {
    const dir = join(tmpRoot, 'make-subprocess-mfc');
    const result = runCli(['make:server-component', 'card', '--mfc', '--dir', dir], tmpRoot);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(dir, 'components/card/card.tsx')), true);
    assert.equal(existsSync(join(dir, 'components/card/card.model.ts')), true);
    assert.equal(existsSync(join(dir, 'components/card/card.style.ts')), true);
    assert.equal(existsSync(join(dir, 'components/card/card.server.ts')), true);
    assert.match(result.stdout, /Created .*components\/card\/\n/);
  });
});
