import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  Files,
  FilesError,
  copy,
  ensureDir,
  exists,
  glob,
  move,
  readJson,
  remove,
  rimraf,
  toBase64,
  writeJson,
} from '../../src/support/files.server.js';

let root: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'jsails-files-'));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('Files', () => {
  it('round-trips JSON', async () => {
    const path = join(root, 'data.json');
    await writeJson(path, { a: 1, b: ['x'] });
    assert.deepEqual(await readJson(path), { a: 1, b: ['x'] });
  });

  it('creates parent directories for writeJson', async () => {
    const path = join(root, 'nested', 'deep', 'data.json');
    await writeJson(path, { ok: true });
    assert.equal(await exists(path), true);
  });

  it('ensureDir creates a directory tree', async () => {
    const dir = join(root, 'made', 'by', 'ensure');
    await ensureDir(dir);
    assert.equal(await exists(dir), true);
  });

  it('exists reports false for a missing path', async () => {
    assert.equal(await exists(join(root, 'nope.txt')), false);
  });

  it('readJson throws not_found for a missing file', async () => {
    await assert.rejects(
      () => readJson(join(root, 'missing.json')),
      (error: unknown) => {
        assert.ok(error instanceof FilesError);
        assert.equal(error.code, 'not_found');
        // Value-free: the path is not echoed.
        assert.equal(error.message.includes('missing.json'), false);
        return true;
      },
    );
  });

  it('readJson throws invalid_argument for malformed JSON', async () => {
    const path = join(root, 'bad.json');
    await writeFile(path, '{ not json ');
    await assert.rejects(
      () => readJson(path),
      (error: unknown) => {
        assert.ok(error instanceof FilesError);
        assert.equal(error.code, 'invalid_argument');
        return true;
      },
    );
  });

  it('copy duplicates a file', async () => {
    const src = join(root, 'src.txt');
    const dest = join(root, 'dest.txt');
    await writeFile(src, 'hello');
    await copy(src, dest);
    assert.equal(await exists(dest), true);
  });

  it('move relocates a file', async () => {
    const src = join(root, 'move-src.txt');
    const dest = join(root, 'move-dest.txt');
    await writeFile(src, 'x');
    await move(src, dest);
    assert.equal(await exists(src), false);
    assert.equal(await exists(dest), true);
  });

  it('remove deletes a file and tolerates a missing target', async () => {
    const path = join(root, 'to-remove.txt');
    await writeFile(path, 'x');
    await remove(path);
    assert.equal(await exists(path), false);
    await remove(path); // no error
  });

  it('glob matches files by pattern', async () => {
    const dir = join(root, 'globdir');
    await ensureDir(dir);
    await writeFile(join(dir, 'a.js'), '');
    await writeFile(join(dir, 'b.js'), '');
    await writeFile(join(dir, 'c.txt'), '');
    const matches = await glob('*.js', { cwd: dir });
    assert.equal(matches.length, 2);
  });

  it('glob accepts an array of patterns', async () => {
    const dir = join(root, 'globarr');
    await ensureDir(dir);
    await writeFile(join(dir, 'a.js'), '');
    await writeFile(join(dir, 'b.txt'), '');
    const matches = await glob(['*.js', '*.txt'], { cwd: dir });
    assert.equal(matches.length, 2);
  });

  it('rimraf removes a directory tree', async () => {
    const dir = join(root, 'rimraf-me');
    await ensureDir(join(dir, 'inner'));
    await writeFile(join(dir, 'inner', 'f.txt'), 'x');
    await rimraf(dir);
    assert.equal(await exists(dir), false);
  });

  it('toBase64 encodes file bytes', async () => {
    const path = join(root, 'b64.txt');
    await writeFile(path, 'hello');
    assert.equal(await toBase64(path), Buffer.from('hello').toString('base64'));
  });

  it('exposes a frozen namespace with the same functions', () => {
    assert.equal(Files.readJson, readJson);
    assert.equal(Files.glob, glob);
    assert.ok(Object.isFrozen(Files));
  });
});
