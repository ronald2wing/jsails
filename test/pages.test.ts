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

import type { RequestContext, Session } from '../src/contracts/http.js';
import type { PageRenderer } from '../src/contracts/render.js';
import {
  loadPageModule,
  PageRenderError,
  preactPageRenderer,
  renderRoute,
} from '../src/pages/page.js';
import type { RouteManifestEntry } from '../src/routing/manifest.js';

const tmpRoot = mkdtempSync(join(fileURLToPath(new URL('..', import.meta.url)), 'pages-'));

after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

const runtimeUrl = new URL('../src/render/jsx-runtime.js', import.meta.url).href;
const componentUrl = new URL('../src/contracts/component.js', import.meta.url).href;

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
): RequestContext {
  const url = new URL('http://localhost/test');
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
