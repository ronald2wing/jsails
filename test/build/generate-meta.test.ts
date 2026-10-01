import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import {
  buildMetaArtifacts,
  emitAutoloadJson,
  emitComponentsRegistry,
  emitModelsRegistry,
  writeMetaArtifacts,
} from '../../src/build/generate-meta.js';

import type { AutoloadRegistry } from '../../src/compiler/project-symbols-scan.js';
import type { ExtractedModel } from '../../src/compiler/model-extract.js';
import type { ComponentModule, ProjectMeta } from '../../src/build/meta-scan.js';
import { deriveFrameworkSymbols } from '../../src/symbols/framework-symbol-catalog-scan.js';
import { loadFrameworkAutoloadDeclaration } from '../../src/compiler/plugin-declaration-scan.js';

const fixturesRoot = mkdtempSync(
  join(fileURLToPath(new URL('..', import.meta.url)), 'generate-meta-fixture-'),
);

/** The repo root, so the scan reads the framework's own `src/` barrels. */
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

/** The framework's curated autoload surface, read from `jsails.plugin.json`. */
const frameworkGlobals = loadFrameworkAutoloadDeclaration(repoRoot);

after(() => {
  rmSync(fixturesRoot, { recursive: true, force: true });
});

const emptyRegistry: AutoloadRegistry = { entries: [], byName: new Map(), collisions: new Map() };

function model(overrides: Partial<ExtractedModel> = {}): ExtractedModel {
  return {
    className: 'Post',
    tableName: 'post',
    fields: [],
    encrypted: [],
    ...overrides,
  };
}

describe('emitAutoloadJson', () => {
  it('emits only autoloadable entries with symbols', () => {
    const registry: AutoloadRegistry = {
      entries: [
        {
          file: '/proj/app/utils/format.ts',
          relative: 'app/utils/format.ts',
          context: 'app',
          autoloadable: true,
          symbols: [{ name: 'formatDate', context: 'app', file: '/proj/app/utils/format.ts' }],
        },
        {
          file: '/proj/app/api/ping.ts',
          relative: 'app/api/ping.ts',
          context: 'app',
          autoloadable: false,
          symbols: [],
        },
      ],
      byName: new Map(),
      collisions: new Map(),
    };

    const json = JSON.parse(emitAutoloadJson(registry)) as {
      version: number;
      entries: { file: string; symbols: string[] }[];
    };

    assert.equal(json.version, 1);
    assert.equal(json.entries.length, 1);
    assert.equal(json.entries[0]?.file, 'app/utils/format.ts');
    assert.deepEqual(json.entries[0]?.symbols, ['formatDate']);
  });
});

describe('emitModelsRegistry', () => {
  it('emits an empty stub when there are no models', () => {
    const out = emitModelsRegistry([], '/proj');
    assert.match(out, /export \{\};/);
    assert.doesNotMatch(out, /defineModel/);
  });

  it('imports the model and emits a defineModel call with columns', () => {
    const out = emitModelsRegistry(
      [
        model({
          fields: [
            {
              field: 'column',
              name: 'title',
              kind: 'varchar',
              length: 200,
              decorators: [],
              start: 0,
              end: 0,
            },
            {
              field: 'column',
              name: 'views',
              kind: 'integer',
              decorators: [],
              start: 0,
              end: 0,
            },
          ],
        }),
      ],
      '/proj',
    );

    assert.match(out, /import \{ Post \} from '\.\.\/models\/post\.js';/);
    assert.match(out, /import \{ defineModel \} from 'jsails\/models';/);
    assert.match(out, /defineModel\(Post, \{/);
    assert.match(out, /table: 'post'/);
    assert.match(out, /\{ name: 'title', type: 'varchar', length: 200 \}/);
    assert.match(out, /\{ name: 'views', type: 'integer' \}/);
  });

  it('imports relation targets and emits a many-to-one relation', () => {
    const out = emitModelsRegistry(
      [
        model({
          fields: [
            {
              field: 'relation',
              name: 'author',
              kind: 'many-to-one',
              target: 'Author',
              foreignKey: 'author_id',
              decorators: [],
              start: 0,
              end: 0,
            },
          ],
        }),
      ],
      '/proj',
    );

    assert.match(out, /import \{ Author \} from '\.\.\/models\/author\.js';/);
    assert.match(
      out,
      /\{ kind: 'many-to-one', name: 'author', target: Author, joinColumn: 'author_id' \}/,
    );
  });

  it('emits folded column flags and relation options', () => {
    const out = emitModelsRegistry(
      [
        model({
          fields: [
            {
              field: 'column',
              name: 'slug',
              kind: 'varchar',
              length: 120,
              unique: true,
              decorators: [],
              start: 0,
              end: 0,
            },
            {
              field: 'column',
              name: 'subtitle',
              kind: 'varchar',
              length: 255,
              nullable: true,
              decorators: [],
              start: 0,
              end: 0,
            },
            {
              field: 'relation',
              name: 'author',
              kind: 'many-to-one',
              target: 'Author',
              foreignKey: 'author_id',
              touch: true,
              decorators: [],
              start: 0,
              end: 0,
            },
            {
              field: 'relation',
              name: 'comments',
              kind: 'one-to-many',
              target: 'Comment',
              foreignKey: 'comments_id',
              counterCache: true,
              inverse: 'post',
              decorators: [],
              start: 0,
              end: 0,
            },
          ],
        }),
      ],
      '/proj',
    );

    assert.match(out, /\{ name: 'slug', type: 'varchar', length: 120, unique: true \}/);
    assert.match(out, /\{ name: 'subtitle', type: 'varchar', length: 255, nullable: true \}/);
    assert.match(
      out,
      /\{ kind: 'many-to-one', name: 'author', target: Author, joinColumn: 'author_id', touch: true \}/,
    );
    assert.match(
      out,
      /\{ kind: 'one-to-many', name: 'comments', target: Comment, counterCache: true, inverse: 'post' \}/,
    );
  });

  it('emits renamedFrom markers for columns and many-to-one relations', () => {
    const out = emitModelsRegistry(
      [
        model({
          fields: [
            {
              field: 'column',
              name: 'title',
              kind: 'varchar',
              length: 255,
              renamedFrom: 'headline',
              decorators: [],
              start: 0,
              end: 0,
            },
            {
              field: 'relation',
              name: 'author',
              kind: 'many-to-one',
              target: 'Author',
              foreignKey: 'author_id',
              renamedFrom: 'writer_id',
              decorators: [],
              start: 0,
              end: 0,
            },
          ],
        }),
      ],
      '/proj',
    );

    assert.match(out, /\{ name: 'title', type: 'varchar', length: 255, renamedFrom: 'headline' \}/);
    assert.match(
      out,
      /\{ kind: 'many-to-one', name: 'author', target: Author, joinColumn: 'author_id', renamedFrom: 'writer_id' \}/,
    );
  });

  it('emits the encrypted set when present', () => {
    const out = emitModelsRegistry(
      [
        model({
          fields: [
            {
              field: 'column',
              name: 'ssn',
              kind: 'varchar',
              length: 255,
              decorators: [],
              start: 0,
              end: 0,
            },
          ],
          encrypted: ['ssn'],
        }),
      ],
      '/proj',
    );

    assert.match(out, /encrypted: \['ssn'\]/);
  });
});

describe('emitComponentsRegistry', () => {
  it('emits an empty stub when there are no components', () => {
    const out = emitComponentsRegistry([], '/proj');
    assert.match(out, /export \{\};/);
    assert.doesNotMatch(out, /registerComponent/);
  });

  it('imports each component and registers it', () => {
    const components: ComponentModule[] = [
      {
        exportName: 'taskList',
        file: '/proj/components/task-list.tsx',
        relative: 'components/task-list.tsx',
      },
    ];

    const out = emitComponentsRegistry(components, '/proj');

    assert.match(out, /import \{ registerComponent \} from 'jsails\/server-components';/);
    assert.match(out, /import \{ taskList \} from '\.\.\/components\/task-list\.js';/);
    assert.match(out, /registerComponent\(taskList\);/);
  });
});

describe('buildMetaArtifacts', () => {
  it('produces all eight artifacts', () => {
    const meta: ProjectMeta = { autoload: emptyRegistry, models: [], components: [] };
    const artifacts = buildMetaArtifacts(meta, '/proj');

    assert.deepEqual(Object.keys(artifacts).sort(), [
      'autoload.json',
      'components.registry.ts',
      'framework-symbols.d.ts',
      'framework-symbols.js',
      'models.registry.ts',
      'plugin-declarations.js',
      'project-symbols.app.d.ts',
      'project-symbols.server.d.ts',
    ]);
  });

  it('threads the curated framework declaration into framework-symbols.d.ts', () => {
    // The ambient d.ts is shared by the server and client tsconfigs, so it must
    // declare the curated framework surface — a server-only name is still
    // type-checkable in a client file (it simply is not projected there). This
    // closes the gap between the pure emitter test and what a real build writes:
    // if the table were accidentally narrowed to the browser-safe set, server
    // authoring (`ApplicationRecord`, decorators) would silently stop compiling.
    const catalog = deriveFrameworkSymbols({
      rootDir: repoRoot,
      declaration: frameworkGlobals,
    });
    const meta: ProjectMeta = { autoload: emptyRegistry, models: [], components: [] };
    const artifacts = buildMetaArtifacts(meta, '/proj');
    const dts = artifacts['framework-symbols.d.ts'];

    const distinctNames = new Set(catalog.map((entry) => entry.name));
    assert.ok(distinctNames.size > 0);
    for (const name of distinctNames) {
      assert.match(dts, new RegExp(`declare const ${name}: `), `missing declaration for ${name}`);
    }

    // A server-only name must be present, proving the emit is not browser-scoped.
    const serverOnly = catalog.find((entry) => entry.target === 'server');
    assert.ok(serverOnly, 'catalog must contain at least one server-only export');
    assert.match(dts, new RegExp(`declare const ${serverOnly.name}: `));
  });

  it('emits the runtime table into framework-symbols.js', () => {
    const catalog = deriveFrameworkSymbols({
      rootDir: repoRoot,
      declaration: frameworkGlobals,
    });
    const meta: ProjectMeta = { autoload: emptyRegistry, models: [], components: [] };
    const artifacts = buildMetaArtifacts(meta, '/proj');
    const runtime = artifacts['framework-symbols.js'];

    // The runtime half is a frozen data literal the installer imports; it must
    // carry the same table the ambient declarations derive from.
    assert.match(runtime, /export const FRAMEWORK_SYMBOLS = Object\.freeze\(\[/);
    assert.match(runtime, /AUTO-GENERATED by jsails build:meta/);
    for (const { name, specifier } of catalog) {
      assert.match(
        runtime,
        new RegExp(`\\{ name: '${name}', specifier: '${specifier.replace(/[/]/g, '\\/')}'`),
        `missing runtime entry for ${specifier}:${name}`,
      );
    }
  });

  it('reads .d.ts barrels for an installed framework with no src/', () => {
    // An installed framework ships only `dist/` (compiled `.js` + `.d.ts`); it
    // has no `src/`. The auto-detection must fall back to the `declaration` mode
    // and read `dist/**/index.d.ts` — never probe a missing `src/**/index.ts`,
    // which would raise ENOENT.
    const frameworkRoot = join(fixturesRoot, 'fake-framework');
    mkdirSync(join(frameworkRoot, 'dist/src/demo'), { recursive: true });
    writeFileSync(
      join(frameworkRoot, 'package.json'),
      `${JSON.stringify({ name: 'fake', type: 'module', exports: { './demo': './dist/src/demo/index.js' } })}\n`,
    );
    writeFileSync(
      join(frameworkRoot, 'dist/src/demo/index.d.ts'),
      "export { demoValue } from './demo.js';\nexport { DemoModel } from './demo.js';\n",
    );

    const meta: ProjectMeta = { autoload: emptyRegistry, models: [], components: [] };
    const artifacts = buildMetaArtifacts(meta, '/proj', {
      frameworkRootDir: frameworkRoot,
      declaration: { mode: 'all' },
    });

    // The runtime table projects `demoValue` and `DemoModel` from `jsails/demo`.
    const runtime = artifacts['framework-symbols.js'];
    assert.match(runtime, /name: 'demoValue', specifier: 'jsails\/demo'/);
    assert.match(runtime, /name: 'DemoModel', specifier: 'jsails\/demo'/);
    const dts = artifacts['framework-symbols.d.ts'];
    assert.match(dts, /declare const demoValue: typeof import\('jsails\/demo'\)\.demoValue;/);
  });

  it('reads source barrels in-repo (src/ present)', () => {
    // The in-repo framework has `src/`, so the scan uses `source` mode and reads
    // `src/**/index.ts`. Assert the real repo root emits a non-trivial table.
    const meta: ProjectMeta = { autoload: emptyRegistry, models: [], components: [] };
    const artifacts = buildMetaArtifacts(meta, '/proj', { frameworkRootDir: repoRoot });
    assert.match(artifacts['framework-symbols.js'], /defineModel|ApplicationRecord/);
  });

  it('folds a plugin autoload declaration into the emitted subpaths', () => {
    // A plugin that `autoload`s `jsails/admin` re-includes that (otherwise
    // framework-curated-excluded) subpath, so its names project and type-check.
    const meta: ProjectMeta = { autoload: emptyRegistry, models: [], components: [] };
    const artifacts = buildMetaArtifacts(meta, '/proj', {
      frameworkRootDir: repoRoot,
      pluginDeclarations: [
        {
          id: 'jsails-admin',
          provides: ['jsails/admin'],
          autoload: { mode: 'selected', specifiers: ['jsails/admin'] },
        },
      ],
    });
    const runtime = artifacts['framework-symbols.js'];
    // `defineAdminPanel` is a real named export of jsails/admin.
    assert.match(runtime, /name: 'defineAdminPanel', specifier: 'jsails\/admin'/);
    assert.match(
      artifacts['framework-symbols.d.ts'],
      /import\('jsails\/admin'\)\.defineAdminPanel;/,
    );
  });

  it('contributes nothing for a plugin with autoload none', () => {
    const meta: ProjectMeta = { autoload: emptyRegistry, models: [], components: [] };
    const withNone = buildMetaArtifacts(meta, '/proj', {
      frameworkRootDir: repoRoot,
      pluginDeclarations: [
        { id: 'jsails-admin', provides: ['jsails/admin'], autoload: { mode: 'none' } },
      ],
    });
    const base = buildMetaArtifacts(meta, '/proj', { frameworkRootDir: repoRoot });
    // No additional subpath: the emitted runtime table matches the curated-only set.
    assert.equal(withNone['framework-symbols.js'], base['framework-symbols.js']);
  });
});

describe('writeMetaArtifacts', () => {
  it('writes every artifact under .jsails/', () => {
    const rootDir = join(fixturesRoot, 'write');
    const meta: ProjectMeta = { autoload: emptyRegistry, models: [], components: [] };

    writeMetaArtifacts(meta, rootDir);

    const models = readFileSync(join(rootDir, '.jsails', 'models.registry.ts'), 'utf8');
    assert.match(models, /AUTO-GENERATED/);
    const autoload = readFileSync(join(rootDir, '.jsails', 'autoload.json'), 'utf8');
    assert.match(autoload, /"version": 1/);
  });
});
