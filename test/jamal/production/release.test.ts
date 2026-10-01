import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { normalizeJamalConfig, type JamalConfig } from '../../../src/jamal/config.js';
import { planProduction, type ProductionPlan } from '../../../src/jamal/production/plan.js';
import {
  executeReleaseSteps,
  type HealthCheck,
  type ReleaseSummary,
} from '../../../src/jamal/production/release.js';
import type { CommandRunner } from '../../../src/jamal/production/command-runner.js';
import type { RemoteRunner } from '../../../src/jamal/production/transport.js';

/**
 * Tests for the production release executor. Every seam — the local command
 * runner, the remote (ssh) runner, and the health check — is injected, so no
 * docker, ssh, or HTTP probe runs: assertions target step ordering, which
 * runner each step reaches, failure stop points, the opt-in rollback, the
 * deferred proxy-switch warning, and value-free failure messages.
 */

function config(): JamalConfig {
  return normalizeJamalConfig({
    service: 'myapp',
    image: 'ghcr.io/acme/myapp',
    health: { path: '/up', timeoutMs: 5000, intervalMs: 30000 },
    production: { server: '1.2.3.4', domain: 'example.com' },
  });
}

/** A domain-less production config: the switch step carries no proxy argv. */
function serverOnlyConfig(): JamalConfig {
  return normalizeJamalConfig({
    service: 'myapp',
    image: 'ghcr.io/acme/myapp',
    health: { path: '/up', timeoutMs: 5000, intervalMs: 30000 },
    production: { server: '1.2.3.4' },
  });
}

function firstPlan(): ProductionPlan {
  return planProduction(config(), { imageTag: '1.0.0' });
}

function rollForwardPlan(): ProductionPlan {
  return planProduction(config(), { imageTag: '2.0.0', previousTag: '1.0.0' });
}

interface RecordedRemote {
  server: string;
  remoteArgv: string[];
}

function makeCommandRunner(exitCode = 0): { runner: CommandRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: CommandRunner = async (argv) => {
    calls.push([...argv]);
    return { exitCode, stdout: '', stderr: '' };
  };
  return { runner, calls };
}

function makeRemoteRunner(exitCode = 0): { remote: RemoteRunner; calls: RecordedRemote[] } {
  const calls: RecordedRemote[] = [];
  const remote: RemoteRunner = {
    async run(server, remoteArgv) {
      calls.push({ server, remoteArgv: [...remoteArgv] });
      return { exitCode, stdout: '', stderr: '' };
    },
  };
  return { remote, calls };
}

function makeHealthCheck(
  onCall?: (url: string, options: { timeoutMs: number; intervalMs: number }) => void,
): { healthCheck: HealthCheck; calls: { url: string; options: unknown }[] } {
  const calls: { url: string; options: unknown }[] = [];
  const healthCheck: HealthCheck = async (url, options) => {
    calls.push({ url, options });
    onCall?.(url, options);
  };
  return { healthCheck, calls };
}

/** An instant sleep seam that records every delay, so retry tests never wait. */
function makeSleep(): { sleep: (ms: number) => Promise<void>; delays: number[] } {
  const delays: number[] = [];
  const sleep = async (ms: number): Promise<void> => {
    delays.push(ms);
  };
  return { sleep, delays };
}

describe('executeReleaseSteps: successful order', () => {
  it('executes build/push locally, pull/run/stop remotely, health via the checker', async () => {
    const plan = rollForwardPlan();
    const local = makeCommandRunner();
    const remote = makeRemoteRunner();
    const health = makeHealthCheck();

    const summary = await executeReleaseSteps(plan, {
      commandRunner: local.runner,
      remoteRunner: remote.remote,
      healthCheck: health.healthCheck,
    });

    assert.deepEqual(summary.completed, [
      'build',
      'push',
      'pull',
      'run',
      'health',
      'switch',
      'stop',
    ]);
    assert.equal(summary.failedStep, undefined);

    // Local steps: build then push, each via the injected command runner.
    assert.deepEqual(local.calls[0], [
      'docker',
      'buildx',
      'build',
      '-t',
      'ghcr.io/acme/myapp:2.0.0',
      '.',
    ]);
    assert.deepEqual(local.calls[1], ['docker', 'push', 'ghcr.io/acme/myapp:2.0.0']);
    assert.equal(local.calls.length, 2);

    // Remote steps: pull, run, switch (proxy deploy), stop (in plan order), all
    // on the plan server.
    assert.deepEqual(
      remote.calls.map((call) => call.server),
      ['1.2.3.4', '1.2.3.4', '1.2.3.4', '1.2.3.4'],
    );
    assert.deepEqual(remote.calls[0]?.remoteArgv, ['docker', 'pull', 'ghcr.io/acme/myapp:2.0.0']);
    assert.deepEqual(remote.calls[1]?.remoteArgv, [
      'docker',
      'run',
      '-d',
      '--name',
      plan.containerName,
      'ghcr.io/acme/myapp:2.0.0',
    ]);
    assert.deepEqual(remote.calls[3]?.remoteArgv, ['docker', 'stop', 'myapp-web-100']);
    assert.equal(remote.calls.length, 4);

    // Health: the checker receives the plan URL and timings.
    assert.equal(health.calls[0]?.url, 'https://example.com/up');
    assert.deepEqual(health.calls[0]?.options, { timeoutMs: 5000, intervalMs: 30000 });

    // The switch step carries a proxy deploy argv (a domain is set), so it is
    // executed, not deferred.
    assert.ok(summary.completed.includes('switch'));
    assert.ok(!summary.warnings.some((warning) => warning.includes('proxy switch is deferred')));
  });

  it('executes the switch via the proxy deploy argv over ssh', async () => {
    const plan = rollForwardPlan();
    const local = makeCommandRunner();
    const remote = makeRemoteRunner();
    const health = makeHealthCheck();

    await executeReleaseSteps(plan, {
      commandRunner: local.runner,
      remoteRunner: remote.remote,
      healthCheck: health.healthCheck,
    });

    // The switch step (a domain is set) runs `kamal-proxy deploy` on the server,
    // targeting the new container with TLS and the production domain as host.
    const switchCall = remote.calls.find(
      (call) => call.remoteArgv[0] === 'docker' && call.remoteArgv[1] === 'exec',
    );
    assert.deepEqual(switchCall, {
      server: '1.2.3.4',
      remoteArgv: [
        'docker',
        'exec',
        'kamal-proxy',
        'kamal-proxy',
        'deploy',
        'myapp',
        '--target',
        'myapp-web-200',
        '--host',
        'example.com',
        '--tls',
      ],
    });
  });
});

describe('executeReleaseSteps: readiness delay', () => {
  it('sleeps readinessDelayMs once before the first health probe', async () => {
    const config = normalizeJamalConfig({
      service: 'myapp',
      image: 'ghcr.io/acme/myapp',
      health: {
        path: '/up',
        timeoutMs: 5000,
        intervalMs: 30000,
        readinessDelayMs: 600,
      },
      production: { server: '1.2.3.4' },
    });
    const plan = planProduction(config, { imageTag: '1.0.0' });
    const { sleep, delays } = makeSleep();
    const health = makeHealthCheck();

    await executeReleaseSteps(plan, {
      commandRunner: makeCommandRunner().runner,
      remoteRunner: makeRemoteRunner().remote,
      healthCheck: health.healthCheck,
      sleep,
    });

    assert.deepEqual(delays, [600]);
    assert.ok(health.calls.length > 0, 'health check should have been called');
  });

  it('honors healthRetries / healthRetryDelayMs from the plan', async () => {
    const config = normalizeJamalConfig({
      service: 'myapp',
      image: 'ghcr.io/acme/myapp',
      health: { path: '/up', timeoutMs: 5000, intervalMs: 30000, retries: 2, retryDelayMs: 100 },
      production: { server: '1.2.3.4' },
    });
    const plan = planProduction(config, { imageTag: '1.0.0' });
    const health = makeHealthCheck(() => {
      throw new Error('fail');
    });
    const { sleep, delays } = makeSleep();

    await executeReleaseSteps(plan, {
      commandRunner: makeCommandRunner().runner,
      remoteRunner: makeRemoteRunner().remote,
      healthCheck: health.healthCheck,
      sleep,
    });

    // 1 attempt + 2 retries = 3 total; plan retryDelayMs of 100 after each failure.
    assert.equal(health.calls.length, 3);
    assert.deepEqual(delays, [100, 100]);
  });
});

describe('executeReleaseSteps: failure stop points', () => {
  it('stops at build and never reaches ssh or the health check', async () => {
    const plan = firstPlan();
    const local = makeCommandRunner(1); // non-zero build/push exit
    const remote = makeRemoteRunner();
    const health = makeHealthCheck();

    const summary = await executeReleaseSteps(plan, {
      commandRunner: local.runner,
      remoteRunner: remote.remote,
      healthCheck: health.healthCheck,
    });

    assert.deepEqual(summary.completed, []);
    assert.equal(summary.failedStep?.kind, 'build');
    assert.equal(summary.failedStep?.exitCode, 1);
    assert.match(summary.failedStep?.message ?? '', /docker buildx build exited with code 1/);
    assert.equal(remote.calls.length, 0, 'no ssh command may run after a build failure');
    assert.equal(health.calls.length, 0, 'no health probe may run after a build failure');
  });

  it('retries a failing health check then reports a value-free timeout', async () => {
    const plan = firstPlan();
    const local = makeCommandRunner();
    const remote = makeRemoteRunner();
    const health = makeHealthCheck(() => {
      throw new Error('poll timed out');
    });
    const { sleep, delays } = makeSleep();

    const summary = await executeReleaseSteps(plan, {
      commandRunner: local.runner,
      remoteRunner: remote.remote,
      healthCheck: health.healthCheck,
      sleep,
    });

    assert.deepEqual(summary.completed, ['build', 'push', 'pull', 'run']);
    assert.equal(summary.failedStep?.kind, 'health');
    assert.equal(summary.failedStep?.message, 'the health check timed out');
    assert.ok(!(summary.failedStep?.message ?? '').includes('example.com'), 'URL must not leak');

    // Default policy: 5 retries after the first attempt, 10s between each.
    assert.equal(health.calls.length, 6);
    assert.deepEqual(delays, [10_000, 10_000, 10_000, 10_000, 10_000]);
  });

  it('succeeds when the health check recovers within the retry budget', async () => {
    const plan = firstPlan();
    const local = makeCommandRunner();
    const remote = makeRemoteRunner();
    let attempts = 0;
    const health = makeHealthCheck(() => {
      attempts += 1;
      if (attempts < 3) {
        throw new Error('poll timed out');
      }
    });
    const { sleep, delays } = makeSleep();

    const summary = await executeReleaseSteps(plan, {
      commandRunner: local.runner,
      remoteRunner: remote.remote,
      healthCheck: health.healthCheck,
      sleep,
    });

    assert.deepEqual(summary.completed, ['build', 'push', 'pull', 'run', 'health', 'switch']);
    assert.equal(summary.failedStep, undefined);
    assert.equal(attempts, 3);
    assert.deepEqual(delays, [10_000, 10_000]);
  });

  it('caps total attempts at maxAttempts even when retries is higher', async () => {
    const plan = firstPlan();
    const health = makeHealthCheck(() => {
      throw new Error('poll timed out');
    });
    const { sleep, delays } = makeSleep();

    const summary = await executeReleaseSteps(plan, {
      commandRunner: makeCommandRunner().runner,
      remoteRunner: makeRemoteRunner().remote,
      healthCheck: health.healthCheck,
      sleep,
      healthRetry: { retries: 5, delayMs: 20, maxAttempts: 2 },
    });

    assert.equal(summary.failedStep?.kind, 'health');
    assert.equal(health.calls.length, 2);
    assert.deepEqual(delays, [20]);
  });

  it('reports a value-free remote failure on a non-zero pull exit', async () => {
    const plan = firstPlan();
    const local = makeCommandRunner();
    const remote = makeRemoteRunner(7);
    const health = makeHealthCheck();

    const summary = await executeReleaseSteps(plan, {
      commandRunner: local.runner,
      remoteRunner: remote.remote,
      healthCheck: health.healthCheck,
    });

    assert.deepEqual(summary.completed, ['build', 'push']);
    assert.equal(summary.failedStep?.kind, 'pull');
    assert.equal(summary.failedStep?.exitCode, 7);
    assert.equal(summary.failedStep?.message, 'pull exited with code 7');
  });
});

describe('executeReleaseSteps: rollback is opt-in', () => {
  it('skips the rollback step when rollback is not requested', async () => {
    const plan = rollForwardPlan();
    const local = makeCommandRunner();
    const remote = makeRemoteRunner();
    const health = makeHealthCheck();

    const summary = await executeReleaseSteps(plan, {
      commandRunner: local.runner,
      remoteRunner: remote.remote,
      healthCheck: health.healthCheck,
    });

    assert.ok(!summary.completed.includes('rollback'));
    assert.equal(
      remote.calls.some(
        (call) =>
          call.remoteArgv.includes('myapp-web-100') &&
          call.remoteArgv[0] === 'docker' &&
          call.remoteArgv[1] === 'run',
      ),
      false,
      'rollback must not run without rollback: true',
    );
  });

  it('executes the rollback step only when rollback is exactly true', async () => {
    const plan = rollForwardPlan();
    const local = makeCommandRunner();
    const remote = makeRemoteRunner();
    const health = makeHealthCheck();

    const summary = await executeReleaseSteps(plan, {
      commandRunner: local.runner,
      remoteRunner: remote.remote,
      healthCheck: health.healthCheck,
      rollback: true,
    });

    assert.ok(summary.completed.includes('rollback'));
    const rollbackCall = remote.calls.find(
      (call) =>
        call.remoteArgv[0] === 'docker' &&
        call.remoteArgv[1] === 'run' &&
        call.remoteArgv.includes('myapp-web-100'),
    );
    assert.deepEqual(rollbackCall?.remoteArgv, [
      'docker',
      'run',
      '-d',
      '--name',
      'myapp-web-100',
      'ghcr.io/acme/myapp:1.0.0',
    ]);
  });
});

describe('executeReleaseSteps: summary shape and determinism', () => {
  it('returns deep-equal summaries for identical input and options', async () => {
    const plan = rollForwardPlan();
    const summaries: ReleaseSummary[] = [];

    for (let index = 0; index < 2; index += 1) {
      summaries.push(
        await executeReleaseSteps(plan, {
          commandRunner: makeCommandRunner().runner,
          remoteRunner: makeRemoteRunner().remote,
          healthCheck: makeHealthCheck().healthCheck,
        }),
      );
    }

    assert.deepEqual(summaries[0], summaries[1]);
  });

  it('carries the plan warnings plus the deferred-switch warning on a domain-less deploy', async () => {
    const plan = planProduction(serverOnlyConfig(), { imageTag: '2.0.0', previousTag: '1.0.0' });
    const summary = await executeReleaseSteps(plan, {
      commandRunner: makeCommandRunner().runner,
      remoteRunner: makeRemoteRunner().remote,
      healthCheck: makeHealthCheck().healthCheck,
    });

    // The roll-forward plan emits a version-skew reminder; without a domain the
    // switch step has no argv and adds a deferred-switch warning.
    assert.ok(summary.warnings.some((warning) => warning.includes('migrations')));
    assert.ok(summary.warnings.some((warning) => warning.includes('proxy switch is deferred')));
  });

  it('reports a value-free switch failure when the proxy deploy exits non-zero', async () => {
    const plan = firstPlan();
    const local = makeCommandRunner();
    const health = makeHealthCheck();
    let remoteCalls = 0;
    const remote: RemoteRunner = {
      async run() {
        remoteCalls += 1;
        // pull and run succeed; the switch (the third remote command) fails.
        return { exitCode: remoteCalls === 3 ? 4 : 0, stdout: '', stderr: '' };
      },
    };

    const summary = await executeReleaseSteps(plan, {
      commandRunner: local.runner,
      remoteRunner: remote,
      healthCheck: health.healthCheck,
    });

    assert.deepEqual(summary.completed, ['build', 'push', 'pull', 'run', 'health']);
    assert.equal(summary.failedStep?.kind, 'switch');
    assert.equal(summary.failedStep?.exitCode, 4);
    assert.equal(summary.failedStep?.message, 'switch exited with code 4');
    assert.ok(!(summary.failedStep?.message ?? '').includes('example.com'), 'domain must not leak');
  });

  it('exposes the health poll timings on the plan', () => {
    const plan = firstPlan();
    assert.equal(plan.healthTimeoutMs, 5000);
    assert.equal(plan.healthIntervalMs, 30000);
  });
});

describe('executeReleaseSteps: required seams', () => {
  it('rejects a call missing the health check', async () => {
    await assert.rejects(
      () =>
        executeReleaseSteps(firstPlan(), {
          commandRunner: makeCommandRunner().runner,
          remoteRunner: makeRemoteRunner().remote,
          healthCheck: undefined as unknown as HealthCheck,
        }),
      (error: unknown) => error instanceof Error && /health check/.test(error.message),
    );
  });
});
