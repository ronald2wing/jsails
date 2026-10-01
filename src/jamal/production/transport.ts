/**
 * SSH transport for jamal production deploys.
 *
 * Remote steps (`pull`, `run`, `health`, `stop`, `rollback`) execute on the
 * target server through `ssh`. {@link sshArgv} assembles the fixed argv array —
 * `ssh -o BatchMode=yes <server> <remote...>` by default — and
 * {@link createRemoteRunner} wraps an injected {@link CommandRunner} so a
 * remote command runs through the same process seam as local build/push, with
 * a bounded timeout.
 *
 * No key material is ever read in JS: authentication, the SSH agent, and
 * host-key verification (`known_hosts`) are all delegated to the system `ssh`
 * client. Batch mode is on by default so a missing or unusable key fails the
 * command instead of blocking on an interactive password prompt.
 */

import type { JamalSshConfig } from '../config.js';
import type { CommandResult, CommandRunner } from './command-runner.js';

/** A permissive subset of {@link JamalSshConfig} for {@link sshArgv}. */
type SshArgvSshConfig = Partial<JamalSshConfig> & {
  readonly keys?: readonly string[];
};

/** The remote runner's default timeout: a `docker pull` over ssh can be slow. */
export const DEFAULT_REMOTE_TIMEOUT_MS = 300_000;

/** Raised when a server name fails the ssh-target validation. */
export class TransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransportError';
  }
}

/** Control characters plus DEL — never valid in a server name. */
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

/** Options for {@link sshArgv}. */
interface SshArgvOptions {
  /**
   * Emit `-o BatchMode=yes` (default `true`) so `ssh` never blocks on a
   * password prompt; a missing key fails the command instead.
   */
  readonly batchMode?: boolean;
  readonly ssh?: SshArgvSshConfig;
}

/**
 * Assemble the fixed `ssh` argv for one remote command. The server is
 * validated (non-empty, no whitespace or control characters, no leading `-`),
 * so a hostile or accidental value can never become an `ssh` option or a shell
 * fragment. The remote argv is passed verbatim as the ssh command — never
 * shell-interpolated.
 */
export function sshArgv(
  server: string,
  remoteArgv: readonly string[],
  options: SshArgvOptions = {},
): readonly string[] {
  assertServer(server);
  const ssh = options.ssh;
  const batchMode = options.batchMode ?? true;
  const result: string[] = ['ssh'];

  if (batchMode) {
    result.push('-o', 'BatchMode=yes');
  }

  if (ssh?.port !== undefined) {
    result.push('-p', String(ssh.port));
  }

  if (ssh?.keys !== undefined) {
    for (const key of ssh.keys) {
      result.push('-i', key);
    }
  }

  if (ssh?.config !== undefined) {
    result.push('-F', ssh.config);
  }

  if (ssh?.forwardAgent) {
    result.push('-o', 'ForwardAgent=yes');
  }

  if (ssh?.proxyCommand !== undefined) {
    result.push('-o', `ProxyCommand=${ssh.proxyCommand}`);
  }

  if (ssh?.logLevel !== undefined) {
    result.push('-o', `LogLevel=${ssh.logLevel}`);
  }

  if (ssh?.keysOnly) {
    result.push('-o', 'IdentitiesOnly=yes');
  }

  const target = ssh?.user !== undefined ? `${ssh.user}@${server}` : server;
  result.push(target, ...remoteArgv);
  return result;
}

/** Reject a server that cannot be a safe ssh target, value-free. */
function assertServer(server: string): void {
  if (typeof server !== 'string' || server.length === 0) {
    throw new TransportError('the ssh server must be a non-empty string');
  }
  if (/\s/.test(server) || CONTROL_CHARS.test(server)) {
    throw new TransportError('the ssh server must not contain whitespace or control characters');
  }
  if (server.startsWith('-')) {
    throw new TransportError('the ssh server must not start with "-"');
  }
}

/** A remote runner: execute a fixed argv array on a server over ssh. */
export interface RemoteRunner {
  run(server: string, remoteArgv: readonly string[]): Promise<CommandResult>;
}

/** Options for {@link createRemoteRunner}. */
interface RemoteRunnerOptions {
  /** The underlying process runner (injected so tests never spawn ssh). */
  readonly processRunner: CommandRunner;
  /** Per-command timeout; defaults to {@link DEFAULT_REMOTE_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  /** SSH config carried into {@link sshArgv}. */
  readonly ssh?: JamalSshConfig;
}

/**
 * Build a remote runner over an injected {@link CommandRunner}. Every `run`
 * validates the server, assembles the `ssh` argv, and runs it with the
 * configured timeout. Non-zero exits resolve as a {@link CommandResult} (the
 * caller decides), while validation failures, spawn failures, and timeouts
 * reject.
 */
export function createRemoteRunner(options: RemoteRunnerOptions): RemoteRunner {
  const { processRunner, timeoutMs = DEFAULT_REMOTE_TIMEOUT_MS, ssh } = options;
  return {
    async run(server, remoteArgv) {
      return processRunner(sshArgv(server, remoteArgv, { ssh }), { timeoutMs });
    },
  };
}
