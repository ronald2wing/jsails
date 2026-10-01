import { readFile, access } from 'node:fs/promises';
import { dirname } from 'node:path';

import fse from 'fs-extra';
import fg from 'fast-glob';
import { rimraf as rimrafFn } from 'rimraf';

import { SupportError } from './errors.js';

// ---------------------------------------------------------------------------
// Domain error
// ---------------------------------------------------------------------------

export type FilesErrorCode = 'not_found' | 'io_failed' | 'invalid_argument';

export class FilesError extends SupportError {
  readonly code: FilesErrorCode;

  constructor(code: FilesErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
  }
}

/**
 * Map a thrown filesystem error to a value-free `FilesError`. The path and the
 * raw system message are never carried through — only the errno class.
 */
function wrapError(error: unknown, operation: string): FilesError {
  if (error instanceof FilesError) return error;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT') {
    return new FilesError('not_found', `${operation}: file not found`, { cause: error });
  }
  return new FilesError('io_failed', `${operation}: filesystem error`, { cause: error });
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface WriteJsonOptions {
  /** Pretty-print with the given number of spaces. */
  spaces?: number;
}

export interface CopyOptions {
  /** Overwrite an existing destination. */
  overwrite?: boolean;
  /** Preserve file timestamps. */
  preserveTimestamps?: boolean;
}

export interface GlobOptions {
  /** Working directory the patterns are resolved against. */
  cwd?: string;
  /** Include dot-files. Defaults to false. */
  dot?: boolean;
  /** Return absolute paths. Defaults to false. */
  absolute?: boolean;
  /** Follow symlinked directories. Defaults to false. */
  followSymbolicLinks?: boolean;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Read and JSON-parse a file. Throws `FilesError` on missing/invalid input. */
export async function readJson<T = unknown>(path: string): Promise<T> {
  try {
    return (await fse.readJson(path)) as T;
  } catch (error) {
    // A malformed JSON document is an input problem, not an I/O failure.
    if (error instanceof SyntaxError) {
      throw new FilesError('invalid_argument', 'readJson: invalid JSON', { cause: error });
    }
    throw wrapError(error, 'readJson');
  }
}

/** Serialize `value` to JSON and write it, creating parent directories. */
export async function writeJson(
  path: string,
  value: unknown,
  options: WriteJsonOptions = {},
): Promise<void> {
  try {
    await fse.ensureDir(dirname(path));
    await fse.writeJson(path, value, { spaces: options.spaces ?? 2 });
  } catch (error) {
    throw wrapError(error, 'writeJson');
  }
}

/** Create a directory and any missing parents. */
export async function ensureDir(path: string): Promise<void> {
  try {
    await fse.ensureDir(path);
  } catch (error) {
    throw wrapError(error, 'ensureDir');
  }
}

/** Copy a file or directory tree. */
export async function copy(src: string, dest: string, options: CopyOptions = {}): Promise<void> {
  try {
    await fse.copy(src, dest, {
      overwrite: options.overwrite ?? true,
      preserveTimestamps: options.preserveTimestamps ?? false,
    });
  } catch (error) {
    throw wrapError(error, 'copy');
  }
}

/** Move a file or directory tree. */
export async function move(src: string, dest: string): Promise<void> {
  try {
    await fse.move(src, dest, { overwrite: true });
  } catch (error) {
    throw wrapError(error, 'move');
  }
}

/** Remove a file or directory; a missing target is not an error. */
export async function remove(path: string): Promise<void> {
  try {
    await fse.remove(path);
  } catch (error) {
    throw wrapError(error, 'remove');
  }
}

/** Test whether a path exists. */
export async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Match files against one or more glob patterns. */
export async function glob(
  patterns: string | readonly string[],
  options: GlobOptions = {},
): Promise<string[]> {
  try {
    const input = typeof patterns === 'string' ? patterns : [...patterns];
    return await fg(input, {
      cwd: options.cwd,
      dot: options.dot ?? false,
      absolute: options.absolute ?? false,
      followSymbolicLinks: options.followSymbolicLinks ?? false,
      onlyFiles: true,
    });
  } catch (error) {
    throw wrapError(error, 'glob');
  }
}

/** Recursively remove a directory (the `rimraf` operation). */
export async function rimraf(path: string): Promise<void> {
  try {
    await rimrafFn(path);
  } catch (error) {
    throw wrapError(error, 'rimraf');
  }
}

/** Read a file and base64-encode its bytes. */
export async function toBase64(path: string): Promise<string> {
  try {
    const buffer = await readFile(path);
    return buffer.toString('base64');
  } catch (error) {
    throw wrapError(error, 'toBase64');
  }
}

// ---------------------------------------------------------------------------
// Frozen namespace
// ---------------------------------------------------------------------------

export const Files = Object.freeze({
  readJson,
  writeJson,
  ensureDir,
  copy,
  move,
  remove,
  exists,
  glob,
  rimraf,
  toBase64,
});
