/**
 * Sail-like Docker Compose execution for jamal.
 *
 * The `dev` set that `jamal dev --write` materializes is a local Docker
 * Compose project (`docker-compose.yml` plus the `docker-compose.database.yml`
 * addon, both bound to the shared `jsails` network). The four execution verbs
 * here — `up`, `down`, `ps`, `logs` — drive that project with plain
 * `docker compose` subcommands, exactly as Laravel Sail does for its local
 * stack. They are the one place jamal spawns a process: the generation
 * commands (`dev`/`deploy`/`targets`) never reach this module.
 *
 * Commands are assembled as fixed argv arrays (never shell-interpolated) and
 * run with the working directory set to the project root (or the `--dir`
 * override). `up` is detached by default (Sail's `up -d` convenience). No
 * service other than the compose project is required or started, and nothing
 * here writes files or touches a network beyond the local Docker socket.
 */

import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

/** The compose file `jamal dev --write` generates and `docker compose` auto-detects. */
export const COMPOSE_FILENAME = 'docker-compose.yml';

/** The four Sail-like execution verbs, in declaration order for help output. */
export const DOCKER_VERBS = ['up', 'down', 'ps', 'logs'] as const;

/** A valid execution verb. */
export type DockerVerb = (typeof DOCKER_VERBS)[number];

/** `true` when `value` names an execution verb. */
export function isDockerVerb(value: string): value is DockerVerb {
  return (DOCKER_VERBS as readonly string[]).includes(value);
}

/** Outcome of one spawned command: its exit code plus captured output. */
export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Run a fixed argv array in `options.cwd`. The dependency seam the jamal
 * command injects for tests; the default streams stdio to the parent process.
 */
export type CommandRunner = (
  argv: readonly string[],
  options: { cwd: string },
) => Promise<CommandResult>;

/**
 * Default runner: spawn the command with inherited stdio so `logs --follow`
 * streams in real time (no buffering), resolving with the exit code once the
 * process exits. A missing binary rejects with an `ENOENT` error; the caller
 * maps that to the "docker compose is unavailable" human error.
 */
export const defaultCommandRunner: CommandRunner = (argv, options) =>
  new Promise<CommandResult>((resolve, reject) => {
    const command = argv[0];
    if (command === undefined) {
      reject(new Error('empty command argv'));
      return;
    }
    const spawnOptions: SpawnOptions = { cwd: options.cwd, stdio: 'inherit' };
    const child: ChildProcess = spawn(command, argv.slice(1), spawnOptions);
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      resolve({ exitCode: code ?? (signal === null ? 0 : 1), stdout: '', stderr: '' });
    });
  });

/** Flags and positionals that shape a compose argv for one verb. */
export interface ComposeArgvOptions {
  /** Follow log output (`logs` only). */
  readonly follow?: boolean;
  /** Service name to scope to (`logs` only). */
  readonly service?: string;
}

/**
 * Assemble the fixed `docker compose` argv for a verb. `up` always appends
 * `-d` (detached is the default, mirroring Sail's `up -d`); `logs` appends
 * `--follow` and/or the single service name when given. No shell
 * interpolation is performed — the result is a plain argument array.
 */
export function composeArgv(verb: DockerVerb, options: ComposeArgvOptions = {}): readonly string[] {
  switch (verb) {
    case 'up':
      return ['docker', 'compose', 'up', '-d'];
    case 'down':
      return ['docker', 'compose', 'down'];
    case 'ps':
      return ['docker', 'compose', 'ps'];
    case 'logs': {
      const argv = ['docker', 'compose', 'logs'];
      if (options.follow) {
        argv.push('--follow');
      }
      if (options.service !== undefined) {
        argv.push(options.service);
      }
      return argv;
    }
  }
}
