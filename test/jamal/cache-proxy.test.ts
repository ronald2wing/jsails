import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runJamalCommand, type JamalDeps } from '../../src/jamal/command.js';
import { normalizeJamalConfig, type JamalConfig } from '../../src/jamal/config.js';

/**
 * Tests for the `jamal cache-proxy` verbs. The config loader is injected, so no
 * file is read and no docker/ssh command is ever spawned. Assertions target the
 * status/plan output, the cookie-allowlist application, positional/flag
 * validation, and the value-free failure paths.
 */

interface Harness {
  deps: JamalDeps;
  out: string[];
  err: string[];
}

function makeDeps(config?: JamalConfig): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const deps: JamalDeps = {
    createRegistry: () => {
      throw new Error('registry must not be built for cache-proxy');
    },
    loadJamalConfig: async () => config ?? normalizeJamalConfig({ service: 'myapp', image: 'img' }),
    cwd: '/project',
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
  };
  return { deps, out, err };
}

function enabledConfig(): JamalConfig {
  return normalizeJamalConfig({
    service: 'myapp',
    image: 'ghcr.io/acme/myapp',
    cacheProxy: { enabled: true, cookieAllowlist: ['session_id'] },
  });
}

describe('jamal cache-proxy --help', () => {
  it('prints usage without loading the config', async () => {
    const { deps, out, err } = makeDeps();
    const code = await runJamalCommand(['cache-proxy', '--help'], deps);

    assert.equal(code, 0);
    assert.match(out.join('\n'), /Usage:/);
    assert.match(out.join('\n'), /plan\|status/);
    assert.equal(err.length, 0);
  });
});

describe('jamal cache-proxy: argument validation', () => {
  it('rejects a missing verb', async () => {
    const { deps, err } = makeDeps();
    const code = await runJamalCommand(['cache-proxy'], deps);
    assert.equal(code, 2);
    assert.match(err.join('\n'), /a verb is required/);
  });

  it('rejects an unknown verb', async () => {
    const { deps, err } = makeDeps();
    const code = await runJamalCommand(['cache-proxy', 'bogus'], deps);
    assert.equal(code, 2);
    assert.match(err.join('\n'), /a verb is required/);
  });

  it('rejects a trailing positional', async () => {
    const { deps, err } = makeDeps();
    const code = await runJamalCommand(['cache-proxy', 'status', 'extra'], deps);
    assert.equal(code, 2);
    assert.match(err.join('\n'), /unexpected argument/);
  });

  it('rejects --tag on status', async () => {
    const { deps, err } = makeDeps();
    const code = await runJamalCommand(['cache-proxy', 'status', '--tag', 'v1'], deps);
    assert.equal(code, 2);
    assert.match(err.join('\n'), /--tag is only valid/);
  });
});

describe('jamal cache-proxy status', () => {
  it('reports "not configured" when cacheProxy is absent', async () => {
    const { deps, out } = makeDeps(normalizeJamalConfig({ service: 'myapp', image: 'img' }));
    const code = await runJamalCommand(['cache-proxy', 'status'], deps);
    assert.equal(code, 0);
    assert.match(out.join('\n'), /not configured/);
  });

  it('reports a disabled cache proxy with its image, size, and allowlist', async () => {
    const config = normalizeJamalConfig({
      service: 'myapp',
      image: 'img',
      cacheProxy: { enabled: false },
    });
    const { deps, out } = makeDeps(config);
    const code = await runJamalCommand(['cache-proxy', 'status'], deps);

    assert.equal(code, 0);
    const text = out.join('\n');
    assert.match(text, /cache proxy: disabled/);
    assert.match(text, /image: varnish:7\.7/);
    assert.match(text, /size: 256m/);
    assert.match(text, /cookie allowlist: none/);
  });

  it('reports an enabled cache proxy with its allowlist', async () => {
    const { deps, out } = makeDeps(enabledConfig());
    const code = await runJamalCommand(['cache-proxy', 'status'], deps);

    assert.equal(code, 0);
    const text = out.join('\n');
    assert.match(text, /cache proxy: enabled/);
    assert.match(text, /cookie allowlist: session_id/);
  });
});

describe('jamal cache-proxy plan', () => {
  it('refuses to plan when the cache proxy is disabled or absent', async () => {
    const { deps, err } = makeDeps(normalizeJamalConfig({ service: 'myapp', image: 'img' }));
    const code = await runJamalCommand(['cache-proxy', 'plan'], deps);
    assert.equal(code, 1);
    assert.match(err.join('\n'), /cacheProxy\.enabled must be true/);
  });

  it('prints the resolved VCL with the allowlist applied', async () => {
    const { deps, out } = makeDeps(enabledConfig());
    const code = await runJamalCommand(['cache-proxy', 'plan'], deps);

    assert.equal(code, 0);
    const text = out.join('\n');
    assert.match(text, /backend myapp-web-latest/);
    assert.match(text, /regsuball\(req\.http\.Cookie, "\(\^\|; \*\)session_id=\[\^;\]\*", ""\)/);
    assert.ok(!text.includes('__BACKEND_HOST__'), 'placeholder must be replaced');
  });

  it('derives the backend container name from --tag', async () => {
    const { deps, out } = makeDeps(enabledConfig());
    const code = await runJamalCommand(['cache-proxy', 'plan', '--tag', 'v1'], deps);

    assert.equal(code, 0);
    assert.match(out.join('\n'), /backend myapp-web-v1/);
  });
});
