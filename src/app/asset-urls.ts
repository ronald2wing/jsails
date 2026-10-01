/**
 * Bounded public-asset URL versioning for Turbo Drive navigation.
 *
 * `createAssetUrlResolver(publicDir)` returns a resolver that maps a
 * root-relative public asset path (`/assets/app.js`) to the same path with a
 * content-derived query (`/assets/app.js?v=<sha256>`). Turbo's
 * `data-turbo-track="reload"` compares the URL across navigations, so a content
 * change that keeps the same filename now yields a new URL and triggers a
 * reload instead of being served from a stale deployment cache.
 *
 * The resolver is a graceful-degradation seam, never a source of errors: it
 * returns the input path unchanged whenever it cannot safely map the path to a
 * real, non-symlinked regular file strictly inside `publicDir` — a missing
 * directory or asset, a traversal/absolute/hidden/backslash/query/fragment
 * path, or a symlink all fall back to the unversioned path. This keeps
 * browser-free SSR (where `public/` may not exist) working, and means a hostile
 * path is never read from disk: only files that survive segment validation and
 * a full `lstat` walk of non-symlink ancestors are hashed.
 *
 * Hashing is cached by file `mtimeMs` + `size`, so an unchanged file is never
 * re-read; a change re-hashes exactly once. Reads stream through `createHash`,
 * so a large asset never blocks the event loop or fills memory, and nothing is
 * ever written to disk.
 */

import { createHash } from 'node:crypto';
import { createReadStream, type Stats } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';

import type { AssetUrlResolver } from '../contracts/http.js';

/** A validated path split into its slash-free, root-relative segments. */
type AssetSegments = readonly string[];

/** A file confirmed to be a regular, non-symlinked asset plus its hash inputs. */
interface ResolvedAsset {
  readonly file: string;
  readonly mtimeMs: number;
  readonly size: number;
}

/** A cached content hash keyed by the file's `mtimeMs` and `size`. */
interface CachedHash {
  readonly mtimeMs: number;
  readonly size: number;
  readonly hash: string;
}

/**
 * Build an asset-URL resolver over `publicDir`. The directory is inspected
 * lazily on first use, so constructing the resolver performs no filesystem
 * access. An empty or non-string `publicDir` yields a resolver that always
 * returns the path unchanged.
 */
export function createAssetUrlResolver(publicDir: string): AssetUrlResolver {
  if (typeof publicDir !== 'string' || publicDir === '') {
    return (path: string) => Promise.resolve(path);
  }

  const hashCache = new Map<string, CachedHash>();
  let rootPromise: Promise<string | undefined> | undefined;

  const getRoot = (): Promise<string | undefined> => {
    rootPromise ??= resolveRoot(publicDir);
    return rootPromise;
  };

  /** Return the cached hash, or compute and cache one, keyed by mtime and size. */
  const computeHash = async (asset: ResolvedAsset): Promise<string> => {
    const cached = hashCache.get(asset.file);
    if (cached !== undefined && cached.mtimeMs === asset.mtimeMs && cached.size === asset.size) {
      return cached.hash;
    }
    const hash = await hashFile(asset.file);
    hashCache.set(asset.file, { mtimeMs: asset.mtimeMs, size: asset.size, hash });
    return hash;
  };

  return async (path: string): Promise<string> => {
    const segments = parseAssetPath(path);
    if (segments === undefined) return path;

    const root = await getRoot();
    if (root === undefined) return path;

    const asset = await resolveAsset(root, segments);
    if (asset === undefined) return path;

    const hash = await computeHash(asset);
    return `${path}?v=${hash}`;
  };
}

/**
 * Resolve `publicDir` to its canonical root, or `undefined` when it is missing,
 * a symlink, or not a directory. Never throws: an unusable root simply leaves
 * every asset unversioned.
 */
async function resolveRoot(publicDir: string): Promise<string | undefined> {
  let stat: Stats;
  try {
    stat = await lstat(publicDir);
  } catch {
    return undefined;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) return undefined;
  try {
    return await realpath(publicDir);
  } catch {
    return undefined;
  }
}

/**
 * Validate a root-relative asset path and return its segments, or `undefined`
 * when it must be rejected. The path must begin with exactly one `/` and carry
 * no query, fragment, backslash, control character, empty, dot-prefixed, or
 * `..` segment — everything the static-file gate also refuses.
 */
function parseAssetPath(path: string): AssetSegments | undefined {
  if (path.charCodeAt(0) !== 47 /* '/' */) return undefined;
  if (path.charCodeAt(1) === 47 /* '//' */) return undefined; // protocol-relative
  if (path.includes('?') || path.includes('#')) return undefined;
  if (path.includes('\\')) return undefined;
  if (path.includes('\u0000')) return undefined;
  if (/[\u0000-\u001f\u007f]/.test(path)) return undefined;

  const segments = path.slice(1).split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') return undefined;
    if (segment.startsWith('.')) return undefined; // hidden
  }
  return segments;
}

/**
 * Walk the segments from `root`, `lstat`-checking every component so a symlink
 * can never escape `public`. Returns the final regular file plus its `mtimeMs`
 * and `size`, or `undefined` when any component is missing, symlinked, or not
 * the expected kind (directory along the way, regular file at the leaf).
 */
async function resolveAsset(
  root: string,
  segments: AssetSegments,
): Promise<ResolvedAsset | undefined> {
  let current = root;
  for (let index = 0; index < segments.length; index += 1) {
    current = join(current, segments[index] ?? '');
    let stat: Stats;
    try {
      stat = await lstat(current);
    } catch {
      return undefined;
    }
    if (stat.isSymbolicLink()) return undefined;
    const isLeaf = index === segments.length - 1;
    if (isLeaf) {
      if (!stat.isFile()) return undefined;
      return { file: current, mtimeMs: stat.mtimeMs, size: stat.size };
    }
    if (!stat.isDirectory()) return undefined;
  }
  return undefined;
}

/** Stream a file through a SHA-256 digest, returning its hex form. */
function hashFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}
