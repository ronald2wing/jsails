import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  JamalConfigError,
  normalizeJamalConfig,
  secret,
  type JamalConfig,
} from '../../../src/jamal/config.js';
import {
  ACCESSORY_HEALTH_MAX_ATTEMPTS,
  ACCESSORY_HEALTH_RETRY_DELAY_MS,
  AccessoryError,
  planAccessories,
  runAccessories,
  type AccessoryAction,
} from '../../../src/jamal/production/accessories.js';
import {
  planProduction,
  type ProductionPlan,
  type ProductionStep,
} from '../../../src/jamal/production/plan.js';
import { DeployExecuteError, runDeployExecution } from '../../../src/jamal/production/execute.js';
import type { CommandRunner } from '../../../src/jamal/production/command-runner.js';
import type { HealthCheck } from '../../../src/jamal/production/release.js';
import type { RemoteRunner } from '../../../src/jamal/production/transport.js';

/**
 * Tests for production service accessories. `planAccessories` and
 * `runAccessories` never touch a process or the network: the remote runner is
 * injected, and the health-retry delay is an injected `sleep`. Assertions
 * target the per-service argv shapes, secret-name-only credentials, the
 * inspect-gated container reuse, the bounded health retry, and the
 * deploy-executor abort before the app release on a failed accessory step.
 */

/** A config with one MariaDB backing service and explicit database credentials. */
function dbConfig(): JamalConfig {
  return normalizeJamalConfig({
    service: 'myapp',
    image: 'ghcr.io/acme/myapp',
    env: {
      DATABASE_NAME: 'myapp',
      DATABASE_USER: 'appuser',
      DATABASE_PASSWORD: secret('DB_PASSWORD'),
    },
    services: { db: { type: 'mariadb' } },
    production: { server: '1.2.3.4', domain: 'example.com' },
  });
}

/** A config with a Valkey service and no password. */
function valkeyConfig(): JamalConfig {
  return normalizeJamalConfig({
    service: 'myapp',
    image: 'ghcr.io/acme/myapp',
    services: { cache: { type: 'valkey' } },
    production: { server: '1.2.3.4' },
  });
}

/** A config with a Valkey service whose password is a secret reference. */
function valkeySecretConfig(): JamalConfig {
  return normalizeJamalConfig({
    service: 'myapp',
    image: 'ghcr.io/acme/myapp',
    env: { VALKEY_PASSWORD: secret('VALKEY_PASSWORD') },
    services: { cache: { type: 'valkey' } },
    production: { server: '1.2.3.4' },
  });
}

/** A config with no backing services. */
function noServiceConfig(): JamalConfig {
  return normalizeJamalConfig({
    service: 'myapp',
    image: 'ghcr.io/acme/myapp',
    production: { server: '1.2.3.4' },
  });
}

/** Find a plan step by kind, or undefined. */
function stepOf(plan: ProductionPlan, kind: ProductionStep['kind']): ProductionStep | undefined {
  return plan.steps.find((step) => step.kind === kind);
}

/** The remote part of a plan step (after `ssh <server>`), or undefined. */
function remotePart(step: ProductionStep | undefined): string[] | undefined {
  const argv = step?.argv;
  if (argv === undefined || argv[0] !== 'ssh') return undefined;
  return [...argv.slice(2)];
}

/** A scriptable remote runner that records every remote argv. */
function makeRemote(script: (remoteArgv: readonly string[]) => number = () => 0): {
  remote: RemoteRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  const remote: RemoteRunner = {
    async run(_server, remoteArgv) {
      calls.push([...remoteArgv]);
      return { exitCode: script(remoteArgv), stdout: '', stderr: '' };
    },
  };
  return { remote, calls };
}

/** An instant sleep seam that records every delay. */
function makeSleep(): { sleep: (ms: number) => Promise<void>; delays: number[] } {
  const delays: number[] = [];
  const sleep = async (ms: number): Promise<void> => {
    delays.push(ms);
  };
  return { sleep, delays };
}

/** Build a hand-crafted accessory step for `runAccessories` tests. */
function accessoryStep(
  action: AccessoryAction,
  name: string,
  remoteArgv: string[],
): ProductionStep {
  return {
    kind: 'accessory',
    description: 'test accessory step',
    argv: ['ssh', '1.2.3.4', ...remoteArgv],
    accessory: { action, service: 'mariadb', name },
  };
}

describe('planAccessories: MariaDB', () => {
  it('plans volume, run, and health steps with the pinned image and conventions', () => {
    const plan = planAccessories(dbConfig());

    assert.deepEqual(
      plan.steps.map((step) => step.accessory?.action),
      ['volume', 'run', 'health'],
    );
    assert.deepEqual(
      plan.steps.map((step) => step.accessory?.service),
      ['mariadb', 'mariadb', 'mariadb'],
    );

    assert.deepEqual(remotePart(plan.steps[0]), ['docker', 'volume', 'create', 'mariadb-data']);
    assert.deepEqual(remotePart(plan.steps[1]), [
      'docker',
      'run',
      '-d',
      '--restart',
      'unless-stopped',
      '--name',
      'db',
      '-p',
      '127.0.0.1:3306:3306',
      '-v',
      'mariadb-data:/var/lib/mysql',
      '-e',
      'MARIADB_DATABASE=myapp',
      '-e',
      'MARIADB_USER=appuser',
      '-e',
      'MARIADB_PASSWORD=DB_PASSWORD',
      'mariadb:11.4',
    ]);
    assert.deepEqual(remotePart(plan.steps[2]), ['docker', 'exec', 'db', 'mariadb-admin', 'ping']);
  });

  it('emits the app env refs pointing at loopback with secret-name credentials', () => {
    const plan = planAccessories(dbConfig());
    assert.deepEqual(plan.appEnv, [
      { name: 'DATABASE_HOST', value: '127.0.0.1' },
      { name: 'DATABASE_PORT', value: '3306' },
      { name: 'DATABASE_TYPE', value: 'mariadb' },
      { name: 'DATABASE_NAME', value: 'myapp' },
      { name: 'DATABASE_USER', value: 'appuser' },
      { name: 'DATABASE_PASSWORD', value: 'DB_PASSWORD' },
    ]);
  });
});

describe('planAccessories: Postgres', () => {
  it('uses the postgres image, port, volume, env vars, and probe', () => {
    const config = normalizeJamalConfig({
      service: 'myapp',
      image: 'img',
      env: { DATABASE_NAME: 'mydb', DATABASE_USER: 'pguser', DATABASE_PASSWORD: 'hunter2' },
      services: { pg: { type: 'postgres' } },
      production: { server: '1.2.3.4' },
    });
    const plan = planAccessories(config);

    assert.deepEqual(remotePart(plan.steps[0]), ['docker', 'volume', 'create', 'postgres-data']);
    assert.deepEqual(remotePart(plan.steps[1]), [
      'docker',
      'run',
      '-d',
      '--restart',
      'unless-stopped',
      '--name',
      'pg',
      '-p',
      '127.0.0.1:5432:5432',
      '-v',
      'postgres-data:/var/lib/postgresql/data',
      '-e',
      'POSTGRES_DB=mydb',
      '-e',
      'POSTGRES_USER=pguser',
      '-e',
      'POSTGRES_PASSWORD=hunter2',
      'postgres:16-alpine',
    ]);
    assert.deepEqual(remotePart(plan.steps[2]), ['docker', 'exec', 'pg', 'pg_isready']);
    assert.deepEqual(plan.appEnv, [
      { name: 'DATABASE_HOST', value: '127.0.0.1' },
      { name: 'DATABASE_PORT', value: '5432' },
      { name: 'DATABASE_TYPE', value: 'postgres' },
      { name: 'DATABASE_NAME', value: 'mydb' },
      { name: 'DATABASE_USER', value: 'pguser' },
      { name: 'DATABASE_PASSWORD', value: 'hunter2' },
    ]);
  });
});

describe('planAccessories: Valkey', () => {
  it('runs valkey with AOF persistence and no requirepass when no password is set', () => {
    const plan = planAccessories(valkeyConfig());

    assert.deepEqual(remotePart(plan.steps[0]), ['docker', 'volume', 'create', 'valkey-data']);
    assert.deepEqual(remotePart(plan.steps[1]), [
      'docker',
      'run',
      '-d',
      '--restart',
      'unless-stopped',
      '--name',
      'cache',
      '-p',
      '127.0.0.1:6379:6379',
      '-v',
      'valkey-data:/data',
      'valkey/valkey:8.0-alpine',
      '--appendonly',
      'yes',
    ]);
    assert.deepEqual(remotePart(plan.steps[2]), ['docker', 'exec', 'cache', 'valkey-cli', 'ping']);
    assert.deepEqual(plan.appEnv, [{ name: 'VALKEY_URL', value: 'redis://127.0.0.1:6379' }]);
  });

  it('adds requirepass and the authenticated probe when a password is set', () => {
    const plan = planAccessories(valkeySecretConfig());

    assert.deepEqual(remotePart(plan.steps[1]), [
      'docker',
      'run',
      '-d',
      '--restart',
      'unless-stopped',
      '--name',
      'cache',
      '-p',
      '127.0.0.1:6379:6379',
      '-v',
      'valkey-data:/data',
      'valkey/valkey:8.0-alpine',
      '--appendonly',
      'yes',
      '--requirepass',
      'VALKEY_PASSWORD',
    ]);
    assert.deepEqual(remotePart(plan.steps[2]), [
      'docker',
      'exec',
      '-e',
      'REDISCLI_AUTH=VALKEY_PASSWORD',
      'cache',
      'valkey-cli',
      'ping',
    ]);
  });
});

describe('planAccessories: omissions and safety', () => {
  it('omits a database env flag when its credential is absent', () => {
    const config = normalizeJamalConfig({
      service: 'myapp',
      image: 'img',
      services: { db: { type: 'mariadb' } },
      production: { server: '1.2.3.4' },
    });
    const plan = planAccessories(config);

    const runArgv = remotePart(plan.steps[1]) ?? [];
    assert.ok(!runArgv.includes('MARIADB_DATABASE'), 'absent credential must not emit a flag');
    assert.ok(!runArgv.includes('MARIADB_USER'));
    assert.ok(!runArgv.includes('MARIADB_PASSWORD'));
    assert.deepEqual(plan.appEnv, [
      { name: 'DATABASE_HOST', value: '127.0.0.1' },
      { name: 'DATABASE_PORT', value: '3306' },
      { name: 'DATABASE_TYPE', value: 'mariadb' },
    ]);
  });

  it('skips dev tools (mailpit/adminer) entirely', () => {
    const config = normalizeJamalConfig({
      service: 'myapp',
      image: 'img',
      services: { mail: { type: 'mailpit' }, admin: { type: 'adminer' } },
      production: { server: '1.2.3.4' },
    });
    assert.deepEqual(planAccessories(config).steps, []);
    assert.deepEqual(planAccessories(config).appEnv, []);
  });

  it('produces an empty plan for a service-less config', () => {
    const plan = planAccessories(noServiceConfig());
    assert.deepEqual(plan.steps, []);
    assert.deepEqual(plan.appEnv, []);
  });

  it('never embeds the redacted secret form in the plan', () => {
    const plan = planAccessories(dbConfig());
    const serialized = JSON.stringify(plan);
    assert.ok(!serialized.includes('secret('), 'the redacted secret(<name>) form must not appear');
  });

  it('rejects a config without a production overlay, value-free', () => {
    assert.throws(
      () =>
        planAccessories(
          normalizeJamalConfig({
            service: 'myapp',
            image: 'img',
            services: { db: { type: 'mariadb' } },
          }),
        ),
      (error: unknown) => error instanceof JamalConfigError && /production/.test(error.message),
    );
  });
});

describe('planProduction: accessory wiring', () => {
  it('prepends accessory steps and adds env refs to the app run step', () => {
    const plan = planProduction(dbConfig(), { imageTag: '1.0.0' });

    assert.deepEqual(
      plan.steps.slice(0, 3).map((step) => step.accessory?.action),
      ['volume', 'run', 'health'],
    );
    assert.deepEqual(
      plan.steps.slice(3).map((step) => step.kind),
      ['build', 'push', 'pull', 'run', 'health', 'switch', 'stop'],
    );

    const run = stepOf(plan, 'run');
    assert.deepEqual(run?.argv, [
      'ssh',
      '1.2.3.4',
      'docker',
      'run',
      '-d',
      '--name',
      plan.containerName,
      '-e',
      'DATABASE_HOST=127.0.0.1',
      '-e',
      'DATABASE_PORT=3306',
      '-e',
      'DATABASE_TYPE=mariadb',
      '-e',
      'DATABASE_NAME=myapp',
      '-e',
      'DATABASE_USER=appuser',
      '-e',
      'DATABASE_PASSWORD=DB_PASSWORD',
      'ghcr.io/acme/myapp:1.0.0',
    ]);
  });

  it('keeps a service-less plan identical to the pre-accessory flow', () => {
    const plan = planProduction(noServiceConfig(), { imageTag: '1.0.0' });

    assert.deepEqual(
      plan.steps.map((step) => step.kind),
      ['build', 'push', 'pull', 'run', 'health', 'switch', 'stop'],
    );
    assert.deepEqual(stepOf(plan, 'run')?.argv, [
      'ssh',
      '1.2.3.4',
      'docker',
      'run',
      '-d',
      '--name',
      plan.containerName,
      'ghcr.io/acme/myapp:1.0.0',
    ]);
  });
});

describe('runAccessories: execution', () => {
  it('runs volume, gates run on inspect, and polls health in order', async () => {
    // The container already exists, so the run step is skipped.
    const remote = makeRemote((argv) => (argv[0] === 'docker' && argv[1] === 'inspect' ? 0 : 0));
    const steps = [
      accessoryStep('volume', 'db', ['docker', 'volume', 'create', 'mariadb-data']),
      accessoryStep('run', 'db', ['docker', 'run', '--name', 'db', 'mariadb:11.4']),
      accessoryStep('health', 'db', ['docker', 'exec', 'db', 'mariadb-admin', 'ping']),
    ];

    await runAccessories(steps, { remoteRunner: remote.remote, sleep: makeSleep().sleep });

    assert.deepEqual(remote.calls[0], ['docker', 'volume', 'create', 'mariadb-data']);
    assert.deepEqual(remote.calls[1], ['docker', 'inspect', 'db']);
    assert.deepEqual(remote.calls[2], ['docker', 'exec', 'db', 'mariadb-admin', 'ping']);
    assert.equal(remote.calls.length, 3, 'an existing container must not be recreated');
  });

  it('recreates the container when the inspect reports it is absent', async () => {
    const remote = makeRemote((argv) => (argv[0] === 'docker' && argv[1] === 'inspect' ? 1 : 0));
    const step = accessoryStep('run', 'db', ['docker', 'run', '--name', 'db', 'mariadb:11.4']);

    await runAccessories([step], { remoteRunner: remote.remote, sleep: makeSleep().sleep });

    assert.deepEqual(remote.calls[0], ['docker', 'inspect', 'db']);
    assert.deepEqual(remote.calls[1], ['docker', 'run', '--name', 'db', 'mariadb:11.4']);
  });

  it('retries a failing health probe up to the attempt cap, then fails value-free', async () => {
    const remote = makeRemote(() => 1);
    const { sleep, delays } = makeSleep();
    const step = accessoryStep('health', 'db', ['docker', 'exec', 'db', 'mariadb-admin', 'ping']);

    await assert.rejects(
      () => runAccessories([step], { remoteRunner: remote.remote, sleep }),
      (error: unknown) => error instanceof AccessoryError && error.action === 'health',
    );

    assert.equal(remote.calls.length, ACCESSORY_HEALTH_MAX_ATTEMPTS);
    assert.equal(delays.length, ACCESSORY_HEALTH_MAX_ATTEMPTS - 1);
    assert.ok(delays.every((ms) => ms === ACCESSORY_HEALTH_RETRY_DELAY_MS));
  });

  it('resolves once a health probe succeeds', async () => {
    let attempts = 0;
    const remote = makeRemote(() => {
      attempts += 1;
      return attempts < 3 ? 1 : 0;
    });
    const step = accessoryStep('health', 'db', ['docker', 'exec', 'db', 'mariadb-admin', 'ping']);

    await runAccessories([step], { remoteRunner: remote.remote, sleep: makeSleep().sleep });

    assert.equal(attempts, 3);
  });

  it('raises a volume failure naming the action', async () => {
    const remote = makeRemote(() => 1);
    const step = accessoryStep('volume', 'db', ['docker', 'volume', 'create', 'mariadb-data']);

    await assert.rejects(
      () => runAccessories([step], { remoteRunner: remote.remote, sleep: makeSleep().sleep }),
      (error: unknown) => error instanceof AccessoryError && error.action === 'volume',
    );
  });

  it('raises a run failure when the recreate exits non-zero', async () => {
    const remote = makeRemote((argv) => (argv[0] === 'docker' && argv[1] === 'inspect' ? 1 : 5));
    const step = accessoryStep('run', 'db', ['docker', 'run', '--name', 'db', 'mariadb:11.4']);

    await assert.rejects(
      () => runAccessories([step], { remoteRunner: remote.remote, sleep: makeSleep().sleep }),
      (error: unknown) => error instanceof AccessoryError && error.action === 'run',
    );
  });
});

describe('runDeployExecution: accessory abort', () => {
  const okHealthCheck: HealthCheck = async () => {};
  const noHooksFs = { exists: () => false, isExecutable: () => false };
  const okHookRunner = async () => ({ exitCode: 0, stdout: '', stderr: '' });

  it('aborts before the app release with a value-free accessory error', async () => {
    // mkdir/rmdir and the volume/inspect steps succeed; the health probe fails.
    const remote = makeRemote((argv) => (argv[0] === 'docker' && argv[1] === 'exec' ? 1 : 0));
    const buildCalls: string[][] = [];
    const commandRunner: CommandRunner = async (argv) => {
      buildCalls.push([...argv]);
      return { exitCode: 0, stdout: '', stderr: '' };
    };

    await assert.rejects(
      () =>
        runDeployExecution({
          config: dbConfig(),
          imageTag: '1.0.0',
          commandRunner,
          remoteRunner: remote.remote,
          healthCheck: okHealthCheck,
          hooksFs: noHooksFs,
          hookRunner: okHookRunner,
          sleep: makeSleep().sleep,
        }),
      (error: unknown) =>
        error instanceof DeployExecuteError &&
        /deploy failed at accessory step "health"/.test(error.message),
    );

    assert.equal(buildCalls.length, 0, 'the app release must not start after an accessory failure');
  });
});
