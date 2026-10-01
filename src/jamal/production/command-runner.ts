/**
 * Process execution foundation for jamal production deploys.
 *
 * {@link createProcessRunner} is the low-level seam that actually spawns a
 * process: a fixed argv array (never a shell string, so no interpolation is
 * possible) is handed to `node:child_process` `spawn` with piped stdout/stderr,
 * both captured into memory and returned alongside the exit code. A
 * `timeoutMs` option kills the child and rejects once the deadline passes.
 * Every rejection is a {@link ProcessRunnerError} whose message is value-free —
 * the argv, the binary name, and any spawn error text never leak into it.
 *
 * The production build/push/ssh layers (see `build.ts` and `transport.ts`)
 * depend on {@link CommandRunner} rather than on `spawn` directly, so they can
 * be driven by a fake runner in tests and never touch a real process.
 */

import { spawn } from 'node:child_process';

/** Outcome of one spawned command: its exit code plus captured output. */
export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Per-run options for a {@link CommandRunner}. */
export interface CommandOptions {
  /** Kill the child and reject after this many milliseconds. */
  readonly timeoutMs?: number;
}

/**
 * Run a fixed argv array and resolve with its exit code and captured output.
 * The seam every production executor injects for tests; `createProcessRunner`
 * is the default implementation.
 */
export type CommandRunner = (
  argv: readonly string[],
  options?: CommandOptions,
) => Promise<CommandResult>;

/** Why a {@link ProcessRunnerError} was raised — never a raw errno or argv. */
type ProcessRunnerErrorCode = 'empty-argv' | 'spawn' | 'timeout';

/** A value-free failure from {@link createProcessRunner}. */
export class ProcessRunnerError extends Error {
  readonly code: ProcessRunnerErrorCode;

  constructor(code: ProcessRunnerErrorCode, message: string) {
    super(message);
    this.name = 'ProcessRunnerError';
    this.code = code;
  }
}

/**
 * The default {@link CommandRunner}: spawn `argv[0]` with the remaining tokens
 * as arguments, `stdio` piped into memory, stdin ignored, and no shell in the
 * picture. An empty argv, a spawn failure, and a timeout each reject with a
 * {@link ProcessRunnerError} that never embeds the command or its output; a
 * successful spawn resolves once the child exits with its code and captured
 * stdout/stderr. When `timeoutMs` is set, the child is `SIGKILL`ed at the
 * deadline and the run rejects.
 */
export function createProcessRunner(): CommandRunner {
  return (argv, options = {}) =>
    new Promise<CommandResult>((resolve, reject) => {
      const command = argv[0];
      if (command === undefined || command === '') {
        reject(new ProcessRunnerError('empty-argv', 'cannot run an empty command'));
        return;
      }

      const child = spawn(command, argv.slice(1), {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));

      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      if (options.timeoutMs !== undefined) {
        timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          child.kill('SIGKILL');
          reject(
            new ProcessRunnerError(
              'timeout',
              `the command timed out after ${options.timeoutMs} ms`,
            ),
          );
        }, options.timeoutMs);
      }

      child.on('error', () => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        // The spawn error's own message embeds the binary name and path; never
        // surface it — a value-free "could not start" is all a caller needs.
        reject(new ProcessRunnerError('spawn', 'the command could not be started'));
      });

      child.on('close', (code, signal) => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        resolve({
          exitCode: code ?? (signal === null ? 0 : 1),
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
        });
      });
    });
}
