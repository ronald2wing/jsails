/**
 * Route manifest tests.
 *
 * Discovery, ordering, and duplicate rejection run against real on-disk
 * fixture trees under a temporary root — never a mocked filesystem — because
 * the whole point of the manifest is faithful filesystem walking. Output-path
 * and substitution helpers are pure and exercised directly.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import {
  discoverRoutes,
  RouteManifestError,
  routeToOutputPath,
  substituteRouteParams,
  type RouteManifestEntry,
} from '../src/routing/manifest.js';

const tmpRoot = mkdtempSync(join(fileURLToPath(new URL('..', import.meta.url)), 'routing-'));

after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

const MODULE_BODY = 'export default () => null;\n';

function writeFixture(root: string, relative: string): void {
  const full = join(root, relative);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, MODULE_BODY);
}

const basicRoot = join(tmpRoot, 'basic');
writeFixture(basicRoot, 'pages/index.js');
writeFixture(basicRoot, 'pages/about.js');
writeFixture(basicRoot, 'pages/notes.mjs');
writeFixture(basicRoot, 'pages/blog/index.js');
writeFixture(basicRoot, 'pages/blog/[id].js');
writeFixture(basicRoot, 'pages/ignored.ts');
writeFixture(basicRoot, 'api/index.js');
writeFixture(basicRoot, 'api/health.js');
writeFixture(basicRoot, 'api/users.js');
writeFixture(basicRoot, 'api/users/[id].js');

const basicManifest = discoverRoutes(basicRoot);

const multiRoot = join(tmpRoot, 'multi');
writeFixture(multiRoot, 'pages/index.js');
writeFixture(multiRoot, 'pages/shop/[category]/[item].js');
const multiManifest = discoverRoutes(multiRoot);

describe('discoverRoutes', () => {
  it('maps index, static, dynamic, and API files to route patterns', () => {
    assert.deepEqual(
      basicManifest.entries.map((entry) => entry.route),
      [
        '/',
        '/about',
        '/api',
        '/api/health',
        '/api/users',
        '/api/users/:id',
        '/blog',
        '/blog/:id',
        '/notes',
      ],
    );

    const index = basicManifest.byRoute.get('/');
    assert.equal(index?.kind, 'page');
    assert.equal(index?.dynamic, false);
    assert.deepEqual(index?.params, []);
    assert.ok(index?.file.endsWith(join('pages', 'index.js')));

    const blogId = basicManifest.byRoute.get('/blog/:id');
    assert.equal(blogId?.kind, 'page');
    assert.equal(blogId?.dynamic, true);
    assert.equal(blogId?.catchAll, false);
    assert.deepEqual(blogId?.params, ['id']);
    assert.ok(blogId?.file.endsWith(join('pages', 'blog', '[id].js')));

    const apiIndex = basicManifest.byRoute.get('/api');
    assert.equal(apiIndex?.kind, 'api');

    const apiUser = basicManifest.byRoute.get('/api/users/:id');
    assert.equal(apiUser?.kind, 'api');
    assert.deepEqual(apiUser?.params, ['id']);

    assert.equal(basicManifest.byRoute.get('/notes')?.kind, 'page');
    assert.equal(basicManifest.byRoute.has('/ignored'), false);
    assert.equal(basicManifest.entries.length, basicManifest.byRoute.size);
  });

  it('orders static segments before parameterized segments', () => {
    const routes = basicManifest.entries.map((entry) => entry.route);
    assert.ok(routes.indexOf('/blog') < routes.indexOf('/blog/:id'));
    assert.ok(routes.indexOf('/api/users') < routes.indexOf('/api/users/:id'));
  });

  it('supports parameterized directories with multiple params', () => {
    const entry = multiManifest.byRoute.get('/shop/:category/:item');
    assert.ok(entry);
    assert.deepEqual(entry.params, ['category', 'item']);
  });

  it('treats missing pages/api directories as empty', () => {
    const manifest = discoverRoutes(join(tmpRoot, 'empty'));
    assert.deepEqual(manifest.entries, []);
    assert.equal(manifest.byRoute.size, 0);
  });

  it('skips symlinked route modules', () => {
    const linkRoot = join(tmpRoot, 'links');
    writeFixture(linkRoot, 'pages/real.js');
    symlinkSync(join(linkRoot, 'pages', 'real.js'), join(linkRoot, 'pages', 'linked.js'));
    const manifest = discoverRoutes(linkRoot);
    assert.deepEqual(
      manifest.entries.map((entry) => entry.route),
      ['/real'],
    );
  });

  it('rejects structurally equivalent parameter routes', () => {
    const root = join(tmpRoot, 'dup-param');
    writeFixture(root, 'pages/[id].js');
    writeFixture(root, 'pages/[slug].js');
    assert.throws(() => discoverRoutes(root), RouteManifestError);
  });

  it('rejects duplicate static routes from index files', () => {
    const root = join(tmpRoot, 'dup-static');
    writeFixture(root, 'pages/foo.js');
    writeFixture(root, 'pages/foo/index.js');
    assert.throws(() => discoverRoutes(root), RouteManifestError);
  });

  it('rejects malformed bracket segments', () => {
    const root = join(tmpRoot, 'malformed');
    writeFixture(root, 'pages/[id.js');
    assert.throws(() => discoverRoutes(root), /malformed/);
  });

  it('rejects catch-all segments explicitly', () => {
    const root = join(tmpRoot, 'catch-all');
    writeFixture(root, 'pages/[...slug].js');
    assert.throws(() => discoverRoutes(root), /catch-all/);
  });

  it('rejects static segments that cannot round-trip through a URL', () => {
    const unsafe = ['hash#name', 'question?name', 'percent%name', 'back\\slash', 'space name'];
    unsafe.forEach((name, index) => {
      const root = join(tmpRoot, `unsafe-${index}`);
      writeFixture(root, `pages/${name}.js`);
      assert.throws(
        () => discoverRoutes(root),
        RouteManifestError,
        `expected "${name}" to be rejected`,
      );
    });
  });

  it('accepts Unicode literal segments reachable through percent-decoding', () => {
    const root = join(tmpRoot, 'unicode-static');
    writeFixture(root, 'pages/café.js');
    const manifest = discoverRoutes(root);
    assert.deepEqual(
      manifest.entries.map((entry) => entry.route),
      ['/café'],
    );
  });
});

describe('routeToOutputPath', () => {
  const outDir = join(tmpRoot, 'out');

  it('maps routes to contained index.html paths', () => {
    assert.equal(routeToOutputPath(outDir, '/'), join(outDir, 'index.html'));
    assert.equal(routeToOutputPath(outDir, '/foo'), join(outDir, 'foo', 'index.html'));
    assert.equal(routeToOutputPath(outDir, '/foo/bar'), join(outDir, 'foo', 'bar', 'index.html'));
    assert.ok(routeToOutputPath(outDir, '/foo').startsWith(outDir));
  });

  it('rejects traversal, dot, backslash, NUL, query, and fragment input', () => {
    assert.throws(() => routeToOutputPath(outDir, '/../secret'), RouteManifestError);
    assert.throws(() => routeToOutputPath(outDir, '/foo/../../etc'), RouteManifestError);
    assert.throws(() => routeToOutputPath(outDir, '/foo/./bar'), RouteManifestError);
    assert.throws(() => routeToOutputPath(outDir, '/foo\\bar'), RouteManifestError);
    assert.throws(() => routeToOutputPath(outDir, '/foo\0bar'), RouteManifestError);
    assert.throws(() => routeToOutputPath(outDir, '/foo?x=1'), RouteManifestError);
    assert.throws(() => routeToOutputPath(outDir, '/foo#frag'), RouteManifestError);
    assert.throws(() => routeToOutputPath(outDir, 'foo'), RouteManifestError);
    assert.throws(() => routeToOutputPath(outDir, '/foo//bar'), RouteManifestError);
  });

  it('decodes each segment exactly once for filesystem mapping', () => {
    assert.equal(
      routeToOutputPath(outDir, '/blog/caf%C3%A9'),
      join(outDir, 'blog', 'café', 'index.html'),
    );
    assert.equal(
      routeToOutputPath(outDir, '/blog/war%20peace'),
      join(outDir, 'blog', 'war peace', 'index.html'),
    );
    assert.equal(
      routeToOutputPath(outDir, '/blog/café'),
      join(outDir, 'blog', 'café', 'index.html'),
    );
  });

  it('rejects decoded separators, dot segments, and double-encoded input', () => {
    assert.throws(() => routeToOutputPath(outDir, '/blog/a%2Fb'), RouteManifestError);
    assert.throws(() => routeToOutputPath(outDir, '/blog/a%5Cb'), RouteManifestError);
    assert.throws(() => routeToOutputPath(outDir, '/blog/%2e%2e'), RouteManifestError);
    assert.throws(() => routeToOutputPath(outDir, '/blog/%2e'), RouteManifestError);
    assert.throws(() => routeToOutputPath(outDir, '/blog/%252F'), RouteManifestError);
    assert.throws(() => routeToOutputPath(outDir, '/blog/%252e%252e'), RouteManifestError);
    assert.throws(() => routeToOutputPath(outDir, '/blog/a%3Fb'), RouteManifestError);
    assert.throws(() => routeToOutputPath(outDir, '/blog/a%23b'), RouteManifestError);
    assert.throws(() => routeToOutputPath(outDir, '/blog/a%00b'), RouteManifestError);
  });

  it('rejects dot-prefixed segments that would map to hidden paths', () => {
    assert.throws(() => routeToOutputPath(outDir, '/blog/.hidden'), RouteManifestError);
    assert.throws(() => routeToOutputPath(outDir, '/blog/%2Ehidden'), RouteManifestError);
    assert.throws(() => routeToOutputPath(outDir, '/blog/%2ehidden'), RouteManifestError);
    // Ordinary interior dots and Unicode/space siblings stay valid.
    assert.equal(routeToOutputPath(outDir, '/blog/a.b'), join(outDir, 'blog', 'a.b', 'index.html'));
    assert.equal(
      routeToOutputPath(outDir, '/blog/caf%C3%A9'),
      join(outDir, 'blog', 'café', 'index.html'),
    );
  });
});

describe('substituteRouteParams', () => {
  const idEntry = basicManifest.byRoute.get('/blog/:id') as RouteManifestEntry;
  const indexEntry = basicManifest.byRoute.get('/') as RouteManifestEntry;
  const multiEntry = multiManifest.byRoute.get('/shop/:category/:item') as RouteManifestEntry;

  it('substitutes and encodes concrete parameter values', () => {
    assert.equal(substituteRouteParams(idEntry, { id: '42' }), '/blog/42');
    assert.equal(substituteRouteParams(idEntry, { id: 'a/b c' }), '/blog/a%2Fb%20c');
    assert.equal(
      substituteRouteParams(multiEntry, { category: 'books', item: 'war and peace' }),
      '/shop/books/war%20and%20peace',
    );
    assert.equal(substituteRouteParams(indexEntry, {}), '/');
  });

  it('rejects missing and extra parameters', () => {
    assert.throws(() => substituteRouteParams(idEntry, {}), /missing/);
    assert.throws(() => substituteRouteParams(idEntry, { id: '1', extra: '2' }), /unexpected/);
    assert.throws(() => substituteRouteParams(indexEntry, { id: '1' }), RouteManifestError);
  });

  it('rejects unsafe, malformed, and non-string parameter values', () => {
    assert.throws(() => substituteRouteParams(idEntry, { id: '..' }), /unsafe/);
    assert.throws(() => substituteRouteParams(idEntry, { id: '.' }), /unsafe/);
    assert.throws(() => substituteRouteParams(idEntry, { id: 'a\\b' }), /backslash/);
    assert.throws(() => substituteRouteParams(idEntry, { id: '%ZZ' }), /percent/);
    assert.throws(() => substituteRouteParams(idEntry, { id: '' }), /unsafe/);
    assert.throws(() => substituteRouteParams(idEntry, { id: '.hidden' }), /unsafe/);
    // An encoded dot prefix cannot be smuggled through the encoder either.
    assert.throws(() => substituteRouteParams(idEntry, { id: '.%2Ehidden' }), /percent/);
    assert.throws(
      () => substituteRouteParams(idEntry, { id: 1 as unknown as string }),
      /must be a string/,
    );
  });

  it('encodes Unicode and space values that decode back to user-friendly segments', () => {
    const out = join(tmpRoot, 'sub-out');
    assert.equal(substituteRouteParams(idEntry, { id: 'café' }), '/blog/caf%C3%A9');
    assert.equal(substituteRouteParams(idEntry, { id: 'a b' }), '/blog/a%20b');
    assert.equal(
      routeToOutputPath(out, substituteRouteParams(idEntry, { id: 'café' })),
      join(out, 'blog', 'café', 'index.html'),
    );
    assert.equal(
      routeToOutputPath(out, substituteRouteParams(idEntry, { id: 'a b' })),
      join(out, 'blog', 'a b', 'index.html'),
    );
  });

  it('rejects values that would need a second decode to become safe', () => {
    const out = join(tmpRoot, 'sub-out');
    assert.throws(() => substituteRouteParams(idEntry, { id: 'a%2Fb' }), /percent/);
    assert.throws(
      () => routeToOutputPath(out, substituteRouteParams(idEntry, { id: 'a/b' })),
      RouteManifestError,
    );
  });
});
