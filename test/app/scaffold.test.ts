/**
 * `writeProjectFiles` tests.
 *
 * Every fixture is a real file under a temp directory; nothing leaves the
 * workspace. Success cases run against the real filesystem, and the two
 * rollback cases inject a tiny `ScaffoldFs` seam so a mid-write failure and a
 * concurrently-created file can be simulated deterministically.
 */

import assert from 'node:assert/strict';
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';

import {
  ScaffoldError,
  writeProjectFiles,
  writeProjectFilesWithFs,
  type ScaffoldFs,
} from '../../src/app/scaffold.js';

const workspace = mkdtempSync(join(tmpdir(), 'jsails-scaffold-'));

after(() => {
  rmSync(workspace, { recursive: true, force: true });
});

/** Create an isolated root for one test case. */
function caseDir(): string {
  return mkdtempSync(join(workspace, 'case-'));
}

/** A `ScaffoldFs` adapter over the real Node filesystem, for seam tests. */
function realFs(): ScaffoldFs {
  return {
    lstat: lstatSync,
    readdir: readdirSync,
    mkdir: mkdirSync,
    rmdir: rmdirSync,
    open: (path) => openSync(path, 'wx'),
    write: (fd, data) => writeFileSync(fd, data, 'utf8'),
    close: closeSync,
    unlink: unlinkSync,
  };
}

/** Read a written file, failing the test when absent. */
function read(dir: string, relative: string): string {
  return readFileSync(join(dir, relative), 'utf8');
}

/** Sorted names directly inside a directory. */
function list(dir: string): string[] {
  return readdirSync(dir).sort();
}

describe('writeProjectFiles success', () => {
  it('creates an absent target with nested files, dotfiles, and AGENTS', async () => {
    const target = join(caseDir(), 'new', 'app');
    const files = {
      'package.json': '{}\n',
      'pages/index.tsx': 'export default () => null;\n',
      'client/main.tsx': 'export {};\n',
      '.gitignore': 'node_modules/\n',
      'AGENTS.md': '# Guide\n',
    };

    const result = await writeProjectFiles(target, files);

    assert.equal(result.targetDir, resolve(target));
    assert.deepEqual(result.files, Object.keys(files).sort());
    assert.equal(read(target, 'package.json'), '{}\n');
    assert.equal(read(target, 'pages/index.tsx'), 'export default () => null;\n');
    assert.equal(read(target, 'client/main.tsx'), 'export {};\n');
    assert.equal(read(target, '.gitignore'), 'node_modules/\n');
    assert.equal(read(target, 'AGENTS.md'), '# Guide\n');
  });

  it('writes into an existing empty target', async () => {
    const target = join(caseDir(), 'app');
    mkdirSync(target);

    await writeProjectFiles(target, { 'a.txt': 'a', 'nested/b.txt': 'b' });

    assert.equal(read(target, 'a.txt'), 'a');
    assert.equal(read(target, 'nested/b.txt'), 'b');
  });
});

describe('writeProjectFiles rejection', () => {
  it('refuses a non-empty target without modifying it', async () => {
    const target = join(caseDir(), 'app');
    mkdirSync(target);
    writeFileSync(join(target, 'existing.txt'), 'keep');

    await assert.rejects(writeProjectFiles(target, { 'x.txt': 'x' }), /not empty/);

    assert.deepEqual(list(target), ['existing.txt']);
    assert.equal(read(target, 'existing.txt'), 'keep');
  });

  it('refuses a symlink target', async () => {
    const base = caseDir();
    const real = join(base, 'real');
    mkdirSync(real);
    const link = join(base, 'link');
    symlinkSync(real, link);

    await assert.rejects(writeProjectFiles(link, { 'x.txt': 'x' }), /symbolic link/);
  });

  it('refuses a target that is a regular file', async () => {
    const base = caseDir();
    const file = join(base, 'target');
    writeFileSync(file, 'data');

    await assert.rejects(writeProjectFiles(file, { 'x.txt': 'x' }), /not a directory/);
  });

  it('rejects malicious keys before any I/O and never creates the target', async () => {
    const badKeys = [
      '/abs/path',
      '../up',
      'a/../../b',
      'a/../b',
      'a\\b',
      'a\u0000b',
      '',
      '.',
      '..',
      'a//b',
      'C:/win',
      '__proto__',
      'a/__proto__/b',
      'a<b',
    ];

    for (const key of badKeys) {
      const target = join(caseDir(), 'target');
      await assert.rejects(
        writeProjectFiles(target, { [key]: 'x' }),
        ScaffoldError,
        `key ${JSON.stringify(key)} must be rejected`,
      );
      assert.equal(
        existsSync(target),
        false,
        `target must not be created for key ${JSON.stringify(key)}`,
      );
    }
  });

  it('rejects a path used as both a file and a directory', async () => {
    const target = join(caseDir(), 'target');
    await assert.rejects(writeProjectFiles(target, { a: 'x', 'a/b': 'y' }), /file and a directory/);
    await assert.rejects(writeProjectFiles(target, { 'a/b': 'y', a: 'x' }), /file and a directory/);
    assert.equal(existsSync(target), false);
  });

  it('rejects non-string contents and non-object maps', async () => {
    const target = join(caseDir(), 'target');
    await assert.rejects(
      writeProjectFiles(target, { a: 42 as unknown as string }),
      /string contents/,
    );
    await assert.rejects(writeProjectFiles(target, null as never), ScaffoldError);
    await assert.rejects(writeProjectFiles(target, [] as never), ScaffoldError);
    await assert.rejects(writeProjectFiles('', { a: 'x' }), /targetDir/);
  });

  it('never overwrites: a second write into the same target is refused', async () => {
    const target = join(caseDir(), 'app');
    await writeProjectFiles(target, { 'a.txt': 'v1' });

    await assert.rejects(writeProjectFiles(target, { 'a.txt': 'v2' }), /not empty/);

    assert.equal(read(target, 'a.txt'), 'v1');
    assert.deepEqual(list(target), ['a.txt']);
  });
});

describe('writeProjectFiles rollback via injected fs', () => {
  it('rolls back only its own files, preserving a concurrently-created file', async () => {
    const target = join(caseDir(), 'app');
    mkdirSync(target);
    const fs = realFs();
    let writes = 0;
    fs.write = (fd, data) => {
      writes += 1;
      if (writes === 2) {
        // A concurrent writer drops an unrelated file just before we fail.
        writeFileSync(join(target, 'unrelated.txt'), 'keep me');
        throw new Error('boom');
      }
      writeFileSync(fd, data, 'utf8');
    };

    await assert.rejects(
      async () => writeProjectFilesWithFs(target, { 'a.txt': 'a', 'b.txt': 'b' }, fs),
      ScaffoldError,
    );

    assert.deepEqual(list(target), ['unrelated.txt']);
    assert.equal(read(target, 'unrelated.txt'), 'keep me');
  });

  it('rolls back a partially-written file when the write fails', async () => {
    const target = join(caseDir(), 'app');
    mkdirSync(target);
    const fs = realFs();
    fs.write = (fd, data) => {
      writeFileSync(fd, data.slice(0, 2), 'utf8');
      const error = new Error('ENOSPC') as NodeJS.ErrnoException;
      error.code = 'ENOSPC';
      throw error;
    };

    await assert.rejects(
      async () => writeProjectFilesWithFs(target, { 'a.txt': 'aaaa' }, fs),
      ScaffoldError,
    );

    assert.deepEqual(list(target), []);
  });

  it('preserves a concurrently-created foreign file when the open reports EEXIST', async () => {
    const target = join(caseDir(), 'app');
    mkdirSync(target);
    const fs = realFs();
    const realOpen = fs.open;
    fs.open = (path) => {
      if (path.endsWith(join('app', 'b.txt'))) {
        // A concurrent writer claims `b.txt` just before our exclusive open.
        writeFileSync(path, 'keep me', { flag: 'wx' });
        const error = new Error('EEXIST') as NodeJS.ErrnoException;
        error.code = 'EEXIST';
        throw error;
      }
      return realOpen(path);
    };

    await assert.rejects(
      async () => writeProjectFilesWithFs(target, { 'a.txt': 'a', 'b.txt': 'b' }, fs),
      /refusing to overwrite/,
    );

    // `a.txt` was ours and rolled back; `b.txt` is the foreign file, preserved.
    assert.deepEqual(list(target), ['b.txt']);
    assert.equal(read(target, 'b.txt'), 'keep me');
  });

  it('rolls back the reserved target and parents when writing fails', async () => {
    const base = caseDir();
    const target = join(base, 'p1', 'p2', 'app');
    const fs = realFs();
    fs.write = () => {
      throw new Error('write failed');
    };

    await assert.rejects(
      async () => writeProjectFilesWithFs(target, { 'a.txt': 'a' }, fs),
      ScaffoldError,
    );

    assert.equal(existsSync(target), false);
    assert.equal(existsSync(join(base, 'p1')), false);
    assert.deepEqual(list(base), []);
  });

  it('never clobbers a target created concurrently during publish', async () => {
    const base = caseDir();
    const target = join(base, 'app');
    const fs = realFs();
    // Simulate another process claiming the target between the initial lstat
    // and the reservation: the reserve `mkdir` reports EEXIST.
    fs.mkdir = (path) => {
      if (path === target) {
        mkdirSync(target);
        writeFileSync(join(target, 'concurrent.txt'), 'mine');
        const error = new Error('EEXIST') as NodeJS.ErrnoException;
        error.code = 'EEXIST';
        throw error;
      }
      mkdirSync(path);
    };

    await assert.rejects(
      async () => writeProjectFilesWithFs(target, { 'a.txt': 'a' }, fs),
      /created concurrently/,
    );

    assert.deepEqual(list(target), ['concurrent.txt']);
    assert.equal(read(target, 'concurrent.txt'), 'mine');
  });
});
