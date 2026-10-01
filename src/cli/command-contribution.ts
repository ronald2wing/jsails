/**
 * Config-agnostic command contribution index (T3.3 foundation).
 *
 * A {@link CommandContribution} is a pure, lazy descriptor that a plugin exposes
 * through its static {@link PluginDescription}. This module builds a validated
 * index over a set of contributions, rejecting duplicates and reserved names
 * before any command module is imported. The index is read-only: `list()` and
 * `has()` never call a `load()` thunk, and resolution is explicit via
 * {@link CommandContributionIndex.resolve}.
 *
 * The builder is pure — it imports no config, opens no connection, and invokes
 * no thunk. This is the core invariant that makes config-agnostic command
 * listing possible.
 */

import {
  COMMAND_NAME_PATTERN,
  DEFAULT_RESERVED_COMMAND_NAMES,
  type CliCommand,
} from './command-registry.js';
import type { CommandConfigType, CommandContribution } from '../extensions/plugin-contract.js';

/**
 * Error codes for command-contribution validation. Every error is value-free:
 * messages name only the offending field or the already-validated command name,
 * never a raw input value.
 */
export type CommandContributionErrorCode =
  | 'invalid_name'
  | 'invalid_summary'
  | 'invalid_audience'
  | 'invalid_config'
  | 'duplicate_name'
  | 'reserved_name'
  | 'unknown_command'
  | 'load_failed';

/**
 * Raised for every command-contribution invariant. Messages never echo a raw
 * input value; structured detail lives on the `code` and optional
 * `commandName` fields.
 */
export class CommandContributionError extends Error {
  readonly code: CommandContributionErrorCode;
  readonly commandName: string | undefined;

  constructor(code: CommandContributionErrorCode, message: string, commandName?: string) {
    super(message);
    this.name = 'CommandContributionError';
    this.code = code;
    this.commandName = commandName;
  }
}

/** Options for {@link buildCommandContributionIndex}. */
export interface BuildCommandContributionIndexOptions {
  /**
   * Extra names the index must reject. Merged with
   * {@link DEFAULT_RESERVED_COMMAND_NAMES}, so builtins can never be shadowed
   * even when the caller forgets to list them.
   */
  readonly reservedNames?: readonly string[];
}

/**
 * A validated, read-mostly view over a set of command contributions. Every
 * method is synchronous except {@link CommandContributionIndex.resolve}, which
 * calls a single contribution's `load()` thunk on demand.
 */
export interface CommandContributionIndex {
  /** Serializable descriptors in input order; `load()` is never called. */
  list(): readonly CommandContribution[];
  /** The contribution descriptor, or `undefined`. `load()` is never called. */
  get(name: string): CommandContribution | undefined;
  /** Whether a contribution is registered under `name`. */
  has(name: string): boolean;
  /**
   * Resolve one contribution into a live {@link CliCommand} by calling its
   * `load()` thunk. Rejects with a {@link CommandContributionError} when the
   * name is unknown or the thunk fails (code: `load_failed`, with a value-free
   * message — the underlying cause is never echoed).
   */
  resolve(name: string): Promise<CliCommand>;
}

/** Valid config-type values accepted on a contribution. */
const VALID_CONFIG_TYPES: ReadonlySet<CommandConfigType> = new Set([
  'app',
  'migration',
  'runtime',
  'seed',
  'none',
]);

/** Read one property, converting a throwing (possibly malicious) getter. */
function readField(target: object, key: string, field: string): unknown {
  try {
    return (target as Record<string, unknown>)[key];
  } catch {
    throw new CommandContributionError('invalid_name', `failed to read ${field}`);
  }
}

/** Validate a single contribution descriptor without calling its `load()` thunk. */
function validateContribution(contribution: CommandContribution, label: string): void {
  if (contribution === null || typeof contribution !== 'object' || Array.isArray(contribution)) {
    throw new CommandContributionError(
      'invalid_name',
      `${label} must be a command contribution object`,
    );
  }

  const name = readField(contribution, 'name', `${label}.name`);
  if (typeof name !== 'string' || !COMMAND_NAME_PATTERN.test(name)) {
    throw new CommandContributionError(
      'invalid_name',
      `${label}.name must be a valid command name`,
      String(name),
    );
  }

  const summary = readField(contribution, 'summary', `${label}.summary`);
  if (typeof summary !== 'string' || summary.trim() === '') {
    throw new CommandContributionError(
      'invalid_summary',
      `${label}.summary must be a non-empty string`,
      String(name),
    );
  }

  const audience = readField(contribution, 'audience', `${label}.audience`);
  if (audience !== 'developer' && audience !== 'user') {
    throw new CommandContributionError(
      'invalid_audience',
      `${label}.audience must be "developer" or "user"`,
      String(name),
    );
  }

  const config = readField(contribution, 'config', `${label}.config`);
  if (!VALID_CONFIG_TYPES.has(config as CommandConfigType)) {
    throw new CommandContributionError(
      'invalid_config',
      `${label}.config must be one of: app, migration, runtime, seed, none`,
      String(name),
    );
  }

  const load = readField(contribution, 'load', `${label}.load`);
  if (typeof load !== 'function') {
    throw new CommandContributionError(
      'invalid_config',
      `${label}.load must be a function`,
      String(name),
    );
  }

  const usage = readField(contribution, 'usage', `${label}.usage`);
  if (usage !== undefined && typeof usage !== 'string') {
    throw new CommandContributionError(
      'invalid_config',
      `${label}.usage must be a string`,
      String(name),
    );
  }
}

/**
 * Build a validated index over `contributions`. Validation runs synchronously
 * before the index is returned: invalid names, missing summaries, bad
 * audiences, unknown config types, duplicate names, and reserved names are all
 * rejected up front. No `load()` thunk is called — laziness is the core
 * invariant.
 */
export function buildCommandContributionIndex(
  contributions: readonly CommandContribution[],
  options: BuildCommandContributionIndexOptions = {},
): CommandContributionIndex {
  if (!Array.isArray(contributions)) {
    throw new CommandContributionError('invalid_config', 'contributions must be an array');
  }

  const reserved = new Set<string>(DEFAULT_RESERVED_COMMAND_NAMES);
  if (options.reservedNames !== undefined) {
    if (!Array.isArray(options.reservedNames)) {
      throw new CommandContributionError(
        'invalid_config',
        'reservedNames must be an array of names',
      );
    }
    for (const name of options.reservedNames) {
      if (typeof name !== 'string' || name.trim() === '') {
        throw new CommandContributionError(
          'invalid_config',
          'reservedNames entries must be non-empty strings',
        );
      }
      reserved.add(name);
    }
  }

  const map = new Map<string, CommandContribution>();
  const order: string[] = [];

  contributions.forEach((contribution, index) => {
    validateContribution(contribution, `contributions[${index}]`);
    const { name } = contribution;

    if (reserved.has(name)) {
      throw new CommandContributionError(
        'reserved_name',
        `command name "${name}" is reserved`,
        name,
      );
    }
    if (map.has(name)) {
      throw new CommandContributionError(
        'duplicate_name',
        `duplicate command name "${name}"`,
        name,
      );
    }

    map.set(name, contribution);
    order.push(name);
  });

  return {
    list(): readonly CommandContribution[] {
      return order.map((name) => map.get(name)!);
    },
    get(name: string): CommandContribution | undefined {
      return map.get(name);
    },
    has(name: string): boolean {
      return map.has(name);
    },
    async resolve(name: string): Promise<CliCommand> {
      const contribution = map.get(name);
      if (contribution === undefined) {
        throw new CommandContributionError('unknown_command', `unknown command "${name}"`, name);
      }
      try {
        return await contribution.load();
      } catch {
        throw new CommandContributionError('load_failed', `failed to load command "${name}"`, name);
      }
    },
  };
}
