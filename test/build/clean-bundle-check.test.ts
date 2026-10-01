/**
 * Clean-client-bundle check tests (Node-import safe).
 *
 * These tests exercise the pure enforcement that a server-only module never
 * reaches the browser bundle. They import only the structural chunk type and
 * the check/plugin functions — no Rolldown or Vite — and run under plain Node
 * with no bundler installed.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CleanBundleError,
  assertCleanClientBundle,
  cleanBundlePlugin,
  findServerOnlyModules,
  type CleanBundlePluginOptions,
  type ClientBundleChunk,
} from '../../src/build/index.js';

/** A chunk helper: default to a chunk type and the given module ids. */
function chunk(fileName: string, moduleIds: readonly string[]): ClientBundleChunk {
  return { fileName, type: 'chunk', moduleIds };
}

const isServerOnly = (id: string): boolean => id.endsWith('.server.ts');

describe('findServerOnlyModules', () => {
  it('returns an empty list when no server-only modules are present', () => {
    const bundle = [chunk('app.js', ['client/main.tsx', 'src/foo.ts'])];
    assert.deepEqual(findServerOnlyModules(bundle, isServerOnly), []);
  });

  it('reports one violation with the offending module id', () => {
    const bundle = [chunk('app.js', ['client/main.tsx', 'src/foo.server.ts'])];
    const violations = findServerOnlyModules(bundle, isServerOnly);

    assert.equal(violations.length, 1);
    assert.equal(violations[0]?.serverOnlyModule, 'src/foo.server.ts');
    assert.deepEqual(violations[0]?.chain, ['src/foo.server.ts']);
  });

  it('dedupes the same offending module id across chunks', () => {
    const bundle = [
      chunk('a.js', ['src/foo.server.ts']),
      chunk('b.js', ['src/foo.server.ts', 'src/other.ts']),
    ];
    const violations = findServerOnlyModules(bundle, isServerOnly);

    assert.equal(violations.length, 1);
    assert.equal(violations[0]?.serverOnlyModule, 'src/foo.server.ts');
  });

  it('ignores non-chunk assets', () => {
    const bundle = [
      { fileName: 'styles.css', type: 'asset' },
      { fileName: 'app.js', type: 'chunk', moduleIds: ['client/main.tsx'] },
    ];
    assert.deepEqual(findServerOnlyModules(bundle, isServerOnly), []);
  });

  it('treats a missing type as a chunk', () => {
    const bundle = [{ fileName: 'app.js', moduleIds: ['src/foo.server.ts'] }];
    const violations = findServerOnlyModules(bundle, isServerOnly);

    assert.equal(violations.length, 1);
    assert.equal(violations[0]?.serverOnlyModule, 'src/foo.server.ts');
  });

  it('orders violations deterministically by module id', () => {
    const bundle = [chunk('app.js', ['src/zzz.server.ts', 'src/aaa.server.ts'])];
    const violations = findServerOnlyModules(bundle, isServerOnly);

    assert.deepEqual(
      violations.map((v) => v.serverOnlyModule),
      ['src/aaa.server.ts', 'src/zzz.server.ts'],
    );
  });
});

describe('assertCleanClientBundle', () => {
  it('does not throw for a clean bundle', () => {
    const bundle = [chunk('app.js', ['client/main.tsx'])];
    assert.doesNotThrow(() => assertCleanClientBundle(bundle, isServerOnly));
  });

  it('throws CleanBundleError naming the offending module', () => {
    const bundle = [chunk('app.js', ['src/foo.server.ts'])];

    try {
      assertCleanClientBundle(bundle, isServerOnly);
      assert.fail('expected a CleanBundleError');
    } catch (err) {
      assert.ok(err instanceof CleanBundleError);
      assert.equal(err.name, 'CleanBundleError');
      assert.equal(err.violations.length, 1);
      assert.match(err.message, /src\/foo\.server\.ts/);
      assert.match(err.message, /chain: src\/foo\.server\.ts/);
    }
  });
});

describe('cleanBundlePlugin', () => {
  it('returns an object with a generateBundle function', () => {
    const plugin = cleanBundlePlugin({ serverOnly: isServerOnly });
    assert.equal(plugin.name, 'jsails-clean-client-bundle');
    assert.equal(typeof plugin.generateBundle, 'function');
  });

  it('throws CleanBundleError when generateBundle sees a server-only module', () => {
    const plugin = cleanBundlePlugin({ serverOnly: isServerOnly });
    const bundle = { 'app.js': chunk('app.js', ['src/foo.server.ts']) };

    assert.throws(
      () => plugin.generateBundle({}, bundle),
      (err: unknown) => err instanceof CleanBundleError,
    );
  });

  it('does not throw when generateBundle sees a clean bundle', () => {
    const plugin = cleanBundlePlugin({ serverOnly: isServerOnly });
    const bundle = { 'app.js': chunk('app.js', ['client/main.tsx']) };

    assert.doesNotThrow(() => plugin.generateBundle({}, bundle));
  });

  it('rejects a missing serverOnly predicate at construction', () => {
    assert.throws(
      () => cleanBundlePlugin({} as unknown as CleanBundlePluginOptions),
      (err: unknown) =>
        err instanceof Error && err.message === 'cleanBundlePlugin requires a serverOnly predicate',
    );
  });

  it('names the import chain when the bundler context exposes importers', () => {
    const plugin = cleanBundlePlugin({ serverOnly: isServerOnly });
    const bundle = { 'app.js': chunk('app.js', ['src/foo.server.ts']) };
    // Graph: client/main.tsx -> src/foo.ts -> src/foo.server.ts. The plugin
    // walks importer edges upward, then reverses to read entry-first.
    const graph: Record<string, readonly string[]> = {
      'src/foo.server.ts': ['src/foo.ts'],
      'src/foo.ts': ['client/main.tsx'],
      'client/main.tsx': [],
    };
    const ctx = { getModuleInfo: (id: string) => ({ importers: graph[id] ?? [] }) };

    assert.throws(
      () => plugin.generateBundle.call(ctx, {}, bundle),
      (err: unknown) => {
        if (!(err instanceof CleanBundleError)) {
          return false;
        }
        const chain = err.violations[0]?.chain ?? [];
        return (
          err.violations.length === 1 &&
          chain.join(' -> ') === 'client/main.tsx -> src/foo.ts -> src/foo.server.ts'
        );
      },
    );
  });

  it('falls back to the bare offender when no importer context is available', () => {
    const plugin = cleanBundlePlugin({ serverOnly: isServerOnly });
    const bundle = { 'app.js': chunk('app.js', ['src/foo.server.ts']) };

    assert.throws(
      () => plugin.generateBundle({}, bundle),
      (err: unknown) => {
        if (!(err instanceof CleanBundleError)) {
          return false;
        }
        return err.violations[0]?.chain.join(' -> ') === 'src/foo.server.ts';
      },
    );
  });
});
