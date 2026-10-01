/**
 * Page loading and route rendering tests.
 *
 * Fixtures are real compiled ESM files written to a temp directory and imported
 * through Node's normal module loader. Their only import is an absolute file URL
 * to the repository's built JSX runtime (and the SERVER_ONLY symbol), so nothing
 * here opens a service connection or depends on a bundler. Because imports are
 * process-global and cached, every fixture uses a unique filename.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import type { RequestContext, Session } from '../../src/contracts/http.js';
import type { PageRenderer } from '../../src/contracts/render.js';
import { createMemoryCacheStore, type CacheStore } from '../../src/cache/index.js';
import {
  loadLayoutModule,
  loadPageModule,
  PageRenderError,
  pageCacheKey,
  preactPageRenderer,
  renderRoute,
} from '../../src/pages/page.js';
import type { RouteManifestEntry } from '../../src/routing/routes.js';

const tmpRoot = mkdtempSync(join(fileURLToPath(new URL('..', import.meta.url)), 'pages-'));

after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

const runtimeUrl = new URL('../../src/jsx/jsx-runtime.js', import.meta.url).href;
const componentUrl = new URL('../../src/contracts/component.js', import.meta.url).href;

let sequence = 0;
/** Write a unique compiled ESM fixture and return its absolute path. */
function writeModule(source: string, extension = '.js'): string {
  const file = join(tmpRoot, `fixture-${sequence++}${extension}`);
  writeFileSync(file, source);
  return file;
}

function pageEntry(file: string, route = '/'): RouteManifestEntry {
  return { kind: 'page', route, file, dynamic: false, catchAll: false, params: [] };
}

function sessionWith(user: string): Session {
  return {
    id: 'session-1',
    csrfToken: 'csrf-token',
    data: { user },
    expiresAt: Date.now() + 60_000,
  };
}

function makeContext(
  params: Record<string, string> = {},
  session: Session | null = null,
  urlString = 'http://localhost/test',
): RequestContext {
  const url = new URL(urlString);
  return { request: new Request(url), url, params, session };
}

const DOCTYPE = '<!DOCTYPE html>';
const SHELL_OPEN = '<html><head><meta charset="utf-8"></head><body>';
const SHELL_CLOSE = '</body></html>';

describe('loadPageModule', () => {
  it('loads a compiled .mjs module with optional load/getStaticPaths', async () => {
    const file = writeModule(
      `import { jsx } from ${JSON.stringify(runtimeUrl)};
       export const getStaticPaths = () => [{ id: '1' }];
       export async function load() { return { ok: true }; }
       export default function Page() { return jsx('p', { children: 'ok' }); }
      `,
      '.mjs',
    );
    const page = await loadPageModule(file);
    assert.equal(typeof page.default, 'function');
    assert.equal(typeof page.load, 'function');
    assert.equal(typeof page.getStaticPaths, 'function');
  });

  it('rejects TypeScript paths before importing', async () => {
    await assert.rejects(
      () => loadPageModule(join(tmpRoot, 'component.ts')),
      (error: unknown) => error instanceof PageRenderError && /\.js or \.mjs/.test(error.message),
    );
  });

  it('rejects a module whose default export is not a function', async () => {
    const file = writeModule('export default 42;\n');
    await assert.rejects(
      () => loadPageModule(file),
      (error: unknown) =>
        error instanceof PageRenderError && /default export must be a function/.test(error.message),
    );
  });

  it('rejects a module with no default export', async () => {
    const file = writeModule('export const load = () => ({});\n');
    await assert.rejects(
      () => loadPageModule(file),
      (error: unknown) => error instanceof PageRenderError,
    );
  });

  it('rejects non-function load and getStaticPaths exports', async () => {
    const file = writeModule(
      'export default function Page() { return null; }\nexport const load = 5;\n',
    );
    await assert.rejects(() => loadPageModule(file), /export "load" must be a function/);

    const other = writeModule(
      'export default function Page() { return null; }\nexport const getStaticPaths = "x";\n',
    );
    await assert.rejects(() => loadPageModule(other), /export "getStaticPaths" must be a function/);
  });

  it('reports an import failure as a PageRenderError', async () => {
    await assert.rejects(
      () => loadPageModule(join(tmpRoot, 'does-not-exist.js')),
      (error: unknown) =>
        error instanceof PageRenderError && /failed to import/.test(error.message),
    );
  });

  it('exposes a valid middleware export as an array of functions', async () => {
    const file = writeModule(
      `export const middleware = [
        async (context, next) => next(),
        () => new Response('ok'),
      ];
       export default function Page() { return null; }
      `,
    );
    const page = await loadPageModule(file);
    assert.ok(Array.isArray(page.middleware));
    assert.equal(page.middleware.length, 2);
    for (const handler of page.middleware) assert.equal(typeof handler, 'function');
  });

  it('rejects a non-array middleware export (value-free)', async () => {
    const file = writeModule(
      `export default function Page() { return null; }
       export const middleware = 'not-an-array';
      `,
    );
    await assert.rejects(
      () => loadPageModule(file),
      (error: unknown) =>
        error instanceof PageRenderError &&
        /exports "middleware" as a non-array value/.test(error.message),
    );
  });

  it('rejects a non-function middleware entry (value-free)', async () => {
    const file = writeModule(
      `export default function Page() { return null; }
       export const middleware = [() => {}, 42];
      `,
    );
    await assert.rejects(
      () => loadPageModule(file),
      (error: unknown) =>
        error instanceof PageRenderError &&
        /exports a non-function middleware entry at index 1/.test(error.message),
    );
  });
});

describe('loadLayoutModule', () => {
  it('loads a compiled layout module with a function default export', async () => {
    const file = writeModule(
      `import { jsx } from ${JSON.stringify(runtimeUrl)};
       export default function Layout({ children }) {
         return jsx('div', { children });
       }
      `,
    );
    const layout = await loadLayoutModule(file);
    assert.equal(typeof layout.default, 'function');
  });

  it('rejects TypeScript paths before importing (value-free)', async () => {
    await assert.rejects(
      () => loadLayoutModule(join(tmpRoot, 'layout.ts')),
      (error: unknown) => error instanceof PageRenderError && /\.js or \.mjs/.test(error.message),
    );
  });

  it('rejects a module whose default export is not a function (value-free)', async () => {
    const file = writeModule('export default null;\n');
    await assert.rejects(
      () => loadLayoutModule(file),
      (error: unknown) =>
        error instanceof PageRenderError && /default export must be a function/.test(error.message),
    );
  });

  it('surfaces a missing module as PageRenderError', async () => {
    await assert.rejects(
      () => loadLayoutModule(join(tmpRoot, 'does-not-exist.js')),
      (error: unknown) =>
        error instanceof PageRenderError && /failed to import/.test(error.message),
    );
  });
});

describe('renderRoute', () => {
  it('awaits async load and passes dynamic params and session to the component', async () => {
    const file = writeModule(
      `import { jsx } from ${JSON.stringify(runtimeUrl)};
       export async function load(context) {
         await Promise.resolve();
         return {
           id: context.params.id,
           user: context.session ? context.session.data.user : 'anon',
         };
       }
       export default function Page({ id, user }) {
         return jsx('p', { children: 'id=' + id + ' user=' + user });
       }
      `,
    );

    const html = await renderRoute(
      pageEntry(file, '/users/:id'),
      makeContext({ id: '42' }, sessionWith('ada')),
    );
    assert.equal(html, `${DOCTYPE}${SHELL_OPEN}<p>id=42 user=ada</p>${SHELL_CLOSE}`);

    const anon = await renderRoute(pageEntry(file, '/users/:id'), makeContext({ id: '7' }));
    assert.equal(anon, `${DOCTYPE}${SHELL_OPEN}<p>id=7 user=anon</p>${SHELL_CLOSE}`);
  });

  it('escapes user-supplied text through Preact, not bespoke logic', async () => {
    const file = writeModule(
      `import { jsx } from ${JSON.stringify(runtimeUrl)};
       export function load() { return { text: "<script>alert('x')</script>" }; }
       export default function Page({ text }) {
         return jsx('div', { children: text });
       }
      `,
    );
    const html = await renderRoute(pageEntry(file), makeContext());
    assert.equal(
      html,
      `${DOCTYPE}${SHELL_OPEN}<div>&lt;script>alert('x')&lt;/script></div>${SHELL_CLOSE}`,
    );
  });

  it('emits a full document once, with a single doctype and root html', async () => {
    const file = writeModule(
      `import { jsx } from ${JSON.stringify(runtimeUrl)};
       export default function Page() {
         return jsx('html', { children: jsx('body', { children: 'full' }) });
       }
      `,
    );
    const html = await renderRoute(pageEntry(file), makeContext());
    assert.equal(html, `${DOCTYPE}<html><body>full</body></html>`);
    assert.equal(html.split(DOCTYPE).length - 1, 1);
    assert.equal(html.split('<html').length - 1, 1);
  });

  it('detects an html root wrapped in a lone fragment', async () => {
    const file = writeModule(
      `import { jsx, Fragment } from ${JSON.stringify(runtimeUrl)};
       export default function Page() {
         return jsx(Fragment, { children: jsx('html', { children: jsx('body', { children: 'frag' }) }) });
       }
      `,
    );
    const html = await renderRoute(pageEntry(file), makeContext());
    assert.equal(html, `${DOCTYPE}<html><body>frag</body></html>`);
  });

  it('does not double-wrap an html root produced by an intermediate component', async () => {
    const file = writeModule(
      `import { jsx } from ${JSON.stringify(runtimeUrl)};
       function Shell() { return jsx('html', { children: jsx('body', { children: 'wrapped' }) }); }
       export default function Page() { return jsx(Shell, {}); }
      `,
    );
    const html = await renderRoute(pageEntry(file), makeContext());
    assert.equal(html, `${DOCTYPE}<html><body>wrapped</body></html>`);
    assert.equal(html.split(DOCTYPE).length - 1, 1);
    assert.equal(html.split('<html').length - 1, 1);
    assert.equal(html.split('<body').length - 1, 1);
  });

  it('wraps a non-html root even when its text looks like an html tag', async () => {
    const file = writeModule(
      `import { jsx } from ${JSON.stringify(runtimeUrl)};
       export default function Page() {
         return jsx('div', { children: '<html>not a document</html>' });
       }
      `,
    );
    const html = await renderRoute(pageEntry(file), makeContext());
    assert.equal(
      html,
      `${DOCTYPE}${SHELL_OPEN}<div>&lt;html>not a document&lt;/html></div>${SHELL_CLOSE}`,
    );
  });

  it('rejects a load result that is not a plain object', async () => {
    const file = writeModule(
      `export function load() { return null; }
       export default function Page() { return null; }
      `,
    );
    await assert.rejects(
      () => renderRoute(pageEntry(file), makeContext()),
      (error: unknown) => error instanceof PageRenderError && /plain object/.test(error.message),
    );
  });

  it('rejects non-page manifest entries', async () => {
    const file = writeModule('export default function Page() { return null; }\n');
    const entry: RouteManifestEntry = { ...pageEntry(file), kind: 'api', route: '/api/x' };
    await assert.rejects(() => renderRoute(entry, makeContext()), /not a page entry/);
  });

  it('rejects a SERVER_ONLY root only in static mode', async () => {
    const file = writeModule(
      `import { SERVER_ONLY } from ${JSON.stringify(componentUrl)};
       import { jsx } from ${JSON.stringify(runtimeUrl)};
       function Page() { return jsx('div', { children: 'live' }); }
       Page[SERVER_ONLY] = true;
       export default Page;
      `,
    );

    await assert.rejects(
      () => renderRoute(pageEntry(file), makeContext(), { staticMode: true }),
      (error: unknown) => error instanceof PageRenderError && /SERVER_ONLY/.test(error.message),
    );

    const html = await renderRoute(pageEntry(file), makeContext());
    assert.equal(html, `${DOCTYPE}${SHELL_OPEN}<div>live</div>${SHELL_CLOSE}`);
  });

  it('does not run middleware: it belongs to the HTTP layer, not renderRoute', async () => {
    // A throwing middleware proves renderRoute only validates the export (via
    // loadPageModule) without ever invoking it — page middleware is applied by
    // the HTTP layer (registerRendererPageRoute), so static rendering is inert.
    const file = writeModule(
      `import { jsx } from ${JSON.stringify(runtimeUrl)};
       export const middleware = [() => { throw new Error('must not run'); }];
       export function load() { return { ran: true }; }
       export default function Page({ ran }) {
         return jsx('p', { children: 'load=' + ran });
       }
       `,
    );
    const html = await renderRoute(pageEntry(file), makeContext());
    assert.equal(html, `${DOCTYPE}${SHELL_OPEN}<p>load=true</p>${SHELL_CLOSE}`);
  });
});

describe('renderRoute layout folding', () => {
  it('wraps the page with a single layout (outermost first = direct child)', async () => {
    const layoutFile = writeModule(
      `import { jsx } from ${JSON.stringify(runtimeUrl)};
       export default function Layout({ children }) {
         return jsx('root-layout', { children });
       }
       `,
    );
    const pageFile = writeModule(
      `import { jsx } from ${JSON.stringify(runtimeUrl)};
       export default function Page() { return jsx('the-page', {}); }
       `,
    );
    const entry = pageEntry(pageFile);
    entry.layouts = [layoutFile];
    const html = await renderRoute(entry, makeContext());
    assert.ok(
      html.includes('<root-layout><the-page></the-page></root-layout>'),
      `expected layout wrapper; got: ${html}`,
    );
  });

  it('folds a two-layout chain inside-out so outermost wraps innermost', async () => {
    const outerFile = writeModule(
      `import { jsx } from ${JSON.stringify(runtimeUrl)};
       export default function Outer({ children }) {
         return jsx('outer', { children });
       }
       `,
    );
    const innerFile = writeModule(
      `import { jsx } from ${JSON.stringify(runtimeUrl)};
       export default function Inner({ children }) {
         return jsx('inner', { children });
       }
       `,
    );
    const pageFile = writeModule(
      `import { jsx } from ${JSON.stringify(runtimeUrl)};
       export default function Page() { return jsx('page', {}); }
       `,
    );
    const entry = pageEntry(pageFile);
    // Outermost first in the array (root → page dir), reverse-fold builds
    // outermost wrapping innermost wrapping page.
    entry.layouts = [outerFile, innerFile];
    const html = await renderRoute(entry, makeContext());
    assert.ok(
      html.includes('<outer><inner><page></page></inner></outer>'),
      `expected outer > inner > page; got: ${html}`,
    );
  });

  it('folds three nested layouts in outermost-first order', async () => {
    const rootFile = writeModule(
      `import { jsx } from ${JSON.stringify(runtimeUrl)};
       export default function Root({ children }) {
         return jsx('root', { children });
       }
       `,
    );
    const groupFile = writeModule(
      `import { jsx } from ${JSON.stringify(runtimeUrl)};
       export default function Group({ children }) {
         return jsx('group', { children });
       }
       `,
    );
    const subdirFile = writeModule(
      `import { jsx } from ${JSON.stringify(runtimeUrl)};
       export default function Subdir({ children }) {
         return jsx('sub', { children });
       }
       `,
    );
    const pageFile = writeModule(
      `import { jsx } from ${JSON.stringify(runtimeUrl)};
       export default function Page() { return jsx('page', {}); }
       `,
    );
    const entry = pageEntry(pageFile);
    entry.layouts = [rootFile, groupFile, subdirFile];
    const html = await renderRoute(entry, makeContext());
    assert.ok(
      html.includes('<root><group><sub><page></page></sub></group></root>'),
      `expected root > group > sub > page; got: ${html}`,
    );
  });

  it('renders unchanged when layouts is absent (null/undefined)', async () => {
    const pageFile = writeModule(
      `import { jsx } from ${JSON.stringify(runtimeUrl)};
       export default function Page() { return jsx('div', { children: 'plain' }); }
       `,
    );
    const entry = pageEntry(pageFile);
    // No layouts property at all.
    const html = await renderRoute(entry, makeContext());
    assert.equal(html, `${DOCTYPE}${SHELL_OPEN}<div>plain</div>${SHELL_CLOSE}`);
  });

  it('renders unchanged when layouts is an empty array', async () => {
    const pageFile = writeModule(
      `import { jsx } from ${JSON.stringify(runtimeUrl)};
       export default function Page() { return jsx('div', { children: 'plain' }); }
       `,
    );
    const entry = pageEntry(pageFile);
    entry.layouts = [];
    const html = await renderRoute(entry, makeContext());
    assert.equal(html, `${DOCTYPE}${SHELL_OPEN}<div>plain</div>${SHELL_CLOSE}`);
  });

  it('passes the resolved page props to every layout', async () => {
    const layoutFile = writeModule(
      `import { jsx } from ${JSON.stringify(runtimeUrl)};
       export default function Layout({ title, children }) {
         return jsx('div', { 'data-title': title, children });
       }
       `,
    );
    const pageFile = writeModule(
      `import { jsx } from ${JSON.stringify(runtimeUrl)};
       export function load() { return { title: 'dashboard' }; }
       export default function Page() { return jsx('page', {}); }
       `,
    );
    const entry = pageEntry(pageFile);
    entry.layouts = [layoutFile];
    const html = await renderRoute(entry, makeContext());
    assert.ok(
      html.includes('data-title="dashboard"'),
      `layout should see page prop 'title'; got: ${html}`,
    );
  });

  it('prevents a page prop named children from overriding the framework slot', async () => {
    // The page's load returns a 'children' prop — but the layout's spread order
    // ({ ...props, children: element }) guarantees the framework element wins.
    const layoutFile = writeModule(
      `import { jsx } from ${JSON.stringify(runtimeUrl)};
       export default function Layout({ children }) {
         return jsx('layout', { children });
       }
       `,
    );
    const pageFile = writeModule(
      `import { jsx } from ${JSON.stringify(runtimeUrl)};
       export function load() { return { children: 'evil' }; }
       export default function Page({ children }) {
         return jsx('page', { children: 'page-saw-children-prop=' + children });
       }
       `,
    );
    const entry = pageEntry(pageFile);
    entry.layouts = [layoutFile];
    const html = await renderRoute(entry, makeContext());
    // The page rendering sees its own 'children' prop ('evil'), but the layout
    // wraps the page element, not the string 'evil'.
    assert.ok(
      html.includes('<layout><page>page-saw-children-prop=evil</page></layout>'),
      `layout should wrap the page VNode, not the 'children' prop string; got: ${html}`,
    );
  });

  it('suppresses the minimal document shell when the outermost layout emits <html>', async () => {
    const layoutFile = writeModule(
      `import { jsx } from ${JSON.stringify(runtimeUrl)};
       export default function Layout({ children }) {
         return jsx('html', { children: jsx('body', { children }) });
       }
       `,
    );
    const pageFile = writeModule(
      `import { jsx } from ${JSON.stringify(runtimeUrl)};
       export default function Page() { return jsx('p', { children: 'content' }); }
       `,
    );
    const entry = pageEntry(pageFile);
    entry.layouts = [layoutFile];
    const html = await renderRoute(entry, makeContext());
    assert.equal(html, `${DOCTYPE}<html><body><p>content</p></body></html>`);
    // The minimal shell (<head><meta charset=...) must NOT appear.
    assert.ok(!html.includes('<head>'), 'expected no head element from the minimal shell');
  });

  it('preserves layout nesting when staticMode is true', async () => {
    const outerFile = writeModule(
      `import { jsx } from ${JSON.stringify(runtimeUrl)};
       export default function Outer({ children }) {
         return jsx('outer', { children });
       }
       `,
    );
    const pageFile = writeModule(
      `import { jsx } from ${JSON.stringify(runtimeUrl)};
       export default function Page() { return jsx('page', {}); }
       `,
    );
    const entry = pageEntry(pageFile);
    entry.layouts = [outerFile];
    const html = await renderRoute(entry, makeContext(), { staticMode: true });
    assert.ok(
      html.includes('<outer><page></page></outer>'),
      `expected static-mode layout nesting; got: ${html}`,
    );
  });

  it('surfaces a bad layout module import as a value-free PageRenderError', async () => {
    const pageFile = writeModule(
      `import { jsx } from ${JSON.stringify(runtimeUrl)};
       export default function Page() { return jsx('page', {}); }
       `,
    );
    const entry = pageEntry(pageFile);
    entry.layouts = [join(tmpRoot, 'nonexistent-layout.js')];
    await assert.rejects(
      () => renderRoute(entry, makeContext()),
      (error: unknown) =>
        error instanceof PageRenderError && /failed to import/.test(error.message),
    );
  });
});

describe('preactPageRenderer', () => {
  it('implements PageRenderer and matches renderRoute output', async () => {
    const file = writeModule(
      `import { jsx } from ${JSON.stringify(runtimeUrl)};
       export default function Page() { return jsx('p', { children: 'seam' }); }
      `,
    );
    const renderer: PageRenderer = preactPageRenderer;
    assert.equal(typeof renderer.render, 'function');

    const entry = pageEntry(file);
    const context = makeContext();
    assert.equal(await renderer.render(entry, context), await renderRoute(entry, context));
  });

  it('forwards static mode to the built-in SERVER_ONLY guard', async () => {
    const file = writeModule(
      `import { SERVER_ONLY } from ${JSON.stringify(componentUrl)};
       export default function Page() { return null; }
       Page[SERVER_ONLY] = true;
      `,
    );
    await assert.rejects(
      () =>
        Promise.resolve(
          preactPageRenderer.render(pageEntry(file), makeContext(), { staticMode: true }),
        ),
      (error: unknown) => error instanceof PageRenderError && /SERVER_ONLY/.test(error.message),
    );
  });
});

describe('pageCacheKey', () => {
  const dummyFile = writeModule(
    `import { jsx } from ${JSON.stringify(runtimeUrl)};
     export default function Page() { return jsx('p', {}); }
    `,
  );

  it('produces the same key for identical route, params, and query', () => {
    const entry = pageEntry(dummyFile, '/users/:id');
    const ctx = makeContext({ id: '42' }, null, 'http://localhost/test?a=1&b=2');
    assert.equal(pageCacheKey(entry, ctx), pageCacheKey(entry, ctx));
  });

  it('produces different keys for different params', () => {
    const entry = pageEntry(dummyFile, '/users/:id');
    const a = pageCacheKey(entry, makeContext({ id: '42' }));
    const b = pageCacheKey(entry, makeContext({ id: '99' }));
    assert.notEqual(a, b);
  });

  it('is insensitive to query parameter order', () => {
    const entry = pageEntry(dummyFile, '/search');
    const a = pageCacheKey(entry, makeContext({}, null, 'http://localhost/test?a=1&b=2'));
    const b = pageCacheKey(entry, makeContext({}, null, 'http://localhost/test?b=2&a=1'));
    assert.equal(a, b);
  });

  it('produces different keys for different query values', () => {
    const entry = pageEntry(dummyFile, '/search');
    const a = pageCacheKey(entry, makeContext({}, null, 'http://localhost/test?q=hello'));
    const b = pageCacheKey(entry, makeContext({}, null, 'http://localhost/test?q=world'));
    assert.notEqual(a, b);
  });

  it('omits the query hash when query is empty', () => {
    const entry = pageEntry(dummyFile, '/about');
    const key = pageCacheKey(entry, makeContext());
    assert.ok(!key.includes('q:'), `expected no query hash in key, got: ${key}`);
  });

  it('includes the jsails:page namespace prefix', () => {
    const entry = pageEntry(dummyFile, '/');
    const key = pageCacheKey(entry, makeContext());
    assert.ok(key.startsWith('jsails:page:'), `expected jsails:page: prefix, got: ${key}`);
  });

  it('produces different keys for different route patterns with same params', () => {
    const entryA = pageEntry(dummyFile, '/users/:id');
    const entryB = pageEntry(dummyFile, '/posts/:id');
    const a = pageCacheKey(entryA, makeContext({ id: '1' }));
    const b = pageCacheKey(entryB, makeContext({ id: '1' }));
    assert.notEqual(a, b);
  });
});

describe('loadPageModule revalidate', () => {
  it('rejects a non-positive revalidate with PageRenderError', async () => {
    const file = writeModule(
      `export default function Page() { return null; }
       export const revalidate = 0;
      `,
    );
    await assert.rejects(
      () => loadPageModule(file),
      (error: unknown) =>
        error instanceof PageRenderError &&
        /revalidate.*must be a positive number/.test(error.message),
    );
  });

  it('rejects a non-number revalidate with PageRenderError', async () => {
    const file = writeModule(
      `export default function Page() { return null; }
       export const revalidate = '60';
      `,
    );
    await assert.rejects(
      () => loadPageModule(file),
      (error: unknown) =>
        error instanceof PageRenderError &&
        /revalidate.*must be a positive number/.test(error.message),
    );
  });

  it('rejects NaN and Infinity as revalidate values', async () => {
    const nanFile = writeModule(
      `export default function Page() { return null; }
       export const revalidate = NaN;
      `,
    );
    await assert.rejects(() => loadPageModule(nanFile), /revalidate.*must be a positive number/);

    const infFile = writeModule(
      `export default function Page() { return null; }
       export const revalidate = Infinity;
      `,
    );
    await assert.rejects(() => loadPageModule(infFile), /revalidate.*must be a positive number/);
  });

  it('accepts a valid positive number for revalidate', async () => {
    const file = writeModule(
      `import { jsx } from ${JSON.stringify(runtimeUrl)};
       export const revalidate = 60;
       export default function Page() { return jsx('p', { children: 'ok' }); }
      `,
    );
    const page = await loadPageModule(file);
    assert.equal(page.revalidate, 60);
  });
});

describe('renderRoute caching', () => {
  it('caches load result when revalidate is set and cache store is available', async () => {
    // The counter in `load` verifies caching: if the second render hits the
    // cache, `load` is not called again and count stays 1. Without caching it
    // would be 2.
    const file = writeModule(
      `import { jsx } from ${JSON.stringify(runtimeUrl)};
       export const revalidate = 60;
       const calls = [];
       export function load() {
         calls.push(1);
         return { count: calls.length };
       }
       export default function Page({ count }) {
         return jsx('p', { children: 'count=' + count });
       }
      `,
    );
    const cache = createMemoryCacheStore();
    const services: Record<string, unknown> = {
      has: () => true,
      tryGet: () => cache,
      get: () => cache,
    };
    const entry = pageEntry(file, '/cached');
    const ctx = { ...makeContext(), services } as unknown as RequestContext;

    const html1 = await renderRoute(entry, ctx);
    const html2 = await renderRoute(entry, ctx);

    assert.equal(html1, `${DOCTYPE}${SHELL_OPEN}<p>count=1</p>${SHELL_CLOSE}`);
    assert.equal(html2, `${DOCTYPE}${SHELL_OPEN}<p>count=1</p>${SHELL_CLOSE}`);
  });

  it('calls load fresh when revalidate is set but no cache store is available', async () => {
    const file = writeModule(
      `import { jsx } from ${JSON.stringify(runtimeUrl)};
       export const revalidate = 60;
       const calls = [];
       export function load() {
         calls.push(1);
         return { count: calls.length };
       }
       export default function Page({ count }) {
         return jsx('p', { children: 'count=' + count });
       }
      `,
    );
    const entry = pageEntry(file, '/nocache');
    const ctx = makeContext(); // no services

    const html1 = await renderRoute(entry, ctx);
    const html2 = await renderRoute(entry, ctx);

    // load called each render: count increments
    assert.equal(html1, `${DOCTYPE}${SHELL_OPEN}<p>count=1</p>${SHELL_CLOSE}`);
    assert.equal(html2, `${DOCTYPE}${SHELL_OPEN}<p>count=2</p>${SHELL_CLOSE}`);
  });

  it('calls load fresh when revalidate is set but staticMode is true', async () => {
    const file = writeModule(
      `import { jsx } from ${JSON.stringify(runtimeUrl)};
       export const revalidate = 60;
       const calls = [];
       export function load() {
         calls.push(1);
         return { count: calls.length };
       }
       export default function Page({ count }) {
         return jsx('p', { children: 'count=' + count });
       }
      `,
    );
    const cache = createMemoryCacheStore();
    const services: Record<string, unknown> = {
      has: () => true,
      tryGet: () => cache,
      get: () => cache,
    };
    const entry = pageEntry(file, '/static-cached');
    const ctx = { ...makeContext(), services } as unknown as RequestContext;

    await renderRoute(entry, ctx, { staticMode: true });
    const html = await renderRoute(entry, ctx, { staticMode: true });

    // static mode bypasses cache: count increments
    assert.equal(html, `${DOCTYPE}${SHELL_OPEN}<p>count=2</p>${SHELL_CLOSE}`);
  });

  it('renders fresh when the cache store remember throws', async () => {
    const file = writeModule(
      `import { jsx } from ${JSON.stringify(runtimeUrl)};
       export const revalidate = 60;
       export function load() { return { ok: true }; }
       export default function Page({ ok }) {
         return ok ? jsx('p', { children: 'fresh' }) : null;
       }
      `,
    );
    const brokenStore: CacheStore = {
      get: () => Promise.resolve(null),
      set: () => Promise.resolve(),
      delete: () => Promise.resolve(),
      remember: () => Promise.reject(new Error('backend down')),
      close: () => Promise.resolve(),
    };
    const services: Record<string, unknown> = {
      has: () => true,
      tryGet: () => brokenStore,
      get: () => brokenStore,
    };
    const entry = pageEntry(file, '/broken-cache');
    const ctx = { ...makeContext(), services } as unknown as RequestContext;

    const html = await renderRoute(entry, ctx);
    assert.equal(html, `${DOCTYPE}${SHELL_OPEN}<p>fresh</p>${SHELL_CLOSE}`);
  });

  it('caches load result only for matching route+params+query, not unrelated requests', async () => {
    // Two routes that share the same page file (simulated by using one
    // compiled module) but have different params should produce different
    // cache keys and therefore independent cache entries.
    const file = writeModule(
      `import { jsx } from ${JSON.stringify(runtimeUrl)};
       export const revalidate = 60;
       const counts = {};
       export function load(context) {
         const id = context.params.id;
         counts[id] = (counts[id] || 0) + 1;
         return { id, count: counts[id] };
       }
       export default function Page({ id, count }) {
         return jsx('p', { children: 'id=' + id + ' count=' + count });
       }
      `,
    );
    const cache = createMemoryCacheStore();
    const services: Record<string, unknown> = {
      has: () => true,
      tryGet: () => cache,
      get: () => cache,
    };
    const entry = pageEntry(file, '/items/:id');

    const ctx42 = { ...makeContext({ id: '42' }), services } as unknown as RequestContext;
    const ctx99 = { ...makeContext({ id: '99' }), services } as unknown as RequestContext;

    await renderRoute(entry, ctx42);
    await renderRoute(entry, ctx42); // cached hit → count stays 1
    const html42 = await renderRoute(entry, ctx42);
    assert.equal(html42, `${DOCTYPE}${SHELL_OPEN}<p>id=42 count=1</p>${SHELL_CLOSE}`);

    const html99 = await renderRoute(entry, ctx99);
    // id=99 is a different cache key, so it loads fresh
    assert.ok(html99.includes('id=99 count=1'), `expected fresh count, got: ${html99}`);
  });
});
