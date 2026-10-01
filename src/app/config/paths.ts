/**
 * Path resolution and containment guards for the application config.
 *
 * The resolved config computes every directory lexically from the config
 * module's location (never creating a directory or reading the filesystem
 * except to harden the isolation checks below). This module owns that
 * computation plus the two private-directory guards: `public` and `storage`
 * must never expose source, config, or compiled output. Existing paths are
 * resolved through `realpath` solely so a symlinked directory cannot smuggle an
 * overlap past the lexical comparison; the resolved config keeps the lexical
 * paths.
 */

import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import {
  AppConfigError,
  DEFAULT_APP_API_DIR,
  DEFAULT_APP_CONFIG_PATH,
  DEFAULT_APP_OUT_DIR,
  DEFAULT_APP_PAGES_DIR,
  DEFAULT_APP_PUBLIC_DIR,
  DEFAULT_APP_STORAGE_DIR,
  DEFAULT_HEALTH_PATH,
} from './schema.js';

/** Resolve a (possibly relative) config path against the working directory. */
export function resolveConfigPath(cwd: string, configPath?: string): string {
  return resolve(cwd, configPath ?? DEFAULT_APP_CONFIG_PATH);
}

/** The absolute directories computed from a config's location and overrides. */
interface ResolvedDirectoryPaths {
  /** Absolute project root. */
  readonly rootDir: string;
  /** Absolute pages directory. */
  readonly pagesDir: string;
  /** Absolute API directory. */
  readonly apiDir: string;
  /** Absolute static-assets directory. */
  readonly publicDir: string;
  /** Absolute build output directory. */
  readonly outDir: string;
  /** Absolute persistent-storage directory. */
  readonly storageDir: string;
}

/**
 * Compute the absolute directory layout: `rootDir` resolves against the config
 * file's directory (the `configDir`), and the four content directories resolve
 * against `rootDir`. Purely lexical — no directory is created or read.
 */
export function resolveDirectoryPaths(options: {
  /** Directory of the config module anchoring `rootDir`. */
  readonly configDir: string;
  readonly rootDir?: string;
  readonly pages?: string;
  readonly api?: string;
  readonly public?: string;
  readonly out?: string;
  readonly storage?: string;
}): ResolvedDirectoryPaths {
  const rootDir = resolve(options.configDir, options.rootDir ?? '.');
  return {
    rootDir,
    pagesDir: resolve(rootDir, options.pages ?? DEFAULT_APP_PAGES_DIR),
    apiDir: resolve(rootDir, options.api ?? DEFAULT_APP_API_DIR),
    publicDir: resolve(rootDir, options.public ?? DEFAULT_APP_PUBLIC_DIR),
    outDir: resolve(rootDir, options.out ?? DEFAULT_APP_OUT_DIR),
    storageDir: resolve(rootDir, options.storage ?? DEFAULT_APP_STORAGE_DIR),
  };
}

/** Internal framework namespace reserved for broadcast and components. */
const RESERVED_INTERNAL_PREFIX = '/_jsails';

/**
 * Resolve the health endpoint path: `undefined` (default) yields
 * {@link DEFAULT_HEALTH_PATH}, `false` disables, and a string is shape-validated.
 * A path must start with `/`, may not end with `/` (except the root path `/`
 * itself), and must not contain a backslash, `?`, `#`, `:`, `[`, `]`, a doubled
 * `/`, or a control character, nor live under the reserved `/_jsails`
 * namespace. The input value is never echoed in an error.
 */
export function resolveHealthPath(value: string | false | undefined): string | undefined {
  if (value === undefined) return DEFAULT_HEALTH_PATH;
  if (value === false) return undefined;
  const valid =
    value.startsWith('/') &&
    (value === '/' || !value.endsWith('/')) &&
    !/[\\?#:[\]]/.test(value) &&
    !value.includes('//') &&
    !/[\u0000-\u001f\u007f]/.test(value);
  if (!valid) {
    throw new AppConfigError('config.healthPath must be an absolute path without a trailing slash');
  }
  if (value === RESERVED_INTERNAL_PREFIX || value.startsWith(`${RESERVED_INTERNAL_PREFIX}/`)) {
    throw new AppConfigError('config.healthPath must not use the reserved /_jsails namespace');
  }
  return value;
}

/** Resolve an existing path to its real path, else return the lexical path. */
function realOrLexical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** True when `child` is `parent` or lives inside it. */
function isPathInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  if (rel === '') return true;
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
}

/** The resolved directory paths whose containment is checked together. */
interface DirectoryLayout {
  readonly configPath: string;
  readonly rootDir: string;
  readonly pagesDir: string;
  readonly apiDir: string;
  readonly publicDir: string;
  readonly outDir: string;
}

/**
 * Reject a `publicDir` that could expose source, config, or compiled output.
 * The public directory must not contain (or equal) the project root, must not
 * overlap the pages/api/out directories in either direction, and must not
 * contain the config module itself.
 *
 * Paths that exist on disk are resolved through `realpath` so a symlinked
 * directory cannot smuggle an overlap past the lexical check; a missing path (a
 * public directory need not exist yet) falls back to its lexical form. This is
 * defense in depth: the runtime static-file middleware independently rejects a
 * symlinked public root and any symlinked segment it serves.
 */
export function assertPublicDirIsolation(layout: DirectoryLayout): void {
  const rootDir = realOrLexical(layout.rootDir);
  const publicDir = realOrLexical(layout.publicDir);
  const configPath = realOrLexical(layout.configPath);

  if (isPathInside(publicDir, rootDir)) {
    throw new AppConfigError('config.public must not contain the project root');
  }
  const directories = [
    ['pages', layout.pagesDir],
    ['api', layout.apiDir],
    ['out', layout.outDir],
  ] as const;
  for (const [field, path] of directories) {
    const resolved = realOrLexical(path);
    if (isPathInside(publicDir, resolved) || isPathInside(resolved, publicDir)) {
      throw new AppConfigError(`config.public must not overlap the ${field} directory`);
    }
  }
  if (isPathInside(publicDir, configPath)) {
    throw new AppConfigError('the app config must not live inside the public directory');
  }
}

/** The resolved paths whose storage-directory containment is checked together. */
interface StorageLayout {
  readonly configPath: string;
  readonly rootDir: string;
  readonly publicDir: string;
  readonly outDir: string;
  readonly storageDir: string;
}

/**
 * Reject a `storageDir` that would expose or clobber build/source state. The
 * storage directory must not equal the project root, must not overlap the
 * public/out directories in either direction, and must not contain the config
 * module itself. Paths that exist on disk are resolved through `realpath` (the
 * same hardening as the public check) so a symlink cannot smuggle an overlap
 * past the lexical comparison.
 */
export function assertStorageIsolation(layout: StorageLayout): void {
  const rootDir = realOrLexical(layout.rootDir);
  const storageDir = realOrLexical(layout.storageDir);
  const configPath = realOrLexical(layout.configPath);

  if (storageDir === rootDir) {
    throw new AppConfigError('config.storage must not equal the project root');
  }
  const directories = [
    ['public', layout.publicDir],
    ['out', layout.outDir],
  ] as const;
  for (const [field, path] of directories) {
    const resolved = realOrLexical(path);
    if (isPathInside(storageDir, resolved) || isPathInside(resolved, storageDir)) {
      throw new AppConfigError(`config.storage must not overlap the ${field} directory`);
    }
  }
  if (isPathInside(storageDir, configPath)) {
    throw new AppConfigError('the app config must not live inside the storage directory');
  }
}
