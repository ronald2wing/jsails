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

  it('generates a model with a snake_case table and ApplicationRecord', async () => {
    const dir = freshDir();
    const code = await runMakeCommand('model', ['blog_post', '--dir', dir]);

    assert.equal(code, 0);
    const content = read(dir, 'models/blog-post.ts');
    assert.match(content, /@Entity\('blog_post'\)/);
    assert.match(content, /export class BlogPost extends ApplicationRecord/);
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
    assert.match(content, /import \{ defineServerComponent \} from 'jsails\/server-components'/);
    assert.match(content, /defineServerComponent<FormCardState>/);
    assert.match(content, /name: 'form-card'/);
    assert.match(content, /staticFallback/);
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
    assert.match(content, /import type \{ RequestContext, RouteMiddleware \} from 'jsails'/);
    assert.match(content, /export const logVisit: RouteMiddleware/);
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

// ---------------------------------------------------------------------------
// subprocess: CLI wiring
// ---------------------------------------------------------------------------

const cliPath = fileURLToPath(new URL('../../src/cli.js', import.meta.url));

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
    assert.match(result.stdout, /--dir <path>/);
  });

  it('prints per-type help for make:page --help', () => {
    const result = runCli(['make:page', '--help'], tmpRoot);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /jsails make:page <name>/);
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
});
