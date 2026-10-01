/**
 * Live-serving locale-prefixed routing: `/fr/<route>` serves the bare route
 * and resolves the ambient locale from the prefix.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { createApp } from '../../src/server/app.js';
import { discoverRoutes } from '../../src/routing/routes.js';
import type { RequestContext } from '../../src/contracts/http.js';

const tmpRoot = mkdtempSync(join(fileURLToPath(new URL('..', import.meta.url)), 'i18n-prefix-'));
after(() => rmSync(tmpRoot, { recursive: true, force: true }));

describe('live locale-prefixed routing', () => {
  it('serves /fr/about with the locale resolved from the prefix', async () => {
    const root = join(tmpRoot, 'app');
    mkdirSync(join(root, 'pages', 'about'), { recursive: true });
    writeFileSync(join(root, 'pages', 'about', 'index.js'), 'export default () => null;\n');
    writeFileSync(join(root, 'pages', 'index.js'), 'export default () => null;\n');

    const manifest = discoverRoutes(root);
    const seen: string[] = [];
    const app = await createApp({
      manifest,
      localeOptions: { locales: ['en', 'fr'], defaultLocale: 'en' },
      renderPage: (entry, _ctx: RequestContext) => {
        seen.push(`${entry.route}`);
        return new Response('ok');
      },
    });
    const res = await app.fetch(new Request('http://localhost/fr/about'));
    assert.equal(res.status, 200);
    assert.deepEqual(seen, ['/about']);

    const bare = await app.fetch(new Request('http://localhost/about'));
    assert.equal(bare.status, 200);
    const en = await app.fetch(new Request('http://localhost/en/about'));
    assert.equal(en.status, 404, 'the default locale stays un-prefixed');
  });
});
