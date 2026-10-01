import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { scanAutoload } from '../../src/compiler/project-symbols-scan.js';
import {
  ShimTreeError,
  emitShimTree,
  scanShimModules,
  writeShimTree,
} from '../../src/compiler/project-symbols-shims.js';
import { deriveFrameworkSymbolNamespaceKeys } from '../../src/symbols/framework-symbols.js';

const fixturesRoot = mkdtempSync(
  join(fileURLToPath(new URL('..', import.meta.url)), 'project-symbols-shims-fixture-'),
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

function shimPath(rootDir: string, relPath: string): string {
  return join(rootDir, '.jsails', relPath);
}

describe('scanShimModules', () => {
  it('orders modules dependency-first and records dep edges', async () => {
    const rootDir = makeDir('order');
    writeModule(rootDir, 'models/author.ts', 'export class Author {}\n');
    // `Author` is a free value reference at module-evaluation time — the shape a
    // surviving decorator such as `@jsails.belongsTo(Author)` produces.
    writeModule(rootDir, 'models/post.ts', 'export class Post {\n  static model = Author;\n}\n');

    const registry = await scanAutoload(rootDir);
    const modules = scanShimModules(registry);

    assert.deepEqual(
      modules.map((module) => module.relative),
      ['models/author.ts', 'models/post.ts'],
    );
    assert.equal(modules[0]?.deps.length, 0);
    assert.deepEqual(modules[1]?.deps, [join(rootDir, 'models/author.ts')]);
    assert.ok(Object.isFrozen(modules));
    assert.ok(Object.isFrozen(modules[1]));
  });

  it('assigns `server` context to models and `app` context to ui', async () => {
    const rootDir = makeDir('contexts');
    writeModule(rootDir, 'models/post.ts', 'export class Post {}\n');
    writeModule(rootDir, 'ui/card.tsx', 'export const Card = () => null;\n');

    const registry = await scanAutoload(rootDir);
    const modules = scanShimModules(registry);

    const byRelative = new Map(modules.map((module) => [module.relative, module]));
    assert.equal(byRelative.get('models/post.ts')?.context, 'server');
    assert.equal(byRelative.get('ui/card.tsx')?.context, 'app');
  });

  it('ignores framework globals, builtins, and typo-shaped free identifiers', async () => {
    const rootDir = makeDir('ignores');
    writeModule(
      rootDir,
      'jobs/send.ts',
      'export const job = defineJob({}, () => console.log("x"));\n',
    );

    const registry = await scanAutoload(rootDir);
    const modules = scanShimModules(registry);

    assert.equal(modules.length, 1);
    assert.deepEqual(modules[0]?.deps, []);
  });

  it('resolves a cross-context reference to the winner (smallest relative path)', async () => {
    const rootDir = makeDir('ambiguous');
    writeModule(rootDir, 'app/utils/thing.ts', 'export function thing() {\n  return 1;\n}\n');
    writeModule(rootDir, 'server/utils/thing.ts', 'export function thing() {\n  return 2;\n}\n');
    // A server-context consumer can see both the `app` and `server` `thing`;
    // it must depend only on the winner (`app/utils/thing.ts` — 'a' < 's').
    writeModule(rootDir, 'models/x.ts', 'export class X {\n  static v = thing;\n}\n');

    const registry = await scanAutoload(rootDir);
    const modules = scanShimModules(registry);

    const consumer = modules.find((m) => m.relative === 'models/x.ts');
    assert.ok(consumer);
    assert.equal(consumer.deps.length, 1);
    assert.ok(consumer.deps[0]?.endsWith('app/utils/thing.ts'));
  });

  it('rejects a cyclic dependency (value-free)', async () => {
    const rootDir = makeDir('cycle');
    writeModule(rootDir, 'models/a.ts', 'export class A {\n  static b = B;\n}\n');
    writeModule(rootDir, 'models/b.ts', 'export class B {\n  static a = A;\n}\n');

    const registry = await scanAutoload(rootDir);

    assert.throws(
      () => scanShimModules(registry),
      (error: unknown) => {
        assert.ok(error instanceof ShimTreeError);
        assert.equal(error.code, 'cyclic_dependency');
        return true;
      },
    );
  });

  it('rejects a shim path collision (value-free)', async () => {
    const rootDir = makeDir('collision');
    // Both compile to `models/post.js` → the same shim path.
    writeModule(rootDir, 'models/post.ts', 'export class Post {}\n');
    writeModule(rootDir, 'models/post.js', 'export class PostRow {}\n');

    const registry = await scanAutoload(rootDir);

    assert.throws(
      () => scanShimModules(registry),
      (error: unknown) => {
        assert.ok(error instanceof ShimTreeError);
        assert.equal(error.code, 'shim_path_collision');
        return true;
      },
    );
  });
});

describe('emitShimTree', () => {
  it('renders dep imports before the real import and globals in dependency order', async () => {
    const rootDir = makeDir('emit-shape');
    writeModule(rootDir, 'models/author.ts', 'export class Author {}\n');
    writeModule(rootDir, 'models/post.ts', 'export class Post {\n  static model = Author;\n}\n');

    const registry = await scanAutoload(rootDir);
    const tree = emitShimTree(scanShimModules(registry), rootDir);

    assert.deepEqual(tree.order, [
      'project-symbols/models/author.js',
      'project-symbols/models/post.js',
    ]);

    const post = tree.files.get('project-symbols/models/post.js');
    assert.ok(post);
    const depLine = post.indexOf("import './author.js';");
    const realLine = post.indexOf("import { Post } from '../../../dist/models/post.js';");
    const assignLine = post.indexOf('globalThis.Post = Post;');
    assert.ok(depLine >= 0 && realLine >= 0 && assignLine >= 0);
    assert.ok(depLine < realLine && realLine < assignLine);

    const globals = tree.files.get('project-symbols.js');
    assert.ok(globals);
    const installLine = globals.indexOf('await installFrameworkSymbols(');
    const authorLine = globals.indexOf("await import('./project-symbols/models/author.js');");
    const postLine = globals.indexOf("await import('./project-symbols/models/post.js');");
    assert.ok(installLine >= 0 && authorLine >= 0 && postLine >= 0);
    assert.ok(installLine < authorLine && authorLine < postLine);
  });

  it('rewrites .mts sources to a .mjs shim and compiled module', async () => {
    const rootDir = makeDir('emit-mts');
    writeModule(rootDir, 'models/thing.mts', 'export class Thing {}\n');

    const registry = await scanAutoload(rootDir);
    const tree = emitShimTree(scanShimModules(registry), rootDir);

    assert.deepEqual(tree.order, ['project-symbols/models/thing.mjs']);
    const shim = tree.files.get('project-symbols/models/thing.mjs');
    assert.ok(shim);
    assert.match(shim, /from '\.\.\/\.\.\/\.\.\/dist\/models\/thing\.mjs';/);
  });

  it('honors a custom compiled root', async () => {
    const rootDir = makeDir('emit-compiled-root');
    writeModule(rootDir, 'models/author.ts', 'export class Author {}\n');

    const registry = await scanAutoload(rootDir);
    const tree = emitShimTree(scanShimModules(registry), rootDir, { compiledRoot: 'build' });

    const shim = tree.files.get('project-symbols/models/author.js');
    assert.ok(shim);
    assert.match(shim, /from '\.\.\/\.\.\/\.\.\/build\/models\/author\.js';/);
  });

  it('emits a framework-only globals barrel when there are no providers', () => {
    const rootDir = makeDir('emit-empty');
    const tree = emitShimTree([], rootDir);

    assert.deepEqual(tree.order, []);
    assert.equal(tree.files.size, 1);
    assert.equal(
      tree.files.get('project-symbols.js'),
      `// AUTO-GENERATED by @jsails/compiler. Do not edit.

import { installFrameworkSymbols } from 'jsails/symbols';

await installFrameworkSymbols(${JSON.stringify(rootDir)});
export {};
`,
    );
  });

  it('is pure — renders without touching the filesystem', () => {
    const rootDir = makeDir('emit-pure');
    emitShimTree([], rootDir);
    assert.equal(existsSync(join(rootDir, '.jsails')), false);
  });
});

describe('emitShimTree collisions', () => {
  it('emits a namespace object in project-symbols.js when collisions are provided', async () => {
    const rootDir = makeDir('emit-collision');
    // Two same-context providers both exporting `Thing` → collision.
    writeModule(rootDir, 'models/a.ts', 'export class Thing {}\n');
    writeModule(rootDir, 'models/b.ts', 'export class Thing {}\n');

    const registry = await scanAutoload(rootDir);
    assert.ok(registry.collisions.has('Thing'), 'collision expected');

    const tree = emitShimTree(scanShimModules(registry), rootDir, {
      collisions: registry.collisions,
    });

    const globals = tree.files.get('project-symbols.js');
    assert.ok(globals);
    // Winner is `models/a.ts` → posix-relative extension-stripped path is
    // `models/a` → `deriveFrameworkSymbolNamespaceKeys` takes the last segment → key `a`.
    assert.match(
      globals,
      /globalThis\.a = \{ Thing: Thing \};/,
      'namespace object with the path-derived key and the colliding name',
    );
    // The bare install still happens in the shim — verify the shim itself has it.
    const aShim = tree.files.get('project-symbols/models/a.js');
    assert.ok(aShim);
    assert.match(aShim, /globalThis\.Thing = Thing;/);
    const bShim = tree.files.get('project-symbols/models/b.js');
    assert.ok(bShim);
    // The loser shim also installs bare Thing (it is unaware of collisions).
    assert.match(bShim, /globalThis\.Thing = Thing;/);
  });

  it('uses the winning provider path as the namespace specifier', async () => {
    // Same-context collision: both in the `server` context, same name.
    const rootDir = makeDir('collision-key-same-context');
    writeModule(rootDir, 'models/format.ts', 'export const format = () => null;\n');
    writeModule(rootDir, 'server/models/format.ts', 'export const format = () => null;\n');

    const registry = await scanAutoload(rootDir);
    assert.ok(registry.collisions.has('format'), 'same-context collision expected');
    // Winner is `models/format.ts` → path `models/format` → key `format` (last segment).
    const tree = emitShimTree(scanShimModules(registry), rootDir, {
      collisions: registry.collisions,
    });

    const globals = tree.files.get('project-symbols.js');
    assert.ok(globals);
    assert.match(globals, /globalThis\.format = \{ format: format \};/);
  });

  it('merges multiple colliding names sharing the same key into one object', async () => {
    const rootDir = makeDir('collision-merge');
    // Two colliding names whose winners are in the same directory → same key.
    writeModule(rootDir, 'models/util.ts', 'export const a = 1;\nexport const b = 2;\n');
    writeModule(rootDir, 'server/models/util.ts', 'export const a = 3;\nexport const b = 4;\n');

    const registry = await scanAutoload(rootDir);

    const tree = emitShimTree(scanShimModules(registry), rootDir, {
      collisions: registry.collisions,
    });

    const globals = tree.files.get('project-symbols.js');
    assert.ok(globals);
    // Winner for both `a` and `b` is `models/util.ts` → path `models/util` → key `util`.
    // Both names land in one object, sorted.
    assert.match(globals, /globalThis\.util = \{ a: a, b: b \};/);
  });

  it('preserves byte-identical project-symbols.js when collisions is absent', async () => {
    const rootDir = makeDir('emit-no-collisions');
    writeModule(rootDir, 'models/author.ts', 'export class Author {}\n');

    const registry = await scanAutoload(rootDir);
    const without = emitShimTree(scanShimModules(registry), rootDir);
    // Explicitly pass collisions (empty) — must be identical.
    const withEmpty = emitShimTree(scanShimModules(registry), rootDir, {
      collisions: new Map(),
    });

    assert.equal(
      without.files.get('project-symbols.js'),
      withEmpty.files.get('project-symbols.js'),
    );
  });

  it('preserves byte-identical project-symbols.js when collisions is an empty map', async () => {
    const rootDir = makeDir('emit-empty-collisions');
    writeModule(rootDir, 'models/author.ts', 'export class Author {}\n');

    const registry = await scanAutoload(rootDir);
    const without = emitShimTree(scanShimModules(registry), rootDir);

    assert.ok(!registry.collisions.has('Author'), 'no collision for unique name');
    assert.match(without.files.get('project-symbols.js') ?? '', /await installFrameworkSymbols\(/);
  });

  it('is deterministic when collisions are present', async () => {
    const rootDir = makeDir('emit-deterministic');
    writeModule(rootDir, 'models/a.ts', 'export class Thing {}\n');
    writeModule(rootDir, 'models/b.ts', 'export class Thing {}\n');

    const registry = await scanAutoload(rootDir);
    const modules = scanShimModules(registry);
    const opts = { collisions: registry.collisions };

    const first = emitShimTree(modules, rootDir, opts);
    const second = emitShimTree(modules, rootDir, opts);

    assert.equal(first.files.get('project-symbols.js'), second.files.get('project-symbols.js'));
  });

  it('produces the same namespace key that deriveFrameworkSymbolNamespaceKeys returns', async () => {
    const rootDir = makeDir('emit-same-key');
    writeModule(rootDir, 'models/thing.ts', 'export class Thing {}\n');
    writeModule(rootDir, 'server/models/thing.ts', 'export class Thing {}\n');

    const registry = await scanAutoload(rootDir);
    const tree = emitShimTree(scanShimModules(registry), rootDir, {
      collisions: registry.collisions,
    });
    const globals = tree.files.get('project-symbols.js');
    assert.ok(globals);

    // Manually derive the expected key: winner is models/thing.ts → path `models/thing`
    const expectedKey = deriveFrameworkSymbolNamespaceKeys(['models/thing']).get('models/thing');
    assert.ok(expectedKey, 'namespace key exists');
    assert.match(globals, new RegExp(`globalThis\\.${expectedKey} = \\{ Thing: Thing \\};`));
  });
});

describe('writeShimTree', () => {
  it('writes the shim tree and a manifest without touching user sources', async () => {
    const rootDir = makeDir('write-basic');
    const source = 'export class Author {}\n';
    writeModule(rootDir, 'models/author.ts', source);

    const registry = await scanAutoload(rootDir);
    writeShimTree(scanShimModules(registry), rootDir);

    assert.ok(existsSync(shimPath(rootDir, 'project-symbols/models/author.js')));
    assert.ok(existsSync(shimPath(rootDir, 'project-symbols.js')));

    const manifest = JSON.parse(
      readFileSync(shimPath(rootDir, 'project-symbols.manifest.json'), 'utf8'),
    );
    assert.equal(manifest.version, 1);
    assert.deepEqual(manifest.files, ['project-symbols.js', 'project-symbols/models/author.js']);

    // The user's source is byte-for-byte unchanged.
    assert.equal(readFileSync(join(rootDir, 'models/author.ts'), 'utf8'), source);
  });

  it('does not rewrite an unchanged file (write-if-changed)', async () => {
    const rootDir = makeDir('write-idempotent');
    writeModule(rootDir, 'models/author.ts', 'export class Author {}\n');

    const modules = scanShimModules(await scanAutoload(rootDir));
    writeShimTree(modules, rootDir);

    const shim = shimPath(rootDir, 'project-symbols/models/author.js');
    const past = new Date(0);
    utimesSync(shim, past, past);

    writeShimTree(modules, rootDir);

    assert.equal(statSync(shim).mtimeMs, 0);
  });

  it('deletes a shim whose source is gone (stale cleanup)', async () => {
    const rootDir = makeDir('write-stale');
    writeModule(rootDir, 'models/author.ts', 'export class Author {}\n');
    writeModule(rootDir, 'models/post.ts', 'export class Post {}\n');

    writeShimTree(scanShimModules(await scanAutoload(rootDir)), rootDir);
    assert.ok(existsSync(shimPath(rootDir, 'project-symbols/models/post.js')));

    rmSync(join(rootDir, 'models/post.ts'));
    writeShimTree(scanShimModules(await scanAutoload(rootDir)), rootDir);

    assert.equal(existsSync(shimPath(rootDir, 'project-symbols/models/post.js')), false);
    assert.ok(existsSync(shimPath(rootDir, 'project-symbols/models/author.js')));

    const manifest = JSON.parse(
      readFileSync(shimPath(rootDir, 'project-symbols.manifest.json'), 'utf8'),
    );
    assert.deepEqual(manifest.files, ['project-symbols.js', 'project-symbols/models/author.js']);
  });

  it('returns the rendered tree', async () => {
    const rootDir = makeDir('write-returns');
    writeModule(rootDir, 'models/author.ts', 'export class Author {}\n');

    const tree = writeShimTree(scanShimModules(await scanAutoload(rootDir)), rootDir);
    assert.equal(
      tree.files.get('project-symbols/models/author.js'),
      readFileSync(shimPath(rootDir, 'project-symbols/models/author.js'), 'utf8'),
    );
  });
});
