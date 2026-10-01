/**
 * Live-serving tests for catch-all routes: a required `[...slug]` and an
 * optional `[[...slug]]` page both serve multi-segment URLs through the Hono
 * pipeline (regression guard for the `*slug` → `:slug{.+}` translation).
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { createApp } from '../../src/server/app.js';
import { discoverRoutes } from '../../src/routing/routes.js';
import type { RequestContext } from '../../src/contracts/http.js';

const tmpRoot = mkdtempSync(join(fileURLToPath(new URL('..', import.meta.url)), 'catch-all-live-'));
after(() => rmSync(tmpRoot, { recursive: true, force: true }));

describe('live catch-all serving', () => {
  it('serves a required catch-all at multi-segment paths and passes the tail param', async () => {
    const root = join(tmpRoot, 'req');
    mkdirSync(join(root, 'pages'), { recursive: true });
    writeFileSync(join(root, 'pages', '[...slug].js'), 'export default () => null;\n');

    const manifest = discoverRoutes(root);
    const seen: string[] = [];
    const app = await createApp({
      manifest,
      renderPage: (entry, ctx: RequestContext) => {
        seen.push(`${ctx.params['slug'] ?? ''}`);
        return new Response(`route=${entry.route}`);
      },
    });

    const res = await app.fetch(new Request('http://localhost/a/b/c'));
    assert.equal(res.status, 200);
    assert.deepEqual(seen, ['a/b/c']);
  });

  it('serves an optional catch-all at both the base path and a tail path', async () => {
    const root = join(tmpRoot, 'opt');
    mkdirSync(join(root, 'pages', 'docs'), { recursive: true });
    writeFileSync(join(root, 'pages', 'docs', '[[...slug]].js'), 'export default () => null;\n');

    const manifest = discoverRoutes(root);
    const seen: string[] = [];
    const app = await createApp({
      manifest,
      renderPage: (_entry, ctx: RequestContext) => {
        seen.push(ctx.params['slug'] ?? '<none>');
        return new Response('ok');
      },
    });

    const base = await app.fetch(new Request('http://localhost/docs'));
    assert.equal(base.status, 200);
    const tail = await app.fetch(new Request('http://localhost/docs/a/b'));
    assert.equal(tail.status, 200);
    assert.deepEqual(seen, ['<none>', 'a/b']);
  });
});
