import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { scanProjectMeta } from '../../src/build/meta-scan.js';

const fixturesRoot = mkdtempSync(
  join(fileURLToPath(new URL('..', import.meta.url)), 'meta-scan-fixture-'),
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

describe('scanProjectMeta', () => {
  it('returns an empty result for an empty project', async () => {
    const rootDir = makeDir('empty');
    const meta = await scanProjectMeta(rootDir);

    assert.deepEqual(meta.models, []);
    assert.deepEqual(meta.components, []);
    assert.equal(meta.autoload.entries.length, 0);
  });

  it('extracts models from models/ and sorts them by class name', async () => {
    const rootDir = makeDir('models');
    writeModule(
      rootDir,
      'models/post.ts',
      `import { ApplicationRecord } from 'jsails/models';
export class Post extends ApplicationRecord {
  declare title: string;
  declare views: number;
}`,
    );
    writeModule(
      rootDir,
      'models/author.ts',
      `import { ApplicationRecord } from 'jsails/models';
export class Author extends ApplicationRecord {
  declare name: string;
}`,
    );

    const meta = await scanProjectMeta(rootDir);

    assert.deepEqual(
      meta.models.map((m) => m.className),
      ['Author', 'Post'],
    );
    const post = meta.models.find((m) => m.className === 'Post');
    assert.equal(post?.tableName, 'post');
  });

  it('skips a models/ module that declares no ApplicationRecord subclass', async () => {
    const rootDir = makeDir('models-skip');
    writeModule(rootDir, 'models/helper.ts', 'export const helper = 1;');

    const meta = await scanProjectMeta(rootDir);
    assert.deepEqual(meta.models, []);
  });

  it('discovers component modules with camelCase export names', async () => {
    const rootDir = makeDir('components');
    writeModule(rootDir, 'components/task-list.tsx', 'export const taskList = () => null;');
    writeModule(rootDir, 'components/counter.tsx', 'export const counter = () => null;');

    const meta = await scanProjectMeta(rootDir);

    assert.deepEqual(
      meta.components.map((c) => c.exportName),
      ['counter', 'taskList'],
    );
    assert.deepEqual(
      meta.components.map((c) => c.relative),
      ['components/counter.tsx', 'components/task-list.tsx'],
    );
  });

  it('collects autoload symbols alongside models and components in one scan', async () => {
    const rootDir = makeDir('combined');
    writeModule(rootDir, 'app/utils/format.ts', 'export const formatDate = () => "";');
    writeModule(
      rootDir,
      'models/post.ts',
      `import { ApplicationRecord } from 'jsails/models';
export class Post extends ApplicationRecord {
  declare title: string;
}`,
    );
    writeModule(rootDir, 'components/counter.tsx', 'export const counter = () => null;');

    const meta = await scanProjectMeta(rootDir);

    assert.equal(meta.models.length, 1);
    assert.equal(meta.components.length, 1);
    assert.ok(meta.autoload.byName.has('formatDate'));
  });

  it('is deterministic across repeated scans', async () => {
    const rootDir = makeDir('deterministic');
    writeModule(rootDir, 'models/b.ts', 'export class B extends ApplicationRecord {}');
    writeModule(rootDir, 'models/a.ts', 'export class A extends ApplicationRecord {}');

    const first = await scanProjectMeta(rootDir);
    const second = await scanProjectMeta(rootDir);

    assert.deepEqual(
      first.models.map((m) => m.className),
      second.models.map((m) => m.className),
    );
  });
});
