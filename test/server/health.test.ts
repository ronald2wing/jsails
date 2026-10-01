/**
 * Deep health probe: `/up?deep=1` runs the system-check registry; bare `/up`
 * stays a fast liveness probe.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createApp } from '../../src/server/app.js';
import { discoverRoutes } from '../../src/routing/routes.js';
import { createSystemCheckRegistry } from '../../src/database/system-checks.js';

const tmpRoot = mkdtempSync(join(fileURLToPath(new URL('..', import.meta.url)), 'health-'));
mkdirSync(join(tmpRoot, 'pages'), { recursive: true });
writeFileSync(join(tmpRoot, 'pages', 'index.js'), 'export default () => null;\n');
const manifest = discoverRoutes(tmpRoot);
after(() => rmSync(tmpRoot, { recursive: true, force: true }));

describe('deep health probe', () => {
  it('bare /up is a plain-text 200 liveness probe', async () => {
    const app = await createApp({ manifest, healthPath: '/up' });
    const res = await app.fetch(new Request('http://localhost/up'));
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/plain/);
  });

  it('/up?deep=1 returns JSON; 503 when a check is error-severity', async () => {
    const healthy = createSystemCheckRegistry();
    healthy.register('db', () => [{ id: 'db', severity: 'info', message: 'reachable' }]);
    const app = await createApp({ manifest, healthPath: '/up', systemChecks: healthy });
    const ok = await app.fetch(new Request('http://localhost/up?deep=1'));
    assert.equal(ok.status, 200);
    const okBody = (await ok.json()) as { status: string };
    assert.equal(okBody.status, 'ok');

    const failing = createSystemCheckRegistry();
    failing.register('db', () => [{ id: 'db', severity: 'error', message: 'down' }]);
    const app2 = await createApp({ manifest, healthPath: '/up', systemChecks: failing });
    const fail = await app2.fetch(new Request('http://localhost/up?deep=1'));
    assert.equal(fail.status, 503);
    const failBody = (await fail.json()) as { status: string; checks: { severity: string }[] };
    assert.equal(failBody.status, 'error');
    assert.equal(failBody.checks[0]?.severity, 'error');
  });

  it('a throwing check is isolated as an error-severity result', () => {
    const registry = createSystemCheckRegistry();
    registry.register('boom', () => {
      throw new Error('kaboom');
    });
    const results = registry.run();
    assert.equal(results.length, 1);
    assert.equal(results[0]?.severity, 'error');
  });

  it('without a registry, ?deep=1 falls back to the plain liveness response', async () => {
    const app = await createApp({ manifest, healthPath: '/up' });
    const res = await app.fetch(new Request('http://localhost/up?deep=1'));
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/plain/);
  });
});
