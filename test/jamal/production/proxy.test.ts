import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ProxyError,
  PROXY_CONFIG_MOUNT,
  PROXY_CONFIG_VOLUME_DEFAULT,
  PROXY_CONTAINER_NAME,
  PROXY_HTTP_PORT_DEFAULT,
  PROXY_HTTPS_PORT_DEFAULT,
  PROXY_IMAGE_DEFAULT,
  proxyBoot,
  proxyBootArgv,
  proxyDeployArgv,
  proxyDeployService,
  proxyList,
  proxyListArgv,
  proxyRemoveService,
  proxyRemoveServiceArgv,
  proxyStatus,
  proxyStatusArgv,
} from '../../../src/jamal/production/proxy.js';
import type { CommandResult } from '../../../src/jamal/production/command-runner.js';
import type { RemoteRunner } from '../../../src/jamal/production/transport.js';

/**
 * Tests for the kamal-proxy component control. The pure argv builders are
 * asserted directly (exact argv shapes and validation), and the executors run
 * against a recording fake {@link RemoteRunner}, so no ssh or docker command is
 * ever spawned: assertions target the exact remote argv, non-zero exit
 * handling, and the value-free error messages.
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

describe('proxyBootArgv: argv shape', () => {
  it('emits the default boot argv (image, config volume, ports 80/443)', () => {
    assert.deepEqual(proxyBootArgv(), [
      'docker',
      'run',
      '-d',
      '--restart',
      'unless-stopped',
      '--name',
      PROXY_CONTAINER_NAME,
      '-p',
      '80:80',
      '-p',
      '443:443',
      '-v',
      `${PROXY_CONFIG_VOLUME_DEFAULT}:${PROXY_CONFIG_MOUNT}`,
      PROXY_IMAGE_DEFAULT,
      'kamal-proxy',
      'run',
    ]);
  });

  it('honors a custom image, config volume, and ports', () => {
    assert.deepEqual(
      proxyBootArgv({
        image: 'ghcr.io/acme/kamal-proxy:edge',
        configVolume: 'cfg',
        httpPort: 8080,
        httpsPort: 8443,
      }),
      [
        'docker',
        'run',
        '-d',
        '--restart',
        'unless-stopped',
        '--name',
        PROXY_CONTAINER_NAME,
        '-p',
        '8080:80',
        '-p',
        '8443:443',
        '-v',
        `cfg:${PROXY_CONFIG_MOUNT}`,
        'ghcr.io/acme/kamal-proxy:edge',
        'kamal-proxy',
        'run',
      ],
    );
  });

  it('exposes the documented default constants', () => {
    assert.equal(PROXY_IMAGE_DEFAULT, 'basecamp/kamal-proxy:v0.10.0');
    assert.equal(PROXY_CONFIG_VOLUME_DEFAULT, 'kamal-proxy-config');
    assert.equal(PROXY_HTTP_PORT_DEFAULT, 80);
    assert.equal(PROXY_HTTPS_PORT_DEFAULT, 443);
  });
});

describe('proxyDeployArgv: argv shape', () => {
  it('emits service, target, and host without TLS flags', () => {
    assert.deepEqual(
      proxyDeployArgv({ service: 'app', target: 'app-web-100', host: 'example.com' }),
      [
        'docker',
        'exec',
        PROXY_CONTAINER_NAME,
        'kamal-proxy',
        'deploy',
        'app',
        '--target',
        'app-web-100',
        '--host',
        'example.com',
      ],
    );
  });

  it('appends --tls when tls is true and keeps it absent when false/omitted', () => {
    assert.deepEqual(
      proxyDeployArgv({ service: 'app', target: 'app-web-100', host: 'example.com', tls: true }),
      [
        'docker',
        'exec',
        PROXY_CONTAINER_NAME,
        'kamal-proxy',
        'deploy',
        'app',
        '--target',
        'app-web-100',
        '--host',
        'example.com',
        '--tls',
      ],
    );
    assert.ok(
      !proxyDeployArgv({
        service: 'app',
        target: 'app-web-100',
        host: 'example.com',
        tls: false,
      }).includes('--tls'),
    );
  });

  it('appends --health-check-path after --host', () => {
    assert.deepEqual(
      proxyDeployArgv({
        service: 'app',
        target: 'app-web-100',
        host: 'example.com',
        healthCheckPath: '/up',
      }),
      [
        'docker',
        'exec',
        PROXY_CONTAINER_NAME,
        'kamal-proxy',
        'deploy',
        'app',
        '--target',
        'app-web-100',
        '--host',
        'example.com',
        '--health-check-path',
        '/up',
      ],
    );
  });

  it('omits --host and emits --tls-on-demand-url when an on-demand URL is set', () => {
    const argv = proxyDeployArgv({
      service: 'app',
      target: 'app-web-100',
      host: 'example.com',
      onDemandTlsUrl: 'https://tls.example.com',
    });
    assert.ok(!argv.includes('--host'), '--host must be omitted with on-demand TLS');
    assert.ok(!argv.includes('example.com'), 'the static host must not appear with on-demand TLS');
    assert.deepEqual(argv, [
      'docker',
      'exec',
      PROXY_CONTAINER_NAME,
      'kamal-proxy',
      'deploy',
      'app',
      '--target',
      'app-web-100',
      '--tls-on-demand-url',
      'https://tls.example.com',
    ]);
  });

  it('combines --tls and --tls-on-demand-url (host omitted) in fixed order', () => {
    assert.deepEqual(
      proxyDeployArgv({
        service: 'app',
        target: 'app-web-100',
        onDemandTlsUrl: '/check',
        tls: true,
      }),
      [
        'docker',
        'exec',
        PROXY_CONTAINER_NAME,
        'kamal-proxy',
        'deploy',
        'app',
        '--target',
        'app-web-100',
        '--tls',
        '--tls-on-demand-url',
        '/check',
      ],
    );
  });
});

describe('proxyRemoveServiceArgv / proxyListArgv / proxyStatusArgv', () => {
  it('removes a service with the fixed docker exec argv', () => {
    assert.deepEqual(proxyRemoveServiceArgv({ service: 'app' }), [
      'docker',
      'exec',
      PROXY_CONTAINER_NAME,
      'kamal-proxy',
      'remove',
      'app',
    ]);
  });

  it('lists services with the fixed docker exec argv', () => {
    assert.deepEqual(proxyListArgv(), [
      'docker',
      'exec',
      PROXY_CONTAINER_NAME,
      'kamal-proxy',
      'list',
    ]);
  });

  it('queries status with docker inspect', () => {
    assert.deepEqual(proxyStatusArgv(), ['docker', 'inspect', PROXY_CONTAINER_NAME]);
  });
});

describe('S8: path-prefix routing', () => {
  it('emits --path-prefix and --strip-path-prefix after --target', () => {
    assert.deepEqual(
      proxyDeployArgv({
        service: 'app',
        target: 'app-web-100',
        host: 'example.com',
        pathPrefix: '/app',
        stripPathPrefix: true,
      }),
      [
        'docker',
        'exec',
        PROXY_CONTAINER_NAME,
        'kamal-proxy',
        'deploy',
        'app',
        '--target',
        'app-web-100',
        '--path-prefix',
        '/app',
        '--strip-path-prefix',
        '--host',
        'example.com',
      ],
    );
  });

  it('emits only --path-prefix without --strip-path-prefix when the latter is absent', () => {
    assert.deepEqual(
      proxyDeployArgv({ service: 'app', target: 't', host: 'h', pathPrefix: '/api' }),
      [
        'docker',
        'exec',
        PROXY_CONTAINER_NAME,
        'kamal-proxy',
        'deploy',
        'app',
        '--target',
        't',
        '--path-prefix',
        '/api',
        '--host',
        'h',
      ],
    );
  });

  it('pathPrefix not starting with "/" is rejected value-free', () => {
    assert.throws(
      () => proxyDeployArgv({ service: 'app', target: 't', host: 'h', pathPrefix: 'app' }),
      (error: unknown) => {
        assert.ok(error instanceof ProxyError);
        assert.ok(!error.message.includes('app'), 'bad value must not leak');
        return true;
      },
    );
  });

  it('pathPrefix with whitespace is rejected value-free', () => {
    assert.throws(
      () => proxyDeployArgv({ service: 'app', target: 't', host: 'h', pathPrefix: '/a b' }),
      ProxyError,
    );
  });
});

describe('S9: TLS staging toggle', () => {
  it('emits --tls-staging after --tls when both are set', () => {
    assert.deepEqual(
      proxyDeployArgv({
        service: 'app',
        target: 'app-web-100',
        host: 'example.com',
        tls: true,
        tlsStaging: true,
      }),
      [
        'docker',
        'exec',
        PROXY_CONTAINER_NAME,
        'kamal-proxy',
        'deploy',
        'app',
        '--target',
        'app-web-100',
        '--host',
        'example.com',
        '--tls',
        '--tls-staging',
      ],
    );
  });

  it('rejects tlsStaging without tls, value-free', () => {
    assert.throws(
      () =>
        proxyDeployArgv({
          service: 'app',
          target: 't',
          host: 'h',
          tlsStaging: true,
        }),
      (error: unknown) => {
        assert.ok(error instanceof ProxyError);
        return true;
      },
    );
  });
});

describe('S10: proxy tuning, header/host controls, and metrics port', () => {
  it('metricsPort on boot emits -p <port>:9090', () => {
    assert.deepEqual(proxyBootArgv({ metricsPort: 9090 }), [
      'docker',
      'run',
      '-d',
      '--restart',
      'unless-stopped',
      '--name',
      PROXY_CONTAINER_NAME,
      '-p',
      '80:80',
      '-p',
      '443:443',
      '-p',
      '9090:9090',
      '-v',
      `${PROXY_CONFIG_VOLUME_DEFAULT}:${PROXY_CONFIG_MOUNT}`,
      PROXY_IMAGE_DEFAULT,
      'kamal-proxy',
      'run',
    ]);
  });

  it('emits a representative multi-option deploy in fixed documented order', () => {
    assert.deepEqual(
      proxyDeployArgv({
        service: 'svc',
        target: 'svc-100',
        host: 'example.com',
        targetTimeout: '30s',
        maxRequestBody: '10m',
        maxResponseBody: '20m',
        healthCheckInterval: '5s',
        healthCheckTimeout: '3s',
        canonicalHost: 'canonical.example.com',
        tlsRedirect: true,
        forwardHeaders: true,
        clientIpHeader: 'X-Real-IP',
        scopeCookie: 'jsails_scope',
        excludeMetrics: true,
        logRequestHeader: 'X-Request-Id',
        logResponseHeader: 'X-Response-Id',
        metricsPort: 9090,
      }),
      [
        'docker',
        'exec',
        PROXY_CONTAINER_NAME,
        'kamal-proxy',
        'deploy',
        'svc',
        '--target',
        'svc-100',
        '--host',
        'example.com',
        '--target-timeout',
        '30s',
        '--max-request-body',
        '10m',
        '--max-response-body',
        '20m',
        '--health-check-interval',
        '5s',
        '--health-check-timeout',
        '3s',
        '--canonical-host',
        'canonical.example.com',
        '--tls-redirect',
        '--forward-headers',
        '--client-ip-header',
        'X-Real-IP',
        '--scope-cookie',
        'jsails_scope',
        '--exclude-metrics',
        '--log-request-header',
        'X-Request-Id',
        '--log-response-header',
        'X-Response-Id',
        '--metrics-port',
        '9090',
      ],
    );
  });

  it('rejects an option value with whitespace, value-free', () => {
    assert.throws(
      () =>
        proxyDeployArgv({
          service: 'app',
          target: 't',
          host: 'h',
          canonicalHost: 'bad host',
        }),
      ProxyError,
    );
  });

  it('rejects metricsPort outside 1..65535, value-free', () => {
    for (const port of [0, 65536, -1, 1.5, Number.NaN]) {
      assert.throws(() => proxyBootArgv({ metricsPort: port }), ProxyError);
    }
  });
});

describe('proxy argv validation', () => {
  it('rejects whitespace, control, empty, and leading-dash values, value-free', () => {
    const bad = ['', 'has space', 'tab\tx', 'ctrl\u0001', '-f'];
    for (const value of bad) {
      assert.throws(
        () => proxyDeployArgv({ service: value, target: 't', host: 'h' }),
        (error: unknown) => {
          assert.ok(error instanceof ProxyError);
          if (value.length > 0) {
            assert.ok(!error.message.includes(value), `${JSON.stringify(value)} must not leak`);
          }
          return true;
        },
      );
      assert.throws(() => proxyRemoveServiceArgv({ service: value }), ProxyError);
    }
  });

  it('requires a host unless an on-demand URL is present', () => {
    assert.throws(
      () => proxyDeployArgv({ service: 'app', target: 't' }),
      (error: unknown) => error instanceof ProxyError && /proxy host/.test(error.message),
    );
    assert.throws(() => proxyDeployArgv({ service: 'app', target: 't', host: '' }), ProxyError);
  });

  it('rejects an invalid image, config volume, and ports, value-free', () => {
    assert.throws(() => proxyBootArgv({ image: 'bad image' }), ProxyError);
    assert.throws(() => proxyBootArgv({ configVolume: '-cfg' }), ProxyError);
    for (const port of [0, 65536, -1, 1.5, Number.NaN]) {
      assert.throws(
        () => proxyBootArgv({ httpPort: port }),
        (error: unknown) => error instanceof ProxyError && /HTTP port/.test(error.message),
      );
      assert.throws(() => proxyBootArgv({ httpsPort: port }), ProxyError);
    }
  });
});

describe('proxy executors over a remote runner', () => {
  it('proxyBoot runs the boot argv on the given server', async () => {
    const { remote, calls } = makeRemote(() => ok);
    await proxyBoot(remote, '1.2.3.4');
    assert.deepEqual(calls, [{ server: '1.2.3.4', remoteArgv: [...proxyBootArgv()] }]);
  });

  it('proxyDeployService runs the deploy argv on the given server', async () => {
    const { remote, calls } = makeRemote(() => ok);
    await proxyDeployService(remote, '1.2.3.4', {
      service: 'app',
      target: 'app-web-100',
      host: 'example.com',
      tls: true,
    });
    assert.deepEqual(calls, [
      {
        server: '1.2.3.4',
        remoteArgv: [
          'docker',
          'exec',
          PROXY_CONTAINER_NAME,
          'kamal-proxy',
          'deploy',
          'app',
          '--target',
          'app-web-100',
          '--host',
          'example.com',
          '--tls',
        ],
      },
    ]);
  });

  it('proxyRemoveService and proxyList run their argv on the given server', async () => {
    const removeRemote = makeRemote(() => ok);
    await proxyRemoveService(removeRemote.remote, 'srv', { service: 'app' });
    assert.deepEqual(removeRemote.calls, [
      {
        server: 'srv',
        remoteArgv: ['docker', 'exec', PROXY_CONTAINER_NAME, 'kamal-proxy', 'remove', 'app'],
      },
    ]);

    const listRemote = makeRemote(() => ok);
    await proxyList(listRemote.remote, 'srv');
    assert.deepEqual(listRemote.calls, [
      {
        server: 'srv',
        remoteArgv: ['docker', 'exec', PROXY_CONTAINER_NAME, 'kamal-proxy', 'list'],
      },
    ]);
  });

  it('proxyList resolves with the command result on success', async () => {
    const result: CommandResult = { exitCode: 0, stdout: 'app\n', stderr: '' };
    const { remote } = makeRemote(() => result);
    assert.equal(await proxyList(remote, 'srv'), result);
  });
});

describe('proxy executors: non-zero exit handling', () => {
  it('throws a value-free ProxyError naming only the operation and exit code', async () => {
    const cases: Array<{ name: string; run: (remote: RemoteRunner) => Promise<unknown> }> = [
      { name: 'proxy boot', run: (r) => proxyBoot(r, 'srv') },
      {
        name: 'proxy deploy',
        run: (r) => proxyDeployService(r, 'srv', { service: 'app', target: 't', host: 'h' }),
      },
      { name: 'proxy remove', run: (r) => proxyRemoveService(r, 'srv', { service: 'app' }) },
      { name: 'proxy list', run: (r) => proxyList(r, 'srv') },
    ];
    for (const entry of cases) {
      const { remote } = makeRemote(() => ({
        exitCode: 7,
        stdout: 'secret stdout',
        stderr: 'denied',
      }));
      await assert.rejects(
        () => entry.run(remote),
        (error: unknown) => {
          assert.ok(error instanceof ProxyError);
          assert.equal(error.message, `${entry.name} exited with code 7`);
          assert.ok(!error.message.includes('secret'), 'output must not leak');
          return true;
        },
      );
    }
  });

  it('proxyStatus resolves true on a zero exit and false on a non-zero exit', async () => {
    const up = makeRemote(() => ok);
    assert.equal(await proxyStatus(up.remote, 'srv'), true);
    assert.deepEqual(up.calls, [
      { server: 'srv', remoteArgv: ['docker', 'inspect', PROXY_CONTAINER_NAME] },
    ]);

    const down = makeRemote(() => ({ exitCode: 1, stdout: '', stderr: '' }));
    assert.equal(await proxyStatus(down.remote, 'srv'), false);
  });
});
