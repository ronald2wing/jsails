/**
 * In-memory disk: a {@link Disk} that stores bytes in a `Map` for the lifetime
 * of the process. It implements the same key validation and the same
 * value-free error contract as {@link LocalDisk}, so it is a drop-in stand-in
 * for tests, demos, and single-process use. It holds no external resources, so
 * cleanup is a no-op.
 */

import {
  assertContentType,
  assertDiskKey,
  assertDiskPrefix,
  DiskError,
  toDiskBytes,
  validateMaxBytes,
  type Disk,
  type DiskData,
  type DiskPutOptions,
} from './disk.js';

/** Options for {@link MemoryDisk}. */
export interface MemoryDiskOptions {
  /** Optional cap on total stored bytes; exceeding it fails `put` before writing. */
  readonly maxBytes?: number;
}

/**
 * In-memory disk. Byte accounting is exact and `maxBytes`-aware. Construct with
 * `new MemoryDisk({ maxBytes? })`; the instance is inert until a method is
 * called.
 */
export class MemoryDisk implements Disk {
  readonly #maxBytes: number | undefined;
  readonly #files = new Map<string, Uint8Array>();
  #totalBytes = 0;

  constructor(options: MemoryDiskOptions = {}) {
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError('MemoryDisk requires an options object');
    }
    this.#maxBytes = validateMaxBytes(options.maxBytes);
  }

  async put(key: string, data: DiskData, options?: DiskPutOptions): Promise<void> {
    assertDiskKey(key);
    assertContentType(options?.contentType);
    const bytes = new Uint8Array(toDiskBytes(data)); // copy: later mutation cannot corrupt
    const existing = this.#files.get(key);
    const projected = this.#totalBytes - (existing?.byteLength ?? 0) + bytes.byteLength;
    if (this.#maxBytes !== undefined && projected > this.#maxBytes) {
      throw new DiskError('max_bytes', 'disk capacity exceeded');
    }
    this.#files.set(key, bytes);
    this.#totalBytes = projected;
  }

  async get(key: string): Promise<Uint8Array> {
    assertDiskKey(key);
    const entry = this.#files.get(key);
    if (entry === undefined) {
      throw new DiskError('not_found', 'file not found');
    }
    return new Uint8Array(entry);
  }

  async exists(key: string): Promise<boolean> {
    assertDiskKey(key);
    return this.#files.has(key);
  }

  async delete(key: string): Promise<void> {
    assertDiskKey(key);
    const entry = this.#files.get(key);
    if (entry === undefined) {
      return; // idempotent
    }
    this.#files.delete(key);
    this.#totalBytes -= entry.byteLength;
  }

  async list(prefix?: string): Promise<readonly string[]> {
    assertDiskPrefix(prefix);
    const keys = [...this.#files.keys()].filter((key) => {
      if (prefix === undefined || prefix === '') {
        return true;
      }
      return key.startsWith(`${prefix}/`);
    });
    keys.sort();
    return keys;
  }

  async size(key: string): Promise<number> {
    assertDiskKey(key);
    const entry = this.#files.get(key);
    if (entry === undefined) {
      throw new DiskError('not_found', 'file not found');
    }
    return entry.byteLength;
  }
}
