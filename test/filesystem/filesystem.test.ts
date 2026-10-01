/**
 * Tests for the `filesystem` surface: the local disk's key/symlink safety,
 * atomic writes, list/size/delete, lazy root creation, and `maxBytes`
 * enforcement; the in-memory disk's parity with the local disk; the plugin's
 * token/name contract and cleanup; and the value-free error guarantee. No
 * external services are required — everything runs against temp directories
 * and in-memory state.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';

import { runExtensions } from '../../src/extensions/index.js';
import {
  DiskError,
  createLocalDisk,
  createMemoryDisk,
  filesystemPlugin,
  filesystemToken,
  type Disk,
  type DiskErrorCode,
  type FileSystem,
} from '../../src/filesystem/index.js';

/** Create a fresh temp directory and register its cleanup on the test. */
function tempRoot(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'jsails-disk-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Assert that a rejection is a `DiskError` with the given code. */
function isDiskError(code: DiskErrorCode): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.ok(error instanceof DiskError, `expected DiskError, got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  };
}

/** Decode stored bytes as UTF-8 for readable assertions. */
function text(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('utf8');
}

describe('createLocalDisk', () => {
  it('round-trips strings and raw bytes', async (t) => {
    const disk = createLocalDisk({ root: tempRoot(t) });

    await disk.put('greeting.txt', 'hello');
    await disk.put('raw.bin', new Uint8Array([1, 2, 3, 255]));

    assert.equal(text(await disk.get('greeting.txt')), 'hello');
    assert.deepEqual(Array.from(await disk.get('raw.bin')), [1, 2, 3, 255]);
  });

  it('does not require the root to exist until the first write', async (t) => {
    const base = tempRoot(t);
    const root = join(base, 'nested', 'root');
    const disk = createLocalDisk({ root });

    assert.equal(existsSync(root), false, 'construction must not create the root');
    await disk.put('a/b.txt', 'x'); // mkdir -p root and parent
    assert.equal(existsSync(join(root, 'a', 'b.txt')), true);
    assert.equal(text(await disk.get('a/b.txt')), 'x');
  });

  it('creates the root eagerly with createRoot: true', (t) => {
    const root = join(tempRoot(t), 'eager');
    createLocalDisk({ root, createRoot: true });
    assert.equal(existsSync(root), true);
  });

  it('writes atomically: no temp files remain and overwrite is complete', async (t) => {
    const root = tempRoot(t);
    const disk = createLocalDisk({ root });

    await disk.put('a.txt', 'first');
    await disk.put('a.txt', 'second-longer-value');

    assert.equal(text(await disk.get('a.txt')), 'second-longer-value');
    assert.deepEqual(
      readdirSync(root).filter((name) => name.endsWith('.tmp')),
      [],
      'no temp files may remain after a successful write',
    );
  });

  it('leaves prior content intact when a write fails', async (t) => {
    const root = tempRoot(t);
    const disk = createLocalDisk({ root, maxBytes: 4 });

    await disk.put('a.txt', 'ok');
    await assert.rejects(disk.put('a.txt', 'too big'), isDiskError('max_bytes'));

    assert.equal(text(await disk.get('a.txt')), 'ok', 'failed write must not clobber the file');
    assert.deepEqual(await disk.list(), ['a.txt']);
    assert.deepEqual(
      readdirSync(root).filter((name) => name.endsWith('.tmp')),
      [],
    );
  });

  it('lists, sizes, deletes idempotently, and reports existence', async (t) => {
    const disk = createLocalDisk({ root: tempRoot(t) });

    await disk.put('b.txt', 'bb');
    await disk.put('a/b.txt', 'inner');
    await disk.put('a/c.txt', 'cc');

    assert.deepEqual(await disk.list(), ['a/b.txt', 'a/c.txt', 'b.txt']);
    assert.deepEqual(await disk.list('a'), ['a/b.txt', 'a/c.txt']);
    assert.deepEqual(await disk.list('missing'), []);
    assert.deepEqual(await disk.list('b.txt'), [], 'a file prefix has no children');

    assert.equal(await disk.size('b.txt'), 2);
    assert.equal(await disk.exists('b.txt'), true);
    assert.equal(await disk.exists('nope.txt'), false);

    await disk.delete('b.txt');
    await disk.delete('b.txt'); // idempotent
    assert.equal(await disk.exists('b.txt'), false);
    assert.deepEqual(await disk.list(), ['a/b.txt', 'a/c.txt']);
  });

  it('rejects path traversal and malformed keys value-free', async (t) => {
    const disk = createLocalDisk({ root: tempRoot(t) });
    const bad = ['', '../x', 'a/../../x', '/abs', 'a\\b', 'C:x', 'a\0b', 'a/./b', 'a//b'];

    for (const key of bad) {
      await assert.rejects(
        disk.put(key, 'x'),
        isDiskError('invalid_key'),
        `key ${JSON.stringify(key)}`,
      );
      await assert.rejects(disk.get(key), isDiskError('invalid_key'), `key ${JSON.stringify(key)}`);
    }
    assert.deepEqual(await disk.list(), [], 'no file may be written by a rejected key');
  });

  it('rejects reads and writes through a symlinked directory escaping the root', async (t) => {
    const root = tempRoot(t);
    const outside = mkdtempSync(join(tmpdir(), 'jsails-outside-'));
    t.after(() => rmSync(outside, { recursive: true, force: true }));
    writeFileSync(join(outside, 'secret.txt'), 'SECRET');
    symlinkSync(outside, join(root, 'link'));

    const disk = createLocalDisk({ root });

    await assert.rejects(disk.get('link/secret.txt'), isDiskError('invalid_key'));
    await assert.rejects(disk.put('link/new.txt', 'x'), isDiskError('invalid_key'));
    await assert.rejects(disk.exists('link/secret.txt'), isDiskError('invalid_key'));
    assert.deepEqual(await disk.list(), [], 'list must never follow a symlink');
    assert.equal(existsSync(join(outside, 'new.txt')), false, 'no write may escape the root');
  });

  it('rejects reading or sizing a file that is a symlink outside the root', async (t) => {
    const root = tempRoot(t);
    const outside = mkdtempSync(join(tmpdir(), 'jsails-outside-'));
    t.after(() => rmSync(outside, { recursive: true, force: true }));
    writeFileSync(join(outside, 'leak.txt'), 'SECRET');
    symlinkSync(join(outside, 'leak.txt'), join(root, 'leak.txt'));

    const disk = createLocalDisk({ root });

    await assert.rejects(disk.get('leak.txt'), isDiskError('invalid_key'));
    await assert.rejects(disk.size('leak.txt'), isDiskError('invalid_key'));
    await assert.rejects(disk.exists('leak.txt'), isDiskError('invalid_key'));
  });

  it('enforces maxBytes across the whole root', async (t) => {
    const disk = createLocalDisk({ root: tempRoot(t), maxBytes: 5 });

    await disk.put('a.txt', 'ab'); // 2 bytes
    await disk.put('b.txt', 'abc'); // 3 bytes, total 5
    await assert.rejects(disk.put('c.txt', 'd'), isDiskError('max_bytes'));

    await disk.delete('a.txt'); // frees 2 bytes
    await disk.put('c.txt', 'de'); // now fits
    assert.equal(text(await disk.get('c.txt')), 'de');
  });
});

describe('createMemoryDisk', () => {
  it('matches the local disk: put/get/list/size/delete/exists', async () => {
    const disk = createMemoryDisk();

    await disk.put('b.txt', 'bb');
    await disk.put('a/b.txt', new Uint8Array([1, 2]));

    assert.equal(text(await disk.get('b.txt')), 'bb');
    assert.deepEqual(Array.from(await disk.get('a/b.txt')), [1, 2]);
    assert.deepEqual(await disk.list(), ['a/b.txt', 'b.txt']);
    assert.deepEqual(await disk.list('a'), ['a/b.txt']);
    assert.equal(await disk.size('b.txt'), 2);
    assert.equal(await disk.exists('b.txt'), true);

    await disk.delete('b.txt');
    await disk.delete('b.txt');
    assert.equal(await disk.exists('b.txt'), false);
    await assert.rejects(disk.get('b.txt'), isDiskError('not_found'));
    await assert.rejects(disk.size('b.txt'), isDiskError('not_found'));
  });

  it('rejects the same malformed keys as the local disk', async () => {
    const disk = createMemoryDisk();
    for (const key of ['../x', '/abs', 'a\\b', '', 'a/../b']) {
      await assert.rejects(disk.put(key, 'x'), isDiskError('invalid_key'));
    }
  });

  it('copies input bytes so later mutation cannot corrupt storage', async () => {
    const disk = createMemoryDisk();
    const bytes = new Uint8Array([9, 9, 9]);
    await disk.put('k', bytes);
    bytes[0] = 0;
    assert.deepEqual(Array.from(await disk.get('k')), [9, 9, 9]);
  });

  it('enforces maxBytes', async () => {
    const disk = createMemoryDisk({ maxBytes: 3 });
    await disk.put('a', 'ab');
    await assert.rejects(disk.put('b', 'cd'), isDiskError('max_bytes'));
    await disk.delete('a');
    await disk.put('c', 'xyz');
    assert.equal(await disk.size('c'), 3);
  });
});

describe('filesystemPlugin', () => {
  it('has name "filesystem" and a stable token', () => {
    assert.equal(filesystemToken.name, 'filesystem');
    assert.equal(filesystemPlugin({ disks: { memory: createMemoryDisk() } }).name, 'filesystem');
  });

  it('provides a FileSystem under the token with named lookups', async () => {
    const local = createMemoryDisk();
    const memory = createMemoryDisk();
    const runtime = await runExtensions([
      filesystemPlugin({ disks: { local, memory }, default: 'local' }),
    ]);
    try {
      const fs: FileSystem = runtime.services.get(filesystemToken);
      assert.equal(fs.disk('local'), local);
      assert.equal(fs.disk('memory'), memory);
      assert.equal(fs.disk(), local, 'disk() resolves the configured default');
      assert.deepEqual(fs.names(), ['local', 'memory']);
    } finally {
      await runtime.close();
    }
  });

  it('resolves disk() to the sole disk when no default is configured', async () => {
    const memory = createMemoryDisk();
    const runtime = await runExtensions([filesystemPlugin({ disks: { memory } })]);
    try {
      const fs: FileSystem = runtime.services.get(filesystemToken);
      assert.equal(fs.disk(), memory);
    } finally {
      await runtime.close();
    }
  });

  it('throws on an unknown name and when the default is ambiguous', async () => {
    const runtime = await runExtensions([
      filesystemPlugin({ disks: { a: createMemoryDisk(), b: createMemoryDisk() } }),
    ]);
    try {
      const fs: FileSystem = runtime.services.get(filesystemToken);
      assert.throws(() => fs.disk('missing'), /no disk named/);
      assert.throws(() => fs.disk(), /requires a disk name or a configured default/);
    } finally {
      await runtime.close();
    }
  });

  it('validates names, disk shapes, and the default eagerly', () => {
    assert.throws(() => filesystemPlugin({ disks: {} }), TypeError);
    assert.throws(() => filesystemPlugin({ disks: { x: {} as unknown as Disk } }), TypeError);
    assert.throws(
      () => filesystemPlugin({ disks: { memory: createMemoryDisk() }, default: 'missing' }),
      TypeError,
    );
  });

  it('closes idempotently with no handles held', async () => {
    const runtime = await runExtensions([filesystemPlugin({ disks: { m: createMemoryDisk() } })]);
    await runtime.close();
    await runtime.close();
  });
});

describe('value-free errors', () => {
  it('never echoes a key, path, or data content', async (t) => {
    const disk = createLocalDisk({ root: tempRoot(t) });
    const secret = 'SUPER_SECRET_CONTENT';

    await assert.rejects(disk.get('missing.txt'), (error: unknown) => {
      assert.ok(error instanceof DiskError);
      assert.equal(error.message, 'file not found');
      return true;
    });
    await assert.rejects(disk.put(`../../etc/${secret}`, secret), (error: unknown) => {
      assert.ok(error instanceof DiskError);
      assert.ok(!error.message.includes(secret), 'error must not echo the key or content');
      return true;
    });
  });

  it('reports capacity failures without echoing the payload', async () => {
    const disk = createMemoryDisk({ maxBytes: 1 });
    await assert.rejects(disk.put('k', 'HUGE_PAYLOAD'), (error: unknown) => {
      assert.ok(error instanceof DiskError);
      assert.equal(error.message, 'disk capacity exceeded');
      return true;
    });
  });
});

// Guard against accidental use of the un-exported validators through the public
// entry (they are implementation details, not part of the `jsails/filesystem`
// surface). This documents the intentional narrow public API.
describe('public surface', () => {
  it('exposes a minimal, typed surface', () => {
    const disk: Disk = createMemoryDisk();
    assert.equal(typeof disk.put, 'function');
    assert.equal(typeof disk.get, 'function');
    assert.equal(typeof disk.exists, 'function');
    assert.equal(typeof disk.delete, 'function');
    assert.equal(typeof disk.list, 'function');
    assert.equal(typeof disk.size, 'function');
  });
});
