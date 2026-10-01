/**
 * Generic lexical file walker for compiled modules.
 *
 * Walks a directory tree depth-first in deterministic code-unit order,
 * returning posix-separated relative paths for files whose extension matches
 * the caller-supplied set. Symlinks are skipped; a missing root directory
 * returns an empty array (ENOENT-tolerant). Every other filesystem error is
 * rethrown.
 *
 * The walker is a build-time lexical primitive consumed by command discovery
 * and the autoload scanner. It never imports modules or opens a connection.
 */

import { readdirSync, type Dirent } from 'node:fs';
import { extname, join } from 'node:path';

import { isErrno } from '../internal/errors.js';

/** Options for {@link walkLexicalFiles}. */
export interface WalkLexicalFilesOptions {
  /** File extensions to include (e.g. `new Set(['.js', '.mjs'])`). */
  readonly extensions: ReadonlySet<string>;
}

/**
 * Walk `rootDir` lexically, returning posix-separated relative paths for every
 * file whose extension matches `options.extensions`. ENOENT-tolerant (missing
 * root → `[]`). Deterministic order: code-unit sort per directory, depth-first.
 */
export function walkLexicalFiles(rootDir: string, options: WalkLexicalFilesOptions): string[] {
  const results: string[] = [];
  walk(rootDir, '');
  return results;

  function walk(current: string, prefix: string): void {
    let dirents: Dirent[];
    try {
      dirents = readdirSync(current, { withFileTypes: true });
    } catch (error) {
      if (isErrno(error, 'ENOENT')) {
        return;
      }
      throw error;
    }
    dirents.sort((a, b) => compareStrings(a.name, b.name));
    for (const dirent of dirents) {
      if (dirent.isSymbolicLink()) {
        continue;
      }
      const relative = prefix === '' ? dirent.name : `${prefix}/${dirent.name}`;
      if (dirent.isDirectory()) {
        walk(join(current, dirent.name), relative);
        continue;
      }
      if (!dirent.isFile() || !options.extensions.has(extname(dirent.name))) {
        continue;
      }
      results.push(relative);
    }
  }
}

/** Code-unit string comparison; locale-independent for deterministic order. */
function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
