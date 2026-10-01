/**
 * Local build and push for jamal production deploys.
 *
 * {@link runBuild} drives `docker buildx build -t <imageRef> <context>` and
 * {@link runPush} drives `docker push <imageRef>` — the two local steps of a
 * production deploy, both through an injected {@link CommandRunner} so they run
 * on the same process seam as the remote ssh steps and never spawn a process in
 * tests. Each resolves with the raw {@link CommandResult} on success; a
 * non-zero exit is converted into a {@link BuildError} whose message names only
 * the operation and the exit code — the image reference and any docker output
 * are never echoed.
 */

import type { CommandResult, CommandRunner } from './command-runner.js';

/** Build context directory when the caller has no explicit one. */
export const DEFAULT_BUILD_CONTEXT = '.';

/** Raised when a build or push exits non-zero. Value-free: no image or output. */
export class BuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BuildError';
  }
}

/** Run `docker buildx build -t <imageRef> <context>`; context defaults to `.`. */
export function runBuild(
  imageRef: string,
  context: string,
  runner: CommandRunner,
): Promise<CommandResult>;
export function runBuild(imageRef: string, runner: CommandRunner): Promise<CommandResult>;
export async function runBuild(
  imageRef: string,
  contextOrRunner: string | CommandRunner,
  maybeRunner?: CommandRunner,
): Promise<CommandResult> {
  const context = typeof contextOrRunner === 'string' ? contextOrRunner : DEFAULT_BUILD_CONTEXT;
  const runner = typeof contextOrRunner === 'function' ? contextOrRunner : maybeRunner;
  if (runner === undefined) {
    throw new BuildError('runBuild requires a command runner');
  }
  return assertExitZero(
    await runner(['docker', 'buildx', 'build', '-t', imageRef, context]),
    'docker buildx build',
  );
}

/** Run `docker push <imageRef>` through the injected runner. */
export async function runPush(imageRef: string, runner: CommandRunner): Promise<CommandResult> {
  return assertExitZero(await runner(['docker', 'push', imageRef]), 'docker push');
}

/** Resolve with the result, or reject a non-zero exit with a value-free error. */
function assertExitZero(result: CommandResult, operation: string): CommandResult {
  if (result.exitCode !== 0) {
    throw new BuildError(`${operation} exited with code ${result.exitCode}`);
  }
  return result;
}
