/**
 * Compiled command discovery.
 *
 * `discoverAppCommands(dir)` walks `dir/commands` for compiled `*.js` / `*.mjs`
 * modules, imports each, and returns their default exports as validated
 * {@link CliCommand}s in deterministic lexical order. It never imports an app
 * config module, never reads `.ts` sources, and never follows symlinks. A
 * module that does not default-export a structurally valid command is rejected
 * with a clear {@link CommandDiscoveryError} naming the offending file.
 *
 * The module imports command files eagerly (inherent to dynamic `import`), so a
 * command module's top-level side effects run at discovery time. This is the
 * same trust boundary as config modules: command files are app code.
 */

import { readdirSync, type Dirent } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { COMMAND_NAME_PATTERN, type CliCommand, type CommandAudience } from './commands.js';

/** Raised when a discovered command module fails to load or is malformed. */
export class CommandDiscoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommandDiscoveryError';
  }
}

/** Options for {@link discoverAppCommands}. */
export interface DiscoverAppCommandsOptions {
  /**
   * Audience applied to discovered commands that do not declare an explicit
   * `audience`. Defaults to `'user'`; a command's own `audience` always wins.
   */
  readonly defaultAudience?: CommandAudience;
}

/** The default audience for discovered commands (user-facing surface). */
const DEFAULT_DISCOVERED_AUDIENCE: CommandAudience = 'user';

/** Resolve the discovery `defaultAudience` option without echoing a bad value. */
function resolveDiscoveryDefaultAudience(value: unknown): CommandAudience {
  if (value === undefined) {
    return DEFAULT_DISCOVERED_AUDIENCE;
  }
  if (value !== 'developer' && value !== 'user') {
    throw new CommandDiscoveryError('defaultAudience must be "developer" or "user"');
  }
  return value;
}

/** Extensions accepted as compiled command modules. */
const COMMAND_EXTENSIONS = new Set(['.js', '.mjs']);

/**
 * Discover compiled command modules under `dir/commands`, returning their
 * validated default exports in lexical order. `dir` is always a base directory
 * that contains a `commands` folder; a missing `commands` directory yields no
 * commands.
 */
export async function discoverAppCommands(
  dir: string = process.cwd(),
  options: DiscoverAppCommandsOptions = {},
): Promise<CliCommand[]> {
  const defaultAudience = resolveDiscoveryDefaultAudience(options.defaultAudience);
  const commandsDir = resolve(dir, 'commands');
  const commands: CliCommand[] = [];
  for (const relative of collectCommandFiles(commandsDir)) {
    const absolute = join(commandsDir, relative);
    commands.push(await importCommand(absolute, relative, defaultAudience));
  }
  return commands;
}

/** Recursively collect compiled command module paths (posix-separated), sorted. */
function collectCommandFiles(dir: string): string[] {
  const results: string[] = [];
  walk(dir, '');
  return results;

  function walk(current: string, prefix: string): void {
    let dirents: Dirent[];
    try {
      dirents = readdirSync(current, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
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
      if (!dirent.isFile() || !COMMAND_EXTENSIONS.has(extname(dirent.name))) {
        continue;
      }
      results.push(relative);
    }
  }
}

/** Import one compiled command module and validate its default export. */
async function importCommand(
  absolute: string,
  relative: string,
  defaultAudience: CommandAudience,
): Promise<CliCommand> {
  let module: unknown;
  try {
    module = await import(pathToFileURL(absolute).href);
  } catch {
    throw new CommandDiscoveryError(`failed to load command module "${relative}"`);
  }
  const defaultExport = (module as { default?: unknown }).default;
  if (defaultExport === undefined) {
    throw new CommandDiscoveryError(
      `command module "${relative}" must default-export a CliCommand`,
    );
  }
  return validateCommand(defaultExport, relative, defaultAudience);
}

/** Structural validation mirroring the registry: name, summary, run, audience. */
function validateCommand(
  value: unknown,
  relative: string,
  defaultAudience: CommandAudience,
): CliCommand {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new CommandDiscoveryError(
      `command module "${relative}" default export must be a CliCommand object`,
    );
  }
  const record = value as Record<string, unknown>;
  const name = record['name'];
  if (typeof name !== 'string' || !COMMAND_NAME_PATTERN.test(name)) {
    throw new CommandDiscoveryError(`command module "${relative}" has an invalid "name"`);
  }
  const summary = record['summary'];
  if (typeof summary !== 'string' || summary.trim() === '') {
    throw new CommandDiscoveryError(
      `command module "${relative}" must declare a non-empty "summary"`,
    );
  }
  const run = record['run'];
  if (typeof run !== 'function') {
    throw new CommandDiscoveryError(`command module "${relative}" must declare a "run" function`);
  }
  const audience = record['audience'];
  if (audience !== undefined && audience !== 'developer' && audience !== 'user') {
    throw new CommandDiscoveryError(`command module "${relative}" has an invalid "audience"`);
  }
  if (audience !== undefined) {
    return value as CliCommand;
  }
  // Materialize the default audience onto a command that did not declare one,
  // so the shared registry (whose own default is `developer`) preserves the
  // user-facing default that discovery imposes.
  return withDefaultAudience(value as CliCommand, defaultAudience);
}

/**
 * Return a shallow wrapper carrying an explicit `audience`, preserving the
 * command's prototype (so a class-instance `run` keeps its method) and its own
 * enumerable fields, without mutating the imported module's export.
 */
function withDefaultAudience(command: CliCommand, audience: CommandAudience): CliCommand {
  return Object.assign(Object.create(Object.getPrototypeOf(command) ?? Object.prototype), command, {
    audience,
  });
}

/** Code-unit string comparison; locale-independent for deterministic order. */
function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
