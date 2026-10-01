import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  acquireLock,
  lockStatus,
  LockContentionError,
  LockError,
  type LockHandle,
} from '../../../src/jamal/production/lock.js';
import type { CommandResult } from '../../../src/jamal/production/command-runner.js';
import type { RemoteRunner } from '../../../src/jamal/production/transport.js';

/**
 * Tests for the remote deploy lock. Everything runs against a recording fake
 * {@link RemoteRunner}, so no ssh command is ever spawned: assertions target the
 * exact remote argv, contention vs release behavior, idempotent release, and
 * the value-free errors for contention and invalid lock directories.
 */

interface RecordedCall {
  server: string;
  remoteArgv: string[];
}

function makeRemote(script: (server: string, remoteArgv: string[]) => CommandResult): {
  remote: RemoteRunner;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const remote: RemoteRunner = {
    async run(server, remoteArgv) {
      calls.push({ server, remoteArgv: [...remoteArgv] });
      return script(server, [...remoteArgv]);
    },
  };
  return { remote, calls };
}

const ok: CommandResult = { exitCode: 0, stdout: '', stderr: '' };

describe('acquireLock/release: argv shapes', () => {
  it('creates the lock directory with mkdir over ssh', async () => {
    const { remote, calls } = makeRemote(() => ok);

    const handle = await acquireLock(remote, { server: '1.2.3.4', lockDir: '/var/lock/jamal' });

    assert.deepEqual(calls[0], { server: '1.2.3.4', remoteArgv: ['mkdir', '/var/lock/jamal'] });
    assert.equal(typeof handle.release, 'function');
  });

  it('releases the lock by removing the directory with rmdir', async () => {
    const { remote, calls } = makeRemote(() => ok);

    const handle = await acquireLock(remote, { server: '1.2.3.4', lockDir: '/var/lock/jamal' });
    await handle.release();

    assert.deepEqual(calls[1], { server: '1.2.3.4', remoteArgv: ['rmdir', '/var/lock/jamal'] });
  });

  it('release is idempotent: a second release performs no rmdir', async () => {
    const { remote, calls } = makeRemote(() => ok);

    const handle = await acquireLock(remote, { server: 's', lockDir: '/lock' });
    await handle.release();
    await handle.release();

    assert.equal(calls.length, 2);
  });
});

describe('acquireLock: contention', () => {
  it('raises a value-free LockContentionError when mkdir fails (lock exists)', async () => {
    const { remote } = makeRemote(() => ({ exitCode: 1, stdout: '', stderr: 'exists' }));

    await assert.rejects(
      () => acquireLock(remote, { server: '1.2.3.4', lockDir: '/var/lock/jamal' }),
      (error: unknown) => {
        assert.ok(error instanceof LockContentionError);
        assert.equal(error.message, 'the deploy lock is already held');
        assert.ok(!error.message.includes('1.2.3.4'), 'server must not leak');
        assert.ok(!error.message.includes('/var/lock'), 'lock directory must not leak');
        return true;
      },
    );
  });
});

describe('lockStatus', () => {
  it('reports held when test -d exits zero', async () => {
    const { remote, calls } = makeRemote(() => ok);

    assert.equal(await lockStatus(remote, { server: '1.2.3.4', lockDir: '/lock' }), true);
    assert.deepEqual(calls[0], { server: '1.2.3.4', remoteArgv: ['test', '-d', '/lock'] });
  });

  it('reports free when test -d exits non-zero', async () => {
    const { remote } = makeRemote(() => ({ exitCode: 1, stdout: '', stderr: '' }));

    assert.equal(await lockStatus(remote, { server: '1.2.3.4', lockDir: '/lock' }), false);
  });
});

describe('lock validation and release failures', () => {
  it('rejects an empty or unsafe lock directory before any ssh call, value-free', async () => {
    for (const bad of ['', '-f', 'has space', 'tab\tx', 'ctrl\u0001']) {
      const { remote, calls } = makeRemote(() => ok);
      await assert.rejects(
        () => acquireLock(remote, { server: '1.2.3.4', lockDir: bad }),
        (error: unknown) => {
          assert.ok(error instanceof LockError);
          assert.ok(!(error instanceof LockContentionError));
          if (bad.length > 0) {
            assert.ok(!error.message.includes(bad), `lockDir ${JSON.stringify(bad)} must not leak`);
          }
          return true;
        },
      );
      assert.equal(calls.length, 0, 'no ssh command may run for an invalid lock directory');
    }
  });

  it('release raises a value-free LockError when rmdir exits non-zero', async () => {
    let calls = 0;
    const { remote } = makeRemote(() => {
      calls += 1;
      return calls === 1 ? ok : { exitCode: 1, stdout: '', stderr: '' };
    });

    const handle: LockHandle = await acquireLock(remote, { server: 's', lockDir: '/lock' });
    await assert.rejects(
      () => handle.release(),
      (error: unknown) => {
        assert.ok(error instanceof LockError);
        assert.equal(error.message, 'the deploy lock could not be released');
        return true;
      },
    );
  });
});
