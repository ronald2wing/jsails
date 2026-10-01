/**
 * Safe project-file writer for the human-first `create` flow.
 *
 * `writeProjectFiles(targetDir, files)` materializes an in-memory file map —
 * the result of {@link createStarterFiles} or any caller-built map — into a
 * real directory on disk. `createStarterFiles` stays pure; this module owns the
 * entire filesystem effect and every safety decision around it.
 *
 * The whole map is validated before any I/O happens: every key must be a
 * portable, contained relative file path (no absolute/UNC/Windows-drive forms,
 * no `..`/`.`/empty segments, no backslashes or Windows-reserved characters, no
 * control characters, no `__proto__` segment) and every value must be a string.
 * File/directory collisions (a path used as both a file and a directory) are
 * rejected, and duplicate keys cannot exist in a record.
 *
 * The target must be absent or an existing empty directory; a symlink target, a
 * non-directory, or a non-empty directory is refused and never touched. Both an
 * absent and an existing empty target are populated the same portable way, and
 * neither ever overwrites an existing file:
 *
 * - The target name is claimed with an exclusive `mkdir` (an absent target
 *   reserves it; an existing empty target is already claimed). A target created
 *   concurrently is never clobbered: the reservation fails on an existing name.
 * - Every file is then created with an exclusive (`wx`) open and written through
 *   its descriptor, tracking every file and directory this call creates so a
 *   failure rolls back only its own artifacts — unrelated or concurrently-created
 *   files are preserved, and no `rm`-recursive ever targets the caller's
 *   directory. There is no cross-directory `rename`, so publishing is portable
 *   to Windows, where `rename` cannot replace an existing directory.
 *
 * Missing parent directories are created (and tracked for rollback) as needed.
 * Failures raise a value-free {@link ScaffoldError}: file contents are never
 * echoed in a message, only paths and errno codes. No dependencies are
 * installed, no subprocess is spawned, and no framework service is started.
 */

import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** Raised for any invalid file map or unsafe/unwritable target. */
export class ScaffoldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScaffoldError';
  }
}

/** Result of a successful {@link writeProjectFiles} call. */
export interface WriteProjectFilesResult {
  /** The absolute, resolved target directory that now holds the files. */
  readonly targetDir: string;
  /** The relative file paths written, in deterministic (sorted) order. */
  readonly files: readonly string[];
}

/**
 * The narrow filesystem surface {@link writeProjectFiles} uses. Exposed so the
 * test suite can inject a failing or interfering filesystem to exercise the
 * rollback paths deterministically; applications always use the real Node
 * `fs` adapter and never construct this.
 */
export interface ScaffoldFs {
  /** `lstat` — never follows symlinks, so a symlink target is detectable. */
  lstat(path: string): Stats;
  /** `readdir` returning names, used to detect a non-empty target. */
  readdir(path: string): string[];
  /** Non-recursive `mkdir`. */
  mkdir(path: string): void;
  /** Non-recursive `rmdir`; fails on a non-empty directory. */
  rmdir(path: string): void;
  /** Exclusive-create `open` (`wx`): returns a descriptor, fails `EEXIST` if the file exists. */
  open(path: string): number;
  /** Write the whole string to an open descriptor. */
  write(fd: number, data: string): void;
  /** Close an open descriptor. */
  close(fd: number): void;
  /** `unlink` a single file. */
  unlink(path: string): void;
}

/** The real Node filesystem adapter. */
const DEFAULT_FS: ScaffoldFs = {
  lstat: lstatSync,
  readdir: readdirSync,
  mkdir: mkdirSync,
  rmdir: rmdirSync,
  open: (path) => openSync(path, 'wx'),
  write: (fd, data) => writeFileSync(fd, data, 'utf8'),
  close: closeSync,
  unlink: unlinkSync,
};

/** C0 controls plus DEL — never valid in a path. */
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

/** A Windows drive prefix (`C:`, `C:` relative, `C:/x`). */
const WINDOWS_DRIVE = /^[A-Za-z]:/;

/** Characters Windows forbids in a file name (drive colon handled separately). */
const WINDOWS_RESERVED_CHARS = /[<>:"|?*]/;

/** One validated file entry. */
interface PlannedFile {
  readonly rel: string;
  readonly content: string;
}

/** Whether a value is a plain object (object literal or null-prototype). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** The `code` of an errno-style error, if any. */
function errnoCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

function isEnoent(error: unknown): boolean {
  return errnoCode(error) === 'ENOENT';
}

function isEexist(error: unknown): boolean {
  return errnoCode(error) === 'EEXIST';
}

/**
 * Describe a filesystem error without ever echoing file contents. An errno code
 * is preferred; otherwise the message (Node fs errors carry paths, never data)
 * or a fixed fallback is used.
 */
function describeFsError(error: unknown): string {
  const code = errnoCode(error);
  if (typeof code === 'string') return code;
  if (error instanceof Error && error.message !== '') return error.message;
  return 'an unknown filesystem error';
}

/** Wrap an arbitrary failure as a {@link ScaffoldError}, preserving the type. */
function toScaffoldError(error: unknown, fallback: string): ScaffoldError {
  if (error instanceof ScaffoldError) return error;
  return new ScaffoldError(`${fallback}: ${describeFsError(error)}`);
}

/**
 * Validate a single map key as a portable, contained relative file path.
 * Dotfiles (`.gitignore`, `.env.example`, `AGENTS.md`) are ordinary segments and
 * allowed; absolute, UNC/Windows-drive, backslash, reserved-character, empty,
 * `.`/`..`, and `__proto__` forms are refused.
 */
function assertPortablePath(path: string): void {
  if (path.length === 0) {
    throw new ScaffoldError('file paths must not be empty');
  }
  if (CONTROL_CHARS.test(path)) {
    throw new ScaffoldError('file paths must not contain control characters');
  }
  if (path.includes('\\')) {
    throw new ScaffoldError('file paths must use forward slashes, not backslashes');
  }
  if (path.startsWith('/')) {
    throw new ScaffoldError('file paths must be relative, not absolute');
  }
  if (WINDOWS_DRIVE.test(path)) {
    throw new ScaffoldError('file paths must not include a Windows drive or UNC prefix');
  }
  if (WINDOWS_RESERVED_CHARS.test(path)) {
    throw new ScaffoldError('file paths must not contain Windows-reserved characters');
  }
  for (const segment of path.split('/')) {
    if (segment.length === 0) {
      throw new ScaffoldError('file paths must not contain empty segments');
    }
    if (segment === '.' || segment === '..') {
      throw new ScaffoldError('file paths must not contain "." or ".." segments');
    }
    if (segment === '__proto__') {
      throw new ScaffoldError('file paths must not contain a "__proto__" segment');
    }
  }
}

/** Reject a path used as both a file and a directory (at segment boundaries). */
function assertNoPathCollisions(paths: readonly string[]): void {
  const files = new Set(paths);
  for (const path of paths) {
    const segments = path.split('/');
    let prefix = '';
    for (let index = 0; index < segments.length - 1; index += 1) {
      const segment = segments[index]!;
      prefix = prefix.length === 0 ? segment : `${prefix}/${segment}`;
      if (files.has(prefix)) {
        throw new ScaffoldError('files contain a path used as both a file and a directory');
      }
    }
  }
}

/**
 * Validate the entire file map and return a deterministic list of planned
 * entries. Runs before any filesystem access; values are never echoed in an
 * error message.
 */
function planFiles(files: unknown): PlannedFile[] {
  if (!isPlainObject(files)) {
    throw new ScaffoldError(
      'files must be a plain object mapping relative paths to string contents',
    );
  }
  const planned: PlannedFile[] = [];
  for (const path of Object.keys(files)) {
    assertPortablePath(path);
    const content = files[path];
    if (typeof content !== 'string') {
      throw new ScaffoldError(`file "${path}" must have string contents`);
    }
    planned.push({ rel: path, content });
  }
  assertNoPathCollisions(planned.map((entry) => entry.rel));
  planned.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return planned;
}

/** Whether the target is absent or an existing empty directory (else throws). */
function inspectTarget(fs: ScaffoldFs, target: string): 'absent' | 'empty' {
  let stat: Stats;
  try {
    stat = fs.lstat(target);
  } catch (error) {
    if (isEnoent(error)) return 'absent';
    throw new ScaffoldError(`target directory could not be inspected: ${describeFsError(error)}`);
  }
  if (stat.isSymbolicLink()) {
    throw new ScaffoldError('target must not be a symbolic link');
  }
  if (!stat.isDirectory()) {
    throw new ScaffoldError('target exists and is not a directory');
  }
  if (fs.readdir(target).length > 0) {
    throw new ScaffoldError('target directory is not empty');
  }
  return 'empty';
}

/**
 * Ensure `dir` exists, creating missing ancestors one level at a time. Every
 * directory this call creates is recorded in `created` (outermost-first, so
 * reverse-order removal is deepest-first); a directory that already exists
 * (including one created concurrently) is never recorded, so rollback never
 * removes it.
 */
function ensureDirectory(fs: ScaffoldFs, dir: string, created: string[]): void {
  try {
    fs.lstat(dir);
    return;
  } catch (error) {
    if (!isEnoent(error)) {
      throw new ScaffoldError(`could not inspect directory "${dir}": ${describeFsError(error)}`);
    }
  }
  const parent = dirname(dir);
  if (parent === dir) {
    throw new ScaffoldError(`could not create directory "${dir}"`);
  }
  ensureDirectory(fs, parent, created);
  try {
    fs.mkdir(dir);
    created.push(dir);
  } catch (error) {
    if (!isEexist(error)) {
      throw new ScaffoldError(`could not create directory "${dir}": ${describeFsError(error)}`);
    }
  }
}

/**
 * Roll back only the artifacts this call created: remove tracked files first
 * (by exact path), then tracked directories deepest-first via non-recursive
 * `rmdir`. Anything else — unrelated or concurrently-created files, or a
 * directory that is no longer empty — is preserved.
 */
function rollback(fs: ScaffoldFs, files: readonly string[], dirs: readonly string[]): void {
  for (const file of [...files].reverse()) {
    try {
      fs.unlink(file);
    } catch {
      // Best effort: never mask the original failure.
    }
  }
  for (const dir of [...dirs].reverse()) {
    try {
      fs.rmdir(dir);
    } catch {
      // `rmdir` only removes an empty directory; a concurrent writer's files stay.
    }
  }
}

/**
 * Create one file with an exclusive `wx` open, establishing ownership only
 * after the open succeeds. The descriptor is written and closed in a `finally`
 * so a failed write still closes it and the outer rollback removes the partial
 * file this call just created — never a foreign file, which is only ever hit
 * when the open itself throws `EEXIST` before anything is recorded.
 */
function writeOwnedFile(
  fs: ScaffoldFs,
  dest: string,
  content: string,
  rel: string,
  createdFiles: string[],
): void {
  let fd: number;
  try {
    fd = fs.open(dest);
  } catch (error) {
    if (isEexist(error)) {
      throw new ScaffoldError(`refusing to overwrite existing file "${rel}"`);
    }
    throw new ScaffoldError(`could not write file "${rel}": ${describeFsError(error)}`);
  }
  // Ownership is established: the file now exists and is ours, so a later
  // write failure can safely roll it back.
  createdFiles.push(dest);
  try {
    fs.write(fd, content);
  } finally {
    fs.close(fd);
  }
}

/** Write every planned file into `target`, tracking own files and directories. */
function populateTarget(
  fs: ScaffoldFs,
  target: string,
  planned: PlannedFile[],
  createdFiles: string[],
  createdDirs: string[],
): void {
  for (const entry of planned) {
    const dest = join(target, ...entry.rel.split('/'));
    ensureDirectory(fs, dirname(dest), createdDirs);
    writeOwnedFile(fs, dest, entry.content, entry.rel, createdFiles);
  }
}

/** Write files directly into an existing empty target with exclusive creates. */
function writeIntoEmpty(fs: ScaffoldFs, target: string, planned: PlannedFile[]): string[] {
  const createdFiles: string[] = [];
  const createdDirs: string[] = [];
  try {
    populateTarget(fs, target, planned, createdFiles, createdDirs);
  } catch (error) {
    rollback(fs, createdFiles, createdDirs);
    throw toScaffoldError(error, 'writing project files failed');
  }
  return planned.map((entry) => entry.rel);
}

/**
 * Publish into an absent target. The target name is reserved with an exclusive
 * `mkdir` (failing on a concurrently-created name) and then populated in place
 * with exclusive creates — no cross-directory `rename` — so publishing is
 * portable to Windows, which cannot rename a directory over an existing one.
 * On failure, the reserved target, its tracked files, and any created parents
 * are rolled back; a concurrently-created target is never touched.
 */
function publishAbsent(
  fs: ScaffoldFs,
  target: string,
  parent: string,
  planned: PlannedFile[],
): string[] {
  const createdFiles: string[] = [];
  const createdDirs: string[] = [];
  try {
    ensureDirectory(fs, parent, createdDirs);
    try {
      fs.mkdir(target);
    } catch (error) {
      if (isEexist(error)) {
        throw new ScaffoldError(
          'target directory was created concurrently; nothing was overwritten',
        );
      }
      throw new ScaffoldError(`could not create target directory: ${describeFsError(error)}`);
    }
    createdDirs.push(target);
    populateTarget(fs, target, planned, createdFiles, createdDirs);
  } catch (error) {
    rollback(fs, createdFiles, createdDirs);
    throw toScaffoldError(error, 'publishing project files failed');
  }
  return planned.map((entry) => entry.rel);
}

/**
 * Write a file map into `targetDir`, validating the whole map before any I/O.
 * The target must be absent or an existing empty directory; a symlink,
 * non-directory, or non-empty target is rejected and never modified. Returns
 * the absolute target and the relative paths written, in sorted order.
 */
export async function writeProjectFiles(
  targetDir: string,
  files: Readonly<Record<string, string>>,
): Promise<WriteProjectFilesResult> {
  return writeProjectFilesWithFs(targetDir, files, DEFAULT_FS);
}

/**
 * Test seam: {@link writeProjectFiles} against an injected filesystem. Not part
 * of the public API; applications call {@link writeProjectFiles}.
 */
export function writeProjectFilesWithFs(
  targetDir: string,
  files: Readonly<Record<string, string>>,
  fs: ScaffoldFs,
): WriteProjectFilesResult {
  if (typeof targetDir !== 'string' || targetDir === '') {
    throw new ScaffoldError('targetDir must be a non-empty string');
  }

  // The entire map is validated before any filesystem access.
  const planned = planFiles(files);

  const target = resolve(targetDir);
  const parent = dirname(target);
  const kind = inspectTarget(fs, target);

  const written =
    kind === 'empty'
      ? writeIntoEmpty(fs, target, planned)
      : publishAbsent(fs, target, parent, planned);

  return { targetDir: target, files: written };
}
