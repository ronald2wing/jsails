/**
 * In-memory disk: a {@link Disk} that stores bytes in a `Map` for the lifetime
 * of the process. It implements the same key validation and the same
 * value-free error contract as {@link createLocalDisk}, so it is a drop-in
 * stand-in for tests, demos, and single-process use. It holds no external
 * resources, so cleanup is a no-op.
 */

import {
  assertContentType,
  assertDiskKey,
  assertDiskPrefix,
  DiskError,
  toDiskBytes,
  validateMaxBytes,
  type Disk,
  type DiskPutOptions,
} from './disk.js';

/** Options for {@link createMemoryDisk}. */
export interface MemoryDiskOptions {
  /** Optional cap on total stored bytes; exceeding it fails `put` before writing. */
  readonly maxBytes?: number;
}

/** Create an in-memory disk. Byte accounting is exact and `maxBytes`-aware. */
export function createMemoryDisk(options: MemoryDiskOptions = {}): Disk {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('createMemoryDisk requires an options object');
  }
  const maxBytes = validateMaxBytes(options.maxBytes);
  const files = new Map<string, Uint8Array>();
  let totalBytes = 0;

  const put: Disk['put'] = async (key, data, options?: DiskPutOptions) => {
    assertDiskKey(key);
    assertContentType(options?.contentType);
    const bytes = new Uint8Array(toDiskBytes(data)); // copy: later mutation cannot corrupt
    const existing = files.get(key);
    const projected = totalBytes - (existing?.byteLength ?? 0) + bytes.byteLength;
    if (maxBytes !== undefined && projected > maxBytes) {
      throw new DiskError('max_bytes', 'disk capacity exceeded');
    }
    files.set(key, bytes);
    totalBytes = projected;
  };

  const get: Disk['get'] = async (key) => {
    assertDiskKey(key);
    const entry = files.get(key);
    if (entry === undefined) {
      throw new DiskError('not_found', 'file not found');
    }
    return new Uint8Array(entry);
  };

  const exists: Disk['exists'] = async (key) => {
    assertDiskKey(key);
    return files.has(key);
  };

  const remove: Disk['delete'] = async (key) => {
    assertDiskKey(key);
    const entry = files.get(key);
    if (entry === undefined) {
      return; // idempotent
    }
    files.delete(key);
    totalBytes -= entry.byteLength;
  };

  const list: Disk['list'] = async (prefix) => {
    assertDiskPrefix(prefix);
    const keys = [...files.keys()].filter((key) => {
      if (prefix === undefined || prefix === '') {
        return true;
      }
      return key.startsWith(`${prefix}/`);
    });
    keys.sort();
    return keys;
  };

  const size: Disk['size'] = async (key) => {
    assertDiskKey(key);
    const entry = files.get(key);
    if (entry === undefined) {
      throw new DiskError('not_found', 'file not found');
    }
    return entry.byteLength;
  };

  return { put, get, exists, delete: remove, list, size };
}
