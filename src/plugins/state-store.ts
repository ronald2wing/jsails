/**
 * Plugin installer state: the persisted record of which plugin version is
 * active for each installed plugin id.
 *
 * `PluginStateStore` reads and writes a single `<pluginsDir>/state.json` file
 * atomically: a write lands in a sibling `.tmp` file and is `rename`d over the
 * destination, so a reader never observes a partially written document. The
 * file shape is a strict Zod schema — `{ version: 1, plugins: { [id]:
 * { active: string, enabled: boolean, settings?: object } } }` — and every
 * plugin id is validated
 * against {@link PLUGIN_ID_PATTERN} while every `active` version is validated as
 * semantic version. A missing file loads as empty state; a malformed file is
 * rejected. All failures raise a value-free {@link PluginStateError}: ids that
 * fail validation, raw version strings, and file contents are never echoed.
 */

import {
  mkdirSync as fsMkdirSync,
  readFileSync as fsReadFileSync,
  renameSync as fsRenameSync,
  writeFileSync as fsWriteFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import { isErrno } from '../internal/errors.js';
import { mapZodIssues } from '../internal/zod.js';
import { isValidSemverVersion, PLUGIN_ID_PATTERN } from './manifest.js';

/** The state filename under the plugins directory. */
export const PLUGIN_STATE_FILENAME = 'state.json';

/** The single supported state-file format version. */
export const PLUGIN_STATE_VERSION = 1;

/** Upper bound on the number of plugins a state file may record. */
const MAX_STATE_PLUGINS = 1000;

/** Upper bound on an `active` version string length. */
const MAX_ACTIVE_VERSION_LENGTH = 256;

/** The persisted record for a single plugin id. */
export interface PluginStateEntry {
  /** The active plugin version (valid semver). */
  readonly active: string;
  /** Whether the plugin is enabled. */
  readonly enabled: boolean;
  /** Plugin settings (a JSON-safe object); absent when unset. */
  readonly settings?: Record<string, unknown>;
}

/** The parsed plugin state document. */
export interface PluginState {
  /** Format version; always {@link PLUGIN_STATE_VERSION}. */
  readonly version: typeof PLUGIN_STATE_VERSION;
  /** Active version and enabled flag per plugin id. */
  readonly plugins: Readonly<Record<string, PluginStateEntry>>;
}

/** Raised for a missing/unreadable/malformed state file or an invalid write. */
export class PluginStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginStateError';
  }
}

/**
 * The persistence surface both state stores satisfy. `PluginStateStore` reads
 * and writes the JSON document synchronously, while the database-backed store
 * (`createDatabasePluginStateStore`) is asynchronous; the return types are a
 * `T | Promise<T>` union so either implementation satisfies this interface
 * structurally without changing the JSON store's existing synchronous callers.
 */
export interface PluginStateSource {
  /** Load the current plugin state. */
  load(): PluginState | Promise<PluginState>;
  /** Persist a validated plugin state. */
  save(state: PluginState): void | Promise<void>;
}

/**
 * The strict state schema. Unknown top-level and per-plugin fields are rejected
 * rather than silently ignored; plugin ids and `active` versions are validated
 * in {@link parsePluginState} so their failures stay value-free.
 */
export const pluginStateSchema = z
  .object({
    version: z.literal(PLUGIN_STATE_VERSION),
    plugins: z.record(
      z.string(),
      z
        .object({
          active: z.string().min(1).max(MAX_ACTIVE_VERSION_LENGTH),
          enabled: z.boolean(),
          settings: z.record(z.string(), z.unknown()).optional(),
        })
        .strict(),
    ),
  })
  .strict();

/** The synchronous filesystem surface the store uses (injectable for tests). */
export interface PluginStateFs {
  /** Read a file as UTF-8; throws an errno-style error with a `code` on failure. */
  readFileSync(path: string): string;
  /** Write a file; throws an errno-style error on failure. */
  writeFileSync(path: string, data: string): void;
  /** Rename a file over its destination (atomic within one filesystem). */
  renameSync(from: string, to: string): void;
  /** Create a directory (and parents) if missing. */
  mkdirSync(path: string): void;
}

const defaultStateFs: PluginStateFs = {
  readFileSync: (path) => fsReadFileSync(path, 'utf8'),
  writeFileSync: (path, data) => fsWriteFileSync(path, data),
  renameSync: (from, to) => fsRenameSync(from, to),
  mkdirSync: (path) => fsMkdirSync(path, { recursive: true }),
};

/** Options for {@link PluginStateStore}. */
export interface PluginStateStoreOptions {
  /** Directory holding `state.json`. */
  readonly pluginsDir: string;
  /** Injectable fs facade (tests); defaults to `node:fs`. */
  readonly fs?: PluginStateFs;
}

/**
 * Read and write `<pluginsDir>/state.json` atomically. See the module doc for
 * the exact contract.
 */
export class PluginStateStore implements PluginStateSource {
  private readonly pluginsDir: string;
  private readonly statePath: string;
  private readonly fs: PluginStateFs;

  constructor(options: PluginStateStoreOptions) {
    this.pluginsDir = options.pluginsDir;
    this.statePath = join(options.pluginsDir, PLUGIN_STATE_FILENAME);
    this.fs = options.fs ?? defaultStateFs;
  }

  /** Load the current state; a missing file yields empty state. */
  load(): PluginState {
    let raw: string;
    try {
      raw = this.fs.readFileSync(this.statePath);
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return emptyState();
      throw new PluginStateError('plugin state could not be read');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new PluginStateError('plugin state is not valid JSON');
    }
    return parsePluginState(parsed);
  }

  /** Validate `state` and atomically write it (temp file + rename). */
  save(state: PluginState): void {
    const normalized = parsePluginState(state);
    const json = `${JSON.stringify(normalized, null, 2)}\n`;
    this.fs.mkdirSync(this.pluginsDir);
    const tempPath = `${this.statePath}.tmp`;
    this.fs.writeFileSync(tempPath, json);
    this.fs.renameSync(tempPath, this.statePath);
  }
}

/** Validate a raw value into a {@link PluginState}, throwing value-free errors. */
function parsePluginState(raw: unknown): PluginState {
  const result = pluginStateSchema.safeParse(raw);
  if (!result.success) {
    throw new PluginStateError(formatStateIssues(result.error));
  }
  const data = result.data;
  const ids = Object.keys(data.plugins);
  if (ids.length > MAX_STATE_PLUGINS) {
    throw new PluginStateError('plugin state contains too many plugins');
  }
  for (const id of ids) {
    if (!PLUGIN_ID_PATTERN.test(id)) {
      throw new PluginStateError('plugin state contains an invalid plugin id');
    }
    if (!isValidSemverVersion(data.plugins[id]!.active)) {
      throw new PluginStateError('plugin state contains an invalid active version');
    }
  }
  return data;
}

/** The field names a state document can carry (used to drop dynamic keys). */
const STATE_FIELD_NAMES = new Set(['version', 'plugins', 'active', 'enabled', 'settings']);

/** Join value-free issue descriptions; no input value is ever echoed. */
function formatStateIssues(error: z.ZodError): string {
  return error.issues.map(mapStateIssue).join('; ');
}

function mapStateIssue(zodIssue: z.ZodIssue): string {
  // The canonical mapper owns the per-issue wording; the path is sanitized
  // locally because a plugin id is a dynamic record key that must never be
  // echoed. `mapZodIssues` is called with a single issue so its message can be
  // reused without adopting its unsanitized path.
  const message = mapZodIssues([zodIssue])[0]?.message ?? 'invalid value';
  const location = sanitizePath(zodIssue.path).join('.');
  const prefix = location === '' ? 'plugin state' : location;
  return `${prefix}: ${message}`;
}

/** Drop dynamic record keys from a Zod path so no input-provided id is echoed. */
function sanitizePath(path: readonly PropertyKey[]): readonly (string | number)[] {
  return path.filter(
    (segment): segment is string | number =>
      typeof segment === 'number' ||
      (typeof segment === 'string' && STATE_FIELD_NAMES.has(segment)),
  );
}

/** A fresh, empty state document. */
function emptyState(): PluginState {
  return { version: PLUGIN_STATE_VERSION, plugins: {} };
}
