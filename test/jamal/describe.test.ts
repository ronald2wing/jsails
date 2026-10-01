import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  describeJamal,
  planLaunchArgv,
  planSshArgv,
  DescribeError,
} from '../../src/jamal/describe.js';
import type { JamalConfig } from '../../src/jamal/config.js';

/**
 * Build a minimal JamalConfig for tests. `env` and `services` default to empty.
 */
function config(overrides: Partial<JamalConfig> = {}): JamalConfig {
  return {
    service: 'app',
    image: 'myapp:latest',
    command: undefined,
    health: undefined,
    env: {},
    services: {},
    volumes: {},
    local: { ports: {}, build: false },
    production: undefined,
    logging: undefined,
    ...overrides,
  };
}

describe('describeJamal', () => {
  it('projects service and empty server/domain when no production config', () => {
    const info = describeJamal(config());

    assert.equal(info.service, 'app');
    assert.equal(info.server, undefined);
    assert.equal(info.domain, undefined);
    assert.deepEqual(info.ports, {});
    assert.deepEqual(info.services, []);
  });

  it('projects server and domain from production config', () => {
    const info = describeJamal(
      config({
        production: {
          server: '1.2.3.4',
          domain: 'example.com',
          onDemandTlsUrl: undefined,
          registry: undefined,
          ssh: undefined,
        },
      }),
    );

    assert.equal(info.server, '1.2.3.4');
    assert.equal(info.domain, 'example.com');
  });

  it('projects local ports', () => {
    const info = describeJamal(
      config({
        local: { ports: { web: 8080, api: 9090 }, build: true },
      }),
    );

    assert.deepEqual(info.ports, { web: 8080, api: 9090 });
  });

  it('projects declared service names', () => {
    const info = describeJamal(
      config({
        services: {
          db: { type: 'mariadb' },
          cache: { type: 'valkey' },
        },
      }),
    );

    assert.deepEqual(info.services, ['db', 'cache']);
  });

  it('never projects env values', () => {
    const info = describeJamal(
      config({
        env: { SECRET: { value: 's3cret', alias: undefined, clear: false } },
      }),
    );

    // env is never visible in DescribeInfo.
    assert.equal('env' in info, false);
    assert.deepEqual(Reflect.ownKeys(info).sort(), [
      'domain',
      'ports',
      'server',
      'service',
      'services',
    ]);
  });
});

describe('planLaunchArgv', () => {
  it('returns ["xdg-open", url] on non-darwin platforms', () => {
    const savedPlatform = process.platform;
    try {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      const argv = planLaunchArgv('https://example.com');
      assert.deepEqual(argv, ['xdg-open', 'https://example.com']);
    } finally {
      Object.defineProperty(process, 'platform', { value: savedPlatform });
    }
  });

  it('returns ["open", url] on darwin', () => {
    const savedPlatform = process.platform;
    try {
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      const argv = planLaunchArgv('http://localhost:3000');
      assert.deepEqual(argv, ['open', 'http://localhost:3000']);
    } finally {
      Object.defineProperty(process, 'platform', { value: savedPlatform });
    }
  });

  it('rejects a non-http(s) URL value-free', () => {
    assert.throws(
      () => planLaunchArgv('ftp://example.com'),
      (error: unknown) => {
        assert.ok(error instanceof DescribeError);
        assert.match(error.message, /must start with/);
        return true;
      },
    );
  });

  it('rejects an empty URL value-free', () => {
    assert.throws(
      () => planLaunchArgv(''),
      (error: unknown) => {
        assert.ok(error instanceof DescribeError);
        return true;
      },
    );
  });

  it('rejects a URL with control characters value-free', () => {
    assert.throws(
      () => planLaunchArgv('http://example.com\u0000'),
      (error: unknown) => {
        assert.ok(error instanceof DescribeError);
        return true;
      },
    );
  });
});

describe('planSshArgv', () => {
  it('returns ["ssh"] when no production config', () => {
    const argv = planSshArgv(config());
    assert.deepEqual(argv, ['ssh']);
  });

  it('emits ssh argv with server and default batch mode', () => {
    const argv = planSshArgv(
      config({
        production: {
          server: '1.2.3.4',
          domain: undefined,
          onDemandTlsUrl: undefined,
          registry: undefined,
          ssh: undefined,
        },
      }),
    );

    assert.deepEqual(argv, ['ssh', '-o', 'BatchMode=yes', '1.2.3.4']);
  });

  it('includes ssh user when configured', () => {
    const argv = planSshArgv(
      config({
        production: {
          server: '1.2.3.4',
          domain: undefined,
          onDemandTlsUrl: undefined,
          registry: undefined,
          ssh: {
            user: 'deploy',
            port: undefined,
            proxyCommand: undefined,
            logLevel: undefined,
            keysOnly: false,
            keys: [],
            config: undefined,
            forwardAgent: false,
          },
        },
      }),
    );

    assert.deepEqual(argv, ['ssh', '-o', 'BatchMode=yes', 'deploy@1.2.3.4']);
  });

  it('includes ssh keys when configured', () => {
    const argv = planSshArgv(
      config({
        production: {
          server: 'server.example',
          domain: undefined,
          onDemandTlsUrl: undefined,
          registry: undefined,
          ssh: {
            user: undefined,
            port: undefined,
            proxyCommand: undefined,
            logLevel: undefined,
            keysOnly: false,
            keys: ['~/.ssh/id_rsa', '~/.ssh/deploy_key'],
            config: undefined,
            forwardAgent: false,
          },
        },
      }),
    );

    assert.deepEqual(argv, [
      'ssh',
      '-o',
      'BatchMode=yes',
      '-i',
      '~/.ssh/id_rsa',
      '-i',
      '~/.ssh/deploy_key',
      'server.example',
    ]);
  });
});
