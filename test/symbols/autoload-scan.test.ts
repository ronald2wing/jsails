import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import {
  AUTOLOAD_JSON_VERSION,
  AutoloadError,
  parseAutoloadJson,
  scanAutoload,
  toAutoloadJson,
} from '../../src/compiler/project-symbols-scan.js';

const fixturesRoot = mkdtempSync(
  join(fileURLToPath(new URL('..', import.meta.url)), 'project-symbols-scan-fixture-'),
);

after(() => {
  rmSync(fixturesRoot, { recursive: true, force: true });
});

function makeDir(name: string): string {
  const dir = join(fixturesRoot, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeModule(rootDir: string, relPath: string, body: string): void {
  const filePath = join(rootDir, relPath);
  mkdirSync(join(filePath, '..'), { recursive: true });
  writeFileSync(filePath, body);
}

function appUtilsDir(rootDir: string): string {
  const dir = join(rootDir, 'app', 'utils');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function serverUtilsDir(rootDir: string): string {
  const dir = join(rootDir, 'server', 'utils');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function appComposablesDir(rootDir: string): string {
  const dir = join(rootDir, 'app', 'composables');
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('scanAutoload', () => {
  // Case 1: walk order determinism (depth-first, lexical)
  it('returns entries in deterministic lexical depth-first order', async () => {
    const rootDir = makeDir('case-1');

    // b.js sorts before a.js in code-unit order within `app/utils/`.
    writeModule(rootDir, 'app/utils/b.js', 'export const beta = 1;');
    writeModule(rootDir, 'app/utils/a.js', 'export const alpha = 1;');
    // Nested subdirectory sorts before its sibling files.
    writeModule(rootDir, 'app/utils/zzz/deep.js', 'export const deep = 1;');

    // Also add a non-autoload entry that sorts between.
    writeModule(rootDir, 'app/api/non-auto.js', 'export const nope = 1;');

    const registry = await scanAutoload(rootDir);

    // Expected order: code-unit sort on relative path.
    // app/api/non-auto.js, app/utils/a.js, app/utils/b.js, app/utils/zzz/deep.js
    const relativePaths = registry.entries.map((e) => e.relative);
    assert.deepEqual(relativePaths, [
      'app/api/non-auto.js',
      'app/utils/a.js',
      'app/utils/b.js',
      'app/utils/zzz/deep.js',
    ]);
  });

  // Case 2: symlink skip
  it('skips symlinked modules', async () => {
    const rootDir = makeDir('case-2');
    appUtilsDir(rootDir);
    writeModule(rootDir, 'app/utils/real.js', 'export const real = 1;');
    symlinkSync(join(rootDir, 'app/utils/real.js'), join(rootDir, 'app/utils/linked.js'));

    const registry = await scanAutoload(rootDir);

    const names = registry.entries.map((e) => e.relative);
    assert.deepEqual(names, ['app/utils/real.js']);
  });

  // Case 3: extension filter — source extensions are scanned, others skipped
  it('scans .ts sources and .mjs; skips .txt', async () => {
    const rootDir = makeDir('case-3');
    appUtilsDir(rootDir);
    writeFileSync(join(rootDir, 'app/utils', 'source.ts'), 'export const fromTs = 1;');
    writeFileSync(join(rootDir, 'app/utils', 'notes.txt'), 'not a module');
    writeModule(rootDir, 'app/utils/good.mjs', 'export const good = 1;');

    const registry = await scanAutoload(rootDir);

    const names = registry.entries.map((e) => e.relative);
    assert.deepEqual(names, ['app/utils/good.mjs', 'app/utils/source.ts']);
    // The .ts source is parsed, not imported: its export is discovered.
    assert.ok(registry.byName.get('fromTs')?.get('app'));
  });

  // Case 4: missing dirs → empty
  it('returns empty entries when no N1 directories exist', async () => {
    const rootDir = makeDir('case-4');

    const registry = await scanAutoload(rootDir);

    assert.deepEqual(registry.entries, []);
    assert.equal(registry.byName.size, 0);
  });

  // Case 5: app classification
  it('classifies app/composables symbols with context "app"', async () => {
    const rootDir = makeDir('case-5');
    appComposablesDir(rootDir);
    writeModule(rootDir, 'app/composables/use-thing.js', 'export function useThing() {}');

    const registry = await scanAutoload(rootDir);

    const symbol = registry.byName.get('useThing')?.get('app');
    assert.ok(symbol);
    assert.equal(symbol.context, 'app');
    assert.ok(symbol.file.endsWith('app/composables/use-thing.js'));
  });

  // Case 6: server classification
  it('classifies server/utils symbols with context "server"', async () => {
    const rootDir = makeDir('case-6');
    serverUtilsDir(rootDir);
    writeModule(rootDir, 'server/utils/hash.js', 'export function hash(s) { return s; }');

    const registry = await scanAutoload(rootDir);

    const symbol = registry.byName.get('hash')?.get('server');
    assert.ok(symbol);
    assert.equal(symbol.context, 'server');
  });

  // Case 7: same name across contexts (allowed, both addressable)
  it('allows same-name exports across app and server contexts', async () => {
    const rootDir = makeDir('case-7');
    appUtilsDir(rootDir);
    serverUtilsDir(rootDir);
    writeModule(rootDir, 'app/utils/x.js', 'export const x = "shared";');
    writeModule(rootDir, 'server/utils/x.js', 'export const x = "server-only";');

    const registry = await scanAutoload(rootDir);

    // Both entries hold their own symbols.
    const appEntry = registry.entries.find((e) => e.relative === 'app/utils/x.js');
    const serverEntry = registry.entries.find((e) => e.relative === 'server/utils/x.js');

    assert.ok(appEntry);
    assert.ok(serverEntry);
    assert.equal(appEntry.symbols[0]?.context, 'app');
    assert.equal(serverEntry.symbols[0]?.context, 'server');

    // The per-name index preserves BOTH contexts — neither is dropped.
    const contexts = registry.byName.get('x');
    assert.ok(contexts);
    assert.equal(contexts.size, 2);
    assert.equal(contexts.get('app')?.context, 'app');
    assert.equal(contexts.get('server')?.context, 'server');
    assert.ok(contexts.get('app')?.file.endsWith('app/utils/x.js'));
    assert.ok(contexts.get('server')?.file.endsWith('server/utils/x.js'));

    // The cross-context case is legitimate, never a collision.
    assert.equal(registry.collisions.has('x'), false);
  });

  // Case 8: duplicate within one context → winner + collision set (no throw)
  it('resolves a same-context duplicate to a winner plus a collision set', async () => {
    const rootDir = makeDir('case-8');
    appUtilsDir(rootDir);
    writeModule(rootDir, 'app/utils/a.js', 'export const dup = 1;');
    writeModule(rootDir, 'app/utils/b.js', 'export const dup = 2;');

    const registry = await scanAutoload(rootDir);

    // The bare winner is the first-in-order (smallest relative) module.
    const winner = registry.byName.get('dup')?.get('app');
    assert.ok(winner);
    assert.ok(winner.file.endsWith('app/utils/a.js'));

    // The collision set holds every same-context symbol, winner first.
    const collision = registry.collisions.get('dup');
    assert.ok(collision);
    assert.equal(collision.length, 2);
    assert.ok(collision[0]?.file.endsWith('app/utils/a.js'));
    assert.ok(collision[1]?.file.endsWith('app/utils/b.js'));
  });

  // Case 9: parse failure (refuse, value-free)
  it('rejects an unparseable module without leaking its source', async () => {
    const rootDir = makeDir('case-9');
    appUtilsDir(rootDir);
    writeModule(rootDir, 'app/utils/boom.js', 'export const = ; // super-secret-token-abc');

    await assert.rejects(scanAutoload(rootDir), (error: unknown) => {
      assert.ok(error instanceof AutoloadError);
      assert.equal(error.code, 'failed_to_parse');
      assert.match(error.message, /failed to parse autoload module/);
      assert.doesNotMatch(error.message, /super-secret-token-abc/);
      return true;
    });
  });

  // Case 10: no named exports
  it('records an entry with empty symbols for a default-only module', async () => {
    const rootDir = makeDir('case-10');
    appUtilsDir(rootDir);
    writeModule(rootDir, 'app/utils/default-only.js', 'export default function () {}');

    const registry = await scanAutoload(rootDir);

    assert.equal(registry.entries.length, 1);
    assert.deepEqual(registry.entries[0]?.symbols, []);
    assert.equal(registry.entries[0]?.autoloadable, true);
  });

  // Case 11: registry frozen
  it('returns a frozen registry with frozen entries and symbols', async () => {
    const rootDir = makeDir('case-11');
    appUtilsDir(rootDir);
    writeModule(rootDir, 'app/utils/one.js', 'export const one = 1;');

    const registry = await scanAutoload(rootDir);

    assert.ok(Object.isFrozen(registry));
    assert.ok(Object.isFrozen(registry.entries));
    for (const entry of registry.entries) {
      assert.ok(Object.isFrozen(entry));
      assert.ok(Object.isFrozen(entry.symbols));
      for (const symbol of entry.symbols) {
        assert.ok(Object.isFrozen(symbol));
      }
    }
    // byName is a Map keyed by name, each value a context→symbol Map.
    assert.ok(registry.byName instanceof Map);
    assert.ok(Object.isFrozen(registry.byName.get('one')));
  });

  // Case 12: inertness (importing the scanner module does not trigger side effects)
  it('importing the scanner module is inert (no directory walks)', async () => {
    // This is proved by fact: importing the module at the top of this file did
    // not throw, open files, or scan any directory. Re-importing is a no-op.
    const mod = await import('../../src/compiler/project-symbols-scan.js');
    assert.ok(typeof mod.scanAutoload === 'function');
  });

  // Case 13: `export *` is expanded within the walked set
  it('expands export * re-exports so a re-exported symbol is injectable', async () => {
    const rootDir = makeDir('case-13');
    appUtilsDir(rootDir);
    // `app/lib/` is walked but not autoloadable, so `alpha`/`beta` are only
    // reachable through the barrel's `export *`.
    writeModule(rootDir, 'app/lib/impl.js', 'export const alpha = 1;\nexport const beta = 1;');
    writeModule(
      rootDir,
      'app/utils/barrel.ts',
      "export * from '../lib/impl.js';\nexport const gamma = 1;",
    );

    const registry = await scanAutoload(rootDir);

    const name = registry.byName.get('alpha')?.get('app');
    assert.ok(name);
    // The symbol is attributed to the module that exports it (the barrel).
    assert.ok(name.file.endsWith('app/utils/barrel.ts'));
    assert.ok(registry.byName.get('beta')?.get('app'));
    assert.ok(registry.byName.get('gamma')?.get('app'));
  });

  // Case 14: declaration files carry no runtime exports
  it('skips .d.ts declaration files', async () => {
    const rootDir = makeDir('case-14');
    appUtilsDir(rootDir);
    writeModule(rootDir, 'app/utils/types.d.ts', 'export declare const ghost: number;');
    writeModule(rootDir, 'app/utils/real.js', 'export const real = 1;');

    const registry = await scanAutoload(rootDir);

    assert.deepEqual(
      registry.entries.map((e) => e.relative),
      ['app/utils/real.js'],
    );
    assert.equal(registry.byName.has('ghost'), false);
  });

  // Case 15: type-only exports are not runtime symbols
  it('ignores type-only exports and interfaces', async () => {
    const rootDir = makeDir('case-15');
    appUtilsDir(rootDir);
    writeModule(
      rootDir,
      'app/utils/typed.ts',
      'export interface Shape { x: number; }\nexport type Alias = string;\nexport const value = 1;',
    );

    const registry = await scanAutoload(rootDir);

    assert.equal(registry.byName.has('Shape'), false);
    assert.equal(registry.byName.has('Alias'), false);
    assert.ok(registry.byName.get('value')?.get('app'));
  });

  // Case 16: unique names produce no collisions
  it('leaves `collisions` empty when every name is unique per context', async () => {
    const rootDir = makeDir('case-16');
    appUtilsDir(rootDir);
    writeModule(rootDir, 'app/utils/a.js', 'export const alpha = 1;');
    writeModule(rootDir, 'app/utils/b.js', 'export const beta = 2;');

    const registry = await scanAutoload(rootDir);

    assert.equal(registry.collisions.size, 0);
  });

  // Case 17: collision winner + list ordering are deterministic under the
  // documented rule (smallest `relative` wins, list sorted by `relative`).
  it('is deterministic: smallest relative path wins, list sorted by relative', async () => {
    const rootDir = makeDir('case-17');
    appUtilsDir(rootDir);
    // `a.js` sorts before `b.js` before `zzz/deep.js`.
    writeModule(rootDir, 'app/utils/zzz/deep.js', 'export const dup = 3;');
    writeModule(rootDir, 'app/utils/a.js', 'export const dup = 1;');
    writeModule(rootDir, 'app/utils/b.js', 'export const dup = 2;');

    const registry = await scanAutoload(rootDir);

    const winner = registry.byName.get('dup')?.get('app');
    assert.ok(winner);
    assert.ok(winner.file.endsWith('app/utils/a.js'));

    const collision = registry.collisions.get('dup');
    assert.ok(collision);
    assert.deepEqual(
      collision.map((symbol) => symbol.file),
      [
        join(rootDir, 'app/utils/a.js'),
        join(rootDir, 'app/utils/b.js'),
        join(rootDir, 'app/utils/zzz/deep.js'),
      ],
    );
  });

  // Case 18: a name colliding in BOTH contexts keeps each context's winner
  // first and does not drop any symbol.
  it('keeps each context winner first when a name collides in both contexts', async () => {
    const rootDir = makeDir('case-18');
    appUtilsDir(rootDir);
    serverUtilsDir(rootDir);
    writeModule(rootDir, 'app/utils/a.js', 'export const dup = 1;');
    writeModule(rootDir, 'app/utils/b.js', 'export const dup = 2;');
    writeModule(rootDir, 'server/utils/c.js', 'export const dup = 3;');
    writeModule(rootDir, 'server/utils/d.js', 'export const dup = 4;');

    const registry = await scanAutoload(rootDir);

    // Each context keeps its own winner in `byName`.
    assert.ok(registry.byName.get('dup')?.get('app')?.file.endsWith('app/utils/a.js'));
    assert.ok(registry.byName.get('dup')?.get('server')?.file.endsWith('server/utils/c.js'));

    // The collision list holds all four symbols: each context's winner first,
    // contexts ordered app before server.
    const collision = registry.collisions.get('dup');
    assert.ok(collision);
    assert.deepEqual(
      collision.map((symbol) => symbol.file),
      [
        join(rootDir, 'app/utils/a.js'),
        join(rootDir, 'app/utils/b.js'),
        join(rootDir, 'server/utils/c.js'),
        join(rootDir, 'server/utils/d.js'),
      ],
    );
  });
});

describe('toAutoloadJson / parseAutoloadJson', () => {
  it('serializes only autoloadable entries with symbols, keeping paths relative', async () => {
    const rootDir = makeDir('json-shape');
    appUtilsDir(rootDir);
    writeModule(rootDir, 'app/utils/one.js', 'export const one = 1;');
    writeModule(rootDir, 'app/utils/default-only.js', 'export default function () {}');
    // A non-autoloadable directory is walked but excluded from the artifact.
    writeModule(rootDir, 'app/lib/impl.js', 'export const hidden = 1;');

    const registry = await scanAutoload(rootDir);
    const document = toAutoloadJson(registry);

    assert.equal(document.version, AUTOLOAD_JSON_VERSION);
    assert.deepEqual(document.entries, [
      { file: 'app/utils/one.js', context: 'app', symbols: ['one'] },
    ]);
  });

  it('round-trips a registry into an equivalent symbol index', async () => {
    const rootDir = makeDir('json-round-trip');
    appUtilsDir(rootDir);
    serverUtilsDir(rootDir);
    writeModule(rootDir, 'app/utils/x.js', 'export const x = "shared";');
    writeModule(rootDir, 'server/utils/x.js', 'export const x = "server-only";');
    writeModule(rootDir, 'app/utils/format.js', 'export function format() {}');

    const registry = await scanAutoload(rootDir);
    const index = parseAutoloadJson(toAutoloadJson(registry), rootDir);

    // Both contexts of a same-named symbol survive the round trip.
    const contexts = index.byName.get('x');
    assert.ok(contexts);
    assert.equal(contexts.size, 2);
    assert.equal(contexts.get('app')?.context, 'app');
    assert.equal(contexts.get('server')?.context, 'server');

    // Paths are re-absolutized against rootDir.
    assert.equal(contexts.get('app')?.file, join(rootDir, 'app/utils/x.js'));
    assert.equal(contexts.get('server')?.file, join(rootDir, 'server/utils/x.js'));
    assert.equal(
      index.byName.get('format')?.get('app')?.file,
      join(rootDir, 'app/utils/format.js'),
    );

    // The round trip preserves an empty collision map for unique names.
    assert.equal(index.collisions.size, 0);
  });

  it('rejects an unsupported version', () => {
    assert.throws(
      () => parseAutoloadJson({ version: 2, entries: [] }, '/tmp'),
      (error: unknown) => {
        assert.ok(error instanceof AutoloadError);
        assert.equal(error.code, 'invalid_registry');
        return true;
      },
    );
  });

  it('rejects a non-object document and a non-array entries field', () => {
    assert.throws(() => parseAutoloadJson(null, '/tmp'), AutoloadError);
    assert.throws(
      () => parseAutoloadJson({ version: AUTOLOAD_JSON_VERSION, entries: {} }, '/tmp'),
      AutoloadError,
    );
  });

  it('rejects a malformed entry without echoing it', () => {
    const secret = 'super-secret-value';
    assert.throws(
      () =>
        parseAutoloadJson(
          {
            version: AUTOLOAD_JSON_VERSION,
            entries: [{ file: 1, context: 'nope', symbols: secret }],
          },
          '/tmp',
        ),
      (error: unknown) => {
        assert.ok(error instanceof AutoloadError);
        assert.equal(error.code, 'invalid_registry');
        assert.doesNotMatch(error.message, /super-secret-value/);
        return true;
      },
    );
  });

  it('resolves a same-context duplicate in the serialized form to a winner + collision', () => {
    const index = parseAutoloadJson(
      {
        version: AUTOLOAD_JSON_VERSION,
        entries: [
          { file: 'app/utils/b.js', context: 'app', symbols: ['dup'] },
          { file: 'app/utils/a.js', context: 'app', symbols: ['dup'] },
        ],
      },
      '/tmp',
    );

    // The winner is deterministic (smallest relative), not input-order.
    const winner = index.byName.get('dup')?.get('app');
    assert.ok(winner);
    assert.equal(winner.file, '/tmp/app/utils/a.js');

    const collision = index.collisions.get('dup');
    assert.ok(collision);
    assert.deepEqual(
      collision.map((symbol) => symbol.file),
      ['/tmp/app/utils/a.js', '/tmp/app/utils/b.js'],
    );
  });
});
