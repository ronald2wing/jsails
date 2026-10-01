/**
 * Public static-file middleware tests.
 *
 * Every fixture is a real file under a temp directory and every request goes
 * through `Hono#fetch` against an in-process app; nothing binds a port or opens
 * a network connection. Binary payloads are plain byte arrays, so no image
 * tooling is required.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';

import { Hono } from 'hono';

import { createPublicFilesMiddleware } from '../src/app/static-files.js';

const workspace = mkdtempSync(join(tmpdir(), 'jsails-static-files-'));

after(() => {
  rmSync(workspace, { recursive: true, force: true });
});

/** Create an isolated root for one test case. */
function caseDir(): string {
  return mkdtempSync(join(workspace, 'case-'));
}

/** Write a fixture, creating parent directories as needed. */
function write(dir: string, relative: string, contents: string | Uint8Array): string {
  const file = join(dir, relative);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, contents);
  return file;
}

/** Build a Hono app with the middleware optionally installed, plus a 404. */
async function buildApp(publicDir: string): Promise<Hono> {
  const middleware = await createPublicFilesMiddleware(publicDir);
  const app = new Hono();
  if (middleware !== undefined) app.use('*', middleware);
  app.notFound((c) => c.text('not found', 404));
  return app;
}

/** Issue an in-process request without touching the network. */
async function request(app: Hono, path: string, init?: RequestInit): Promise<Response> {
  return app.fetch(new Request(`http://example.test${path}`, init));
}

describe('createPublicFilesMiddleware lifecycle', () => {
  it('returns undefined for a missing root and rejects bad roots', async () => {
    const base = caseDir();

    assert.equal(await createPublicFilesMiddleware(join(base, 'absent')), undefined);

    const file = write(base, 'plain.txt', 'x');
    await assert.rejects(() => createPublicFilesMiddleware(file), /must be a directory/);

    const realDir = join(base, 'real');
    mkdirSync(realDir);
    const link = join(base, 'link');
    symlinkSync(realDir, link);
    await assert.rejects(() => createPublicFilesMiddleware(link), /symbolic link/);

    await assert.rejects(() => createPublicFilesMiddleware(''), TypeError);
  });
});

describe('createPublicFilesMiddleware serving', () => {
  it('serves text and binary files with adapter content types and nosniff', async () => {
    const pub = caseDir();
    write(pub, 'hello.txt', 'hello world');
    write(pub, 'index.html', '<h1>home</h1>');
    write(pub, 'data.bin', Uint8Array.from([0, 1, 2, 253, 254, 255]));
    const app = await buildApp(pub);

    const text = await request(app, '/hello.txt');
    assert.equal(text.status, 200);
    assert.match(text.headers.get('content-type') ?? '', /^text\/plain/);
    assert.equal(text.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(await text.text(), 'hello world');

    const binary = await request(app, '/data.bin');
    assert.equal(binary.status, 200);
    assert.equal(binary.headers.get('content-type'), 'application/octet-stream');
    assert.deepEqual(
      Array.from(new Uint8Array(await binary.arrayBuffer())),
      [0, 1, 2, 253, 254, 255],
    );

    const home = await request(app, '/');
    assert.equal(home.status, 200);
    assert.match(home.headers.get('content-type') ?? '', /^text\/html/);
    assert.equal(await home.text(), '<h1>home</h1>');
  });

  it('serves a literal percent in a filename without double decoding it', async () => {
    const pub = caseDir();
    write(pub, '100%.txt', 'percent');
    const app = await buildApp(pub);

    const response = await request(app, '/100%25.txt');
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'percent');

    // The query string is not part of the filesystem path.
    assert.equal((await request(app, '/100%25.txt?v=2')).status, 200);
  });

  it('answers HEAD with headers and an empty body', async () => {
    const pub = caseDir();
    write(pub, 'hello.txt', 'hello world');
    const app = await buildApp(pub);

    const head = await request(app, '/hello.txt', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.match(head.headers.get('content-type') ?? '', /^text\/plain/);
    assert.equal(head.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(head.headers.get('content-length'), '11');
    assert.equal((await head.arrayBuffer()).byteLength, 0);
  });

  it('serves directory indexes, with and without a trailing slash', async () => {
    const pub = caseDir();
    write(pub, 'sub/index.html', '<p>sub</p>');
    mkdirSync(join(pub, 'empty'));
    write(pub, 'file.txt', 'file');
    const app = await buildApp(pub);

    assert.equal(await (await request(app, '/sub/')).text(), '<p>sub</p>');
    assert.equal(await (await request(app, '/sub')).text(), '<p>sub</p>');
    assert.equal((await request(app, '/empty/')).status, 404);
    // A trailing slash on a regular file is not a directory request.
    assert.equal((await request(app, '/file.txt/')).status, 404);
  });

  it('calls next for missing files and unrelated methods', async () => {
    const pub = caseDir();
    write(pub, 'hello.txt', 'hi');
    const app = await buildApp(pub);

    assert.equal((await request(app, '/missing.txt')).status, 404);
    assert.equal((await request(app, '/hello.txt', { method: 'POST' })).status, 404);
    assert.equal((await request(app, '/hello.txt', { method: 'DELETE' })).status, 404);
  });
});

describe('createPublicFilesMiddleware security gate', () => {
  it('never serves hidden dot-segments', async () => {
    const pub = caseDir();
    write(pub, '.env', 'SECRET=1');
    write(pub, '.well-known/secret.txt', 'x');
    write(pub, 'ok.txt', 'ok');
    const app = await buildApp(pub);

    assert.equal((await request(app, '/.env')).status, 404);
    assert.equal((await request(app, '/%2eenv')).status, 404);
    assert.equal((await request(app, '/.well-known/secret.txt')).status, 404);
    assert.equal((await request(app, '/ok.txt')).status, 200);
  });

  it('rejects traversal, backslash, NUL, malformed, and double-encoded paths', async () => {
    const base = caseDir();
    const pub = join(base, 'public');
    mkdirSync(pub);
    write(pub, 'inside.txt', 'inside');
    write(base, 'secret.txt', 'TOP SECRET'); // deliberately outside the root
    const app = await buildApp(pub);

    const rejected = [
      '/..%2fsecret.txt',
      '/%2e%2e%2fsecret.txt',
      '/a%2f..%2fb',
      '/a%5c..%5csecret.txt',
      '/a%00b.txt',
      '/%252e%252e%2fsecret.txt',
      '/%e0%80%af',
    ];
    for (const path of rejected) {
      const response = await request(app, path);
      assert.equal(response.status, 404, `expected 404 for ${path}`);
      assert.notEqual(await response.text(), 'TOP SECRET');
    }

    assert.equal((await request(app, '/inside.txt')).status, 200);
  });

  it('rejects symlinked files, ancestor directories, and directory indexes', async () => {
    const base = caseDir();
    const pub = join(base, 'public');
    mkdirSync(pub);
    write(pub, 'ok.txt', 'ok');
    const target = write(base, 'target.txt', 'outside');

    symlinkSync(target, join(pub, 'link.txt'));
    write(base, 'outside-dir/secret.txt', 'outside');
    symlinkSync(join(base, 'outside-dir'), join(pub, 'linked-dir'));
    mkdirSync(join(pub, 'docs'));
    symlinkSync(target, join(pub, 'docs', 'index.html'));

    const app = await buildApp(pub);
    assert.equal((await request(app, '/link.txt')).status, 404);
    assert.equal((await request(app, '/linked-dir/secret.txt')).status, 404);
    assert.equal((await request(app, '/docs/')).status, 404);
    assert.equal((await request(app, '/docs/index.html')).status, 404);
    assert.equal((await request(app, '/ok.txt')).status, 200);
  });

  it('ignores client-supplied x-forwarded headers', async () => {
    const pub = caseDir();
    write(pub, 'hello.txt', 'hello');
    const app = await buildApp(pub);

    const response = await request(app, '/hello.txt', {
      headers: {
        'x-forwarded-host': 'evil.test',
        'x-forwarded-prefix': '/../../',
        'x-forwarded-for': '10.0.0.1',
      },
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'hello');
  });
});

describe('createPublicFilesMiddleware ordering', () => {
  it('does not shadow a route registered before it', async () => {
    const pub = caseDir();
    write(pub, 'api/private.txt', 'file-contents');
    const middleware = await createPublicFilesMiddleware(pub);
    assert.ok(middleware !== undefined);

    const app = new Hono();
    app.get('/api/private.txt', (c) => c.text('handler'));
    app.use('*', middleware);
    app.notFound((c) => c.text('not found', 404));

    assert.equal(await (await request(app, '/api/private.txt')).text(), 'handler');
    // A sibling public file with no route is still served.
    write(pub, 'api/public.txt', 'public');
    assert.equal(await (await request(app, '/api/public.txt')).text(), 'public');
  });
});
