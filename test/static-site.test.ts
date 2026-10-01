/**
 * Static site generation tests.
 *
 * Page fixtures are real compiled ESM modules written to a temp directory and
 * imported through Node's normal loader with an absolute file URL to the
 * repository's built JSX runtime. Nothing here starts a server, an ORM, or a
 * queue; rendering, escaping, and asset copying all run in-process.
 */

import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';

import type { PageRenderer } from '../src/contracts/render.js';
import {
  createServiceToken,
  runExtensions,
  type ServiceRegistry,
} from '../src/extensions/index.js';
import {
  generateStaticSite,
  StaticSiteError,
  type GenerateStaticSiteResult,
} from '../src/pages/static-site.js';
import type { RouteManifest, RouteManifestEntry } from '../src/routing/manifest.js';

const root = mkdtempSync(join(tmpdir(), 'jsails-static-site-'));

after(() => {
  rmSync(root, { recursive: true, force: true });
});

const runtimeUrl = new URL('../src/render/jsx-runtime.js', import.meta.url).href;

let sequence = 0;
/** Write a unique compiled ESM fixture and return its absolute path. */
function writeModule(source: string): string {
  const file = join(root, `module-${sequence++}.js`);
  writeFileSync(file, source);
  return file;
}

/** Create an isolated directory for one test case. */
function caseDir(): string {
  return mkdtempSync(join(root, 'case-'));
}

function pageEntry(
  route: string,
  file: string,
  dynamic = false,
  params: string[] = [],
): RouteManifestEntry {
  return { kind: 'page', route, file, dynamic, catchAll: false, params };
}

function apiEntry(route: string, file: string): RouteManifestEntry {
  return {
    kind: 'api',
    route,
    file,
    dynamic: false,
    catchAll: false,
    params: [],
  };
}

function manifestOf(entries: RouteManifestEntry[]): RouteManifest {
  return {
    entries,
    byRoute: new Map(entries.map((entry) => [entry.route, entry])),
  };
}

const jsx = (children: string): string => `import { jsx } from ${JSON.stringify(runtimeUrl)};
export default function Page() { return jsx('div', { children: ${JSON.stringify(children)} }); }
`;

describe('generateStaticSite', () => {
  it('renders static and dynamic pages, copies assets, skips API, and rebuilds its own output', async () => {
    const base = caseDir();
    const out = join(base, 'out');
    const pub = join(base, 'public');
    mkdirSync(join(pub, 'assets'), { recursive: true });

    const home = writeModule(
      `import { jsx } from ${JSON.stringify(runtimeUrl)};
       export default function Page() { return jsx('h1', { children: 'Home' }); }
      `,
    );
    const post = writeModule(
      `import { jsx } from ${JSON.stringify(runtimeUrl)};
       export function load(context) { return { slug: context.params.slug }; }
       export const getStaticPaths = () => [{ slug: 'a' }, { slug: 'b' }];
       export default function Page({ slug }) { return jsx('p', { children: 'post ' + slug }); }
      `,
    );
    writeFileSync(join(pub, 'robots.txt'), 'User-agent: *\n');
    writeFileSync(join(pub, 'assets', 'app.css'), 'body{color:red}');

    const manifest = manifestOf([
      pageEntry('/', home),
      pageEntry('/blog/:slug', post, true, ['slug']),
      apiEntry('/api/ping', join(base, 'api-ping.js')),
    ]);

    const first: GenerateStaticSiteResult = await generateStaticSite({
      manifest,
      outDir: out,
      publicDir: pub,
      baseUrl: 'https://example.com',
    });

    assert.deepEqual(Object.keys(first).sort(), ['copied', 'skipped', 'written']);
    assert.deepEqual(first.skipped, ['/api/ping']);
    assert.deepEqual(first.written, [
      join(out, 'index.html'),
      join(out, 'blog', 'a', 'index.html'),
      join(out, 'blog', 'b', 'index.html'),
    ]);
    assert.deepEqual(first.copied, [join(out, 'assets', 'app.css'), join(out, 'robots.txt')]);

    assert.match(readFileSync(join(out, 'index.html'), 'utf8'), /<h1>Home<\/h1>/);
    assert.match(readFileSync(join(out, 'blog', 'a', 'index.html'), 'utf8'), /<p>post a<\/p>/);
    assert.match(readFileSync(join(out, 'blog', 'b', 'index.html'), 'utf8'), /<p>post b<\/p>/);
    assert.equal(readFileSync(join(out, 'robots.txt'), 'utf8'), 'User-agent: *\n');

    // The second build replaces a directory this build itself owns.
    const second = await generateStaticSite({
      manifest,
      outDir: out,
      publicDir: pub,
      baseUrl: 'https://example.com',
    });
    assert.deepEqual(second.written, first.written);
    assert.match(readFileSync(join(out, 'blog', 'a', 'index.html'), 'utf8'), /<p>post a<\/p>/);
  });

  it('writes Unicode and space parameters to user-friendly directories', async () => {
    const base = caseDir();
    const out = join(base, 'out');
    const post = writeModule(
      `import { jsx } from ${JSON.stringify(runtimeUrl)};
       export const getStaticPaths = () => [{ slug: 'café' }, { slug: 'hello world' }];
       export function load(context) { return { slug: context.params.slug }; }
       export default function Page({ slug }) { return jsx('p', { children: slug }); }
      `,
    );

    const result = await generateStaticSite({
      manifest: manifestOf([pageEntry('/blog/:slug', post, true, ['slug'])]),
      outDir: out,
    });

    assert.deepEqual(result.written, [
      join(out, 'blog', 'café', 'index.html'),
      join(out, 'blog', 'hello world', 'index.html'),
    ]);
    assert.match(readFileSync(join(out, 'blog', 'café', 'index.html'), 'utf8'), /café/);
    assert.match(
      readFileSync(join(out, 'blog', 'hello world', 'index.html'), 'utf8'),
      /hello world/,
    );
  });

  it('builds request URLs from baseUrl and rejects non-http(s) values', async () => {
    const base = caseDir();
    const out = join(base, 'out');
    const file = writeModule(
      `import { jsx } from ${JSON.stringify(runtimeUrl)};
       export default function Page(_props, context) { return jsx('span', { children: context.url.origin }); }
      `,
    );
    const manifest = manifestOf([pageEntry('/', file)]);

    await generateStaticSite({
      manifest,
      outDir: out,
      baseUrl: 'https://example.com',
    });
    assert.match(readFileSync(join(out, 'index.html'), 'utf8'), /https:\/\/example\.com/);

    await assert.rejects(
      () =>
        generateStaticSite({
          manifest,
          outDir: join(base, 'other'),
          baseUrl: 'ftp://example.com',
        }),
      (error: unknown) => error instanceof StaticSiteError && /http or https/.test(error.message),
    );
    assert.equal(existsSync(join(base, 'other')), false);
  });

  it('escapes rendered text through Preact rather than a bespoke escaper', async () => {
    const base = caseDir();
    const out = join(base, 'out');
    const file = writeModule(
      `import { jsx } from ${JSON.stringify(runtimeUrl)};
       export function load() { return { text: "<script>alert('x')</script>" }; }
       export default function Page({ text }) { return jsx('div', { children: text }); }
      `,
    );

    await generateStaticSite({
      manifest: manifestOf([pageEntry('/', file)]),
      outDir: out,
    });
    const html = readFileSync(join(out, 'index.html'), 'utf8');
    assert.match(html, /&lt;script>alert\('x'\)&lt;\/script>/);
    assert.doesNotMatch(html, /<script>alert/);
  });

  it('fails before writing when a dynamic page lacks getStaticPaths', async () => {
    const base = caseDir();
    const out = join(base, 'out');
    const file = writeModule(jsx('x'));

    await assert.rejects(
      () =>
        generateStaticSite({
          manifest: manifestOf([pageEntry('/blog/:slug', file, true, ['slug'])]),
          outDir: out,
        }),
      (error: unknown) => error instanceof StaticSiteError && /getStaticPaths/.test(error.message),
    );
    assert.equal(existsSync(out), false);
  });

  it('rejects invalid and duplicate dynamic parameter records before writing', async () => {
    const base = caseDir();
    const out = join(base, 'out');

    const bad = writeModule(
      `import { jsx } from ${JSON.stringify(runtimeUrl)};
       export const getStaticPaths = () => [{ slug: 7 }];
       export default function Page() { return jsx('p', { children: 'x' }); }
      `,
    );
    await assert.rejects(
      () =>
        generateStaticSite({
          manifest: manifestOf([pageEntry('/blog/:slug', bad, true, ['slug'])]),
          outDir: out,
        }),
      (error: unknown) =>
        error instanceof StaticSiteError && /must be a string/.test(error.message),
    );

    const dup = writeModule(
      `import { jsx } from ${JSON.stringify(runtimeUrl)};
       export const getStaticPaths = () => [{ slug: 'a' }, { slug: 'a' }];
       export default function Page({ slug }) { return jsx('p', { children: slug }); }
      `,
    );
    await assert.rejects(
      () =>
        generateStaticSite({
          manifest: manifestOf([pageEntry('/blog/:slug', dup, true, ['slug'])]),
          outDir: out,
        }),
      (error: unknown) => error instanceof StaticSiteError && /collision/.test(error.message),
    );
    assert.equal(existsSync(out), false);
  });

  it('preserves a prior build when the next build fails to render', async () => {
    const base = caseDir();
    const out = join(base, 'out');
    const good = writeModule(jsx('stable'));
    const manifest = manifestOf([pageEntry('/', good)]);

    await generateStaticSite({ manifest, outDir: out });
    assert.match(readFileSync(join(out, 'index.html'), 'utf8'), /stable/);

    const boom = writeModule(
      `import { jsx } from ${JSON.stringify(runtimeUrl)};
       export default function Page() { throw new Error('boom'); }
      `,
    );
    await assert.rejects(() =>
      generateStaticSite({
        manifest: manifestOf([pageEntry('/', boom)]),
        outDir: out,
      }),
    );
    assert.match(readFileSync(join(out, 'index.html'), 'utf8'), /stable/);
  });

  it('refuses a foreign non-empty output directory without touching it', async () => {
    const base = caseDir();
    const out = join(base, 'out');
    mkdirSync(out);
    writeFileSync(join(out, 'keep.txt'), 'precious');
    const file = writeModule(jsx('x'));

    await assert.rejects(
      () =>
        generateStaticSite({
          manifest: manifestOf([pageEntry('/', file)]),
          outDir: out,
        }),
      (error: unknown) =>
        error instanceof StaticSiteError && /ownership marker/.test(error.message),
    );
    assert.equal(readFileSync(join(out, 'keep.txt'), 'utf8'), 'precious');
    assert.deepEqual(readdirSync(out), ['keep.txt']);
  });

  it('refuses a forged or truncated ownership marker without touching the directory', async () => {
    const file = writeModule(jsx('x'));

    for (const forged of ['{"generator":"other","version":1}\n', '{"generator":"jsails"']) {
      const base = caseDir();
      const out = join(base, 'out');
      mkdirSync(out);
      writeFileSync(join(out, '.jsails-static-site.json'), forged);
      writeFileSync(join(out, 'valuable.txt'), 'precious');

      await assert.rejects(
        () =>
          generateStaticSite({
            manifest: manifestOf([pageEntry('/', file)]),
            outDir: out,
          }),
        (error: unknown) =>
          error instanceof StaticSiteError && /ownership marker/.test(error.message),
      );
      assert.equal(readFileSync(join(out, 'valuable.txt'), 'utf8'), 'precious');
      assert.deepEqual(readdirSync(out).sort(), ['.jsails-static-site.json', 'valuable.txt']);
    }
  });

  it('rejects dot-prefixed dynamic parameters without writing a hidden page', async () => {
    const base = caseDir();
    const out = join(base, 'out');
    const file = writeModule(
      `import { jsx } from ${JSON.stringify(runtimeUrl)};
       export const getStaticPaths = () => [{ slug: '.hidden' }];
       export default function Page() { return jsx('p', { children: 'x' }); }
      `,
    );

    await assert.rejects(() =>
      generateStaticSite({
        manifest: manifestOf([pageEntry('/p/:slug', file, true, ['slug'])]),
        outDir: out,
      }),
    );
    assert.equal(existsSync(out), false);
    assert.equal(existsSync(join(out, 'p', '.hidden', 'index.html')), false);
  });

  it('rejects public-asset collisions with rendered pages', async () => {
    const base = caseDir();
    const out = join(base, 'out');
    const pub = join(base, 'public');
    mkdirSync(pub);
    writeFileSync(join(pub, 'index.html'), 'taken');
    const file = writeModule(jsx('x'));

    await assert.rejects(
      () =>
        generateStaticSite({
          manifest: manifestOf([pageEntry('/', file)]),
          outDir: out,
          publicDir: pub,
        }),
      (error: unknown) => error instanceof StaticSiteError && /collision/.test(error.message),
    );
    assert.equal(existsSync(out), false);
  });

  it('skips hidden public files so secrets are not published', async () => {
    const base = caseDir();
    const out = join(base, 'out');
    const pub = join(base, 'public');
    mkdirSync(pub);
    writeFileSync(join(pub, '.env'), 'SECRET=1');
    writeFileSync(join(pub, 'ok.txt'), 'ok');
    const file = writeModule(jsx('x'));

    const result = await generateStaticSite({
      manifest: manifestOf([pageEntry('/', file)]),
      outDir: out,
      publicDir: pub,
    });

    assert.deepEqual(result.copied, [join(out, 'ok.txt')]);
    assert.equal(existsSync(join(out, '.env')), false);
    assert.equal(existsSync(join(out, 'ok.txt')), true);
  });

  it('rejects symlinks in the public directory', async () => {
    const base = caseDir();
    const out = join(base, 'out');
    const pub = join(base, 'public');
    mkdirSync(pub);
    writeFileSync(join(base, 'target.css'), 'x');
    symlinkSync(join(base, 'target.css'), join(pub, 'linked.css'));
    const file = writeModule(jsx('x'));

    await assert.rejects(
      () =>
        generateStaticSite({
          manifest: manifestOf([pageEntry('/', file)]),
          outDir: out,
          publicDir: pub,
        }),
      (error: unknown) => error instanceof StaticSiteError && /symlink/.test(error.message),
    );
    assert.equal(existsSync(out), false);
  });

  it('rejects a symlinked output path ancestry', async () => {
    const base = caseDir();
    const real = join(base, 'real');
    mkdirSync(real);
    const link = join(base, 'link');
    symlinkSync(real, link);
    const file = writeModule(jsx('x'));

    await assert.rejects(
      () =>
        generateStaticSite({
          manifest: manifestOf([pageEntry('/', file)]),
          outDir: join(link, 'out'),
        }),
      (error: unknown) => error instanceof StaticSiteError && /symlink/.test(error.message),
    );
  });

  it('rejects traversal in dynamic parameter values', async () => {
    const base = caseDir();
    const out = join(base, 'out');
    const file = writeModule(
      `import { jsx } from ${JSON.stringify(runtimeUrl)};
       export const getStaticPaths = () => [{ slug: '..' }];
       export default function Page() { return jsx('p', { children: 'x' }); }
      `,
    );

    await assert.rejects(() =>
      generateStaticSite({
        manifest: manifestOf([pageEntry('/p/:slug', file, true, ['slug'])]),
        outDir: out,
      }),
    );
    assert.equal(existsSync(out), false);
  });

  it('rejects an outDir that contains its source modules', async () => {
    const file = writeModule(jsx('x'));

    await assert.rejects(
      () =>
        generateStaticSite({
          manifest: manifestOf([pageEntry('/', file)]),
          outDir: dirname(file),
        }),
      (error: unknown) =>
        error instanceof StaticSiteError && /contain manifest module/.test(error.message),
    );
  });
});

describe('generateStaticSite custom renderer', () => {
  it('renders static and dynamic routes through the supplied renderer, never the page component', async () => {
    const base = caseDir();
    const out = join(base, 'out');
    // Both components throw: reaching the Preact path would fail the build.
    const home = writeModule(
      `export default function Page() { throw new Error('preact path must not run'); }`,
    );
    const post = writeModule(
      `export const getStaticPaths = () => [{ slug: 'a' }, { slug: 'b' }];
       export default function Page() { throw new Error('preact path must not run'); }`,
    );
    const calls: string[] = [];
    const renderer: PageRenderer = {
      render(entry, context) {
        calls.push(`${entry.route}|${context.params.slug ?? '-'}`);
        return `<custom data-route="${entry.route}">${context.params.slug ?? 'home'}</custom>`;
      },
    };

    const result = await generateStaticSite({
      manifest: manifestOf([pageEntry('/', home), pageEntry('/blog/:slug', post, true, ['slug'])]),
      outDir: out,
      renderer,
    });

    assert.deepEqual(result.written, [
      join(out, 'index.html'),
      join(out, 'blog', 'a', 'index.html'),
      join(out, 'blog', 'b', 'index.html'),
    ]);
    assert.deepEqual(calls, ['/|-', '/blog/:slug|a', '/blog/:slug|b']);
    assert.match(
      readFileSync(join(out, 'index.html'), 'utf8'),
      /^<custom data-route="\/">home<\/custom>$/,
    );
    assert.match(
      readFileSync(join(out, 'blog', 'a', 'index.html'), 'utf8'),
      /^<custom data-route="\/blog\/:slug">a<\/custom>$/,
    );
  });

  it('threads storagePath into the synthesized page context', async () => {
    const base = caseDir();
    const out = join(base, 'out');
    const file = writeModule(
      `export default function Page() { throw new Error('preact path must not run'); }`,
    );
    let seenStoragePath: string | undefined;
    const renderer: PageRenderer = {
      render(_entry, context) {
        seenStoragePath = context.storagePath;
        return '<p>x</p>';
      },
    };

    await generateStaticSite({
      manifest: manifestOf([pageEntry('/', file)]),
      outDir: out,
      renderer,
      storagePath: '/data/app/storage',
    });

    assert.equal(seenStoragePath, '/data/app/storage');
  });

  it('leaves storagePath absent from the synthesized context when not supplied', async () => {
    const base = caseDir();
    const out = join(base, 'out');
    const file = writeModule(
      `export default function Page() { throw new Error('preact path must not run'); }`,
    );
    let seenStoragePath: string | undefined = 'absent';
    const renderer: PageRenderer = {
      render(_entry, context) {
        seenStoragePath = context.storagePath;
        return '<p>x</p>';
      },
    };

    await generateStaticSite({
      manifest: manifestOf([pageEntry('/', file)]),
      outDir: out,
      renderer,
    });

    assert.equal(seenStoragePath, undefined);
  });

  it('still enforces the compiled getStaticPaths contract for dynamic routes', async () => {
    const base = caseDir();
    const out = join(base, 'out');
    const file = writeModule(
      `export default function Page() { throw new Error('preact path must not run'); }`,
    );
    let rendered = false;
    const renderer: PageRenderer = {
      render() {
        rendered = true;
        return '<p>x</p>';
      },
    };

    await assert.rejects(
      () =>
        generateStaticSite({
          manifest: manifestOf([pageEntry('/blog/:slug', file, true, ['slug'])]),
          outDir: out,
          renderer,
        }),
      (error: unknown) => error instanceof StaticSiteError && /getStaticPaths/.test(error.message),
    );
    assert.equal(rendered, false);
    assert.equal(existsSync(out), false);
  });

  it('awaits async renderer results and rejects a non-string return before writing', async () => {
    const base = caseDir();
    const out = join(base, 'out');
    const file = writeModule(
      `export default function Page() { throw new Error('preact path must not run'); }`,
    );
    const asyncRenderer: PageRenderer = {
      async render() {
        await Promise.resolve();
        return '<async>ok</async>';
      },
    };

    const result = await generateStaticSite({
      manifest: manifestOf([pageEntry('/', file)]),
      outDir: out,
      renderer: asyncRenderer,
    });
    assert.deepEqual(result.written, [join(out, 'index.html')]);
    assert.equal(readFileSync(join(out, 'index.html'), 'utf8'), '<async>ok</async>');

    const badOut = join(base, 'bad-out');
    const badRenderer: PageRenderer = {
      render: (() => 42) as unknown as PageRenderer['render'],
    };
    await assert.rejects(
      () =>
        generateStaticSite({
          manifest: manifestOf([pageEntry('/', file)]),
          outDir: badOut,
          renderer: badRenderer,
        }),
      (error: unknown) =>
        error instanceof StaticSiteError && /must return an HTML string/.test(error.message),
    );
    assert.equal(existsSync(badOut), false);
  });

  it('exposes a typed non-database service from runExtensions through context.services', async () => {
    const base = caseDir();
    const out = join(base, 'out');
    const file = writeModule(
      `export default function Page() { throw new Error('preact path must not run'); }`,
    );
    const token = createServiceToken<{ label: string }>('greeter');
    const runtime = await runExtensions([
      {
        name: 'greeter-extension',
        setup({ services }) {
          services.provide(token, { label: 'from-extension' });
        },
      },
    ]);

    try {
      let observed: ServiceRegistry | undefined;
      const renderer: PageRenderer = {
        render(_entry, context) {
          observed = context.services;
          const service = context.services?.get(token);
          return `<p>${service?.label ?? 'missing'}</p>`;
        },
      };

      await generateStaticSite({
        manifest: manifestOf([pageEntry('/', file)]),
        outDir: out,
        renderer,
        services: runtime.services,
      });

      assert.equal(observed, runtime.services);
      assert.equal(readFileSync(join(out, 'index.html'), 'utf8'), '<p>from-extension</p>');
    } finally {
      await runtime.close();
    }
  });

  it('leaves context.services absent when no registry is supplied', async () => {
    const base = caseDir();
    const out = join(base, 'out');
    const file = writeModule(
      `export default function Page() { throw new Error('preact path must not run'); }`,
    );
    let present: boolean | undefined;
    const renderer: PageRenderer = {
      render(_entry, context) {
        present = 'services' in context;
        return '<p>no services</p>';
      },
    };

    await generateStaticSite({
      manifest: manifestOf([pageEntry('/', file)]),
      outDir: out,
      renderer,
    });

    assert.equal(present, false);
    assert.equal(readFileSync(join(out, 'index.html'), 'utf8'), '<p>no services</p>');
  });
});
