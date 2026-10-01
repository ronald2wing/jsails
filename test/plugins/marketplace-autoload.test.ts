import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveMarketplaceAutoload } from '../../src/plugins/activation.js';
import type { DiscoveredPlugin } from '../../src/plugins/discovery/index.js';
import type { PluginManifest } from '../../src/plugins/manifest/index.js';
import type { AutoloadDeclaration } from '../../src/symbols/framework-symbols.js';

/** A minimal discovered plugin fixture. */
function discovered(
  id: string,
  options: {
    root?: boolean;
    requiredBy?: string[];
    autoload?: AutoloadDeclaration;
    plugins?: { id: string; range: string }[];
  } = {},
): DiscoveredPlugin {
  const manifest: PluginManifest = {
    id,
    version: '1.0.0',
    jsailsCompat: '^1.0.0',
    entry: `./${id}.js`,
    permissions: [],
    ...(options.autoload === undefined ? {} : { autoload: options.autoload }),
    ...(options.plugins === undefined ? {} : { plugins: options.plugins }),
  };
  return {
    id,
    version: '1.0.0',
    source: 'dependency',
    manifest,
    manifestPath: `/node_modules/${id}/package.json`,
    ...(options.root === undefined ? {} : { root: options.root }),
    ...(options.requiredBy === undefined ? {} : { requiredBy: options.requiredBy }),
  };
}

describe('resolveMarketplaceAutoload', () => {
  it('returns the own-surface entry for a directly-installed (root) plugin', () => {
    const entries = resolveMarketplaceAutoload([
      discovered('a', { root: true, autoload: { mode: 'selected', specifiers: ['a/x'] } }),
    ]);
    assert.deepEqual(entries, [
      { origin: 'a', autoload: { mode: 'selected', specifiers: ['a/x'] } },
    ]);
  });

  it('suppresses a transitive dependency the installer does not delegate', () => {
    // meta (root) installs a, but does not delegate it: a is NOT active.
    const entries = resolveMarketplaceAutoload([
      discovered('meta', { root: true, autoload: { mode: 'none' } }),
      discovered('a', {
        requiredBy: ['meta'],
        autoload: { mode: 'selected', specifiers: ['a/x'] },
      }),
    ]);
    assert.deepEqual(
      entries.map((e) => e.origin),
      ['meta'],
    );
  });

  it('delegates a named transitive dependency', () => {
    const entries = resolveMarketplaceAutoload([
      discovered('meta', {
        root: true,
        autoload: { mode: 'selected', plugins: ['a'] },
      }),
      discovered('a', {
        requiredBy: ['meta'],
        autoload: { mode: 'selected', specifiers: ['a/x'] },
      }),
    ]);
    assert.deepEqual(entries.map((e) => e.origin).sort(), ['a', 'meta']);
  });

  it('direct install wins over a transitive installer that suppresses', () => {
    // a is both root (direct) and required by meta (which does not delegate it).
    // Direct wins: a is active regardless of meta.
    const entries = resolveMarketplaceAutoload([
      discovered('meta', { root: true, autoload: { mode: 'none' } }),
      discovered('a', {
        root: true,
        requiredBy: ['meta'],
        autoload: { mode: 'selected', specifiers: ['a/x'] },
      }),
    ]);
    assert.ok(entries.some((e) => e.origin === 'a'));
  });

  it('delegates every installed plugin under all', () => {
    const entries = resolveMarketplaceAutoload([
      discovered('meta', { root: true, autoload: { mode: 'all' } }),
      discovered('a', { requiredBy: ['meta'] }),
      discovered('b', { requiredBy: ['meta'] }),
    ]);
    assert.deepEqual(entries.map((e) => e.origin).sort(), ['a', 'b', 'meta']);
  });

  it('treats a manager-enabled bundle as a direct install', () => {
    // A bundle is never `root` and carries no `requiredBy`, but is installed
    // deliberately by the manager. When its id is in the enabled set, its own
    // autoload is active — it must not be silently suppressed.
    const bundle = discovered('bundle', {
      autoload: { mode: 'selected', specifiers: ['bundle/x'] },
    });
    const entries = resolveMarketplaceAutoload([bundle], ['bundle']);
    assert.deepEqual(entries, [
      { origin: 'bundle', autoload: { mode: 'selected', specifiers: ['bundle/x'] } },
    ]);
  });

  it('suppresses a manager bundle that is not enabled', () => {
    const bundle = discovered('bundle', {
      autoload: { mode: 'selected', specifiers: ['bundle/x'] },
    });
    const entries = resolveMarketplaceAutoload([bundle], []);
    assert.deepEqual(entries, []);
  });

  it('treats a declared manifest.plugins dependency as an install edge', () => {
    // meta declares `plugins: [a]` (bundle-to-bundle dependency) but does not
    // delegate `a` — so `a` is installed but suppressed (use-without-expose).
    const entries = resolveMarketplaceAutoload(
      [
        discovered('meta', {
          root: true,
          autoload: { mode: 'none' },
          plugins: [{ id: 'a', range: '^1' }],
        }),
        discovered('a', { autoload: { mode: 'selected', specifiers: ['a/x'] } }),
      ],
      ['meta'],
    );
    assert.deepEqual(
      entries.map((e) => e.origin),
      ['meta'],
    );
    assert.equal(
      entries.some((e) => e.origin === 'a'),
      false,
    );
  });

  it('delegates a declared manifest.plugins dependency via autoload.plugins', () => {
    const entries = resolveMarketplaceAutoload(
      [
        discovered('meta', {
          root: true,
          autoload: { mode: 'selected', plugins: ['a'] },
          plugins: [{ id: 'a', range: '^1' }],
        }),
        discovered('a', { autoload: { mode: 'selected', specifiers: ['a/x'] } }),
      ],
      ['meta'],
    );
    assert.deepEqual(entries.map((e) => e.origin).sort(), ['a', 'meta']);
  });
});
