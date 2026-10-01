import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runJamalCommand, type JamalDeps } from '../../src/jamal/command.js';
import { normalizeJamalConfig, type JamalConfig } from '../../src/jamal/config.js';
import type { DeployHistory } from '../../src/jamal/production/history.js';
import { containerNameForTag } from '../../src/jamal/production/plan.js';
import {
  proxyDeployArgv,
  proxyListArgv,
  proxyRemoveServiceArgv,
} from '../../src/jamal/production/proxy.js';
import type { RemoteRunner } from '../../src/jamal/production/transport.js';

/**
 * Tests for the `jamal domain` verbs. Every seam (config loader, remote runner,
 * history reader) is injected, so no ssh, docker, or disk access happens: the
 * assertions target the exact remote argv each verb assembles, the `--dry-run`
 * output, the positional/flag validation, and the value-free failure paths.
 */

interface RecordedRemote {
  server: string;
  remoteArgv: string[];
}

const TAG = 'abc123';

function domainConfig(overrides: { service?: string; server?: string } = {}): JamalConfig {
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

interface DomainHarness {
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
): DomainHarness {
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
      throw new Error('registry must not be built for domain');
    },
    loadJamalConfig: async () => overrides.config ?? domainConfig(),
    readHistory: async () => overrides.deployHistory ?? history(),
    remoteRunner: remote,
    cwd: '/project',
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
  };
  return { deps, out, err, calls };
}

describe('jamal domain add', () => {
  it('routes the host to the latest deploy over ssh, terminating TLS by default', async () => {
    const { deps, calls, err } = makeDeps();

    const code = await runJamalCommand(['domain', 'add', 'example.com'], deps);

    assert.equal(code, 0, err.join('\n'));
    assert.deepEqual(calls, [
      {
        server: '1.2.3.4',
        remoteArgv: [
          ...proxyDeployArgv({
            service: 'myapp',
            target: containerNameForTag('myapp', TAG),
            host: 'example.com',
            tls: true,
          }),
        ],
      },
    ]);
  });

  it('omits --tls with --no-tls', async () => {
    const { deps, calls } = makeDeps();

    const code = await runJamalCommand(['domain', 'add', 'example.com', '--no-tls'], deps);

    assert.equal(code, 0);
    assert.deepEqual(calls[0]?.remoteArgv, [
      ...proxyDeployArgv({
        service: 'myapp',
        target: containerNameForTag('myapp', TAG),
        host: 'example.com',
        tls: false,
      }),
    ]);
    assert.ok(!calls[0]?.remoteArgv.includes('--tls'));
  });

  it('honors --service as the backend service name', async () => {
    const { deps, calls } = makeDeps();

    const code = await runJamalCommand(['domain', 'add', 'example.com', '--service', 'web'], deps);

    assert.equal(code, 0);
    assert.deepEqual(calls[0]?.remoteArgv, [
      ...proxyDeployArgv({
        service: 'web',
        target: containerNameForTag('web', TAG),
        host: 'example.com',
        tls: true,
      }),
    ]);
  });

  it('--dry-run prints the exact ssh argv and never runs it', async () => {
    const { deps, out, calls } = makeDeps();

    const code = await runJamalCommand(['domain', 'add', 'example.com', '--dry-run'], deps);

    assert.equal(code, 0);
    assert.equal(calls.length, 0);
    assert.match(
      out.join('\n'),
      new RegExp(
        '\\[dry-run\\] ssh -o BatchMode=yes 1\\.2\\.3\\.4 docker exec kamal-proxy ' +
          'kamal-proxy deploy myapp --target myapp-web-abc123 --host example\\.com --tls',
      ),
    );
  });

  it('fails value-free when no deploy history has been recorded', async () => {
    const { deps, err, calls } = makeDeps({ deployHistory: { version: 1, entries: [] } });

    const code = await runJamalCommand(['domain', 'add', 'example.com'], deps);

    assert.equal(code, 1);
    assert.equal(calls.length, 0);
    assert.match(err.join('\n'), /no deploy history to route a domain/);
  });

  it('requires a host', async () => {
    const { deps, err, calls } = makeDeps();

    const code = await runJamalCommand(['domain', 'add'], deps);

    assert.equal(code, 2);
    assert.equal(calls.length, 0);
    assert.match(err.join('\n'), /requires a host/);
  });

  it('rejects invalid host values as usage errors, value-free', async () => {
    for (const bad of [
      'https://example.com',
      'Example.COM',
      '*.example.com',
      'has space',
      'example.com/check',
      'example.com:443',
      'user@example.com',
    ]) {
      const { deps, err, calls } = makeDeps();
      const code = await runJamalCommand(['domain', 'add', bad], deps);
      assert.equal(code, 2, `expected usage error for ${JSON.stringify(bad)}`);
      assert.equal(calls.length, 0);
      assert.ok(
        !err.join('\n').includes(bad),
        `${JSON.stringify(bad)} must not leak into the error message`,
      );
    }
  });

  it('rejects an unknown flag as a usage error', async () => {
    const { deps, err } = makeDeps();

    const code = await runJamalCommand(['domain', 'add', 'example.com', '--bogus'], deps);

    assert.equal(code, 2);
    assert.match(err.join('\n'), /Unknown option/);
  });
});

describe('jamal domain remove', () => {
  it('removes the service (and its host) via the proxy remove argv', async () => {
    const { deps, calls, err } = makeDeps();

    const code = await runJamalCommand(['domain', 'remove', 'example.com'], deps);

    assert.equal(code, 0, err.join('\n'));
    assert.deepEqual(calls, [
      { server: '1.2.3.4', remoteArgv: [...proxyRemoveServiceArgv({ service: 'myapp' })] },
    ]);
  });

  it('honors --service and validates the host', async () => {
    const { deps, calls } = makeDeps();

    const code = await runJamalCommand(
      ['domain', 'remove', 'example.com', '--service', 'web'],
      deps,
    );

    assert.equal(code, 0);
    assert.deepEqual(calls[0]?.remoteArgv, [...proxyRemoveServiceArgv({ service: 'web' })]);
  });

  it('requires a host', async () => {
    const { deps, err } = makeDeps();

    const code = await runJamalCommand(['domain', 'remove'], deps);

    assert.equal(code, 2);
    assert.match(err.join('\n'), /requires a host/);
  });
});

describe('jamal domain list', () => {
  it('runs the proxy list argv and forwards its output verbatim', async () => {
    const { deps, out, calls, err } = makeDeps({ remoteStdout: 'myapp example.com\n' });

    const code = await runJamalCommand(['domain', 'list'], deps);

    assert.equal(code, 0, err.join('\n'));
    assert.deepEqual(calls, [{ server: '1.2.3.4', remoteArgv: [...proxyListArgv()] }]);
    assert.match(out.join('\n'), /myapp example\.com/);
  });

  it('rejects extra positionals', async () => {
    const { deps, err } = makeDeps();

    const code = await runJamalCommand(['domain', 'list', 'extra'], deps);

    assert.equal(code, 2);
    assert.match(err.join('\n'), /unexpected argument/);
  });
});

describe('jamal domain: config and subcommand handling', () => {
  it('requires config.production', async () => {
    const { deps, err } = makeDeps({
      config: normalizeJamalConfig({ service: 'myapp', image: 'ghcr.io/acme/myapp' }),
    });

    const code = await runJamalCommand(['domain', 'list'], deps);

    assert.equal(code, 1);
    assert.match(err.join('\n'), /config\.production is required/);
  });

  it('reports an unknown subcommand as a usage error', async () => {
    const { deps, err } = makeDeps();

    const code = await runJamalCommand(['domain', 'bogus'], deps);

    assert.equal(code, 2);
    assert.match(err.join('\n'), /subcommand is required \(add \| list \| remove\)/);
  });

  it('prints the domain usage on --help without loading config', async () => {
    const { deps, out } = makeDeps();

    const code = await runJamalCommand(['domain', '--help'], deps);

    assert.equal(code, 0);
    assert.match(out.join('\n'), /jamal domain - manage the proxy/);
    assert.match(out.join('\n'), /add <host>/);
    assert.match(out.join('\n'), /remove <host>/);
    assert.match(out.join('\n'), /--no-tls/);
  });

  it('reports a non-zero remote exit code value-free', async () => {
    const { deps, out, err } = makeDeps({ exitCode: 7, remoteStdout: 'routing\n' });

    const code = await runJamalCommand(['domain', 'list'], deps);

    assert.equal(code, 7);
    assert.match(out.join('\n'), /routing/);
    assert.match(err.join('\n'), /domain list exited with code 7/);
  });
});
