/**
 * Incremental on-disk cache for rendered content pages.
 *
 * Keys each doc by its source .md file's `mtimeMs + size` so unchanged files
 * skip re-parsing and re-highlighting on rebuild. A missing or corrupt entry is
 * a cache miss, never an error (graceful degradation).
 *
 * Known limitation: `mtimeMs + size` can miss a same-millisecond edit where the
 * file size stays identical. This is acceptable for a docs build — touch the
 * file twice (or delete the cache dir) to force a rebuild.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

interface CacheEntry {
  html: string;
  toc: TocHeading[];
  headings: TocHeading[];
}

interface TocHeading {
  depth: number;
  id: string;
  text: string;
}

function cacheKey(mtimeMs: number, size: number): string {
  return `${mtimeMs}-${size}`;
}

export interface CacheStore {
  get(filePath: string, mtimeMs: number, size: number): CacheEntry | null;
  put(filePath: string, mtimeMs: number, size: number, entry: CacheEntry): void;
}

export function createFileCache(cacheDir: string): CacheStore {
  // Ensure the cache directory exists.
  if (!existsSync(cacheDir)) {
    mkdirSync(cacheDir, { recursive: true });
  }

  function entryPath(filePath: string, mtimeMs: number, size: number): string {
    // Hash the path to avoid filesystem-illegal characters in cache filenames.
    const hash = simpleHash(filePath);
    return resolvePath(cacheDir, `${hash}-${cacheKey(mtimeMs, size)}.json`);
  }

  return {
    get(filePath, mtimeMs, size) {
      try {
        const p = entryPath(filePath, mtimeMs, size);
        const raw = readFileSync(p, 'utf-8');
        return JSON.parse(raw) as CacheEntry;
      } catch {
        return null;
      }
    },

    put(filePath, mtimeMs, size, entry) {
      try {
        const p = entryPath(filePath, mtimeMs, size);
        writeFileSync(p, JSON.stringify(entry), 'utf-8');
      } catch {
        // Cache write failure is silent — graceful degradation.
      }
    },
  };
}

/**
 * Simple non-cryptographic hash for cache filenames.
 */
function simpleHash(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    const char = input.charCodeAt(i);
    hash = (hash * 31 + char) & 0x7fffffff;
  }
  return hash.toString(36).padStart(7, '0');
}
