import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { walkLexicalFiles } from '../../src/compiler/lexical-walk.js';

const fixturesRoot = mkdtempSync(
  join(fileURLToPath(new URL('..', import.meta.url)), 'lexical-walk-fixture-'),
);

after(() => {
  rmSync(fixturesRoot, { recursive: true, force: true });
});

function makeDir(name: string): string {
  const dir = join(fixturesRoot, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeFile(dir: string, name: string, content: string): void {
  const filePath = join(dir, name);
  mkdirSync(join(filePath, '..'), { recursive: true });
  writeFileSync(filePath, content);
}

describe('walkLexicalFiles', () => {
  it('returns files in lexical depth-first order', () => {
    const dir = makeDir('lexical');

    // In code-unit sort, `a.js` comes before `sub/`; the walk adds files and
    // recurses into directories in sorted order.
    writeFile(join(dir, 'sub'), 'b.js', '');
    writeFile(dir, 'a.js', '');

    const files = walkLexicalFiles(dir, { extensions: new Set(['.js']) });

    // In code-unit sort, `a.js` comes before `sub/`; the walk adds files and
    // recurses into directories in sorted order.
    assert.deepEqual(files, ['a.js', 'sub/b.js']);
  });

  it('recurses into nested directories in sorted order', () => {
    const dir = makeDir('recursive');
    mkdirSync(join(dir, 'zzz'));
    mkdirSync(join(dir, 'aaa'));
    writeFile(join(dir, 'zzz'), 'deep.js', '');
    writeFile(join(dir, 'aaa'), 'shallow.js', '');
    writeFile(dir, 'first.js', '');

    const files = walkLexicalFiles(dir, { extensions: new Set(['.js']) });

    // Depth-first in sorted order: `aaa` sorts before `first.js`, then `zzz`.
    assert.deepEqual(files, ['aaa/shallow.js', 'first.js', 'zzz/deep.js']);
  });

  it('skips symlinks', () => {
    const dir = makeDir('symlink');
    writeFile(dir, 'real.js', '');
    symlinkSync(join(dir, 'real.js'), join(dir, 'linked.js'));

    const files = walkLexicalFiles(dir, { extensions: new Set(['.js']) });

    assert.deepEqual(files, ['real.js']);
  });

  it('skips non-matching extensions', () => {
    const dir = makeDir('extensions');
    writeFile(dir, 'keep.mjs', '');
    writeFile(dir, 'skip.ts', '');
    writeFile(dir, 'also-skip.txt', '');

    const files = walkLexicalFiles(dir, { extensions: new Set(['.mjs']) });

    assert.deepEqual(files, ['keep.mjs']);
  });

  it('returns empty array for a missing root directory', () => {
    const dir = makeDir('missing');
    const nonexistent = join(dir, 'nonexistent');

    const files = walkLexicalFiles(nonexistent, { extensions: new Set(['.js']) });

    assert.deepEqual(files, []);
  });

  it('rethrows non-ENOENT errors', () => {
    // Create a regular file and try to walk it as if it were a directory.
    const dir = makeDir('enotdir');
    writeFile(dir, 'not-a-dir', '');

    assert.throws(
      () => walkLexicalFiles(join(dir, 'not-a-dir'), { extensions: new Set(['.js']) }),
      /ENOTDIR/,
    );
  });

  it('returns posix-separated relative paths on all platforms', () => {
    const dir = makeDir('posix');
    mkdirSync(join(dir, 'nested'));
    writeFile(join(dir, 'nested'), 'deep.js', '');

    const files = walkLexicalFiles(dir, { extensions: new Set(['.js']) });

    assert.equal(files[0], 'nested/deep.js');
    assert.ok(!files[0].includes('\\'), 'path must use posix separators');
  });

  it('includes .js and .mjs when both are requested', () => {
    const dir = makeDir('both');
    writeFile(dir, 'one.js', '');
    writeFile(dir, 'two.mjs', '');

    const files = walkLexicalFiles(dir, { extensions: new Set(['.js', '.mjs']) });

    assert.deepEqual(files, ['one.js', 'two.mjs']);
  });
});
