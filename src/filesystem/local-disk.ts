/**
 * Local filesystem disk: a {@link Disk} backed by a directory on disk.
 *
 * `createLocalDisk({ root, maxBytes?, createRoot? })` stores files under `root`
 * addressed by relative POSIX keys. It is built for safety first:
 *
 * - **Key safety.** Every key is validated as a relative POSIX path, so a key
 *   can never lexically escape `root`.
 * - **Symlink safety.** `root` and each existing ancestor directory of a target
 *   are resolved through `realpath`; a symlink that would resolve outside the
 *   root (including a dangling one) fails closed with a value-free error.
 *   `list` never follows symlinks.
 * - **Atomic writes.** Data is written to a temp file in the same directory and
 *   `rename`d over the target, so a reader never observes a partial file and a
 *   failed write leaves the previous content intact.
 * - **Lazy root.** Creation never requires `root` to exist: it is created
 *   (`mkdir -p`, including parent directories of the key) on the first write,
 *   unless `createRoot: true` creates it eagerly.
 * - **No open handles.** Files are opened per operation and closed, so the disk
 *   needs no `close()` and cleanup is a no-op.
 *
 * All I/O failures surface as value-free {@link DiskError}s (never echoing a
 * path or the data); option mistakes surface as `TypeError` at construction.
 */

import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { errnoCode, isErrno } from '../internal/errors.js';
import {
  assertContentType,
  assertDiskKey,
  assertDiskPrefix,
  DiskError,
  toDiskBytes,
  validateMaxBytes,
  type Disk,
} from './disk.js';

/** Options for {@link createLocalDisk}. */
export interface LocalDiskOptions {
  /** The directory that owns the stored files. */
  readonly root: string;
  /** Optional cap on total stored bytes; exceeding it fails `put` before writing. */
  readonly maxBytes?: number;
  /** Create `root` eagerly at construction; default is lazy (on first write). */
  readonly createRoot?: boolean;
}

/** True for the errors that mean "nothing there" (`ENOENT`/`ENOTDIR`/`EISDIR`). */
function isNotFound(error: unknown): boolean {
  return isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR') || isErrno(error, 'EISDIR');
}

/** Reduce a filesystem error to a payload-free {@link DiskError}. */
function wrapIo(error: unknown): DiskError {
  const code = errnoCode(error);
  return new DiskError('io', code === undefined ? 'disk I/O failed' : `disk I/O failed (${code})`);
}

/** True when `candidate` is `root` or lives strictly inside it (segment-aware). */
function isInsideRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`));
}

/**
 * Create a local disk. Construction validates options and (when `createRoot`)
 * creates the root; it never reads or opens the files otherwise.
 */
export function createLocalDisk(options: LocalDiskOptions): Disk {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('createLocalDisk requires an options object');
  }
  if (typeof options.root !== 'string' || options.root.trim() === '') {
    throw new TypeError('root must be a non-empty string');
  }
  const maxBytes = validateMaxBytes(options.maxBytes);
  const rootPath = resolve(options.root);

  if (options.createRoot === true) {
    try {
      mkdirSync(rootPath, { recursive: true });
    } catch (error) {
      throw wrapIo(error);
    }
  }

  // The resolved real path of `root`, memoized once it exists (lazily created
  // on the first write). Every target is derived from this real path, so a
  // symlinked root resolves to its target before any containment check.
  let rootReal: string | undefined;
  // Best-effort total of stored bytes, tracked only when `maxBytes` is set.
  let totalBytes: number | undefined;

  /** Resolve the real root without creating it; `undefined` when it is absent. */
  async function resolveRootReal(): Promise<string | undefined> {
    if (rootReal !== undefined) {
      return rootReal;
    }
    try {
      rootReal = await realpath(rootPath);
      return rootReal;
    } catch (error) {
      if (isNotFound(error)) {
        return undefined;
      }
      throw wrapIo(error);
    }
  }

  /** Create the root (mkdir -p) and memoize its real path. */
  async function ensureRoot(): Promise<string> {
    if (rootReal !== undefined) {
      return rootReal;
    }
    try {
      await mkdir(rootPath, { recursive: true });
      rootReal = await realpath(rootPath);
      return rootReal;
    } catch (error) {
      throw wrapIo(error);
    }
  }

  /** Join a validated key onto the real root. */
  function targetFor(root: string, key: string): string {
    return join(root, key);
  }

  /** Resolve a symlink and verify it stays inside the root (fail closed). */
  async function assertSymlinkContained(root: string, linkPath: string): Promise<void> {
    let resolved: string;
    try {
      resolved = await realpath(linkPath);
    } catch {
      // A dangling symlink cannot resolve inside the root; refuse it.
      throw new DiskError('invalid_key', 'disk path traverses a dangling symlink');
    }
    if (!isInsideRoot(root, resolved)) {
      throw new DiskError('invalid_key', 'disk path escapes the root directory through a symlink');
    }
  }

  /**
   * Walk every existing ancestor directory of `target` and reject any symlink
   * that escapes the root. The final segment is handled by each operation, since
   * its semantics differ (rename replaces it, reads follow it, list skips it).
   */
  async function assertNoSymlinkEscape(root: string, target: string): Promise<void> {
    const rel = relative(root, target);
    if (rel === '' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      if (rel === '') {
        return;
      }
      throw new DiskError('invalid_key', 'disk path escapes the root directory');
    }
    const segments = rel.split(sep);
    let current = root;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const segment = segments[index];
      if (segment === undefined) {
        continue;
      }
      current = join(current, segment);
      let stats;
      try {
        stats = await lstat(current);
      } catch (error) {
        if (isNotFound(error)) {
          return; // ancestor missing: nothing deeper can be symlinked
        }
        throw wrapIo(error);
      }
      if (stats.isSymbolicLink()) {
        await assertSymlinkContained(root, current);
      } else if (!stats.isDirectory()) {
        return; // a file where a directory is expected: nothing below it exists
      }
    }
  }

  /** Resolve a readable target, verifying it stays inside the root. */
  async function resolveReadableTarget(root: string, target: string): Promise<string> {
    try {
      const resolved = await realpath(target);
      if (!isInsideRoot(root, resolved)) {
        throw new DiskError(
          'invalid_key',
          'disk path escapes the root directory through a symlink',
        );
      }
      return resolved;
    } catch (error) {
      if (error instanceof DiskError) {
        throw error;
      }
      if (isNotFound(error)) {
        throw new DiskError('not_found', 'file not found');
      }
      throw wrapIo(error);
    }
  }

  /** Read a resolved path as a regular file, or fail value-free. */
  async function readFileBytes(resolved: string): Promise<Uint8Array> {
    try {
      const stats = await lstat(resolved);
      if (!stats.isFile()) {
        throw new DiskError('not_found', 'file not found');
      }
      return new Uint8Array(await readFile(resolved));
    } catch (error) {
      if (error instanceof DiskError) {
        throw error;
      }
      throw wrapIo(error);
    }
  }

  /** Sum the byte size of every regular file under `dir`, never following symlinks. */
  async function computeTotal(dir: string): Promise<number> {
    let total = 0;
    const visit = async (current: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(current, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) {
          continue;
        }
        const full = join(current, entry.name);
        if (entry.isDirectory()) {
          await visit(full);
        } else if (entry.isFile()) {
          try {
            total += (await lstat(full)).size;
          } catch {
            // A file that vanished mid-scan contributes nothing.
          }
        }
      }
    };
    await visit(dir);
    return total;
  }

  /** The tracked total, lazily computed from disk when `maxBytes` is enforced. */
  async function getTotal(root: string): Promise<number> {
    if (maxBytes === undefined) {
      return Number.POSITIVE_INFINITY;
    }
    if (totalBytes === undefined) {
      totalBytes = await computeTotal(root);
    }
    return totalBytes;
  }

  /** Best-effort temp-file cleanup; the primary write error always wins. */
  async function unlinkQuietly(path: string): Promise<void> {
    try {
      await unlink(path);
    } catch {
      // Ignored: a leftover temp file is harmless; the failing operation's error
      // is what matters and must propagate unchanged.
    }
  }

  const put: Disk['put'] = async (key, data, options) => {
    assertDiskKey(key);
    assertContentType(options?.contentType);
    const bytes = toDiskBytes(data);
    const root = await ensureRoot();
    const target = targetFor(root, key);
    await assertNoSymlinkEscape(root, target);

    let existingSize = 0;
    try {
      const stats = await lstat(target);
      if (stats.isDirectory()) {
        throw new DiskError('io', 'disk entry is a directory');
      }
      if (stats.isSymbolicLink()) {
        // Rename would replace the link without writing through it, but a link
        // pointing outside the root is refused regardless.
        await assertSymlinkContained(root, target);
      } else {
        existingSize = stats.size;
      }
    } catch (error) {
      if (error instanceof DiskError) {
        throw error;
      }
      if (!isNotFound(error)) {
        throw wrapIo(error);
      }
    }

    const total = await getTotal(root);
    if (maxBytes !== undefined && total - existingSize + bytes.length > maxBytes) {
      throw new DiskError('max_bytes', 'disk capacity exceeded');
    }

    const parent = dirname(target);
    const temp = join(parent, `.${randomBytes(6).toString('hex')}.tmp`);
    try {
      await mkdir(parent, { recursive: true });
      await writeFile(temp, bytes);
      await rename(temp, target);
    } catch (error) {
      await unlinkQuietly(temp);
      throw wrapIo(error);
    }

    if (maxBytes !== undefined) {
      totalBytes = total - existingSize + bytes.length;
    }
  };

  const get: Disk['get'] = async (key) => {
    assertDiskKey(key);
    const root = await resolveRootReal();
    if (root === undefined) {
      throw new DiskError('not_found', 'file not found');
    }
    const target = targetFor(root, key);
    await assertNoSymlinkEscape(root, target);
    const resolved = await resolveReadableTarget(root, target);
    return readFileBytes(resolved);
  };

  const exists: Disk['exists'] = async (key) => {
    assertDiskKey(key);
    const root = await resolveRootReal();
    if (root === undefined) {
      return false;
    }
    const target = targetFor(root, key);
    await assertNoSymlinkEscape(root, target);
    try {
      const resolved = await realpath(target);
      if (!isInsideRoot(root, resolved)) {
        throw new DiskError(
          'invalid_key',
          'disk path escapes the root directory through a symlink',
        );
      }
      return true;
    } catch (error) {
      if (error instanceof DiskError) {
        throw error;
      }
      if (isNotFound(error)) {
        return false;
      }
      throw wrapIo(error);
    }
  };

  const remove: Disk['delete'] = async (key) => {
    assertDiskKey(key);
    const root = await resolveRootReal();
    if (root === undefined) {
      return; // idempotent
    }
    const target = targetFor(root, key);
    await assertNoSymlinkEscape(root, target);

    let existingSize = 0;
    try {
      const stats = await lstat(target);
      if (stats.isDirectory()) {
        throw new DiskError('io', 'disk entry is a directory');
      }
      existingSize = stats.isFile() ? stats.size : 0;
    } catch (error) {
      if (error instanceof DiskError) {
        throw error;
      }
      if (isNotFound(error)) {
        return; // idempotent
      }
      throw wrapIo(error);
    }

    const totalBefore = maxBytes === undefined ? undefined : await getTotal(root);
    try {
      await unlink(target);
    } catch (error) {
      if (isNotFound(error)) {
        return; // raced away; still a no-op
      }
      throw wrapIo(error);
    }
    if (totalBefore !== undefined) {
      totalBytes = totalBefore - existingSize;
    }
  };

  const list: Disk['list'] = async (prefix) => {
    assertDiskPrefix(prefix);
    const root = await resolveRootReal();
    if (root === undefined) {
      return [];
    }

    let base: string;
    if (prefix === undefined || prefix === '') {
      base = root;
    } else {
      const candidate = targetFor(root, prefix);
      await assertNoSymlinkEscape(root, candidate);
      try {
        const resolved = await realpath(candidate);
        if (!isInsideRoot(root, resolved)) {
          throw new DiskError(
            'invalid_key',
            'disk path escapes the root directory through a symlink',
          );
        }
        base = resolved;
      } catch (error) {
        if (error instanceof DiskError) {
          throw error;
        }
        if (isNotFound(error)) {
          return [];
        }
        throw wrapIo(error);
      }
    }

    const keys: string[] = [];
    const collect = async (current: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(current, { withFileTypes: true });
      } catch (error) {
        if (isNotFound(error)) {
          return;
        }
        throw wrapIo(error);
      }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) {
          continue;
        }
        const full = join(current, entry.name);
        if (entry.isDirectory()) {
          await collect(full);
        } else if (entry.isFile()) {
          keys.push(relative(root, full).split(sep).join('/'));
        }
      }
    };
    await collect(base);
    keys.sort();
    return keys;
  };

  const size: Disk['size'] = async (key) => {
    assertDiskKey(key);
    const root = await resolveRootReal();
    if (root === undefined) {
      throw new DiskError('not_found', 'file not found');
    }
    const target = targetFor(root, key);
    await assertNoSymlinkEscape(root, target);
    const resolved = await resolveReadableTarget(root, target);
    try {
      const stats = await lstat(resolved);
      if (!stats.isFile()) {
        throw new DiskError('not_found', 'file not found');
      }
      return stats.size;
    } catch (error) {
      if (error instanceof DiskError) {
        throw error;
      }
      throw wrapIo(error);
    }
  };

  return { put, get, exists, delete: remove, list, size };
}
