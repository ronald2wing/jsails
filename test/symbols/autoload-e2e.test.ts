import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { scanAutoload } from '../../src/compiler/project-symbols-scan.js';
import { emitShimTree, scanShimModules } from '../../src/compiler/project-symbols-shims.js';
import { emitFrameworkSymbolsModule } from '../../src/compiler/framework-symbols-emit.js';
import { deriveFrameworkSymbols } from '../../src/symbols/framework-symbol-catalog-scan.js';
import { loadFrameworkAutoloadDeclaration } from '../../src/compiler/plugin-declaration-scan.js';

/**
 * End-to-end proof of the autoload contract for the **server tree**.
 *
 * The unit tests cover the pure pieces (the scanner, the shim renderer, the
 * declaration emitter). This test covers the one thing they cannot: that a
 * project tree with **no imports at all** type-checks against the generated
 * declarations and runs when the generated `.jsails/project-symbols.js` is preloaded.
 *
 * It does not spawn `tsc` (the repo's own suite already type-checks the emitted
 * `.d.ts` shape in `project-symbols-dts.test.ts`); instead it writes the small
 * compiled module bodies `tsc` would emit — a class reading a bare
 * `ApplicationRecord` and a class reading a bare sibling — and runs them under
 * the generated preload. That isolates the runtime ordering the preload owns.
 */

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

const fixturesRoot = mkdtempSync(join(tmpdir(), 'jsails-autoload-e2e-'));

after(() => {
  rmSync(fixturesRoot, { recursive: true, force: true });
});

/** Write `contents` to `path`, creating parent directories. */
function write(path: string, contents: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, contents);
}

/** Build a fixture project whose sources carry no imports. */
async function buildFixture(name: string): Promise<string> {
  const rootDir = join(fixturesRoot, name);
  mkdirSync(rootDir, { recursive: true });

  // ESM project root: `.js/…` files are modules, so `project-symbols.js` can use `import`.
  write(
    join(rootDir, 'package.json'),
    `${JSON.stringify({ name: 'autoload-e2e-fixture', private: true, type: 'module' }, null, 2)}\n`,
  );

  // `Author` reads a bare framework global; `Post` reads a bare project symbol
  // (the shape a surviving `@jsails.belongsTo(Author)` decorator produces).
  write(
    join(rootDir, 'models/author.ts'),
    'export class Author extends ApplicationRecord {\n  declare name: string;\n}\n',
  );
  write(
    join(rootDir, 'models/post.ts'),
    'export class Post extends ApplicationRecord {\n  static author = Author;\n}\n',
  );

  const registry = await scanAutoload(rootDir);
  const tree = emitShimTree(scanShimModules(registry), rootDir);
  for (const [relative, contents] of tree.files) {
    write(join(rootDir, '.jsails', relative), contents);
  }

  // The framework-symbol table `build:meta` derives from the framework's own
  // barrels (filtered by the curated framework declaration) and emits beside
  // `project-symbols.js`; the preload's installer reads it to publish the
  // framework globals (e.g. `ApplicationRecord`).
  const frameworkGlobals = deriveFrameworkSymbols({
    rootDir: repoRoot,
    declaration: loadFrameworkAutoloadDeclaration(repoRoot),
  });
  write(
    join(rootDir, '.jsails', 'framework-symbols.js'),
    emitFrameworkSymbolsModule(frameworkGlobals),
  );

  // The compiled output `tsc` would produce — order-independent, because the
  // preload is what establishes ordering.
  write(
    join(rootDir, 'dist/models/author.js'),
    'export class Author extends ApplicationRecord {\n}\n',
  );
  write(join(rootDir, 'dist/models/post.js'), 'export class Post extends ApplicationRecord {\n}\n');

  write(
    join(rootDir, 'probe.mjs'),
    [
      'console.log(`Author=${typeof globalThis.Author}`);',
      'console.log(`Post=${typeof globalThis.Post}`);',
      'console.log(`jsails=${typeof globalThis.jsails}`);',
      '',
    ].join('\n'),
  );

  // Resolve bare `jsails/*` specifiers the same way an installed project does.
  mkdirSync(join(rootDir, 'node_modules'), { recursive: true });
  symlinkSync(repoRoot, join(rootDir, 'node_modules/jsails'), 'dir');

  return rootDir;
}

function runProbe(rootDir: string, preload: boolean): string {
  const args = preload ? ['--import', './.jsails/project-symbols.js', 'probe.mjs'] : ['probe.mjs'];
  return execFileSync(process.execPath, args, { cwd: rootDir, encoding: 'utf8', timeout: 60_000 });
}

describe('autoload end to end (server tree)', () => {
  it(
    'emits a preload that installs framework globals before project shims',
    { skip: process.platform === 'win32' },
    async () => {
      const rootDir = await buildFixture('preload-order');
      const globals = readFileSync(join(rootDir, '.jsails/project-symbols.js'), 'utf8');

      const installLine = globals.indexOf('await installFrameworkSymbols(');
      const authorLine = globals.indexOf("await import('./project-symbols/models/author.js');");
      const postLine = globals.indexOf("await import('./project-symbols/models/post.js');");
      assert.ok(installLine >= 0, 'project-symbols.js awaits the framework install');
      assert.ok(
        installLine < authorLine && authorLine < postLine,
        'framework, then author, then post',
      );
    },
  );

  it(
    'resolves bare symbols at runtime when preloaded and fails without it',
    { skip: process.platform === 'win32' },
    async () => {
      const rootDir = await buildFixture('preload-runtime');

      const preloaded = runProbe(rootDir, true);
      assert.match(preloaded, /Author=function/);
      assert.match(preloaded, /Post=function/);
      assert.match(preloaded, /jsails=object/);

      const bare = runProbe(rootDir, false);
      assert.match(bare, /Author=undefined/);
      assert.match(bare, /Post=undefined/);
    },
  );

  it(
    'awaits a top-level-await provider and publishes it to a cross-context consumer',
    { skip: process.platform === 'win32' },
    async () => {
      // Mirrors the static starter: `server/content.ts` awaits an async
      // collection at module top level and `shared/site.ts` is a plain app
      // provider; a consumer reads both bare. The shim chain must await the
      // server provider's TLA before the consumer observes it.
      const rootDir = join(fixturesRoot, 'tla-provider');
      mkdirSync(rootDir, { recursive: true });
      write(
        join(rootDir, 'package.json'),
        `${JSON.stringify({ name: 'autoload-tla-fixture', private: true, type: 'module' }, null, 2)}\n`,
      );
      write(
        join(rootDir, 'server/content.ts'),
        'export const posts = await Promise.resolve([{ slug: "hello" }]);\n',
      );
      write(join(rootDir, 'shared/site.ts'), 'export const site = { title: "Blog" };\n');

      const registry = await scanAutoload(rootDir);
      const tree = emitShimTree(scanShimModules(registry), rootDir);
      for (const [relative, contents] of tree.files) {
        write(join(rootDir, '.jsails', relative), contents);
      }

      write(
        join(rootDir, 'dist/server/content.js'),
        'export const posts = await Promise.resolve([{ slug: "hello" }]);\n',
      );
      write(join(rootDir, 'dist/shared/site.js'), 'export const site = { title: "Blog" };\n');

      write(
        join(rootDir, 'probe.mjs'),
        [
          'console.log(`posts=${JSON.stringify(globalThis.posts)}`);',
          'console.log(`site=${JSON.stringify(globalThis.site)}`);',
          '',
        ].join('\n'),
      );

      mkdirSync(join(rootDir, 'node_modules'), { recursive: true });
      symlinkSync(repoRoot, join(rootDir, 'node_modules/jsails'), 'dir');

      const out = runProbe(rootDir, true);
      assert.match(out, /posts=\[\{"slug":"hello"\}\]/);
      assert.match(out, /site=\{"title":"Blog"\}/);
    },
  );
});
