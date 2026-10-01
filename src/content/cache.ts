/**
 * Incremental on-disk cache for rendered content pages.
 *
 * Keys each page by its source `.md` file's `mtimeMs + size` AND a cache-format
 * version, so unchanged files skip re-parsing and re-highlighting on rebuild.
 * The version segment is load-bearing: a change to the RENDER PIPELINE (e.g.
 * stripping the leading H1) leaves the source file untouched, so `mtimeMs +
 * size` alone would serve stale HTML/toc from a prior build. Bumping
 * `CACHE_FORMAT_VERSION` on any output-shape change invalidates every old entry
 * without requiring a manual cache purge. A missing or corrupt entry is a cache
 * miss, never an error (graceful degradation).
 *
 * Known limitation: `mtimeMs + size` can miss a same-millisecond edit where the
 * file size stays identical. This is acceptable for a content build — touch the
 * file twice (or delete the cache dir) to force a rebuild.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import type { TocHeading } from './content-model.js';

/**
 * Bump when the render pipeline changes the shape of `html`, `toc`, or
 * `headings` so pre-existing cache entries are treated as misses.
 *
 * History:
 *   1 — initial
 *   2 — leading H1 stripped from html + toc (frontmatter title is canonical)
 */
const CACHE_FORMAT_VERSION = 2;

interface CacheEntry {
  html: string;
  toc: TocHeading[];
  headings: TocHeading[];
}

function cacheKey(mtimeMs: number, size: number): string {
  return `v${CACHE_FORMAT_VERSION}-${mtimeMs}-${size}`;
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
