/**
 * Remote deploy lock for jamal production deploys.
 *
 * A deploy lock is a directory on the target server that at most one release
 * may hold at a time. {@link acquireLock} creates it with `mkdir` over ssh and
 * treats a non-zero exit as contention — the directory already exists, so
 * another release is in flight — raising a {@link LockContentionError} whose
 * message never names the server or the lock directory. The returned handle's
 * `release()` removes the directory with `rmdir`; it is idempotent, so a
 * duplicated release is a no-op. {@link lockStatus} reports whether the lock
 * directory currently exists (`test -d`), for callers that want to skip rather
 * than fail on a held lock.
 *
 * Every command runs through the injected {@link RemoteRunner}, which assembles
 * the fixed `ssh` argv via {@link sshArgv}; no shell is ever involved and no
 * secret value reaches the command. A held lock is never cleared automatically.
 */

import type { RemoteRunner } from './transport.js';

/** Raised for any lock failure that is not contention. Value-free. */
export class LockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LockError';
  }
}

/** Raised when the deploy lock is already held. Value-free. */
export class LockContentionError extends LockError {
  constructor(message: string) {
    super(message);
    this.name = 'LockContentionError';
  }
}

/** Control characters plus DEL — never valid in a lock directory. */
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

/** Options naming the ssh target and the lock directory. */
interface LockOptions {
  readonly server: string;
  readonly lockDir: string;
}

/** A held lock; {@link release} removes it (idempotently). */
export interface LockHandle {
  release(): Promise<void>;
}

/** Reject a lock directory that cannot be a safe ssh argv token, value-free. */
function assertLockDir(lockDir: string): void {
  if (typeof lockDir !== 'string' || lockDir.length === 0) {
    throw new LockError('the lock directory must be a non-empty string');
  }
  if (/\s/.test(lockDir) || CONTROL_CHARS.test(lockDir)) {
    throw new LockError('the lock directory must not contain whitespace or control characters');
  }
  if (lockDir.startsWith('-')) {
    throw new LockError('the lock directory must not start with "-"');
  }
}

/**
 * Acquire the deploy lock on `server` by creating `lockDir` with `mkdir`. A
 * zero exit means the directory did not exist and the lock is held by this
 * caller; any other exit is reported as contention. The returned handle's
 * `release()` removes the directory with `rmdir` and is idempotent.
 */
export async function acquireLock(remote: RemoteRunner, options: LockOptions): Promise<LockHandle> {
  const { server, lockDir } = options;
  assertLockDir(lockDir);
  const result = await remote.run(server, ['mkdir', lockDir]);
  if (result.exitCode !== 0) {
    throw new LockContentionError('the deploy lock is already held');
  }
  return createHandle(remote, server, lockDir);
}

/** Report whether the deploy lock currently exists (`test -d` exit zero). */
export async function lockStatus(remote: RemoteRunner, options: LockOptions): Promise<boolean> {
  const { server, lockDir } = options;
  assertLockDir(lockDir);
  const result = await remote.run(server, ['test', '-d', lockDir]);
  return result.exitCode === 0;
}

/** Build a {@link LockHandle} that rmdirs the lock directory exactly once. */
function createHandle(remote: RemoteRunner, server: string, lockDir: string): LockHandle {
  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      const result = await remote.run(server, ['rmdir', lockDir]);
      if (result.exitCode !== 0) {
        throw new LockError('the deploy lock could not be released');
      }
    },
  };
}
