import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  JamalConfigError,
  normalizeJamalConfig,
  secret,
  type JamalConfig,
} from '../../../src/jamal/config.js';
import {
  formatProductionPlan,
  planProduction,
  type ProductionPlan,
  type ProductionStep,
} from '../../../src/jamal/production/plan.js';

/**
 * Tests for the pure production planner. `planProduction` never touches disk or
 * the environment and never resolves a secret, so these run entirely
 * in-process. Assertions target the ordered step kinds and argv shapes, the
 * value-free `env` reduction, container-name determinism, the conditional
 * rollback step, https-vs-http health URL selection, and invalid-tag rejection.
 */

/** A full production config (tagless image; the tag arrives via options). */
function fullConfig(): JamalConfig {
  return normalizeJamalConfig({
    service: 'myapp',
    image: 'ghcr.io/acme/myapp',
    command: 'node server.js',
    health: { path: '/up', timeoutMs: 5000, intervalMs: 30000 },
    env: {
      NODE_ENV: 'production',
      DB_PASSWORD: secret('DB_PASSWORD'),
      API_KEY: secret('API_KEY'),
    },
    services: { db: { type: 'mariadb' } },
    volumes: { storage: '/app/storage', data: '/var/lib/mysql' },
    production: {
      server: '1.2.3.4',
      domain: 'example.com',
      registry: { server: 'ghcr.io', username: 'acme' },
    },
  });
}

/** The step of a given kind, or undefined. */
function stepOf(plan: ProductionPlan, kind: ProductionStep['kind']): ProductionStep | undefined {
  return plan.steps.find((step) => step.kind === kind);
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

describe('planProduction: ordered step kinds and argv shapes', () => {
  it('prepends the backing-service accessory steps before the app flow', () => {
    const plan = planProduction(fullConfig(), { imageTag: '1.0.0' });

    // `services: { db: { type: 'mariadb' } }` contributes one accessory step
    // each for its volume, container, and health poll, all before the app build.
    assert.deepEqual(
      plan.steps.map((step) => step.kind),
      [
        'accessory',
        'accessory',
        'accessory',
        'build',
        'push',
        'pull',
        'run',
        'health',
        'switch',
        'stop',
      ],
    );
  });

  it('lays out the seven app steps in order when no backing service is declared', () => {
    const plan = planProduction(
      normalizeJamalConfig({
        service: 'myapp',
        image: 'img',
        production: { server: '1.2.3.4', domain: 'example.com' },
      }),
      { imageTag: '1.0.0' },
    );

    assert.deepEqual(
      plan.steps.map((step) => step.kind),
      ['build', 'push', 'pull', 'run', 'health', 'switch', 'stop'],
    );
  });

  it('builds and pushes locally, then pulls/runs/stops over ssh', () => {
    const plan = planProduction(fullConfig(), { imageTag: '1.0.0' });
    const imageRef = 'ghcr.io/acme/myapp:1.0.0';

    assert.deepEqual(stepOf(plan, 'build')?.argv, [
      'docker',
      'buildx',
      'build',
      '-t',
      imageRef,
      '.',
    ]);
    assert.deepEqual(stepOf(plan, 'push')?.argv, ['docker', 'push', imageRef]);
    assert.deepEqual(stepOf(plan, 'pull')?.argv, ['ssh', '1.2.3.4', 'docker', 'pull', imageRef]);
    assert.deepEqual(stepOf(plan, 'run')?.argv, [
      'ssh',
      '1.2.3.4',
      'docker',
      'run',
      '-d',
      '--name',
      plan.containerName,
      // The MariaDB accessory appends the loopback DATABASE_* env refs so the
      // app reaches the backing container on 127.0.0.1 (no credentials in
      // `fullConfig().env`, so only host/port/type are emitted).
      '-e',
      'DATABASE_HOST=127.0.0.1',
      '-e',
      'DATABASE_PORT=3306',
      '-e',
      'DATABASE_TYPE=mariadb',
      imageRef,
    ]);
  });

  it('polls the health URL over ssh and emits the proxy deploy argv for the switch', () => {
    const plan = planProduction(fullConfig(), { imageTag: '1.0.0' });

    const health = stepOf(plan, 'health');
    assert.deepEqual(health?.argv, [
      'ssh',
      '1.2.3.4',
      'curl',
      '-fsS',
      '--max-time',
      '5',
      'https://example.com/up',
    ]);
    assert.match(health?.description ?? '', /every 30000 ms/);
    assert.match(health?.description ?? '', /5000 ms per-probe timeout/);

    // A domain is set, so the switch step carries the ssh-prefixed proxy deploy
    // argv targeting the new container with TLS and the production domain as host.
    const switchStep = stepOf(plan, 'switch');
    assert.deepEqual(switchStep?.argv, [
      'ssh',
      '1.2.3.4',
      'docker',
      'exec',
      'kamal-proxy',
      'kamal-proxy',
      'deploy',
      'myapp',
      '--target',
      'myapp-web-100',
      '--host',
      'example.com',
      '--tls',
    ]);
    assert.match(switchStep?.description ?? '', /route traffic to/);
  });

  it('keeps the switch a pure directive when no production domain is set', () => {
    const plan = planProduction(
      normalizeJamalConfig({
        service: 'myapp',
        image: 'img',
        production: { server: '1.2.3.4' },
      }),
      { imageTag: '1.0.0' },
    );

    const switchStep = stepOf(plan, 'switch');
    assert.equal(switchStep?.argv, undefined);
    assert.match(switchStep?.description ?? '', /route traffic to/);
  });

  it('emits an on-demand TLS proxy deploy argv (host omitted) when onDemandTlsUrl is set', () => {
    const plan = planProduction(
      normalizeJamalConfig({
        service: 'myapp',
        image: 'img',
        production: { server: '1.2.3.4', onDemandTlsUrl: 'https://tls.example.com/check' },
      }),
      { imageTag: '1.0.0' },
    );

    const switchStep = stepOf(plan, 'switch');
    assert.deepEqual(switchStep?.argv, [
      'ssh',
      '1.2.3.4',
      'docker',
      'exec',
      'kamal-proxy',
      'kamal-proxy',
      'deploy',
      'myapp',
      '--target',
      'myapp-web-100',
      '--tls',
      '--tls-on-demand-url',
      'https://tls.example.com/check',
    ]);
  });
});

describe('planProduction: secret safety', () => {
  it('reduces env to name + secret flag and never embeds a value', () => {
    const plan = planProduction(fullConfig(), { imageTag: '1.0.0' });

    assert.deepEqual(plan.env, [
      { name: 'API_KEY', secret: true, alias: undefined, clear: false },
      { name: 'DB_PASSWORD', secret: true, alias: undefined, clear: false },
      { name: 'NODE_ENV', secret: false, alias: undefined, clear: false },
    ]);

    for (const entry of plan.env) {
      assert.deepEqual(Object.keys(entry).sort(), ['alias', 'clear', 'name', 'secret']);
    }
    const serialized = JSON.stringify(plan);
    assert.ok(!serialized.includes('secret('), 'the redacted secret(<name>) form must not appear');
    assert.ok(!serialized.includes('"value"'), 'no env value field may appear');
  });

  it('keeps the health URL free of registry and secret values', () => {
    const plan = planProduction(fullConfig(), { imageTag: '1.0.0' });

    assert.equal(plan.healthUrl, 'https://example.com/up');
    assert.ok(!plan.healthUrl.includes('ghcr.io'));
    assert.ok(!plan.healthUrl.includes('acme'));
  });
});

describe('planProduction: container name determinism and sanitization', () => {
  it('sanitizes the tag into a deterministic 12-char-or-fewer fragment', () => {
    assert.equal(
      planProduction(fullConfig(), { imageTag: 'Release/1.0.0-beta.2' }).containerName,
      'myapp-web-release100be',
    );
    assert.equal(
      planProduction(fullConfig(), { imageTag: 'v1.2.3' }).containerName,
      'myapp-web-v123',
    );
    assert.equal(
      planProduction(fullConfig(), { imageTag: '1.0.0' }).containerName,
      'myapp-web-100',
    );
  });

  it('produces a non-empty fragment even for all-punctuation tags', () => {
    const name = planProduction(fullConfig(), {
      imageTag: '---',
    }).containerName;
    assert.match(name, /^myapp-web-\d+$/);
  });
});

describe('planProduction: rollback and stop', () => {
  it('adds a rollback step only when previousTag is provided, pointing at the previous image', () => {
    const withoutPrevious = planProduction(fullConfig(), { imageTag: '2.0.0' });
    assert.equal(
      withoutPrevious.steps.some((step) => step.kind === 'rollback'),
      false,
    );

    const withPrevious = planProduction(fullConfig(), {
      imageTag: '2.0.0',
      previousTag: '1.0.0',
    });
    assert.deepEqual(
      withPrevious.steps.map((step) => step.kind),
      [
        'accessory',
        'accessory',
        'accessory',
        'build',
        'push',
        'pull',
        'run',
        'health',
        'switch',
        'stop',
        'rollback',
      ],
    );

    const rollback = stepOf(withPrevious, 'rollback');
    assert.ok(rollback?.argv?.includes('ghcr.io/acme/myapp:1.0.0'));
    assert.match(rollback?.description ?? '', /ghcr\.io\/acme\/myapp:1\.0\.0/);
  });

  it('stops the previous container by name when previousTag is known', () => {
    const plan = planProduction(fullConfig(), {
      imageTag: '2.0.0',
      previousTag: '1.0.0',
    });

    const stop = stepOf(plan, 'stop');
    assert.deepEqual(stop?.argv, ['ssh', '1.2.3.4', 'docker', 'stop', 'myapp-web-100']);
  });

  it('leaves the stop step argv-less on a first deploy (no previous tag)', () => {
    const plan = planProduction(fullConfig(), { imageTag: '1.0.0' });
    const stop = stepOf(plan, 'stop');
    assert.equal(stop?.argv, undefined);
    assert.match(stop?.description ?? '', /Stop the previous container/);
  });
});

describe('planProduction: health URL selection', () => {
  it('uses https when a domain is set and http otherwise', () => {
    assert.equal(
      planProduction(fullConfig(), { imageTag: '1.0.0' }).healthUrl,
      'https://example.com/up',
    );

    const serverOnly = planProduction(
      normalizeJamalConfig({
        service: 'myapp',
        image: 'img',
        production: { server: '1.2.3.4' },
      }),
      { imageTag: '1.0.0' },
    );
    assert.equal(serverOnly.healthUrl, 'http://1.2.3.4/up');
  });
});

describe('planProduction: health retry/readiness fields', () => {
  it('carries healthRetries, healthRetryDelayMs, and healthReadinessDelayMs when set', () => {
    const plan = planProduction(
      normalizeJamalConfig({
        service: 'myapp',
        image: 'img',
        health: {
          path: '/up',
          timeoutMs: 5000,
          intervalMs: 30000,
          retries: 10,
          retryDelayMs: 2000,
          readinessDelayMs: 1500,
        },
        production: { server: '1.2.3.4' },
      }),
      { imageTag: '1.0.0' },
    );

    assert.equal(plan.healthRetries, 10);
    assert.equal(plan.healthRetryDelayMs, 2000);
    assert.equal(plan.healthReadinessDelayMs, 1500);
  });

  it('leaves healthRetries, healthRetryDelayMs, and healthReadinessDelayMs undefined when unset', () => {
    const plan = planProduction(
      normalizeJamalConfig({
        service: 'myapp',
        image: 'img',
        health: { path: '/up', timeoutMs: 5000, intervalMs: 30000 },
        production: { server: '1.2.3.4' },
      }),
      { imageTag: '1.0.0' },
    );

    assert.equal(plan.healthRetries, undefined);
    assert.equal(plan.healthRetryDelayMs, undefined);
    assert.equal(plan.healthReadinessDelayMs, undefined);
  });
});

describe('planProduction: env aliasing and clear flag', () => {
  it('reports alias and clear in ProductionEnvEntry', () => {
    const plan = planProduction(
      normalizeJamalConfig({
        service: 'myapp',
        image: 'img',
        env: {
          DB_USER: { value: secret('DB_USER'), alias: 'DATABASE_USER' },
          PUBLIC_KEY: { value: 'pk_abc123', clear: true },
        },
        production: { server: '1.2.3.4' },
      }),
      { imageTag: '1.0.0' },
    );

    const user = plan.env.find((e) => e.name === 'DB_USER');
    assert.ok(user !== undefined);
    assert.equal(user.secret, true);
    assert.equal(user.alias, 'DATABASE_USER');
    assert.equal(user.clear, false);

    const pub = plan.env.find((e) => e.name === 'PUBLIC_KEY');
    assert.ok(pub !== undefined);
    assert.equal(pub.secret, false);
    assert.equal(pub.alias, undefined);
    assert.equal(pub.clear, true);
  });

  it('renders an aliased env entry with alias and clear in the plan', () => {
    const plan = planProduction(
      normalizeJamalConfig({
        service: 'myapp',
        image: 'img',
        env: { NODE_ENV: 'production', KEY: { value: secret('SEC'), alias: 'ALIAS', clear: true } },
        production: { server: '1.2.3.4' },
      }),
      { imageTag: '1.0.0' },
    );

    assert.deepEqual(plan.env, [
      { name: 'KEY', secret: true, alias: 'ALIAS', clear: true },
      { name: 'NODE_ENV', secret: false, alias: undefined, clear: false },
    ]);
  });
});

describe('planProduction: host volumes', () => {
  it('carries source, options, and host in ProductionVolumeEntry', () => {
    const plan = planProduction(
      normalizeJamalConfig({
        service: 'myapp',
        image: 'img',
        volumes: { uploads: '/host/uploads:/app/uploads:ro', storage: '/app/storage' },
        production: { server: '1.2.3.4' },
      }),
      { imageTag: '1.0.0' },
    );

    const hostVol = plan.volumes.find((v) => v.name === 'uploads');
    assert.ok(hostVol !== undefined);
    assert.equal(hostVol.source, '/host/uploads');
    assert.equal(hostVol.containerPath, '/app/uploads');
    assert.equal(hostVol.options, 'ro');
    assert.equal(hostVol.host, true);

    const namedVol = plan.volumes.find((v) => v.name === 'storage');
    assert.ok(namedVol !== undefined);
    assert.equal(namedVol.source, 'storage');
    assert.equal(namedVol.containerPath, '/app/storage');
    assert.equal(namedVol.options, undefined);
    assert.equal(namedVol.host, false);
  });

  it('adds -v flags to the run step argv for host volumes', () => {
    const plan = planProduction(
      normalizeJamalConfig({
        service: 'myapp',
        image: 'img',
        volumes: { uploads: '/host/uploads:/app/uploads:ro' },
        production: { server: '1.2.3.4' },
      }),
      { imageTag: '1.0.0' },
    );

    const run = stepOf(plan, 'run');
    const argv = run?.argv ?? [];
    const vIdx = argv.indexOf('-v');
    assert.ok(vIdx >= 0, 'expected -v flag in run argv');
    assert.equal(argv[vIdx + 1], '/host/uploads:/app/uploads:ro');
  });

  it('omits -v flags when volumes are absent', () => {
    const plan = planProduction(
      normalizeJamalConfig({
        service: 'myapp',
        image: 'img',
        production: { server: '1.2.3.4' },
      }),
      { imageTag: '1.0.0' },
    );

    const run = stepOf(plan, 'run');
    const argv = run?.argv ?? [];
    assert.ok(!argv.includes('-v'));
  });
});

describe('planProduction: logging args in run argv', () => {
  it('emits --log-driver and sorted --log-opt in the run step argv', () => {
    const plan = planProduction(
      normalizeJamalConfig({
        service: 'myapp',
        image: 'img',
        logging: { driver: 'json-file', options: { 'max-size': '10m', 'max-file': '3' } },
        production: { server: '1.2.3.4' },
      }),
      { imageTag: '1.0.0' },
    );

    const run = stepOf(plan, 'run');
    assert.ok(run?.argv !== undefined);
    const argv = run?.argv ?? [];

    const driverIdx = argv.indexOf('--log-driver');
    assert.ok(driverIdx >= 0, 'expected --log-driver in run argv');
    assert.equal(argv[driverIdx + 1], 'json-file');

    const maxFileIdx = argv.indexOf('--log-opt');
    assert.ok(maxFileIdx >= 0, 'expected --log-opt in run argv');
    assert.equal(argv[maxFileIdx + 1], 'max-file=3');

    // Options are sorted alphabetically by key.
    const maxSizeIdx = argv.indexOf('max-size=10m');
    assert.ok(maxSizeIdx >= 0, 'expected max-size=10m in run argv');
    assert.ok(maxFileIdx < maxSizeIdx, 'max-file should appear before max-size (sorted by key)');
  });

  it('omits --log-driver and --log-opt when logging is unset', () => {
    const plan = planProduction(
      normalizeJamalConfig({
        service: 'myapp',
        image: 'img',
        production: { server: '1.2.3.4' },
      }),
      { imageTag: '1.0.0' },
    );

    const run = stepOf(plan, 'run');
    const argv = run?.argv ?? [];
    assert.ok(!argv.includes('--log-driver'));
    assert.ok(!argv.includes('--log-opt'));
  });
});

describe('planProduction: invalid tags and config', () => {
  it('rejects a tag with whitespace or control characters, value-free', () => {
    for (const bad of ['has space', 'line\nbreak', 'tab\tx', 'ctrl\u0001']) {
      const error = capture(() => planProduction(fullConfig(), { imageTag: bad }));
      assert.match(error.message, /image tag/);
      assert.ok(!error.message.includes(bad), `tag ${JSON.stringify(bad)} must not leak`);
    }
  });

  it('rejects an empty tag', () => {
    assert.match(
      capture(() => planProduction(fullConfig(), { imageTag: '' })).message,
      /non-empty/,
    );
  });

  it('rejects an invalid previousTag', () => {
    assert.match(
      capture(() =>
        planProduction(fullConfig(), {
          imageTag: '1.0.0',
          previousTag: 'bad tag',
        }),
      ).message,
      /image tag/,
    );
  });

  it('rejects a config without a production overlay', () => {
    assert.match(
      capture(() =>
        planProduction(normalizeJamalConfig({ service: 'x', image: 'y' }), {
          imageTag: '1.0.0',
        }),
      ).message,
      /production/,
    );
  });
});

describe('planProduction: determinism', () => {
  it('produces a deep-equal plan across calls for identical input', () => {
    const config = fullConfig();
    const first = planProduction(config, {
      imageTag: '1.0.0',
      previousTag: '0.9.0',
    });
    const second = planProduction(config, {
      imageTag: '1.0.0',
      previousTag: '0.9.0',
    });

    assert.deepEqual(first, second);
  });

  it('emits deterministic reminders for the registry and version skew', () => {
    const plan = planProduction(fullConfig(), {
      imageTag: '2.0.0',
      previousTag: '1.0.0',
    });

    assert.deepEqual(plan.warnings, [
      'Log in to the registry before pushing: docker login ghcr.io.',
      'Rolling forward from ghcr.io/acme/myapp:1.0.0 to ghcr.io/acme/myapp:2.0.0: run any pending ' +
        'migrations before the proxy switch and keep 1.0.0 and 2.0.0 compatible during the cutover.',
    ]);
  });

  it('emits no reminders without a registry or previous tag', () => {
    const plan = planProduction(
      normalizeJamalConfig({
        service: 'myapp',
        image: 'img',
        production: { server: '1.2.3.4' },
      }),
      { imageTag: '1.0.0' },
    );
    assert.deepEqual(plan.warnings, []);
  });
});

describe('formatProductionPlan: dry-run rendering', () => {
  it('renders image/container headers, kind-first steps, $ argv, and trailing warnings', () => {
    const plan = planProduction(fullConfig(), { imageTag: '1.0.0' });
    const text = formatProductionPlan(plan);
    const lines = text.split('\n');

    assert.equal(lines[0], 'image: ghcr.io/acme/myapp:1.0.0');
    assert.equal(lines[1], 'container: myapp-web-100');
    assert.equal(lines[2], '');

    // Every step line begins with its kind; argv lines are the indented `$ ...`.
    for (const step of plan.steps) {
      assert.ok(lines.includes(`${step.kind}: ${step.description}`), `missing ${step.kind} line`);
      if (step.argv !== undefined) {
        assert.ok(lines.includes(`  $ ${step.argv.join(' ')}`), `missing argv for ${step.kind}`);
      }
    }

    // Warnings trail every step, prefixed with `warning: `.
    assert.deepEqual(
      lines.filter((line) => line.startsWith('warning: ')),
      plan.warnings.map((warning) => `warning: ${warning}`),
    );

    // Value-free: no secret reference or credential name leaks into the preview.
    assert.ok(!text.includes('secret('));
    assert.ok(!text.includes('DB_PASSWORD'));
  });
});
