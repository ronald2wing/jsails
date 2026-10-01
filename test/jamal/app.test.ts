import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runJamalCommand, type JamalDeps } from '../../src/jamal/command.js';
import { normalizeJamalConfig, type JamalConfig } from '../../src/jamal/config.js';
import type { DeployHistory } from '../../src/jamal/production/history.js';
import { containerNameForTag } from '../../src/jamal/production/plan.js';
import type { RemoteRunner } from '../../src/jamal/production/transport.js';

/**
 * Tests for the `jamal app` lifecycle verbs. Every seam (config loader, remote
 * runner, history reader) is injected, so no ssh or docker access happens: the
 * assertions target the exact remote argv each verb assembles, the `--dry-run`
 * output, flag/positional validation, and value-free failure paths.
 */

interface RecordedRemote {
  server: string;
  remoteArgv: string[];
}

const TAG = 'abc123';

function appConfig(overrides: { service?: string; server?: string } = {}): JamalConfig {
  return normalizeJamalConfig({
    service: overrides.service ?? 'myapp',
    image: 'ghcr.io/acme/myapp:latest',
    production: { server: overrides.server ?? '1.2.3.4' },
  });
}

function history(tag: string = TAG): DeployHistory {
  return {
    version: 1,
    entries: [{ service: 'myapp', tag, timestamp: '2026-01-01T00:00:00.000Z' }],
  };
}

interface AppHarness {
  deps: JamalDeps;
  out: string[];
  err: string[];
  calls: RecordedRemote[];
}

function makeDeps(
  overrides: {
    config?: JamalConfig;
    deployHistory?: DeployHistory;
    exitCode?: number;
    remoteStdout?: string;
    remoteRunner?: RemoteRunner;
  } = {},
): AppHarness {
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
      throw new Error('registry must not be built for app');
    },
    loadJamalConfig: async () => overrides.config ?? appConfig(),
    readHistory: async () => overrides.deployHistory ?? history(),
    remoteRunner: remote,
    cwd: '/project',
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
  };
  return { deps, out, err, calls };
}

function containerForTag(service: string, tag: string): string {
  return containerNameForTag(service, tag);
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

describe('jamal app boot', () => {
  it('starts the container when inspect returns non-zero', async () => {
    const container = containerForTag('myapp', TAG);
    const { deps, calls, err } = makeDeps({
      remoteRunner: {
        async run(server, remoteArgv) {
          calls.push({ server, remoteArgv: [...remoteArgv] });
          // inspect returns non-zero (container does not exist).
          const exitCode = remoteArgv[0] === 'docker' && remoteArgv[1] === 'inspect' ? 1 : 0;
          return { exitCode, stdout: '', stderr: '' };
        },
      },
    });

    const code = await runJamalCommand(['app', 'boot'], deps);

    assert.equal(code, 0, err.join('\n'));
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0]?.remoteArgv, ['docker', 'inspect', container]);
    assert.deepEqual(calls[1]?.remoteArgv, ['docker', 'start', container]);
  });

  it('is a no-op when the container is already running (inspect exits 0)', async () => {
    const container = containerForTag('myapp', TAG);
    const { deps, calls, err } = makeDeps();

    const code = await runJamalCommand(['app', 'boot'], deps);

    assert.equal(code, 0, err.join('\n'));
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.remoteArgv, ['docker', 'inspect', container]);
    // No start call.
  });

  it('--dry-run prints both commands and makes no remote calls', async () => {
    const container = containerForTag('myapp', TAG);
    const { deps, out, calls } = makeDeps();

    const code = await runJamalCommand(['app', 'boot', '--dry-run'], deps);

    assert.equal(code, 0);
    assert.equal(calls.length, 0);
    const output = out.join('\n');
    assert.match(output, new RegExp(`\\[dry-run\\] ssh 1\\.2\\.3\\.4 docker inspect ${container}`));
    assert.match(output, new RegExp(`\\[dry-run\\] ssh 1\\.2\\.3\\.4 docker start ${container}`));
  });
});

// ---------------------------------------------------------------------------
// start / stop / details
// ---------------------------------------------------------------------------

describe('jamal app start', () => {
  it('runs docker start over ssh for the latest container', async () => {
    const container = containerForTag('myapp', TAG);
    const { deps, calls, err } = makeDeps();

    const code = await runJamalCommand(['app', 'start'], deps);

    assert.equal(code, 0, err.join('\n'));
    assert.deepEqual(calls, [{ server: '1.2.3.4', remoteArgv: ['docker', 'start', container] }]);
  });
});

describe('jamal app stop', () => {
  it('runs docker stop over ssh for the latest container', async () => {
    const container = containerForTag('myapp', TAG);
    const { deps, calls } = makeDeps();

    const code = await runJamalCommand(['app', 'stop'], deps);

    assert.equal(code, 0);
    assert.deepEqual(calls[0]?.remoteArgv, ['docker', 'stop', container]);
  });
});

describe('jamal app details', () => {
  it('runs docker inspect over ssh for the latest container', async () => {
    const container = containerForTag('myapp', TAG);
    const { deps, calls } = makeDeps();

    const code = await runJamalCommand(['app', 'details'], deps);

    assert.equal(code, 0);
    assert.deepEqual(calls[0]?.remoteArgv, ['docker', 'inspect', container]);
  });
});

// ---------------------------------------------------------------------------
// containers
// ---------------------------------------------------------------------------

describe('jamal app containers', () => {
  it('runs docker ps -a filtered by the service name', async () => {
    const { deps, calls, err } = makeDeps();

    const code = await runJamalCommand(['app', 'containers'], deps);

    assert.equal(code, 0, err.join('\n'));
    assert.deepEqual(calls, [
      { server: '1.2.3.4', remoteArgv: ['docker', 'ps', '-a', '--filter', 'name=myapp'] },
    ]);
  });

  it('does not require deploy history', async () => {
    const { deps, calls } = makeDeps({ deployHistory: { version: 1, entries: [] } });

    const code = await runJamalCommand(['app', 'containers'], deps);

    assert.equal(code, 0);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.remoteArgv, ['docker', 'ps', '-a', '--filter', 'name=myapp']);
  });

  it('--dry-run prints the ssh argv', async () => {
    const { deps, out, calls } = makeDeps();

    const code = await runJamalCommand(['app', 'containers', '--dry-run'], deps);

    assert.equal(code, 0);
    assert.equal(calls.length, 0);
    assert.match(out.join('\n'), /\[dry-run\] ssh 1\.2\.3\.4 docker ps -a --filter name=myapp/);
  });
});

// ---------------------------------------------------------------------------
// logs
// ---------------------------------------------------------------------------

describe('jamal app logs', () => {
  it('runs docker logs over ssh for the latest container', async () => {
    const container = containerForTag('myapp', TAG);
    const { deps, calls, err } = makeDeps({ remoteStdout: 'log line\n' });

    const code = await runJamalCommand(['app', 'logs'], deps);

    assert.equal(code, 0, err.join('\n'));
    assert.deepEqual(calls[0]?.remoteArgv, ['docker', 'logs', container]);
  });

  it('adds --follow with the flag', async () => {
    const container = containerForTag('myapp', TAG);
    const { deps, calls } = makeDeps();

    const code = await runJamalCommand(['app', 'logs', '--follow'], deps);

    assert.equal(code, 0);
    assert.deepEqual(calls[0]?.remoteArgv, ['docker', 'logs', '--follow', container]);
  });
});

// ---------------------------------------------------------------------------
// exec
// ---------------------------------------------------------------------------

describe('jamal app exec', () => {
  it('runs docker exec over ssh with the command', async () => {
    const container = containerForTag('myapp', TAG);
    const { deps, calls, err } = makeDeps();

    const code = await runJamalCommand(['app', 'exec', '--', 'ls', '-la'], deps);

    assert.equal(code, 0, err.join('\n'));
    assert.deepEqual(calls, [
      { server: '1.2.3.4', remoteArgv: ['docker', 'exec', container, 'ls', '-la'] },
    ]);
  });

  it('requires -- before the command', async () => {
    const { deps, err } = makeDeps();

    const code = await runJamalCommand(['app', 'exec', 'ls'], deps);

    assert.equal(code, 2);
    assert.match(err.join('\n'), /requires "--"/);
  });

  it('requires a command after --', async () => {
    const { deps, err } = makeDeps();

    const code = await runJamalCommand(['app', 'exec', '--'], deps);

    assert.equal(code, 2);
    assert.match(err.join('\n'), /requires a command/);
  });
});

// ---------------------------------------------------------------------------
// Error paths
// ---------------------------------------------------------------------------

describe('jamal app: error paths', () => {
  it('requires config.production', async () => {
    const { deps, err } = makeDeps({
      config: normalizeJamalConfig({
        service: 'myapp',
        image: 'ghcr.io/acme/myapp',
      }),
    });

    const code = await runJamalCommand(['app', 'start'], deps);

    assert.equal(code, 1);
    assert.match(err.join('\n'), /config\.production is required for `jamal app`/);
  });

  it('reports no deploy history as a value-free error', async () => {
    const { deps, err, calls } = makeDeps({ deployHistory: { version: 1, entries: [] } });

    const code = await runJamalCommand(['app', 'start'], deps);

    assert.equal(code, 1);
    assert.equal(calls.length, 0);
    assert.match(err.join('\n'), /no deploy history to inspect/);
  });

  it('reports an unknown verb as a usage error', async () => {
    const { deps, err } = makeDeps();

    const code = await runJamalCommand(['app', 'bogus'], deps);

    assert.equal(code, 2);
    assert.match(err.join('\n'), /a verb is required/);
  });

  it('rejects an unknown flag as a usage error', async () => {
    const { deps, err } = makeDeps();

    const code = await runJamalCommand(['app', 'start', '--bogus'], deps);

    assert.equal(code, 2);
    assert.match(err.join('\n'), /Unknown option/);
  });

  it('rejects --follow on a non-logs verb', async () => {
    const { deps, err } = makeDeps();

    const code = await runJamalCommand(['app', 'start', '--follow'], deps);

    assert.equal(code, 2);
    assert.match(err.join('\n'), /--follow is only valid for `jamal app logs`/);
  });

  it('prints app usage on --help without loading config', async () => {
    const { deps, out } = makeDeps();

    const code = await runJamalCommand(['app', '--help'], deps);

    assert.equal(code, 0);
    const output = out.join('\n');
    assert.match(output, /jamal app - manage the app container/);
    assert.match(output, /boot\b/);
    assert.match(output, /start\b/);
    assert.match(output, /stop\b/);
    assert.match(output, /details\b/);
    assert.match(output, /containers\b/);
    assert.match(output, /logs \[--follow\]/);
    assert.match(output, /exec -- <cmd\.\.\.>/);
    assert.match(output, /--follow/);
    assert.match(output, /--dry-run/);
  });

  it('reports a non-zero remote exit code value-free', async () => {
    const { deps, out, err } = makeDeps({ exitCode: 7, remoteStdout: 'info\n' });

    const code = await runJamalCommand(['app', 'start'], deps);

    assert.equal(code, 7);
    assert.match(out.join('\n'), /info/);
    assert.match(err.join('\n'), /app start exited with code 7/);
  });

  it('--dry-run makes no remote calls', async () => {
    const container = containerForTag('myapp', TAG);
    const { deps, out, calls } = makeDeps();

    const code = await runJamalCommand(['app', 'start', '--dry-run'], deps);

    assert.equal(code, 0);
    assert.equal(calls.length, 0);
    assert.match(
      out.join('\n'),
      new RegExp(`\\[dry-run\\] ssh 1\\.2\\.3\\.4 docker start ${container}`),
    );
  });

  it('containers does not require deploy history', async () => {
    const { deps, calls } = makeDeps({ deployHistory: undefined as unknown as DeployHistory });

    const code = await runJamalCommand(['app', 'containers'], deps);

    assert.equal(code, 0);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.remoteArgv, ['docker', 'ps', '-a', '--filter', 'name=myapp']);
  });
});
