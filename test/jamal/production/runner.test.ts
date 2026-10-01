import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createProcessRunner,
  ProcessRunnerError,
  type CommandOptions,
  type CommandResult,
  type CommandRunner,
} from '../../../src/jamal/production/command-runner.js';
import {
  createRemoteRunner,
  DEFAULT_REMOTE_TIMEOUT_MS,
  sshArgv,
  TransportError,
} from '../../../src/jamal/production/transport.js';

/**
 * Tests for the process-runner and ssh-transport foundations. `createProcessRunner`
 * is exercised against a real `node` child (never docker/ssh) to prove fixed-argv
 * capture, stdio buffering, timeout, and value-free spawn errors; the remote
 * runner and the ssh argv builder run entirely against faked process runners.
 */

describe('createProcessRunner: real spawn', () => {
  it('captures stdout, stderr, and a non-zero exit code', async () => {
    const result = await createProcessRunner()([
      process.execPath,
      '-e',
      'process.stdout.write("out"); process.stderr.write("err"); process.exit(3)',
    ]);
    assert.equal(result.exitCode, 3);
    assert.equal(result.stdout, 'out');
    assert.equal(result.stderr, 'err');
  });

  it('passes argv verbatim (fixed argv, no shell interpolation)', async () => {
    const result = await createProcessRunner()([
      process.execPath,
      '-e',
      'process.stdout.write(JSON.stringify(process.argv.slice(1)))',
      'alpha',
      'two words',
      'beta$VAR',
    ]);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(JSON.parse(result.stdout), ['alpha', 'two words', 'beta$VAR']);
  });

  it('rejects an empty argv with a value-free error', async () => {
    await assert.rejects(
      () => createProcessRunner()([]),
      (error: unknown) => {
        assert.ok(error instanceof ProcessRunnerError);
        assert.equal(error.code, 'empty-argv');
        assert.match(error.message, /empty command/);
        return true;
      },
    );
  });

  it('rejects a missing binary with a value-free spawn error', async () => {
    await assert.rejects(
      () => createProcessRunner()(['jsails-no-such-binary-xyz', 'arg']),
      (error: unknown) => {
        assert.ok(error instanceof ProcessRunnerError);
        assert.equal(error.code, 'spawn');
        assert.equal(error.message, 'the command could not be started');
        return true;
      },
    );
  });

  it('kills the child and rejects value-free when the timeout elapses', async () => {
    await assert.rejects(
      () =>
        createProcessRunner()([process.execPath, '-e', 'setTimeout(() => {}, 10000)'], {
          timeoutMs: 50,
        }),
      (error: unknown) => {
        assert.ok(error instanceof ProcessRunnerError);
        assert.equal(error.code, 'timeout');
        assert.match(error.message, /timed out after 50 ms/);
        return true;
      },
    );
  });
});

describe('sshArgv: shape and server validation', () => {
  it('emits BatchMode=yes by default', () => {
    assert.deepEqual(sshArgv('1.2.3.4', ['docker', 'pull', 'img:1.0.0']), [
      'ssh',
      '-o',
      'BatchMode=yes',
      '1.2.3.4',
      'docker',
      'pull',
      'img:1.0.0',
    ]);
  });

  it('omits BatchMode when batchMode is false', () => {
    assert.deepEqual(sshArgv('1.2.3.4', ['docker', 'stop', 'x'], { batchMode: false }), [
      'ssh',
      '1.2.3.4',
      'docker',
      'stop',
      'x',
    ]);
  });

  it('rejects an empty server', () => {
    assert.throws(
      () => sshArgv('', ['true']),
      (error: unknown) => {
        assert.ok(error instanceof TransportError);
        assert.match(error.message, /non-empty/);
        return true;
      },
    );
  });

  it('rejects a server with whitespace or control characters, value-free', () => {
    for (const bad of ['has space', 'tab\tx', 'line\nbreak', 'ctrl\u0001']) {
      assert.throws(
        () => sshArgv(bad, ['true']),
        (error: unknown) => {
          assert.ok(error instanceof TransportError);
          assert.match(error.message, /whitespace or control/);
          assert.ok(!error.message.includes(bad), `server ${JSON.stringify(bad)} must not leak`);
          return true;
        },
      );
    }
  });

  it('rejects a server with a leading dash', () => {
    for (const bad of ['-o', '-F', '-x', '-p']) {
      assert.throws(
        () => sshArgv(bad, ['true']),
        (error: unknown) => {
          assert.ok(error instanceof TransportError);
          assert.match(error.message, /must not start with/);
          return true;
        },
      );
    }
  });
});

describe('sshArgv options', () => {
  it('emits flags in fixed order when ssh options are set', () => {
    const argv = sshArgv('srv', ['docker', 'ps'], {
      ssh: { port: 2222, keys: ['/home/deploy/.ssh/id_rsa'], forwardAgent: true },
    });
    assert.deepEqual(argv, [
      'ssh',
      '-o',
      'BatchMode=yes',
      '-p',
      '2222',
      '-i',
      '/home/deploy/.ssh/id_rsa',
      '-o',
      'ForwardAgent=yes',
      'srv',
      'docker',
      'ps',
    ]);
  });

  it('renders user as user@server', () => {
    const argv = sshArgv('srv', ['docker', 'ps'], {
      ssh: { user: 'deploy' },
    });
    assert.deepEqual(argv, ['ssh', '-o', 'BatchMode=yes', 'deploy@srv', 'docker', 'ps']);
  });

  it('emits -F config and -o ProxyCommand=<cmd> when set', () => {
    const argv = sshArgv('srv', ['true'], {
      ssh: {
        config: '/path/to/ssh_config',
        proxyCommand: 'connect -H proxy:3128 %h %p',
      },
    });
    assert.deepEqual(argv, [
      'ssh',
      '-o',
      'BatchMode=yes',
      '-F',
      '/path/to/ssh_config',
      '-o',
      'ProxyCommand=connect -H proxy:3128 %h %p',
      'srv',
      'true',
    ]);
  });

  it('emits -o IdentitiesOnly=yes when keysOnly is true', () => {
    const argv = sshArgv('srv', ['true'], {
      ssh: { keysOnly: true },
    });
    assert.deepEqual(argv, [
      'ssh',
      '-o',
      'BatchMode=yes',
      '-o',
      'IdentitiesOnly=yes',
      'srv',
      'true',
    ]);
  });

  it('emits -o LogLevel=<level> when logLevel is set', () => {
    const argv = sshArgv('srv', ['true'], {
      ssh: { logLevel: 'ERROR' },
    });
    assert.deepEqual(argv, ['ssh', '-o', 'BatchMode=yes', '-o', 'LogLevel=ERROR', 'srv', 'true']);
  });

  it('emits -i for each key entry', () => {
    const argv = sshArgv('srv', ['true'], {
      ssh: { keys: ['~/.ssh/id_rsa', '~/.ssh/id_ed25519'] },
    });
    assert.deepEqual(argv, [
      'ssh',
      '-o',
      'BatchMode=yes',
      '-i',
      '~/.ssh/id_rsa',
      '-i',
      '~/.ssh/id_ed25519',
      'srv',
      'true',
    ]);
  });

  it('omits BatchMode when batchMode is false even with ssh options', () => {
    const argv = sshArgv('srv', ['true'], {
      batchMode: false,
      ssh: { port: 2222 },
    });
    assert.deepEqual(argv, ['ssh', '-p', '2222', 'srv', 'true']);
  });
});

describe('createRemoteRunner', () => {
  interface RecordedCall {
    argv: readonly string[];
    options?: CommandOptions;
  }

  function recordingRunner(calls: RecordedCall[]): CommandRunner {
    return async (argv, options) => {
      calls.push({ argv, options });
      return { exitCode: 0, stdout: '', stderr: '' };
    };
  }

  it('assembles the ssh argv through the injected runner with the default timeout', async () => {
    const calls: RecordedCall[] = [];
    const remote = createRemoteRunner({
      processRunner: recordingRunner(calls),
    });

    const result = await remote.run('1.2.3.4', ['docker', 'pull', 'img:1.0.0']);

    assert.equal(result.exitCode, 0);
    assert.deepEqual(calls[0]?.argv, [
      'ssh',
      '-o',
      'BatchMode=yes',
      '1.2.3.4',
      'docker',
      'pull',
      'img:1.0.0',
    ]);
    assert.equal(calls[0]?.options?.timeoutMs, DEFAULT_REMOTE_TIMEOUT_MS);
  });

  it('honors an explicit timeout', async () => {
    const calls: RecordedCall[] = [];
    const remote = createRemoteRunner({
      processRunner: recordingRunner(calls),
      timeoutMs: 1234,
    });

    await remote.run('1.2.3.4', ['true']);

    assert.equal(calls[0]?.options?.timeoutMs, 1234);
  });

  it('resolves a non-zero exit as a CommandResult instead of throwing', async () => {
    const processRunner: CommandRunner = async () => ({
      exitCode: 7,
      stdout: '',
      stderr: 'nope',
    });
    const remote = createRemoteRunner({ processRunner });

    const result: CommandResult = await remote.run('1.2.3.4', ['docker', 'stop', 'x']);

    assert.equal(result.exitCode, 7);
    assert.equal(result.stderr, 'nope');
  });

  it('propagates a runner rejection', async () => {
    const processRunner: CommandRunner = async () => {
      throw new ProcessRunnerError('timeout', 'the command timed out after 50 ms');
    };
    const remote = createRemoteRunner({ processRunner });

    await assert.rejects(
      () => remote.run('1.2.3.4', ['true']),
      (error: unknown) => error instanceof ProcessRunnerError && error.code === 'timeout',
    );
  });

  it('validates the server before invoking the process runner', async () => {
    let ran = false;
    const processRunner: CommandRunner = async () => {
      ran = true;
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    const remote = createRemoteRunner({ processRunner });

    await assert.rejects(
      () => remote.run('-o', ['true']),
      (error: unknown) => error instanceof TransportError,
    );
    assert.equal(ran, false);
  });
});
