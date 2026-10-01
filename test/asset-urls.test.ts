/**
 * Asset-URL versioning tests.
 *
 * Every fixture is a real file under a temp directory; nothing opens a port or
 * a network connection. The resolver is exercised directly against on-disk
 * files, and the two context-injection seams (`createApp`, `generateStaticSite`)
 * are probed with a custom renderer / API handler so no Preact or module import
 * is required.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';

import { createApplication } from '../src/app/application.js';
import { createAssetUrlResolver } from '../src/app/asset-urls.js';
import { validateAppConfig } from '../src/app/config.js';
import type { RequestContext } from '../src/contracts/http.js';
import type { PageRenderer } from '../src/contracts/render.js';
import { generateStaticSite } from '../src/pages/static-site.js';
import type { RouteManifest, RouteManifestEntry } from '../src/routing/manifest.js';
import { createApp } from '../src/server/app.js';

const workspace = mkdtempSync(join(tmpdir(), 'jsails-asset-urls-'));

after(() => {
  rmSync(workspace, { recursive: true, force: true });
});

/** Create an isolated directory for one test case. */
function caseDir(): string {
  return mkdtempSync(join(workspace, 'case-'));
}

/** Write a file, creating parent directories, and return its absolute path. */
function write(dir: string, relative: string, contents: string): string {
  const file = join(dir, relative);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, contents);
  return file;
}

function pageEntry(route: string, file: string): RouteManifestEntry {
  return { kind: 'page', route, file, dynamic: false, catchAll: false, params: [] };
}

function apiEntry(route: string, file: string): RouteManifestEntry {
  return { kind: 'api', route, file, dynamic: false, catchAll: false, params: [] };
}

function manifestOf(entries: RouteManifestEntry[]): RouteManifest {
  return { entries, byRoute: new Map(entries.map((entry) => [entry.route, entry])) };
}

const VERSION_QUERY = /\?v=[0-9a-f]{64}$/;

describe('createAssetUrlResolver', () => {
  it('returns a stable content hash with a `?v=` query suffix', async () => {
    const pub = caseDir();
    write(pub, 'assets/app.js', 'const app = 1;\n');
    const resolve = createAssetUrlResolver(pub);

    const expected = createHash('sha256').update('const app = 1;\n').digest('hex');
    const url = await resolve('/assets/app.js');

    assert.equal(url, `/assets/app.js?v=${expected}`);
    // The resolver is stable across repeated calls for unchanged content.
    assert.equal(await resolve('/assets/app.js'), url);
  });

  it('re-hashes when file content changes, detected by size or mtime', async () => {
    const pub = caseDir();
    const file = write(pub, 'app.js', 'alpha');
    const resolve = createAssetUrlResolver(pub);
    const before = await resolve('/app.js');

    // A size change invalidates the cache key.
    writeFileSync(file, 'bravo-echo');
    const resized = await resolve('/app.js');
    assert.notEqual(resized, before);
    assert.match(resized, VERSION_QUERY);

    // A same-size change is caught when the mtime is bumped past the cached one.
    writeFileSync(file, 'charlie');
    const stat = statSync(file);
    const future = new Date(stat.mtimeMs + 2000);
    utimesSync(file, future, future);
    const rehashed = await resolve('/app.js');
    assert.notEqual(rehashed, resized);
    assert.match(rehashed, VERSION_QUERY);
  });

  it('versions assets with Unicode names using a URI-safe hash', async () => {
    const pub = caseDir();
    write(pub, 'assets/café.js', 'const café = 1;\n');
    const resolve = createAssetUrlResolver(pub);

    const expected = createHash('sha256').update('const café = 1;\n').digest('hex');
    assert.equal(await resolve('/assets/café.js'), `/assets/café.js?v=${expected}`);
  });

  it('returns the path unchanged for a missing directory, asset, or publicDir', async () => {
    const base = caseDir();
    const pub = join(base, 'public');
    mkdirSync(pub);
    write(pub, 'app.js', 'x');
    const resolve = createAssetUrlResolver(pub);

    assert.equal(await resolve('/missing.js'), '/missing.js');
    assert.equal(await resolve('/app.js/'), '/app.js/');

    const absent = createAssetUrlResolver(join(base, 'does-not-exist'));
    assert.equal(await absent('/app.js'), '/app.js');

    const invalid = createAssetUrlResolver('');
    assert.equal(await invalid('/app.js'), '/app.js');
  });

  it('rejects traversal, hidden, backslash, absolute, query, and fragment paths', async () => {
    const base = caseDir();
    const pub = join(base, 'public');
    mkdirSync(pub);
    write(pub, 'app.js', 'ok');
    write(base, 'secret.js', 'TOP SECRET');
    const resolve = createAssetUrlResolver(pub);

    const rejected = [
      '/../secret.js',
      '/a/../../b.js',
      '/.env',
      '/.hidden/app.js',
      '/a\\b.js',
      'https://example.com/app.js',
      '//example.com/app.js',
      '/app.js?v=1',
      '/app.js#frag',
      '/a//b.js',
      'assets/app.js',
    ];
    for (const path of rejected) {
      assert.equal(await resolve(path), path, `expected ${JSON.stringify(path)} unchanged`);
    }

    // A legitimate path still versions, proving the rejects are not global.
    assert.match(await resolve('/app.js'), VERSION_QUERY);
  });

  it('rejects symlinks and never reads outside publicDir', async () => {
    const base = caseDir();
    const pub = join(base, 'public');
    mkdirSync(pub);
    write(pub, 'app.js', 'inside');
    const resolve = createAssetUrlResolver(pub);

    // A secret file outside publicDir must never be hashed or read.
    const secret = write(base, 'secret.js', 'OUTSIDE SECRET');
    symlinkSync(secret, join(pub, 'link.js'));
    assert.equal(await resolve('/link.js'), '/link.js');

    // A symlinked directory cannot smuggle a path out of publicDir.
    const outside = join(base, 'outside');
    mkdirSync(outside);
    write(outside, 'x.js', 'OUTSIDE');
    symlinkSync(outside, join(pub, 'linked'));
    assert.equal(await resolve('/linked/x.js'), '/linked/x.js');

    // A directory requested as an asset is not versioned.
    mkdirSync(join(pub, 'docs'));
    assert.equal(await resolve('/docs'), '/docs');

    // The untouched real asset still resolves.
    assert.match(await resolve('/app.js'), VERSION_QUERY);
  });
});

describe('assetUrl context injection', () => {
  it('threads assetUrl into page and API request contexts through createApp', async () => {
    const base = caseDir();
    const pageFile = write(base, 'index.js', 'export default function P() {}\n');
    const apiFile = write(
      base,
      'api.js',
      `export async function GET(request, context) {
        return new Response(JSON.stringify({ hasAssetUrl: typeof context.assetUrl === 'function' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }\n`,
    );

    let rendererAssetUrl: RequestContext['assetUrl'];
    const renderer: PageRenderer = {
      render(_entry, context) {
        rendererAssetUrl = context.assetUrl;
        return '<p>ok</p>';
      },
    };

    const app = await createApp({
      manifest: manifestOf([pageEntry('/', pageFile), apiEntry('/api/ping', apiFile)]),
      renderer,
      authorize: () => true,
      assetUrl: async (path) => `${path}?v=test`,
    });

    const page = await app.fetch(new Request('http://localhost/'));
    assert.equal(page.status, 200);
    assert.equal(typeof rendererAssetUrl, 'function');

    const api = await app.fetch(new Request('http://localhost/api/ping'));
    assert.equal(api.status, 200);
    assert.deepEqual(await api.json(), { hasAssetUrl: true });
  });

  it('threads assetUrl into the static render context through generateStaticSite', async () => {
    const base = caseDir();
    const out = join(base, 'out');
    const file = write(base, 'index.js', 'export default function P() {}\n');

    let rendererAssetUrl: RequestContext['assetUrl'];
    const renderer: PageRenderer = {
      render(_entry, context) {
        rendererAssetUrl = context.assetUrl;
        return '<p>ok</p>';
      },
    };

    await generateStaticSite({
      manifest: manifestOf([pageEntry('/', file)]),
      outDir: out,
      renderer,
      assetUrl: async (path) => `${path}?v=ssg`,
    });

    assert.equal(typeof rendererAssetUrl, 'function');
  });

  it('wires a real resolver through createApplication to both build and fetch', async () => {
    const base = caseDir();
    write(join(base, 'pages'), 'index.js', 'export default function P() {}\n');
    write(join(base, 'public'), 'assets/app.js', 'const app = 1;\n');

    const config = validateAppConfig({ rootDir: base, port: 0 }, { cwd: base });
    const resolved: string[] = [];
    const renderer: PageRenderer = {
      async render(_entry, context) {
        const url = await context.assetUrl?.('/assets/app.js');
        if (url !== undefined) resolved.push(url);
        return '<p>ok</p>';
      },
    };

    const app = await createApplication({ ...config, renderer });
    try {
      const fetched = await app.fetch(new Request('http://localhost/'));
      assert.equal(fetched.status, 200);
      assert.match(resolved[0] ?? '', VERSION_QUERY);

      await app.build();
      assert.match(resolved[1] ?? '', VERSION_QUERY);
    } finally {
      await app.close();
    }
  });
});
