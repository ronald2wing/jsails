/**
 * The `Disk` contract: a keyed blob store over relative POSIX-style paths.
 *
 * A disk stores named files (`put`) and reads them back by key (`get`); every
 * key is a relative path using forward slashes (`docs/report.txt`) — absolute
 * paths, `..`/`.` segments, backslashes, drive prefixes, and control characters
 * are rejected. Implementations own their persistence: {@link createLocalDisk}
 * writes to the real filesystem, {@link createMemoryDisk} keeps bytes in memory.
 *
 * The contract deliberately exposes no absolute path and no `path()` accessor:
 * callers address content by key only, and a disk never leaks where its files
 * live. `get` returns raw bytes; the optional `contentType` on `put` is
 * validated and accepted for forward compatibility but is not persisted (the
 * v1 `get` returns bytes only), so it carries no state and no promise of a
 * metadata round-trip.
 *
 * Every failure that reaches a caller is a value-free {@link DiskError}: no key,
 * path, or data content is ever embedded in a message. Construction-time option
 * mistakes throw `TypeError` instead, matching the other factory helpers.
 */

/** Data accepted by `put`: raw bytes, or a UTF-8 string. */
export type DiskData = Uint8Array | string;

/** Options for {@link Disk.put}. */
export interface DiskPutOptions {
  /** Advisory MIME type. Validated but not persisted in the v1 contract. */
  readonly contentType?: string;
}

/** A keyed blob store over relative POSIX-style paths. */
export interface Disk {
  /** Atomically store `data` under `relativePath`. */
  put(relativePath: string, data: DiskData, options?: DiskPutOptions): Promise<void>;
  /** Read the raw bytes stored under `relativePath`. */
  get(relativePath: string): Promise<Uint8Array>;
  /** Whether a file exists at `relativePath`. */
  exists(relativePath: string): Promise<boolean>;
  /** Remove the file at `relativePath`; a no-op when absent. */
  delete(relativePath: string): Promise<void>;
  /** Sorted keys under `prefix` (recursive), or every key when omitted. */
  list(prefix?: string): Promise<readonly string[]>;
  /** Byte size of the file at `relativePath`. */
  size(relativePath: string): Promise<number>;
}

/** Machine-readable reason for a {@link DiskError}. */
export type DiskErrorCode = 'invalid_key' | 'not_found' | 'max_bytes' | 'io';

/** Raised for every disk failure that reaches a caller. Messages are value-free. */
export class DiskError extends Error {
  readonly code: DiskErrorCode;

  constructor(code: DiskErrorCode, message: string) {
    super(message);
    this.name = 'DiskError';
    this.code = code;
  }
}

/** C0 controls plus DEL — never valid in a key. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** A Windows drive prefix (`C:`), invalid for a POSIX-style key. */
const WINDOWS_DRIVE = /^[A-Za-z]:/;

/**
 * Reject any key that is not a relative POSIX-style path. Conservative: empty,
 * absolute, drive-prefixed, backslashed, control-bearing, and any
 * empty/`.`/`..` segment are all refused with a value-free `DiskError` (the key
 * is never echoed).
 */
export function assertDiskKey(key: unknown): asserts key is string {
  if (typeof key !== 'string' || key.length === 0) {
    throw new DiskError('invalid_key', 'disk keys must be non-empty strings');
  }
  if (CONTROL_CHARS.test(key)) {
    throw new DiskError('invalid_key', 'disk keys must not contain control characters');
  }
  if (key.includes('\\')) {
    throw new DiskError('invalid_key', 'disk keys must use forward slashes');
  }
  if (key.startsWith('/') || WINDOWS_DRIVE.test(key)) {
    throw new DiskError('invalid_key', 'disk keys must be relative POSIX paths');
  }
  for (const segment of key.split('/')) {
    if (segment.length === 0 || segment === '.' || segment === '..') {
      throw new DiskError('invalid_key', 'disk keys must not contain empty, ".", or ".." segments');
    }
  }
}

/** Validate a `list` prefix: `undefined`/`''` means "all", otherwise a valid key. */
export function assertDiskPrefix(prefix: unknown): asserts prefix is string | undefined {
  if (prefix === undefined || prefix === '') {
    return;
  }
  assertDiskKey(prefix);
}

/** Normalize accepted `put` data to bytes (a UTF-8 encode for strings). */
export function toDiskBytes(data: DiskData): Uint8Array {
  if (typeof data === 'string') {
    return Buffer.from(data, 'utf8');
  }
  return data;
}

/** Validate the advisory `contentType`, when supplied. */
export function assertContentType(contentType: unknown): void {
  if (contentType === undefined) {
    return;
  }
  if (typeof contentType !== 'string' || contentType.trim() === '') {
    throw new TypeError('contentType must be a non-empty string');
  }
}

/** Validate a `maxBytes` option: `undefined` or a non-negative integer. */
export function validateMaxBytes(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    !Number.isInteger(value)
  ) {
    throw new TypeError('maxBytes must be a non-negative integer');
  }
  return value;
}
