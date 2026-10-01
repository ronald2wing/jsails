import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, it } from 'node:test';

import type { FrameworkSymbol } from '../../src/symbols/framework-symbols.js';
import {
  NONE_SYMBOL_DECLARATION,
  applySymbolDeclaration,
  computeFrameworkSymbolCollisionGroups,
  deriveFrameworkSymbolNamespaceKeys,
  frameworkGlobalSpecifiers,
  resolveSymbolDeclaration,
  resolveSymbolDeclarations,
} from '../../src/symbols/framework-symbols.js';
import { loadFrameworkAutoloadDeclaration } from '../../src/compiler/plugin-declaration-scan.js';
import { deriveFrameworkSymbols } from '../../src/symbols/framework-symbol-catalog-scan.js';
import type { FrameworkSymbolOverrideWarning } from '../../src/symbols/install-server.js';
import {
  SymbolsInstallError,
  installFrameworkSymbols,
  installProjectSymbols,
} from '../../src/symbols/install-server.js';

/** The repo root, so the scan reads the framework's own `src/` barrels. */
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

/** The framework's curated autoload surface, read from `jsails.plugin.json`. */
const frameworkGlobals = loadFrameworkAutoloadDeclaration(repoRoot);

/** The full-surface declaration, for tests that exercise the scan's enumeration. */
const ALL: { mode: 'all' } = { mode: 'all' };

describe('framework symbols catalog', () => {
  it('is the full public surface, with no default export projected', () => {
    const catalog = deriveFrameworkSymbols({ rootDir: repoRoot, declaration: ALL });
    // 832 value exports today; a floor keeps the assertion from breaking on
    // every added helper while still catching a truncated scan.
    assert.ok(catalog.length > 700, `catalog has ${catalog.length} entries`);
    assert.equal(
      catalog.some((entry) => entry.name === 'default'),
      false,
    );
  });

  it('every name is unique per (name, specifier) pair', () => {
    const catalog = deriveFrameworkSymbols({ rootDir: repoRoot, declaration: ALL });
    const keys = catalog.map((entry) => `${entry.name}\u0000${entry.specifier}`);
    assert.equal(new Set(keys).size, keys.length);
  });

  it('a name may be re-exported by more than one subpath (real collisions exist)', () => {
    // Under the full-surface catalog, collisions are expected — the namespace
    // mechanism depends on them. `ApplicationRecord` is one.
    const catalog = deriveFrameworkSymbols({ rootDir: repoRoot, declaration: ALL });
    const groups = computeFrameworkSymbolCollisionGroups(catalog);
    assert.ok(groups.size > 0, 'expected at least one real name collision');
    assert.ok(groups.has('ApplicationRecord'));
  });

  it('lists distinct specifiers, sorted', () => {
    const catalog = deriveFrameworkSymbols({ rootDir: repoRoot, declaration: ALL });
    const specifiers = frameworkGlobalSpecifiers(catalog);
    assert.deepEqual(specifiers, [...specifiers].sort());
    assert.equal(new Set(specifiers).size, specifiers.length);
  });

  it('every declared symbol is actually exported by its subpath', async () => {
    const catalog = deriveFrameworkSymbols({ rootDir: repoRoot, declaration: ALL });
    for (const { name, specifier } of catalog) {
      const module = (await import(specifier)) as Record<string, unknown>;
      assert.notEqual(module[name], undefined, `${specifier} does not export ${name}`);
    }
  });

  it('the curated framework declaration names real subpaths and excludes none-machinery', () => {
    assert.equal(frameworkGlobals.mode, 'selected');
    assert.ok(frameworkGlobals.specifiers.length > 0);
    for (const specifier of frameworkGlobals.specifiers) {
      if (specifier === 'jsails/symbols' || specifier === 'jsails/symbols/client') {
        assert.fail('projection machinery must not be in the default');
      }
    }
    const curated = deriveFrameworkSymbols({
      rootDir: repoRoot,
      declaration: frameworkGlobals,
    });
    assert.ok(curated.length > 0);
    // Curated surface is strictly smaller than the full surface.
    const full = deriveFrameworkSymbols({ rootDir: repoRoot, declaration: ALL });
    assert.ok(curated.length < full.length);
  });
});

describe('computeFrameworkSymbolCollisionGroups', () => {
  it('returns empty for unique names', () => {
    const globals: readonly FrameworkSymbol[] = [
      { name: 'alpha', specifier: 'testns/a', target: 'both' },
      { name: 'beta', specifier: 'testns/b', target: 'both' },
    ];
    assert.equal(computeFrameworkSymbolCollisionGroups(globals).size, 0);
  });

  it('groups duplicate names in table order', () => {
    const globals: readonly FrameworkSymbol[] = [
      { name: 'dup', specifier: 'testns/a', target: 'both' },
      { name: 'other', specifier: 'testns/b', target: 'both' },
      { name: 'dup', specifier: 'testns/c', target: 'both' },
    ];
    const groups = computeFrameworkSymbolCollisionGroups(globals);
    assert.equal(groups.size, 1);
    const group = groups.get('dup');
    assert.ok(group);
    assert.deepEqual(
      group.map((entry) => entry.specifier),
      ['testns/a', 'testns/c'],
    );
  });
});

describe('deriveFrameworkSymbolNamespaceKeys', () => {
  it('uses the last path segment when it is unique', () => {
    const keys = deriveFrameworkSymbolNamespaceKeys(['jsails/content', 'jsails/blog']);
    assert.equal(keys.get('jsails/content'), 'content');
    assert.equal(keys.get('jsails/blog'), 'blog');
  });

  it('prepends the next segment when the last segment collides', () => {
    const keys = deriveFrameworkSymbolNamespaceKeys(['vendor/content', 'jsails/content']);
    assert.equal(keys.get('vendor/content'), 'content');
    assert.equal(keys.get('jsails/content'), 'jsails_content');
  });

  it('falls back to the sanitized full specifier when all segments collide', () => {
    // `a/x-y` claims the `x-y` key first; `x-y` (a different specifier) then
    // finds its only segment taken, so it falls back to the sanitized full
    // specifier `x_y`.
    const keys = deriveFrameworkSymbolNamespaceKeys(['a/x-y', 'x-y']);
    assert.equal(keys.get('a/x-y'), 'x-y');
    assert.equal(keys.get('x-y'), 'x_y');
  });

  it('allows the same specifier to reuse its key', () => {
    const keys = deriveFrameworkSymbolNamespaceKeys(['a/b', 'a/b']);
    assert.equal(keys.size, 1);
    assert.equal(keys.get('a/b'), 'b');
  });
});

describe('installFrameworkSymbols', () => {
  it('assigns every framework global onto globalThis', async () => {
    const catalog = deriveFrameworkSymbols({ rootDir: repoRoot, declaration: ALL });
    await installFrameworkSymbols(repoRoot, { globals: catalog, onWarn: () => {} });
    const target = globalThis as Record<string, unknown>;
    for (const { name } of catalog) {
      assert.notEqual(target[name], undefined, `${name} was not installed`);
    }
  });

  it('is idempotent', async () => {
    const catalog = deriveFrameworkSymbols({ rootDir: repoRoot, declaration: ALL });
    await installFrameworkSymbols(repoRoot, { globals: catalog, onWarn: () => {} });
    const first = (globalThis as Record<string, unknown>).ApplicationRecord;
    await installFrameworkSymbols(repoRoot, { globals: catalog, onWarn: () => {} });
    assert.equal((globalThis as Record<string, unknown>).ApplicationRecord, first);
  });
});

/**
 * Collision behaviour, exercised against a synthetic table via the injectable
 * `globals`/`loadModule` options. The real framework table has many
 * duplicate names, so without these the namespace mechanism would be dead code.
 *
 * Synthetic specifiers use a `testns/` prefix so the derived namespace keys
 * cannot collide with a real framework namespace; every global set here is
 * deleted in `finally` so tests do not leak onto `globalThis`.
 */
describe('installFrameworkSymbols collision handling', () => {
  const fakeLoader =
    (modules: Record<string, Record<string, unknown>>) =>
    async (specifier: string): Promise<Record<string, unknown>> =>
      modules[specifier] ?? {};

  const installed = new Set<string>();
  const track = (name: string): void => {
    installed.add(name);
  };

  afterEach(() => {
    for (const name of installed) {
      delete (globalThis as Record<string, unknown>)[name];
    }
    installed.clear();
  });

  it('installs only the bare name when a name is unique', async () => {
    const globals = [
      { name: 'uniqueAlpha', specifier: 'testns/alpha', target: 'both' },
      { name: 'uniqueBeta', specifier: 'testns/beta', target: 'both' },
    ] as const;
    const modules = {
      'testns/alpha': { uniqueAlpha: 'A' },
      'testns/beta': { uniqueBeta: 'B' },
    };
    await installFrameworkSymbols(repoRoot, { globals, loadModule: fakeLoader(modules) });
    track('uniqueAlpha');
    track('uniqueBeta');
    track('alpha');
    track('beta');

    const target = globalThis as Record<string, unknown>;
    assert.equal(target.uniqueAlpha, 'A');
    assert.equal(target.uniqueBeta, 'B');
    // No namespace object was created for a non-colliding name.
    assert.equal(target.alpha, undefined);
    assert.equal(target.beta, undefined);
  });

  it('first-in-order wins the bare slot and each provider gets a namespace object', async () => {
    const globals = [
      { name: 'sharedThing', specifier: 'testns/first', target: 'both' },
      { name: 'sharedThing', specifier: 'testns/second', target: 'both' },
    ] as const;
    const modules = {
      'testns/first': { sharedThing: 'FROM_FIRST' },
      'testns/second': { sharedThing: 'FROM_SECOND' },
    };
    await installFrameworkSymbols(repoRoot, { globals, loadModule: fakeLoader(modules) });
    track('sharedThing');
    track('first');
    track('second');

    const target = globalThis as Record<string, unknown>;
    // Bare slot: the first entry in table order.
    assert.equal(target.sharedThing, 'FROM_FIRST');
    // Real namespace objects, reachable by property access — never dotted keys.
    assert.deepEqual(target.first, { sharedThing: 'FROM_FIRST' });
    assert.deepEqual(target.second, { sharedThing: 'FROM_SECOND' });
    // A dotted property name is NOT installed.
    assert.equal(target['first.sharedThing'], undefined);
  });

  it('namespace object is a real object reachable by property access', async () => {
    const globals = [
      { name: 'readingTime', specifier: 'testns/content', target: 'both' },
      { name: 'readingTime', specifier: 'testns/blog', target: 'both' },
    ] as const;
    const modules = {
      'testns/content': { readingTime: () => 1 },
      'testns/blog': { readingTime: () => 2 },
    };
    await installFrameworkSymbols(repoRoot, { globals, loadModule: fakeLoader(modules) });
    track('readingTime');
    track('content');
    track('blog');

    const target = globalThis as Record<string, unknown>;
    const content = target.content as Record<string, unknown>;
    const blog = target.blog as Record<string, unknown>;
    assert.equal(typeof content.readingTime, 'function');
    assert.equal(typeof blog.readingTime, 'function');
    assert.notEqual(content.readingTime, blog.readingTime);
  });

  it('throws a value-free error when a declared symbol is missing', async () => {
    const globals = [{ name: 'absentSymbol', specifier: 'testns/alpha', target: 'both' }] as const;
    await assert.rejects(
      () =>
        installFrameworkSymbols(repoRoot, {
          globals,
          loadModule: fakeLoader({ 'testns/alpha': {} }),
        }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        // The missing symbol/specifier are named (a framework bug), never user input.
        assert.ok(err.message.includes('absentSymbol'));
        return true;
      },
    );
  });

  it('is idempotent under collision', async () => {
    const globals = [
      { name: 'sharedThing', specifier: 'testns/first', target: 'both' },
      { name: 'sharedThing', specifier: 'testns/second', target: 'both' },
    ] as const;
    const modules = {
      'testns/first': { sharedThing: 'FROM_FIRST' },
      'testns/second': { sharedThing: 'FROM_SECOND' },
    };
    await installFrameworkSymbols(repoRoot, { globals, loadModule: fakeLoader(modules) });
    track('sharedThing');
    track('first');
    track('second');
    const target = globalThis as Record<string, unknown>;
    const firstNs = target.first;

    await installFrameworkSymbols(repoRoot, { globals, loadModule: fakeLoader(modules) });
    assert.equal(target.sharedThing, 'FROM_FIRST');
    assert.deepEqual(target.first, firstNs);
  });

  it('an override of a colliding bare name preserves the first-in-order value', async () => {
    // A pre-existing global must be replaced by the first-in-order winner (not
    // silently ignored), with a warning naming what was lost. Uses fresh names
    // so `installedFrameworkSymbolOrigins` has no prior record (the loader is module-global).
    (globalThis as Record<string, unknown>).testnsCollideOverride = 'PRE_EXISTING';
    try {
      const globals = [
        { name: 'testnsCollideOverride', specifier: 'testnsCollide/a', target: 'both' },
        { name: 'testnsCollideOverride', specifier: 'testnsCollide/b', target: 'both' },
      ] as const;
      const modules = {
        'testnsCollide/a': { testnsCollideOverride: 'FROM_FIRST' },
        'testnsCollide/b': { testnsCollideOverride: 'FROM_SECOND' },
      };
      const warnings: FrameworkSymbolOverrideWarning[] = [];
      await installFrameworkSymbols(repoRoot, {
        globals,
        loadModule: fakeLoader(modules),
        onWarn: (w) => warnings.push(w),
      });
      track('testnsCollideOverride');
      track('testnsCollide');

      const target = globalThis as Record<string, unknown>;
      assert.equal(target.testnsCollideOverride, 'FROM_FIRST');
      // Exactly one bare override (the winner); the loser never touched the slot.
      const bare = warnings.filter((w) => w.name === 'testnsCollideOverride');
      assert.equal(bare.length, 1);
      assert.equal(bare[0]?.from, 'pre-existing (unknown)');
      assert.equal(bare[0]?.over, 'framework:testnsCollide/a');
    } finally {
      delete (globalThis as Record<string, unknown>).testnsCollideOverride;
    }
  });
});

/**
 * Override policy (§13.4). The synthetic table's names are unique and prefixed
 * `testnsOverride…` so they cannot collide with a real framework namespace, and
 * every installed global is deleted in `finally`.
 */
describe('installFrameworkSymbols override warnings', () => {
  const fakeLoader =
    (modules: Record<string, Record<string, unknown>>) =>
    async (specifier: string): Promise<Record<string, unknown>> =>
      modules[specifier] ?? {};

  it('is silent when the slot is empty', async () => {
    const globals = [
      { name: 'testnsOverrideAlpha', specifier: 'testnsOverride/a', target: 'both' },
    ] as const;
    const warnings: FrameworkSymbolOverrideWarning[] = [];
    try {
      await installFrameworkSymbols(repoRoot, {
        globals,
        loadModule: fakeLoader({ 'testnsOverride/a': { testnsOverrideAlpha: 'A' } }),
        onWarn: (w) => warnings.push(w),
      });
      assert.equal(warnings.length, 0);
    } finally {
      delete (globalThis as Record<string, unknown>).testnsOverrideAlpha;
    }
  });

  it('is silent on an identical re-install', async () => {
    const globals = [
      { name: 'testnsOverrideBravo', specifier: 'testnsOverride/b', target: 'both' },
    ] as const;
    const modules = { 'testnsOverride/b': { testnsOverrideBravo: 'B' } };
    const warnings: FrameworkSymbolOverrideWarning[] = [];
    try {
      await installFrameworkSymbols(repoRoot, {
        globals,
        loadModule: fakeLoader(modules),
        onWarn: (w) => warnings.push(w),
      });
      await installFrameworkSymbols(repoRoot, {
        globals,
        loadModule: fakeLoader(modules),
        onWarn: (w) => warnings.push(w),
      });
      assert.equal(warnings.length, 0);
    } finally {
      delete (globalThis as Record<string, unknown>).testnsOverrideBravo;
    }
  });

  it('warns once, then proceeds, when it displaces a different prior value', async () => {
    const globals = [
      { name: 'testnsOverrideCharlie', specifier: 'testnsOverride/c', target: 'both' },
    ] as const;
    (globalThis as Record<string, unknown>).testnsOverrideCharlie = 'PRE_EXISTING';
    const warnings: FrameworkSymbolOverrideWarning[] = [];
    try {
      await installFrameworkSymbols(repoRoot, {
        globals,
        loadModule: fakeLoader({ 'testnsOverride/c': { testnsOverrideCharlie: 'C' } }),
        onWarn: (w) => warnings.push(w),
      });
      // Proceeds: the new value wins.
      assert.equal((globalThis as Record<string, unknown>).testnsOverrideCharlie, 'C');
      assert.equal(warnings.length, 1);
      assert.deepEqual(warnings[0], {
        name: 'testnsOverrideCharlie',
        from: 'pre-existing (unknown)',
        over: 'framework:testnsOverride/c',
        reason: 'override',
      });
    } finally {
      delete (globalThis as Record<string, unknown>).testnsOverrideCharlie;
    }
  });

  it('warns when a framework global displaces a foreign one', async () => {
    (globalThis as Record<string, unknown>).testnsOverrideDelta = () => 'host';
    const globals = [
      { name: 'testnsOverrideDelta', specifier: 'testnsOverride/d', target: 'both' },
    ] as const;
    const warnings: FrameworkSymbolOverrideWarning[] = [];
    try {
      await installFrameworkSymbols(repoRoot, {
        globals,
        loadModule: fakeLoader({ 'testnsOverride/d': { testnsOverrideDelta: () => 'jsails' } }),
        onWarn: (w) => warnings.push(w),
      });
      assert.equal(warnings.length, 1);
      assert.equal(warnings[0]?.over, 'framework:testnsOverride/d');
      assert.equal(warnings[0]?.from, 'pre-existing (unknown)');
    } finally {
      delete (globalThis as Record<string, unknown>).testnsOverrideDelta;
    }
  });

  it('labels a plugin-origin override as plugin:<name>', async () => {
    (globalThis as Record<string, unknown>).testnsOverrideEcho = 'framework-value';
    const globals = [
      { name: 'testnsOverrideEcho', specifier: 'testnsOverride/e', target: 'both' },
    ] as const;
    const warnings: FrameworkSymbolOverrideWarning[] = [];
    try {
      await installFrameworkSymbols(repoRoot, {
        globals,
        loadModule: fakeLoader({ 'testnsOverride/e': { testnsOverrideEcho: 'plugin-value' } }),
        origin: 'plugin:acme-tools',
        onWarn: (w) => warnings.push(w),
      });
      assert.equal(warnings.length, 1);
      assert.equal(warnings[0]?.over, 'plugin:acme-tools');
    } finally {
      delete (globalThis as Record<string, unknown>).testnsOverrideEcho;
    }
  });

  it('still throws when a declared symbol is missing (override never masks a bug)', async () => {
    const globals = [
      { name: 'testnsOverrideFoxtrot', specifier: 'testnsOverride/f', target: 'both' },
    ] as const;
    await assert.rejects(
      () =>
        installFrameworkSymbols(repoRoot, {
          globals,
          loadModule: fakeLoader({ 'testnsOverride/f': {} }),
          onWarn: () => {},
        }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes('testnsOverrideFoxtrot'));
        return true;
      },
    );
  });
});

describe('installProjectSymbols', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function tempProject(): string {
    const dir = mkdtempSync(join(tmpdir(), 'jsails-symbols-'));
    tempDirs.push(dir);
    return dir;
  }

  function writeProjectSymbols(rootDir: string, body: string): void {
    mkdirSync(join(rootDir, '.jsails'), { recursive: true });
    writeFileSync(join(rootDir, '.jsails', 'project-symbols.js'), body, 'utf8');
  }

  it('resolves silently when no generated symbols file exists', async () => {
    const rootDir = tempProject();
    // No `.jsails/project-symbols.js` — a project that never ran build:meta is valid.
    await installProjectSymbols(rootDir);
  });

  it('resolves when the generated symbols file imports successfully', async () => {
    const rootDir = tempProject();
    mkdirSync(join(rootDir, 'dist'), { recursive: true });
    writeFileSync(join(rootDir, 'dist', 'model.js'), 'export const thing = 1;\n', 'utf8');
    // A well-formed shim: the compiled module exists, so the install resolves
    // and publishes the symbol onto globalThis.
    writeProjectSymbols(
      rootDir,
      "import { thing } from './../dist/model.js';\nglobalThis.__jsailsTestThing = thing;\nexport {};\n",
    );

    await installProjectSymbols(rootDir);
    const target = globalThis as Record<string, unknown>;
    assert.equal(target.__jsailsTestThing, 1);
    delete target.__jsailsTestThing;
  });

  it('reframes a missing compiled module as a stale-project-symbols error', async () => {
    const rootDir = tempProject();
    // `.jsails/project-symbols.js` exists but its shim imports a module under a
    // missing `dist/` — the stale artifact after a clean or fresh clone.
    writeProjectSymbols(rootDir, "import './../dist/absent.js';\nexport {};\n");

    await assert.rejects(
      () => installProjectSymbols(rootDir),
      (err: unknown) => {
        assert.ok(err instanceof SymbolsInstallError);
        assert.equal(err.code, 'stale_project_globals');
        assert.ok(err.message.includes('.jsails/project-symbols.js'));
        assert.ok(err.message.includes('rebuild'));
        // The original module-resolution failure is preserved for diagnosis.
        assert.equal((err.cause as { code?: unknown } | undefined)?.code, 'ERR_MODULE_NOT_FOUND');
        return true;
      },
    );
  });

  it('propagates a non-module-not-found failure unchanged', async () => {
    const rootDir = tempProject();
    // The generated file throws a syntax error at evaluation, not a resolution
    // failure — it must NOT be mislabelled as staleness.
    writeProjectSymbols(rootDir, 'export const broken = ;\n');

    await assert.rejects(
      () => installProjectSymbols(rootDir),
      (err: unknown) => {
        assert.ok(err instanceof SyntaxError);
        assert.equal(err instanceof SymbolsInstallError, false);
        return true;
      },
    );
  });
});

describe('symbol declaration model', () => {
  it('defaults to none when no declaration is supplied', () => {
    assert.deepEqual(resolveSymbolDeclaration(undefined), NONE_SYMBOL_DECLARATION);
    assert.equal(
      applySymbolDeclaration(
        [{ name: 'A', specifier: 'jsails/a', target: 'server' }],
        NONE_SYMBOL_DECLARATION,
      ).length,
      0,
    );
  });

  it('folds participants by union, and all admits everything', () => {
    assert.deepEqual(resolveSymbolDeclarations([{ mode: 'selected', specifiers: ['jsails/a'] }]), {
      mode: 'selected',
      specifiers: ['jsails/a'],
    });
    assert.deepEqual(
      resolveSymbolDeclarations([
        { mode: 'selected', specifiers: ['jsails/a'] },
        { mode: 'selected', specifiers: ['jsails/b'] },
      ]),
      { mode: 'selected', specifiers: ['jsails/a', 'jsails/b'] },
    );
    // any `all` participant opens the whole surface.
    assert.deepEqual(
      resolveSymbolDeclarations([{ mode: 'selected', specifiers: ['jsails/a'] }, { mode: 'all' }]),
      { mode: 'all' },
    );
    // none contributes nothing.
    assert.deepEqual(
      resolveSymbolDeclarations([{ mode: 'none' }, { mode: 'selected', specifiers: ['jsails/a'] }]),
      { mode: 'selected', specifiers: ['jsails/a'] },
    );
  });

  it('applies a terminal narrowing last', () => {
    const union = resolveSymbolDeclarations(
      [{ mode: 'selected', specifiers: ['jsails/a', 'jsails/b'] }],
      { mode: 'selected', specifiers: ['jsails/a'] },
    );
    assert.deepEqual(union, { mode: 'selected', specifiers: ['jsails/a'] });

    assert.deepEqual(resolveSymbolDeclarations([{ mode: 'all' }], { mode: 'none' }), {
      mode: 'none',
    });
  });

  it('is deterministic and frozen', () => {
    const result = resolveSymbolDeclarations([
      { mode: 'selected', specifiers: ['jsails/b', 'jsails/a'] },
    ]);
    assert.deepEqual(result, { mode: 'selected', specifiers: ['jsails/a', 'jsails/b'] });
    assert.ok(Object.isFrozen(result));
    assert.ok(Object.isFrozen((result as { specifiers: readonly string[] }).specifiers));
  });
});
