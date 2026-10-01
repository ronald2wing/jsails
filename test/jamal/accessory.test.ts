import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runJamalCommand, type JamalDeps } from '../../src/jamal/command.js';
import { normalizeJamalConfig, type JamalConfig } from '../../src/jamal/config.js';
import { CONVENTIONS, accessoryRunArgv } from '../../src/jamal/production/accessories.js';
import type { RemoteRunner } from '../../src/jamal/production/transport.js';

/**
 * Tests for the `jamal accessory` lifecycle verbs. Every seam (config loader,
 * remote runner) is injected, so no ssh or docker access happens: the
 * assertions target the exact remote argv each verb assembles, the `--dry-run`
 * output, positional/flag validation, and value-free failure paths.
 */

interface RecordedRemote {
  server: string;
  remoteArgv: string[];
}

/** A config with mariadb + valkey backing services, plus a dev tool. */
function accessoryConfig(overrides: { server?: string } = {}): JamalConfig {
  return normalizeJamalConfig({
    service: 'myapp',
    image: 'ghcr.io/acme/myapp:latest',
    services: {
      mariadb: { type: 'mariadb' },
      valkey: { type: 'valkey' },
      mailpit: { type: 'mailpit' },
    },
    production: { server: overrides.server ?? '1.2.3.4' },
  });
}

interface AccessoryHarness {
  deps: JamalDeps;
  out: string[];
  err: string[];
  calls: RecordedRemote[];
}

function makeDeps(
  overrides: {
    config?: JamalConfig;
    exitCode?: number;
    remoteStdout?: string;
    remoteRunner?: RemoteRunner;
  } = {},
): AccessoryHarness {
  const out: string[] = [];
  const err: string[] = [];
  const calls: RecordedRemote[] = [];
  const remote: RemoteRunner = overrides.remoteRunner ?? {
    async run(server, remoteArgv) {
      calls.push({ server, remoteArgv: [...remoteArgv] });
      return {
        exitCode: overrides.exitCode ?? 0,
        stdout: overrides.remoteStdout ?? '',
        stderr: '',
      };
    },
  };
  const deps: JamalDeps = {
    createRegistry: () => {
      throw new Error('registry must not be built for accessory');
    },
    loadJamalConfig: async () => overrides.config ?? accessoryConfig(),
    remoteRunner: remote,
    cwd: '/project',
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
  };
  return { deps, out, err, calls };
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

describe('jamal accessory boot', () => {
  it('creates the volume and starts the container when it does not exist', async () => {
    const { deps, calls, err } = makeDeps({
      remoteRunner: {
        async run(server, remoteArgv) {
          calls.push({ server, remoteArgv: [...remoteArgv] });
          // inspect returns non-zero (container does not exist yet).
          const exitCode = remoteArgv[0] === 'docker' && remoteArgv[1] === 'inspect' ? 1 : 0;
          return { exitCode, stdout: '', stderr: '' };
        },
      },
    });

    const code = await runJamalCommand(['accessory', 'boot', 'mariadb'], deps);

    assert.equal(code, 0, err.join('\n'));
    assert.equal(calls.length, 3);
    // Volume create
    assert.deepEqual(calls[0]?.remoteArgv, [
      'docker',
      'volume',
      'create',
      CONVENTIONS.mariadb.volume,
    ]);
    // Inspect check
    assert.deepEqual(calls[1]?.remoteArgv, ['docker', 'inspect', 'mariadb']);
    // Run argv (inspect failed, so run is executed)
    assert.deepEqual(calls[2]?.remoteArgv, [...accessoryRunArgv('mariadb', 'mariadb', {})]);
  });

  it('reuses an existing container without re-creating it', async () => {
    // inspect succeeds (exitCode 0) -> skip run
    const { deps, calls, err } = makeDeps({ exitCode: 0 });

    const code = await runJamalCommand(['accessory', 'boot', 'mariadb'], deps);

    assert.equal(code, 0, err.join('\n'));
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0]?.remoteArgv, [
      'docker',
      'volume',
      'create',
      CONVENTIONS.mariadb.volume,
    ]);
    assert.deepEqual(calls[1]?.remoteArgv, ['docker', 'inspect', 'mariadb']);
  });

  it('boots every backing service when no name is given, skipping dev tools', async () => {
    const { deps, calls, err } = makeDeps({
      remoteRunner: {
        async run(server, remoteArgv) {
          calls.push({ server, remoteArgv: [...remoteArgv] });
          // inspect returns non-zero (containers do not exist yet).
          const exitCode = remoteArgv[0] === 'docker' && remoteArgv[1] === 'inspect' ? 1 : 0;
          return { exitCode, stdout: '', stderr: '' };
        },
      },
    });

    const code = await runJamalCommand(['accessory', 'boot'], deps);

    assert.equal(code, 0, err.join('\n'));
    // mariadb + valkey, sorted; mailpit skipped
    assert.equal(calls.length, 6); // 3 per service (volume + inspect + run)
    assert.deepEqual(calls[0]?.remoteArgv, [
      'docker',
      'volume',
      'create',
      CONVENTIONS.mariadb.volume,
    ]);
    assert.deepEqual(calls[3]?.remoteArgv, [
      'docker',
      'volume',
      'create',
      CONVENTIONS.valkey.volume,
    ]);
  });

  it('--dry-run prints the ssh commands and makes no remote calls', async () => {
    const { deps, out, calls } = makeDeps();

    const code = await runJamalCommand(['accessory', 'boot', 'mariadb', '--dry-run'], deps);

    assert.equal(code, 0);
    assert.equal(calls.length, 0);
    const output = out.join('\n');
    assert.match(output, /\[dry-run\] ssh 1\.2\.3\.4 docker volume create/);
    assert.match(output, /\[dry-run\] ssh 1\.2\.3\.4 docker inspect mariadb/);
    assert.match(output, /\[dry-run\] ssh 1\.2\.3\.4 docker run/);
  });
});

// ---------------------------------------------------------------------------
// start / stop / reboot / remove
// ---------------------------------------------------------------------------

describe('jamal accessory start', () => {
  it('runs docker start over ssh', async () => {
    const { deps, calls, err } = makeDeps();

    const code = await runJamalCommand(['accessory', 'start', 'mariadb'], deps);

    assert.equal(code, 0, err.join('\n'));
    assert.deepEqual(calls, [{ server: '1.2.3.4', remoteArgv: ['docker', 'start', 'mariadb'] }]);
  });

  it('starts every backing service when no name is given, sorted', async () => {
    const { deps, calls } = makeDeps();

    const code = await runJamalCommand(['accessory', 'start'], deps);

    assert.equal(code, 0);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0], { server: '1.2.3.4', remoteArgv: ['docker', 'start', 'mariadb'] });
    assert.deepEqual(calls[1], { server: '1.2.3.4', remoteArgv: ['docker', 'start', 'valkey'] });
  });
});

describe('jamal accessory stop', () => {
  it('runs docker stop over ssh', async () => {
    const { deps, calls } = makeDeps();

    const code = await runJamalCommand(['accessory', 'stop', 'mariadb'], deps);

    assert.equal(code, 0);
    assert.deepEqual(calls[0]?.remoteArgv, ['docker', 'stop', 'mariadb']);
  });

  it('stops all backing services when no name is given', async () => {
    const { deps, calls } = makeDeps();

    const code = await runJamalCommand(['accessory', 'stop'], deps);

    assert.equal(code, 0);
    assert.equal(calls.length, 2);
  });
});

describe('jamal accessory reboot', () => {
  it('runs docker restart over ssh', async () => {
    const { deps, calls } = makeDeps();

    const code = await runJamalCommand(['accessory', 'reboot', 'mariadb'], deps);

    assert.equal(code, 0);
    assert.deepEqual(calls[0]?.remoteArgv, ['docker', 'restart', 'mariadb']);
  });
});

describe('jamal accessory remove', () => {
  it('runs docker rm -f over ssh', async () => {
    const { deps, calls } = makeDeps();

    const code = await runJamalCommand(['accessory', 'remove', 'mariadb'], deps);

    assert.equal(code, 0);
    assert.deepEqual(calls[0]?.remoteArgv, ['docker', 'rm', '-f', 'mariadb']);
  });

  it('removes all backing services when no name is given', async () => {
    const { deps, calls } = makeDeps();

    const code = await runJamalCommand(['accessory', 'remove'], deps);

    assert.equal(code, 0);
    assert.equal(calls.length, 2);
  });
});

// ---------------------------------------------------------------------------
// logs / details
// ---------------------------------------------------------------------------

describe('jamal accessory logs', () => {
  it('runs docker logs over ssh', async () => {
    const { deps, calls, err } = makeDeps({ remoteStdout: 'some log\n' });

    const code = await runJamalCommand(['accessory', 'logs', 'mariadb'], deps);

    assert.equal(code, 0, err.join('\n'));
    assert.deepEqual(calls[0]?.remoteArgv, ['docker', 'logs', 'mariadb']);
  });

  it('adds --follow with the flag', async () => {
    const { deps, calls } = makeDeps();

    const code = await runJamalCommand(['accessory', 'logs', 'mariadb', '--follow'], deps);

    assert.equal(code, 0);
    assert.deepEqual(calls[0]?.remoteArgv, ['docker', 'logs', '--follow', 'mariadb']);
  });

  it('requires a service name', async () => {
    const { deps, err } = makeDeps();

    const code = await runJamalCommand(['accessory', 'logs'], deps);

    assert.equal(code, 2);
    assert.match(err.join('\n'), /requires a service name/);
  });
});

describe('jamal accessory details', () => {
  it('runs docker inspect over ssh', async () => {
    const { deps, calls } = makeDeps();

    const code = await runJamalCommand(['accessory', 'details', 'mariadb'], deps);

    assert.equal(code, 0);
    assert.deepEqual(calls[0]?.remoteArgv, ['docker', 'inspect', 'mariadb']);
  });

  it('requires a service name', async () => {
    const { deps, err } = makeDeps();

    const code = await runJamalCommand(['accessory', 'details'], deps);

    assert.equal(code, 2);
    assert.match(err.join('\n'), /requires a service name/);
  });
});

// ---------------------------------------------------------------------------
// Error paths
// ---------------------------------------------------------------------------

describe('jamal accessory: error paths', () => {
  it('reports an unknown service name as a usage error, value-free', async () => {
    const { deps, err, calls } = makeDeps();

    const code = await runJamalCommand(['accessory', 'boot', 'nonexistent'], deps);

    assert.equal(code, 2);
    assert.equal(calls.length, 0);
    assert.match(err.join('\n'), /unknown accessory/);
  });

  it('reports a dev-tool name as a usage error, value-free', async () => {
    const { deps, err, calls } = makeDeps();

    const code = await runJamalCommand(['accessory', 'boot', 'mailpit'], deps);

    assert.equal(code, 2);
    assert.equal(calls.length, 0);
    assert.match(err.join('\n'), /unknown accessory/);
  });

  it('requires config.production', async () => {
    const { deps, err } = makeDeps({
      config: normalizeJamalConfig({
        service: 'myapp',
        image: 'ghcr.io/acme/myapp',
        services: { mariadb: { type: 'mariadb' } },
      }),
    });

    const code = await runJamalCommand(['accessory', 'boot', 'mariadb'], deps);

    assert.equal(code, 1);
    assert.match(err.join('\n'), /config\.production is required/);
  });

  it('reports an invalid verb as a usage error', async () => {
    const { deps, err } = makeDeps();

    const code = await runJamalCommand(['accessory', 'bogus'], deps);

    assert.equal(code, 2);
    assert.match(err.join('\n'), /a verb is required/);
  });

  it('rejects an unknown flag as a usage error', async () => {
    const { deps, err } = makeDeps();

    const code = await runJamalCommand(['accessory', 'boot', 'mariadb', '--bogus'], deps);

    assert.equal(code, 2);
    assert.match(err.join('\n'), /Unknown option/);
  });

  it('rejects --follow on a non-logs verb', async () => {
    const { deps, err } = makeDeps();

    const code = await runJamalCommand(['accessory', 'boot', 'mariadb', '--follow'], deps);

    assert.equal(code, 2);
    assert.match(err.join('\n'), /--follow is only valid/);
  });

  it('prints accessory usage on --help without loading config', async () => {
    const { deps, out } = makeDeps();

    const code = await runJamalCommand(['accessory', '--help'], deps);

    assert.equal(code, 0);
    const output = out.join('\n');
    assert.match(output, /jamal accessory - manage backing service containers/);
    assert.match(output, /boot \[name\]/);
    assert.match(output, /start \[name\]/);
    assert.match(output, /stop \[name\]/);
    assert.match(output, /reboot \[name\]/);
    assert.match(output, /logs <name>/);
    assert.match(output, /remove \[name\]/);
    assert.match(output, /details <name>/);
    assert.match(output, /--follow/);
    assert.match(output, /--dry-run/);
  });

  it('reports a non-zero remote exit code value-free', async () => {
    const { deps, out, err } = makeDeps({ exitCode: 7, remoteStdout: 'info\n' });

    const code = await runJamalCommand(['accessory', 'details', 'mariadb'], deps);

    assert.equal(code, 7);
    assert.match(out.join('\n'), /info/);
    assert.match(err.join('\n'), /accessory details mariadb exited with code 7/);
  });

  it('--dry-run prints the ssh command with the server', async () => {
    const { deps, out, calls } = makeDeps();

    const code = await runJamalCommand(['accessory', 'start', 'mariadb', '--dry-run'], deps);

    assert.equal(code, 0);
    assert.equal(calls.length, 0);
    assert.match(out.join('\n'), /\[dry-run\] ssh 1\.2\.3\.4 docker start mariadb/);
  });

  it('--dry-run masks the server when it contains dots', async () => {
    const { deps, out, calls } = makeDeps({
      config: accessoryConfig({ server: 'prod.example.com' }),
    });

    const code = await runJamalCommand(['accessory', 'start', 'mariadb', '--dry-run'], deps);

    assert.equal(code, 0);
    assert.equal(calls.length, 0);
    assert.match(out.join('\n'), /\[dry-run\] ssh prod\.example\.com docker start mariadb/);
  });
});

// ---------------------------------------------------------------------------
// No backing services declared
// ---------------------------------------------------------------------------

describe('jamal accessory: no backing services', () => {
  it('reports an error when no backing services are declared and no name is given', async () => {
    const { deps, err } = makeDeps({
      config: normalizeJamalConfig({
        service: 'myapp',
        image: 'ghcr.io/acme/myapp',
        services: { mailpit: { type: 'mailpit' } },
        production: { server: '1.2.3.4' },
      }),
    });

    const code = await runJamalCommand(['accessory', 'boot'], deps);

    assert.equal(code, 1);
    assert.match(err.join('\n'), /no backing services/);
  });
});
