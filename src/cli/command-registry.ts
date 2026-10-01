/**
 * User-defined CLI command foundation.
 *
 * Built-in commands (`makemigrations`, `migrate`, `showmigrations`, `work`,
 * `schedule`, `build`, `serve`) stay owned by the central CLI. This module lets
 * an application and its extensions declare *additional* commands without
 * touching the entry point:
 *
 * - {@link collectConfigCommands} reads `app.commands` and
 *   `extensions[].commands` structurally from a raw config object. It never
 *   imports the config, calls an extension `setup`, or invokes a command
 *   handler; it only reads metadata and command references.
 * - {@link createCliCommandRegistry} validates the collected commands (name,
 *   summary, run function), enforces a single namespace across app- and
 *   extension-declared commands, refuses reserved/builtin names, and exposes
 *   serializable metadata plus an async executor.
 *
 * The module is pure: it imports nothing, writes no globals, and holds no
 * filesystem or config concerns. The caller owns `--help` handling and passes
 * the working directory, config path, and output sinks through
 * {@link CliCommandContext}. Raw argument tokens (including unknown flags) are
 * passed through untouched so each command parses its own options.
 */

/**
 * Which users a command is surfaced to. Developer-only commands are hidden from
 * end users; `user` commands are part of the public command surface.
 */
export type CommandAudience = 'developer' | 'user';

/** The runtime surface handed to a command handler. */
export interface CliCommandContext {
  /** Path of the config module the command was loaded from. */
  readonly configPath: string;
  /** Working directory the command should resolve relative paths against. */
  readonly cwd: string;
  /** Write a line to standard output. */
  stdout(text: string): void;
  /** Write a line to standard error. */
  stderr(text: string): void;
}

/**
 * A user-declared CLI command.
 *
 * `run` stays on the object (never destructured or rebound) so a class-instance
 * command keeps its own `this`. It may return nothing (treated as exit code 0),
 * a number in `0..255`, or a promise of either.
 */
export interface CliCommand {
  /** Unique, non-empty command name matching {@link COMMAND_NAME_PATTERN}. */
  readonly name: string;
  /** One-line description shown in help output. Must be non-empty. */
  readonly summary: string;
  /** Optional usage string; carried through verbatim. */
  readonly usage?: string;
  /**
   * Which users this command targets. Optional on the declaration; the registry
   * resolves it against a `defaultAudience` when producing metadata.
   */
  readonly audience?: CommandAudience;
  run(rawArgs: readonly string[], ctx: CliCommandContext): number | void | Promise<number | void>;
}

/** Serializable command metadata; never carries a function reference. */
export interface CliCommandMetadata {
  readonly name: string;
  readonly summary: string;
  readonly usage?: string;
  /** Resolved audience (explicit value or the registry default). */
  readonly audience?: CommandAudience;
}

/** Machine-readable failure reason for {@link CliCommandError}. */
export type CliCommandErrorCode =
  | 'invalid_config'
  | 'invalid_command'
  | 'invalid_name'
  | 'duplicate_name'
  | 'reserved_name'
  | 'unknown_command'
  | 'invalid_audience'
  | 'invalid_exit_code';

/**
 * Raised for every command-registry invariant. Messages name the offending
 * *field* or the already-validated command name, never a raw config value:
 * config modules are trusted app code and a getter may throw an exception whose
 * text embeds a credential.
 */
export class CliCommandError extends Error {
  readonly code: CliCommandErrorCode;
  /** The command name a violation refers to, when one is known and safe. */
  readonly commandName: string | undefined;

  constructor(code: CliCommandErrorCode, message: string, commandName?: string) {
    super(message);
    this.name = 'CliCommandError';
    this.code = code;
    this.commandName = commandName;
  }
}

/** Options for {@link createCliCommandRegistry}. */
export interface CliCommandRegistryOptions {
  /**
   * Extra names that user commands must not claim. Merged with
   * {@link DEFAULT_RESERVED_COMMAND_NAMES}, so builtins can never be shadowed
   * even when the caller forgets to list them.
   */
  readonly reservedNames?: readonly string[];
  /**
   * Audience assigned to commands that do not declare an explicit `audience`.
   * Defaults to `'developer'`; a command's own `audience` always wins.
   */
  readonly defaultAudience?: CommandAudience;
}

/** A validated, read-mostly view over a set of user commands. */
export interface CliCommandRegistry {
  /** Serializable metadata in declaration order; no function references. */
  list(): readonly CliCommandMetadata[];
  /** The original command object (keeping method `this`), or `undefined`. */
  get(name: string): CliCommand | undefined;
  /** Whether a runnable command is registered under `name`. */
  has(name: string): boolean;
  /**
   * Invoke the command with raw argument tokens. Resolves to a validated exit
   * code in `0..255`; a `void` return is treated as `0`. Rejects with a
   * {@link CliCommandError} for an unknown command or an out-of-range/non-number
   * return value — truthy values are never silently coerced.
   */
  run(name: string, args: readonly string[], ctx: CliCommandContext): Promise<number>;
}

/**
 * Command names accepted by the registry: a letter followed by letters, digits,
 * `:`, `_`, or `-`. Rejects empty/whitespace names and flag-like `-` prefixes.
 */
export const COMMAND_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9:_-]*$/;

/**
 * Names the central CLI owns. They are always reserved so a user-declared
 * command can never shadow a builtin.
 */
export const DEFAULT_RESERVED_COMMAND_NAMES: readonly string[] = Object.freeze([
  'makemigrations',
  'migrate',
  'showmigrations',
  'work',
  'schedule',
  'build',
  'serve',
  'seed',
  'queue',
  'schedules',
  'make:page',
  'make:api',
  'make:job',
  'make:model',
  'make:command',
  'make:server-component',
  'make:serializer',
  'make:middleware',
  'create',
  'dev',
  'jamal',
  'plugins',
  'inspect',
  'describe',
  'explain',
]);

/**
 * A command whose metadata was read during one normalization pass, with `this`
 * intact. The same command may be normalized again in a later pass (collection
 * and registry validation are separate passes); nothing is cached across them.
 */
interface NormalizedCommand {
  readonly command: CliCommand;
  readonly metadata: CliCommandMetadata;
}

/** Read one property, converting a throwing (possibly malicious) getter. */
function readField(target: object, key: string, field: string): unknown {
  try {
    return (target as Record<string, unknown>)[key];
  } catch {
    throw new CliCommandError('invalid_config', `failed to read ${field}`);
  }
}

/**
 * Resolve an audience value against a default. An explicit `'developer'` or
 * `'user'` wins; `undefined` falls back to the default; anything else rejects
 * with a value-free error (the offending value is never echoed).
 */
function resolveAudience(
  value: unknown,
  defaultAudience: CommandAudience,
  field: string,
): CommandAudience {
  if (value === undefined) {
    return defaultAudience;
  }
  if (value !== 'developer' && value !== 'user') {
    throw new CliCommandError('invalid_audience', `${field} must be "developer" or "user"`);
  }
  return value;
}

/**
 * Validate one command object without cloning it. Each field is read once per
 * normalization pass via a normal property access, so accessor-backed commands
 * keep their `this`; nothing on the object is invoked. Normalization runs once
 * per pass (collection and registry validation are separate passes), so the
 * same command's fields may be read again in a later pass — no identity or
 * metadata is cached.
 */
function normalizeCommand(
  value: unknown,
  field: string,
  defaultAudience: CommandAudience = 'developer',
): NormalizedCommand {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new CliCommandError('invalid_command', `${field} must be a command object`);
  }
  const name = readField(value, 'name', `${field}.name`);
  if (typeof name !== 'string' || !COMMAND_NAME_PATTERN.test(name)) {
    throw new CliCommandError('invalid_name', `${field}.name must be a valid command name`);
  }
  const summary = readField(value, 'summary', `${field}.summary`);
  if (typeof summary !== 'string' || summary.trim() === '') {
    throw new CliCommandError(
      'invalid_command',
      `${field}.summary must be a non-empty string`,
      name,
    );
  }
  const usage = readField(value, 'usage', `${field}.usage`);
  if (usage !== undefined && typeof usage !== 'string') {
    throw new CliCommandError('invalid_command', `${field}.usage must be a string`, name);
  }
  const audience = resolveAudience(
    readField(value, 'audience', `${field}.audience`),
    defaultAudience,
    `${field}.audience`,
  );
  const run = readField(value, 'run', `${field}.run`);
  if (typeof run !== 'function') {
    throw new CliCommandError('invalid_command', `${field}.run must be a function`, name);
  }

  const metadata: CliCommandMetadata =
    usage === undefined
      ? Object.freeze({ name, summary, audience })
      : Object.freeze({ name, summary, audience, usage });
  return { command: value as unknown as CliCommand, metadata };
}

/**
 * Validate and normalize a command return value. `void` maps to `0`; a number
 * must be an integer in `0..255`. Anything else rejects rather than being
 * coerced, so a truthy non-number cannot become a silent success.
 */
function normalizeExitCode(name: string, value: unknown): number {
  if (value === undefined) {
    return 0;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 255) {
    throw new CliCommandError(
      'invalid_exit_code',
      `command "${name}" returned an invalid exit code`,
      name,
    );
  }
  return value === 0 ? 0 : value;
}

/**
 * Build a registry over `commands`. All validation runs synchronously before
 * the registry is returned: nothing is invoked, so a malformed list has no side
 * effects. Duplicate names, reserved names, and invalid names/run/summary are
 * rejected up front.
 */
export function createCliCommandRegistry(
  commands: readonly CliCommand[],
  options: CliCommandRegistryOptions = {},
): CliCommandRegistry {
  if (!Array.isArray(commands)) {
    throw new CliCommandError('invalid_command', 'commands must be an array');
  }

  const defaultAudience = resolveAudience(options.defaultAudience, 'developer', 'defaultAudience');

  const reserved = new Set<string>(DEFAULT_RESERVED_COMMAND_NAMES);
  if (options.reservedNames !== undefined) {
    if (!Array.isArray(options.reservedNames)) {
      throw new CliCommandError('invalid_config', 'reservedNames must be an array of names');
    }
    for (const name of options.reservedNames) {
      if (typeof name !== 'string' || name.trim() === '') {
        throw new CliCommandError(
          'invalid_config',
          'reservedNames entries must be non-empty strings',
        );
      }
      reserved.add(name);
    }
  }

  const entries = new Map<string, NormalizedCommand>();
  const order: string[] = [];

  commands.forEach((value, index) => {
    const normalized = normalizeCommand(value, `commands[${index}]`, defaultAudience);
    const { name } = normalized.metadata;
    if (reserved.has(name)) {
      throw new CliCommandError('reserved_name', `command name "${name}" is reserved`, name);
    }
    if (entries.has(name)) {
      throw new CliCommandError('duplicate_name', `duplicate command name "${name}"`, name);
    }
    entries.set(name, normalized);
    order.push(name);
  });

  return {
    list(): readonly CliCommandMetadata[] {
      return order.map((name) => {
        const entry = entries.get(name);
        if (entry === undefined) {
          // Unreachable: `order` is only appended alongside an entry.
          throw new CliCommandError('unknown_command', `unknown command "${name}"`, name);
        }
        return entry.metadata;
      });
    },
    get(name: string): CliCommand | undefined {
      return entries.get(name)?.command;
    },
    has(name: string): boolean {
      return entries.has(name);
    },
    async run(name: string, args: readonly string[], ctx: CliCommandContext): Promise<number> {
      const entry = entries.get(name);
      if (entry === undefined) {
        throw new CliCommandError('unknown_command', `unknown command "${name}"`, name);
      }
      if (!Array.isArray(args)) {
        throw new CliCommandError('invalid_command', 'arguments must be an array', name);
      }
      // Property call keeps `this` bound to the command object for methods.
      const result = await entry.command.run(args, ctx);
      return normalizeExitCode(entry.metadata.name, result);
    },
  };
}

/**
 * Collect user commands declared on an app config and its extensions, without
 * importing the config, running an extension `setup`, or invoking a handler.
 *
 * The accepted structural shape is:
 *
 * ```ts
 * { commands?: CliCommand[]; extensions?: Array<{ commands?: CliCommand[] }> }
 * ```
 *
 * App-level commands come first, then each extension's commands in declaration
 * order, flattened into one list so {@link createCliCommandRegistry} can apply a
 * single namespace across both sources. Unknown fields are ignored and no value
 * is echoed in an error.
 */
export function collectConfigCommands(rawConfig: unknown): readonly CliCommand[] {
  if (rawConfig === null || typeof rawConfig !== 'object' || Array.isArray(rawConfig)) {
    throw new CliCommandError('invalid_config', 'the config must be an object');
  }

  const commands: CliCommand[] = [];

  const appCommands = readField(rawConfig, 'commands', 'config.commands');
  if (appCommands !== undefined) {
    if (!Array.isArray(appCommands)) {
      throw new CliCommandError('invalid_config', 'config.commands must be an array');
    }
    appCommands.forEach((entry, index) => {
      commands.push(normalizeCommand(entry, `config.commands[${index}]`).command);
    });
  }

  const extensions = readField(rawConfig, 'extensions', 'config.extensions');
  if (extensions !== undefined) {
    if (!Array.isArray(extensions)) {
      throw new CliCommandError('invalid_config', 'config.extensions must be an array');
    }
    extensions.forEach((extension, index) => {
      if (extension === null || typeof extension !== 'object' || Array.isArray(extension)) {
        throw new CliCommandError(
          'invalid_config',
          `config.extensions[${index}] must be an object`,
        );
      }
      const extensionCommands = readField(
        extension,
        'commands',
        `config.extensions[${index}].commands`,
      );
      if (extensionCommands === undefined) {
        return;
      }
      if (!Array.isArray(extensionCommands)) {
        throw new CliCommandError(
          'invalid_config',
          `config.extensions[${index}].commands must be an array`,
        );
      }
      extensionCommands.forEach((entry, commandIndex) => {
        commands.push(
          normalizeCommand(entry, `config.extensions[${index}].commands[${commandIndex}]`).command,
        );
      });
    });
  }

  return commands;
}
