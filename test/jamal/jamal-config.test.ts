import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import {
  DEFAULT_JAMAL_CONFIG_PATH,
  JamalConfigError,
  SecretRef,
  loadJamalConfig,
  normalizeJamalConfig,
  redactJamalConfig,
  secret,
} from '../../src/jamal/config.js';

/**
 * Tests for the Jamal v1 config model. Config modules are written under the
 * project tree (not `os.tmpdir()`) so they inherit `"type": "module"` and load
 * as ESM, exactly as the app-config loader tests do. No service is contacted,
 * no file is written by the config layer, and no secret is resolved.
 */

const fixturesRoot = mkdtempSync(
  join(fileURLToPath(new URL('..', import.meta.url)), 'jamal-config-fixture-'),
);

after(() => {
  rmSync(fixturesRoot, { recursive: true, force: true });
});

function makeDir(name: string): string {
  const dir = join(fixturesRoot, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Relative import specifier from a fixture's config module to the compiled config module. */
function secretModuleSpecifier(dir: string): string {
  const from = join(dir, DEFAULT_JAMAL_CONFIG_PATH);
  const to = fileURLToPath(new URL('../../src/jamal/config.js', import.meta.url));
  const rel = relative(dirname(from), to).replaceAll('\\', '/');
  return rel.startsWith('.') ? rel : `./${rel}`;
}

function writeConfig(dir: string, body: string): string {
  const path = join(dir, DEFAULT_JAMAL_CONFIG_PATH);
  writeFileSync(path, body);
  return path;
}

/** A full valid config for reuse, without secret refs so it can be JSON-cloned. */
function fullConfig(): Record<string, unknown> {
  return {
    service: 'myapp',
    image: 'ghcr.io/acme/myapp:git-sha',
    command: 'node server.js',
    health: { path: '/up', timeoutMs: 5000, intervalMs: 30000 },
    env: { NODE_ENV: 'production' },
    services: {
      db: { type: 'mariadb' },
      cache: { type: 'valkey' },
    },
    volumes: { storage: '/app/storage', data: '/var/lib/mysql' },
    local: { ports: { web: 3000 }, build: true },
    production: {
      server: '1.2.3.4',
      domain: 'example.com',
      registry: { server: 'ghcr.io', username: 'acme' },
    },
  };
}

/** Capture a thrown JamalConfigError. */
function capture(fn: () => unknown): JamalConfigError {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof JamalConfigError, `expected JamalConfigError, got ${String(error)}`);
    return error;
  }
  throw new Error('expected a JamalConfigError, but nothing was thrown');
}

describe('secret()', () => {
  it('returns a SecretRef with a non-leaking redacted string form', () => {
    const ref = secret('DB_PASSWORD');
    assert.ok(ref instanceof SecretRef);
    assert.equal(ref.name, 'DB_PASSWORD');
    assert.equal(ref.toString(), 'secret(DB_PASSWORD)');
    assert.equal(JSON.stringify(ref), '"secret(DB_PASSWORD)"');
    assert.equal(JSON.stringify({ PASSWORD: ref }), '{"PASSWORD":"secret(DB_PASSWORD)"}');
  });

  it('rejects empty, whitespace, and control-character names', () => {
    for (const name of ['', '  ', 'has space', 'line\nbreak', 'tab\tx', 'ctrl\u0001']) {
      const error = capture(() => secret(name));
      if (name !== '') {
        assert.ok(!error.message.includes(name), `name ${JSON.stringify(name)} must not leak`);
      }
    }
  });

  it('is not spoofable by a plain object', () => {
    const plain = { name: 'DB_PASSWORD' };
    assert.ok(!(plain instanceof SecretRef));
    assert.notEqual(plain.toString(), 'secret(DB_PASSWORD)');
  });
});

describe('normalizeJamalConfig: valid config', () => {
  it('normalizes a full config into the typed frozen model', () => {
    const model = normalizeJamalConfig({
      ...fullConfig(),
      env: { NODE_ENV: 'production', DB_PASSWORD: secret('DB_PASSWORD') },
    });

    assert.equal(model.service, 'myapp');
    assert.equal(model.image, 'ghcr.io/acme/myapp:git-sha');
    assert.equal(model.command, 'node server.js');
    assert.deepEqual(model.health, {
      path: '/up',
      timeoutMs: 5000,
      intervalMs: 30000,
      retries: undefined,
      retryDelayMs: undefined,
      readinessDelayMs: undefined,
    });
    assert.equal(model.env['NODE_ENV']?.value, 'production');
    const dbPassword = model.env['DB_PASSWORD']?.value;
    assert.ok(dbPassword instanceof SecretRef);
    assert.equal(dbPassword.name, 'DB_PASSWORD');
    assert.deepEqual(model.services, {
      db: { type: 'mariadb' },
      cache: { type: 'valkey' },
    });
    assert.deepEqual(model.volumes, {
      storage: {
        source: 'storage',
        containerPath: '/app/storage',
        options: undefined,
        host: false,
      },
      data: { source: 'data', containerPath: '/var/lib/mysql', options: undefined, host: false },
    });
    assert.deepEqual(model.local, { ports: { web: 3000 }, build: true });
    assert.deepEqual(model.production, {
      server: '1.2.3.4',
      domain: 'example.com',
      onDemandTlsUrl: undefined,
      registry: { server: 'ghcr.io', username: 'acme' },
      ssh: undefined,
    });
  });

  it('applies defaults for omitted optional sections', () => {
    const model = normalizeJamalConfig({ service: 'app', image: 'img' });

    assert.equal(model.command, undefined);
    assert.equal(model.health, undefined);
    assert.deepEqual(model.env, {});
    assert.deepEqual(model.services, {});
    assert.deepEqual(model.volumes, {});
    assert.deepEqual(model.local, { ports: {}, build: false });
    assert.equal(model.production, undefined);
  });
});

describe('normalizeJamalConfig: overlay merge semantics', () => {
  it('merges base + overlays non-destructively with defaults for absent fields', () => {
    const raw = {
      service: 'app',
      image: 'img',
      env: { A: '1' },
      local: { ports: { web: 8080 } },
      production: { server: '10.0.0.1' },
    };

    const model = normalizeJamalConfig(raw);

    assert.equal(model.service, 'app');
    assert.equal(model.image, 'img');
    assert.deepEqual(model.env, { A: { value: '1', alias: undefined, clear: false } });
    assert.deepEqual(model.local, { ports: { web: 8080 }, build: false });
    assert.deepEqual(model.production, {
      server: '10.0.0.1',
      domain: undefined,
      onDemandTlsUrl: undefined,
      registry: undefined,
      ssh: undefined,
    });
  });

  it('never mutates the input object or its nested overlays', () => {
    const raw = fullConfig();
    const snapshot = JSON.parse(JSON.stringify(raw));

    normalizeJamalConfig(raw);

    assert.deepEqual(raw, snapshot);
  });
});

describe('normalizeJamalConfig: strict shape', () => {
  it('rejects a non-object export', () => {
    for (const bad of [null, undefined, 42, 'x', [], true]) {
      const error = capture(() => normalizeJamalConfig(bad));
      assert.match(error.message, /plain object/);
    }
  });

  it('rejects an unknown top-level key without echoing it', () => {
    const error = capture(() =>
      normalizeJamalConfig({
        service: 'x',
        image: 'y',
        SUPER_SECRET_KEY: 'leak-me',
      }),
    );
    assert.match(error.message, /unrecognized field/);
    assert.ok(!error.message.includes('SUPER_SECRET_KEY'));
    assert.ok(!error.message.includes('leak-me'));
  });

  it('rejects unknown keys inside nested objects', () => {
    const cases: [string, () => unknown][] = [
      [
        'health',
        () =>
          normalizeJamalConfig({
            service: 'x',
            image: 'y',
            health: { path: '/up', timeoutMs: 1, intervalMs: 1, bogus: 1 },
          }),
      ],
      [
        'services',
        () =>
          normalizeJamalConfig({
            service: 'x',
            image: 'y',
            services: { db: { type: 'mariadb', bogus: 1 } },
          }),
      ],
      [
        'local',
        () =>
          normalizeJamalConfig({
            service: 'x',
            image: 'y',
            local: { ports: {}, build: true, bogus: 1 },
          }),
      ],
      [
        'production',
        () =>
          normalizeJamalConfig({
            service: 'x',
            image: 'y',
            production: { server: 's', bogus: 1 },
          }),
      ],
      [
        'registry',
        () =>
          normalizeJamalConfig({
            service: 'x',
            image: 'y',
            production: {
              server: 's',
              registry: { server: 'r', username: 'u', bogus: 1 },
            },
          }),
      ],
    ];
    for (const [label, fn] of cases) {
      assert.match(capture(fn).message, /unrecognized field/, label);
    }
  });

  it('rejects a non-string service or image', () => {
    assert.match(
      capture(() => normalizeJamalConfig({ service: '', image: 'y' })).message,
      /below the minimum/,
    );
    assert.match(
      capture(() => normalizeJamalConfig({ service: 5, image: 'y' })).message,
      /service/,
    );
    assert.match(
      capture(() => normalizeJamalConfig({ service: 'x', image: '' })).message,
      /below the minimum/,
    );
  });

  it('rejects a host volume with ".." traversal in the source path, value-free', () => {
    const error = capture(() =>
      normalizeJamalConfig({
        service: 'app',
        image: 'img',
        volumes: { uploads: '/../escape:/app/uploads' },
      }),
    );
    assert.match(error.message, /"\.\." traversal/);
    assert.ok(!error.message.includes('/../escape'), 'the traversal path must not leak');
  });

  it('rejects a host volume with backslash or control characters in the source path', () => {
    for (const bad of ['/path\\sep:/app', '/path\u0001:/app']) {
      assert.throws(
        () =>
          normalizeJamalConfig({
            service: 'app',
            image: 'img',
            volumes: { uploads: bad },
          }),
        (error: unknown): boolean => {
          assert.ok(error instanceof JamalConfigError);
          return true;
        },
      );
    }
  });

  it('rejects a host volume with a non-ro/rw option', () => {
    assert.throws(
      () =>
        normalizeJamalConfig({
          service: 'app',
          image: 'img',
          volumes: { uploads: '/host:/container:badopt' },
        }),
      (error: unknown): boolean => {
        assert.ok(error instanceof JamalConfigError);
        return true;
      },
    );
  });

  it('normalizes host volumes with and without options', () => {
    const model = normalizeJamalConfig({
      service: 'app',
      image: 'img',
      volumes: {
        uploads: '/host/path:/app/uploads:ro',
        logs: './relative:/app/logs',
      },
    });

    const uploads = model.volumes['uploads']!;
    assert.equal(uploads.source, '/host/path');
    assert.equal(uploads.containerPath, '/app/uploads');
    assert.equal(uploads.options, 'ro');
    assert.equal(uploads.host, true);

    const logs = model.volumes['logs']!;
    assert.equal(logs.source, './relative');
    assert.equal(logs.containerPath, '/app/logs');
    assert.equal(logs.options, undefined);
    assert.equal(logs.host, true);
  });

  it('preserves $PWD/ verbatim in host volume sources', () => {
    const model = normalizeJamalConfig({
      service: 'app',
      image: 'img',
      volumes: { data: '$PWD/data:/app/data' },
    });

    assert.equal(model.volumes['data']?.source, '$PWD/data');
    assert.equal(model.volumes['data']?.host, true);
  });

  it('rejects non-string/non-SecretRef env values and unknown service types', () => {
    assert.match(
      capture(() => normalizeJamalConfig({ service: 'x', image: 'y', env: { A: 123 } })).message,
      /env/,
    );
    assert.match(
      capture(() =>
        normalizeJamalConfig({
          service: 'x',
          image: 'y',
          services: { db: { type: 'sqlite' } },
        }),
      ).message,
      /services/,
    );
  });
});

describe('normalizeJamalConfig: unsafe values', () => {
  it('rejects control characters in scalar strings without echoing them', () => {
    const cases: [string, () => unknown][] = [
      ['service', () => normalizeJamalConfig({ service: 'a\nb', image: 'y' })],
      ['image', () => normalizeJamalConfig({ service: 'x', image: 'a\u0001b' })],
      [
        'command',
        () =>
          normalizeJamalConfig({
            service: 'x',
            image: 'y',
            command: 'run\u007f',
          }),
      ],
      [
        'env value',
        () =>
          normalizeJamalConfig({
            service: 'x',
            image: 'y',
            env: { A: 'a\nb' },
          }),
      ],
      [
        'production server',
        () =>
          normalizeJamalConfig({
            service: 'x',
            image: 'y',
            production: { server: 'a\nb' },
          }),
      ],
    ];
    for (const [label, fn] of cases) {
      const error = capture(fn);
      assert.match(error.message, /control characters/, label);
      assert.ok(!error.message.includes('\n'), label);
    }
  });

  it('rejects reserved keys in records without echoing the key', () => {
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      const envError = capture(() =>
        normalizeJamalConfig({
          service: 'x',
          image: 'y',
          env: JSON.parse(`{"${key}": "v"}`),
        }),
      );
      assert.match(envError.message, /reserved key/);
      assert.ok(!envError.message.includes(key));

      const volumeError = capture(() =>
        normalizeJamalConfig({
          service: 'x',
          image: 'y',
          volumes: JSON.parse(`{"${key}": "/data"}`),
        }),
      );
      assert.match(volumeError.message, /reserved key/);
    }
  });

  it('rejects invalid health configs', () => {
    assert.match(
      capture(() =>
        normalizeJamalConfig({
          service: 'x',
          image: 'y',
          health: { path: 'up', timeoutMs: 100, intervalMs: 100 },
        }),
      ).message,
      /health.path must start with/,
    );
    assert.match(
      capture(() =>
        normalizeJamalConfig({
          service: 'x',
          image: 'y',
          health: { path: '/up', timeoutMs: 0, intervalMs: 100 },
        }),
      ).message,
      /health/,
    );
    assert.match(
      capture(() =>
        normalizeJamalConfig({
          service: 'x',
          image: 'y',
          health: { path: '/up', timeoutMs: 100, intervalMs: -1 },
        }),
      ).message,
      /health/,
    );
    assert.match(
      capture(() =>
        normalizeJamalConfig({
          service: 'x',
          image: 'y',
          health: { path: '/up', timeoutMs: 1.5, intervalMs: 100 },
        }),
      ).message,
      /health/,
    );
    assert.match(
      capture(() =>
        normalizeJamalConfig({
          service: 'x',
          image: 'y',
          health: { path: '/up', timeoutMs: 100 },
        }),
      ).message,
      /health/,
    );
  });

  it('normalizes health retries, retryDelayMs, and readinessDelayMs', () => {
    const model = normalizeJamalConfig({
      service: 'app',
      image: 'img',
      health: {
        path: '/up',
        timeoutMs: 5000,
        intervalMs: 30000,
        retries: 3,
        retryDelayMs: 5000,
        readinessDelayMs: 2000,
      },
    });

    assert.equal(model.health?.retries, 3);
    assert.equal(model.health?.retryDelayMs, 5000);
    assert.equal(model.health?.readinessDelayMs, 2000);
  });

  it('defaults health retries/retryDelayMs/readinessDelayMs to undefined', () => {
    const model = normalizeJamalConfig({
      service: 'app',
      image: 'img',
      health: { path: '/up', timeoutMs: 5000, intervalMs: 30000 },
    });

    assert.equal(model.health?.retries, undefined);
    assert.equal(model.health?.retryDelayMs, undefined);
    assert.equal(model.health?.readinessDelayMs, undefined);
  });

  it('rejects negative health retries, retryDelayMs, and readinessDelayMs', () => {
    for (const field of ['retries', 'retryDelayMs', 'readinessDelayMs']) {
      const config = {
        service: 'x',
        image: 'y',
        health: { path: '/up', timeoutMs: 100, intervalMs: 100, [field]: -1 },
      };
      assert.throws(
        () => normalizeJamalConfig(config),
        (error: unknown) => {
          assert.ok(error instanceof JamalConfigError);
          return true;
        },
      );
    }
  });

  it('rejects invalid ports', () => {
    const invalid = [0, 65536, -1, 1.5, '3000', Number.NaN];
    for (const port of invalid) {
      const error = capture(() =>
        normalizeJamalConfig({
          service: 'x',
          image: 'y',
          local: { ports: { web: port } },
        }),
      );
      assert.match(error.message, /local/, `port ${String(port)}`);
      assert.ok(
        !String(error.message).includes(String(port)),
        `port ${String(port)} must not leak`,
      );
    }
  });

  it('accepts the boundary ports 1 and 65535', () => {
    assert.deepEqual(
      normalizeJamalConfig({
        service: 'x',
        image: 'y',
        local: { ports: { a: 1, b: 65535 } },
      }).local.ports,
      { a: 1, b: 65535 },
    );
  });

  it('rejects invalid volume names and container paths', () => {
    const badVolumes: Record<string, string>[] = [
      { '': '/data' },
      { 'a/b': '/data' },
      { '.': '/data' },
      { '..': '/data' },
      { data: 'relative' },
      { data: '/app/../secret' },
      { data: '/app\\secret' },
      { data: '/app/../' },
    ];
    for (const volumes of badVolumes) {
      const error = capture(() => normalizeJamalConfig({ service: 'x', image: 'y', volumes }));
      assert.ok(error.message.length > 0);
      // No input value is echoed.
      assert.ok(!error.message.includes(JSON.stringify(volumes)));
    }
  });
});

describe('normalizeJamalConfig: production.onDemandTlsUrl', () => {
  const production = (onDemandTlsUrl: string) => ({
    service: 'x',
    image: 'y',
    production: { server: '1.2.3.4', onDemandTlsUrl },
  });

  it('accepts an absolute https URL', () => {
    const model = normalizeJamalConfig(production('https://tls.example.com/check'));
    assert.equal(model.production?.onDemandTlsUrl, 'https://tls.example.com/check');
  });

  it('accepts an absolute http URL and a local path', () => {
    assert.equal(
      normalizeJamalConfig(production('http://tls.example.com/check')).production?.onDemandTlsUrl,
      'http://tls.example.com/check',
    );
    assert.equal(
      normalizeJamalConfig(production('/tls/check')).production?.onDemandTlsUrl,
      '/tls/check',
    );
  });

  it('rejects whitespace, control characters, and non-http(s)/local schemes', () => {
    for (const bad of ['has space', 'line\nbreak', 'tab\tx', 'ctrl\u0001', 'ftp://x/check']) {
      const error = capture(() => normalizeJamalConfig(production(bad)));
      assert.match(error.message, /onDemandTlsUrl/);
      assert.ok(!error.message.includes(bad), `value ${JSON.stringify(bad)} must not leak`);
    }
  });

  it('rejects a value without an http(s) or "/" prefix', () => {
    const error = capture(() => normalizeJamalConfig(production('example.com/check')));
    assert.match(error.message, /onDemandTlsUrl/);
  });

  it('rejects a non-string value without echoing it', () => {
    assert.match(
      capture(() =>
        normalizeJamalConfig({
          service: 'x',
          image: 'y',
          production: { server: '1.2.3.4', onDemandTlsUrl: 42 },
        }),
      ).message,
      /production/,
    );
  });

  it('is mutually exclusive with production.domain', () => {
    const error = capture(() =>
      normalizeJamalConfig({
        service: 'x',
        image: 'y',
        production: { server: '1.2.3.4', domain: 'example.com', onDemandTlsUrl: 'https://x/check' },
      }),
    );
    assert.match(error.message, /mutually exclusive/);
  });
});

describe('normalizeJamalConfig: frozen output', () => {
  it('deep-freezes the model and its nested records', () => {
    const model = normalizeJamalConfig({
      ...fullConfig(),
      env: { NODE_ENV: 'production', DB_PASSWORD: secret('DB_PASSWORD') },
    });

    assert.equal(Object.isFrozen(model), true);
    assert.equal(Object.isFrozen(model.env), true);
    assert.equal(Object.isFrozen(model.services), true);
    assert.equal(Object.isFrozen(model.volumes), true);
    assert.equal(Object.isFrozen(model.local), true);
    assert.equal(Object.isFrozen(model.local.ports), true);
    assert.ok(model.production !== undefined);
    assert.equal(Object.isFrozen(model.production), true);
    assert.ok(model.production.registry !== undefined);
    assert.equal(Object.isFrozen(model.production.registry), true);
  });
});

describe('logging', () => {
  it('normalizes a logging block with driver and options', () => {
    const model = normalizeJamalConfig({
      service: 'app',
      image: 'img',
      logging: { driver: 'json-file', options: { 'max-size': '10m', 'max-file': '3' } },
    });

    assert.equal(model.logging?.driver, 'json-file');
    assert.deepEqual(model.logging?.options, { 'max-file': '3', 'max-size': '10m' });
  });

  it('defaults logging to undefined', () => {
    const model = normalizeJamalConfig({
      service: 'app',
      image: 'img',
    });
    assert.equal(model.logging, undefined);
  });

  it('defaults logging.options to an empty map', () => {
    const model = normalizeJamalConfig({
      service: 'app',
      image: 'img',
      logging: { driver: 'json-file' },
    });
    assert.deepEqual(model.logging?.options, {});
  });

  it('rejects a logging.driver with whitespace', () => {
    assert.throws(
      () =>
        normalizeJamalConfig({
          service: 'app',
          image: 'img',
          logging: { driver: 'json file' },
        }),
      (error: unknown) => {
        assert.ok(error instanceof JamalConfigError);
        return true;
      },
    );
  });

  it('rejects a logging options key/value with whitespace', () => {
    assert.throws(
      () =>
        normalizeJamalConfig({
          service: 'app',
          image: 'img',
          logging: { driver: 'local', options: { 'bad key': 'v' } },
        }),
      (error: unknown) => {
        assert.ok(error instanceof JamalConfigError);
        return true;
      },
    );

    assert.throws(
      () =>
        normalizeJamalConfig({
          service: 'app',
          image: 'img',
          logging: { driver: 'local', options: { key: 'bad value' } },
        }),
      (error: unknown) => {
        assert.ok(error instanceof JamalConfigError);
        return true;
      },
    );
  });

  it('preserves logging through redactJamalConfig', () => {
    const model = normalizeJamalConfig({
      service: 'app',
      image: 'img',
      logging: { driver: 'json-file', options: { 'max-size': '10m' } },
    });
    const redacted = redactJamalConfig(model);
    assert.equal(redacted.logging?.driver, 'json-file');
    assert.deepEqual(redacted.logging?.options, { 'max-size': '10m' });
  });
});

describe('ssh options', () => {
  it('normalizes a production.ssh block and freezes it', () => {
    const model = normalizeJamalConfig({
      service: 'app',
      image: 'img',
      production: {
        server: '1.2.3.4',
        ssh: { user: 'deploy', port: 2222, keysOnly: true, forwardAgent: true },
      },
    });

    assert.ok(model.production !== undefined);
    assert.ok(model.production?.ssh !== undefined);
    assert.equal(model.production?.ssh?.user, 'deploy');
    assert.equal(model.production?.ssh?.port, 2222);
    assert.equal(model.production?.ssh?.keysOnly, true);
    assert.equal(model.production?.ssh?.forwardAgent, true);
    assert.equal(Object.isFrozen(model.production?.ssh), true);
  });

  it('applies defaults for boolean ssh fields', () => {
    const model = normalizeJamalConfig({
      service: 'app',
      image: 'img',
      production: { server: '1.2.3.4', ssh: { user: 'deploy' } },
    });

    assert.equal(model.production?.ssh?.keysOnly, false);
    assert.equal(model.production?.ssh?.forwardAgent, false);
    assert.equal(model.production?.ssh?.port, undefined);
  });

  it('rejects unknown keys in the ssh block', () => {
    assert.throws(
      () =>
        normalizeJamalConfig({
          service: 'app',
          image: 'img',
          production: { server: '1.2.3.4', ssh: { user: 'deploy', unknownKey: 'bad' } },
        }),
      (error: unknown) => {
        assert.ok(error instanceof JamalConfigError);
        assert.match(String(error.message), /unrecognized/);
        return true;
      },
    );
  });

  it('rejects a port outside 1..65535', () => {
    for (const port of [0, 65536, -1, 99999]) {
      assert.throws(
        () =>
          normalizeJamalConfig({
            service: 'app',
            image: 'img',
            production: { server: '1.2.3.4', ssh: { port } },
          }),
        (error: unknown) => {
          assert.ok(error instanceof JamalConfigError);
          return true;
        },
      );
    }
  });

  it('rejects a proxyCommand with whitespace', () => {
    const error = capture(() =>
      normalizeJamalConfig({
        service: 'app',
        image: 'img',
        production: { server: '1.2.3.4', ssh: { proxyCommand: 'ssh -W %h:%p bastion' } },
      }),
    );
    assert.match(error.message, /whitespace or control/);
    assert.ok(!error.message.includes('bastion'), 'proxyCommand value must not leak');
  });

  it('rejects a user with whitespace or leading dash', () => {
    assert.throws(
      () =>
        normalizeJamalConfig({
          service: 'app',
          image: 'img',
          production: { server: '1.2.3.4', ssh: { user: 'has space' } },
        }),
      (error: unknown) => {
        assert.ok(error instanceof JamalConfigError);
        return true;
      },
    );

    assert.throws(
      () =>
        normalizeJamalConfig({
          service: 'app',
          image: 'img',
          production: { server: '1.2.3.4', ssh: { user: '-bad' } },
        }),
      (error: unknown) => {
        assert.ok(error instanceof JamalConfigError);
        return true;
      },
    );
  });

  it('preserves ssh block through redactJamalConfig', () => {
    const model = normalizeJamalConfig({
      service: 'app',
      image: 'img',
      production: { server: '1.2.3.4', ssh: { user: 'deploy', port: 2222 } },
    });
    const redacted = redactJamalConfig(model);

    assert.ok(redacted.production?.ssh !== undefined);
    assert.equal(redacted.production?.ssh?.user, 'deploy');
    assert.equal(redacted.production?.ssh?.port, 2222);
  });
});

describe('normalizeJamalConfig: env entries', () => {
  it('normalizes a JamalEnvEntry with alias and clear fields', () => {
    const model = normalizeJamalConfig({
      service: 'app',
      image: 'img',
      env: {
        DB_HOST: { value: 'localhost', clear: true },
        DB_USER: { value: secret('DB_USER'), alias: 'DATABASE_USER' },
      },
    });

    const host = model.env['DB_HOST']!;
    assert.equal(host.value, 'localhost');
    assert.equal(host.clear, true);
    assert.equal(host.alias, undefined);

    const user = model.env['DB_USER']!;
    assert.ok(user.value instanceof SecretRef);
    assert.equal(user.value.name, 'DB_USER');
    assert.equal(user.alias, 'DATABASE_USER');
    assert.equal(user.clear, false);
  });

  it('normalizes plain string values with defaults', () => {
    const model = normalizeJamalConfig({
      service: 'app',
      image: 'img',
      env: { NODE_ENV: 'production' },
    });

    const entry = model.env['NODE_ENV']!;
    assert.equal(entry.value, 'production');
    assert.equal(entry.alias, undefined);
    assert.equal(entry.clear, false);
  });

  it('rejects an env alias with whitespace or control characters', () => {
    assert.throws(
      () =>
        normalizeJamalConfig({
          service: 'app',
          image: 'img',
          env: { KEY: { value: 'v', alias: 'has space' } },
        }),
      (error: unknown): boolean => {
        assert.ok(error instanceof JamalConfigError);
        return true;
      },
    );
    assert.throws(
      () =>
        normalizeJamalConfig({
          service: 'app',
          image: 'img',
          env: { KEY: { value: 'v', alias: 'ctrl\u0001' } },
        }),
      (error: unknown): boolean => {
        assert.ok(error instanceof JamalConfigError);
        return true;
      },
    );
  });

  it('rejects an env entry without a value field', () => {
    assert.throws(
      () =>
        normalizeJamalConfig({
          service: 'app',
          image: 'img',
          env: { KEY: { alias: 'OTHER' } },
        }),
      (error: unknown): boolean => {
        assert.ok(error instanceof JamalConfigError);
        return true;
      },
    );
  });

  it('rejects an env entry with a nested entry value', () => {
    assert.throws(
      () =>
        normalizeJamalConfig({
          service: 'app',
          image: 'img',
          env: { KEY: { value: { value: 'nested', clear: true } } },
        }),
      (error: unknown): boolean => {
        assert.ok(error instanceof JamalConfigError);
        return true;
      },
    );
  });
});

describe('redactJamalConfig', () => {
  it('renders SecretRefs as secret(<name>) and leaves literals untouched', () => {
    const model = normalizeJamalConfig({
      service: 'app',
      image: 'img',
      env: {
        NODE_ENV: 'production',
        DB_PASSWORD: secret('DB_PASSWORD'),
        URL: 'redis://x',
      },
    });

    const redacted = redactJamalConfig(model);

    assert.deepEqual(redacted.env, {
      NODE_ENV: 'production',
      DB_PASSWORD: 'secret(DB_PASSWORD)',
      URL: 'redis://x',
    });
    assert.equal(redacted.service, 'app');
    assert.equal(redacted.image, 'img');
  });

  it('produces JSON.stringify output that never contains a resolved value', () => {
    const model = normalizeJamalConfig({
      service: 'app',
      image: 'img',
      env: { DB_PASSWORD: secret('DB_PASSWORD') },
    });

    const serialized = JSON.stringify(redactJamalConfig(model));

    assert.ok(serialized.includes('"DB_PASSWORD":"secret(DB_PASSWORD)"'));
    assert.ok(!serialized.includes('"name"'), 'SecretRef name object must not serialize');
  });

  it('does not mutate the source model and freezes its output', () => {
    const model = normalizeJamalConfig({
      service: 'app',
      image: 'img',
      env: { DB_PASSWORD: secret('DB_PASSWORD') },
    });

    const redacted = redactJamalConfig(model);

    assert.ok(model.env['DB_PASSWORD']?.value instanceof SecretRef);
    assert.equal(Object.isFrozen(redacted), true);
    assert.equal(Object.isFrozen(redacted.env), true);
  });
});

describe('loadJamalConfig', () => {
  it('loads jamal.config.js from cwd and normalizes it', async () => {
    const dir = makeDir('load-valid');
    writeConfig(dir, `export default { service: 'myapp', image: 'ghcr.io/acme/myapp:latest' };`);

    const model = await loadJamalConfig(dir);

    assert.equal(model.service, 'myapp');
    assert.equal(model.image, 'ghcr.io/acme/myapp:latest');
    assert.deepEqual(model.local, { ports: {}, build: false });
  });

  it('round-trips a secret() created inside the config module', async () => {
    const dir = makeDir('load-secret');
    writeConfig(
      dir,
      `import { secret } from '${secretModuleSpecifier(dir)}';
export default {
  service: 'myapp',
  image: 'ghcr.io/acme/myapp:latest',
  env: { DATABASE_PASSWORD: secret('DB_PASSWORD'), NODE_ENV: 'production' },
};`,
    );

    const model = await loadJamalConfig(dir);

    const entry = model.env['DATABASE_PASSWORD'];
    assert.ok(entry?.value instanceof SecretRef);
    assert.equal(entry?.value.name, 'DB_PASSWORD');
    assert.equal(model.env['NODE_ENV']?.value, 'production');
    assert.deepEqual(redactJamalConfig(model).env, {
      DATABASE_PASSWORD: 'secret(DB_PASSWORD)',
      NODE_ENV: 'production',
    });
  });

  it('reports a clear error when the config file is missing', async () => {
    const dir = makeDir('load-missing');

    await assert.rejects(loadJamalConfig(dir), (error: unknown) => {
      assert.ok(error instanceof JamalConfigError);
      assert.match(error.message, /not found/);
      assert.match(error.message, new RegExp(DEFAULT_JAMAL_CONFIG_PATH));
      return true;
    });
  });

  it('rejects a module without a default export', async () => {
    const dir = makeDir('load-named-only');
    writeConfig(dir, `export const notDefault = 1;`);

    await assert.rejects(loadJamalConfig(dir), (error: unknown) => {
      assert.ok(error instanceof JamalConfigError);
      assert.match(error.message, /default-export/);
      return true;
    });
  });

  it('rejects a non-object default export', async () => {
    const dir = makeDir('load-null-default');
    writeConfig(dir, `export default null;`);

    await assert.rejects(loadJamalConfig(dir), (error: unknown) => {
      assert.ok(error instanceof JamalConfigError);
      assert.match(error.message, /plain object/);
      return true;
    });
  });

  it('does not echo a module exception when import fails', async () => {
    const dir = makeDir('load-throwing');
    writeConfig(dir, `throw new Error('supersecret-credential');`);

    await assert.rejects(loadJamalConfig(dir), (error: unknown) => {
      assert.ok(error instanceof JamalConfigError);
      assert.doesNotMatch(error.message, /supersecret-credential/);
      assert.equal(error.cause, undefined);
      return true;
    });
  });

  it('defaults cwd to the current working directory when omitted', async () => {
    const dir = makeDir('load-default-cwd');
    writeConfig(dir, `export default { service: 'cwd-app', image: 'img' };`);
    const previous = process.cwd();
    try {
      process.chdir(dir);
      const model = await loadJamalConfig();
      assert.equal(model.service, 'cwd-app');
    } finally {
      process.chdir(previous);
    }
  });
});
