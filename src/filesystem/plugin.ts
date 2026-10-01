/**
 * First-party `filesystem` plugin: exposes a {@link FileSystem} over a map of
 * named {@link Disk}s under a typed service token.
 *
 * `filesystemPlugin({ disks, default? })` builds a {@link JsailsPlugin} named
 * `filesystem` whose `setup` registers the service under {@link filesystemToken}.
 * A consumer calls `disk(name)` to select a configured disk by name, `disk()`
 * with no argument to use the configured default (or the sole disk), and
 * `names()` to list the configured names. Names are validated eagerly at plugin
 * construction: non-empty, unique (a plain object keyed by name), each value a
 * `Disk`, and `default` one of them.
 *
 * Cleanup is a no-op: a disk holds no open handles (files are opened and closed
 * per operation), so `setup` returns no teardown and the runner's `close`
 * remains idempotent.
 */

import { definePlugin, type JsailsPlugin } from '../extensions/plugin-contract.js';
import { createServiceToken, type ServiceToken } from '../extensions/services.js';
import type { Disk } from './disk.js';

/** The service the `filesystem` plugin provides: named disk lookup. */
export interface FileSystem {
  /** The configured disk by name, the default, or the sole disk. */
  disk(name?: string): Disk;
  /** The configured disk names, in declaration order. */
  names(): readonly string[];
}

/**
 * Opaque token for the {@link FileSystem}. Defined once here and shared by the
 * provider (`filesystemPlugin`) and any consumer (e.g. an extension's
 * `requires`).
 */
export const filesystemToken: ServiceToken<FileSystem> =
  createServiceToken<FileSystem>('filesystem');

/** Options accepted by {@link filesystemPlugin}. */
export interface FilesystemPluginOptions {
  /** The disks this plugin exposes, keyed by non-empty, unique names. */
  readonly disks: Readonly<Record<string, Disk>>;
  /** Name of the disk returned by `disk()` with no argument. */
  readonly default?: string;
}

/** True when `value` implements the {@link Disk} contract. */
function isDisk(value: unknown): value is Disk {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Partial<Disk>;
  return (
    typeof candidate.put === 'function' &&
    typeof candidate.get === 'function' &&
    typeof candidate.exists === 'function' &&
    typeof candidate.delete === 'function' &&
    typeof candidate.list === 'function' &&
    typeof candidate.size === 'function'
  );
}

/**
 * Build the first-party `filesystem` plugin. Validation is eager and throws
 * `TypeError` for malformed options; the returned plugin is otherwise inert.
 */
export function filesystemPlugin(options: FilesystemPluginOptions): JsailsPlugin {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('filesystemPlugin requires an options object');
  }
  if (options.disks === null || typeof options.disks !== 'object' || Array.isArray(options.disks)) {
    throw new TypeError('disks must be a map of named disks');
  }
  const disks = options.disks;
  const names = Object.keys(disks);
  if (names.length === 0) {
    throw new TypeError('filesystemPlugin requires at least one disk');
  }
  for (const name of names) {
    if (name.trim() === '') {
      throw new TypeError('disk names must be non-empty strings');
    }
    const disk = disks[name];
    if (!isDisk(disk)) {
      throw new TypeError(`disk "${name}" must implement the Disk contract`);
    }
  }
  if (options.default !== undefined) {
    if (typeof options.default !== 'string' || options.default.trim() === '') {
      throw new TypeError('default must be a configured disk name');
    }
    if (!(options.default in disks)) {
      throw new TypeError(`default disk "${options.default}" is not configured`);
    }
  }

  const defaultName = options.default;
  const lookup = (name: string): Disk => {
    const disk = disks[name];
    if (disk === undefined) {
      throw new Error(`filesystem has no disk named "${name}"`);
    }
    return disk;
  };

  return definePlugin({
    name: 'filesystem',
    setup({ services }) {
      const disk = (name?: string): Disk => {
        if (name !== undefined) {
          return lookup(name);
        }
        if (defaultName !== undefined) {
          return lookup(defaultName);
        }
        if (names.length === 1) {
          const sole = names[0];
          if (sole !== undefined) {
            return lookup(sole);
          }
        }
        throw new Error('filesystem requires a disk name or a configured default');
      };

      services.provide(filesystemToken, {
        disk,
        names: () => [...names],
      });
    },
  });
}
