import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { normalizeJamalConfig, type JamalConfig } from '../../src/jamal/config.js';
import { runJamalCommand, type JamalDeps } from '../../src/jamal/command.js';
import { createDeploymentGeneratorRegistry } from '../../src/deploy/registry.js';
import {
  containerNameForTag,
  planProduction,
  type ProductionPlan,
} from '../../src/jamal/production/plan.js';
import {
  DeployExecuteError,
  RollbackError,
  createFetchHealthCheck,
  defaultImageTag,
  deployLockDir,
  remoteExecArgv,
  remoteLogsArgv,
  remoteStatusArgv,
  runDeployExecution,
  runRollbackExecution,
  type DeployExecutionOptions,
} from '../../src/jamal/production/execute.js';
import {
  DEPLOYS_HISTORY_PATH,
  DeployHistoryError,
  appendDeployEntry,
  deploysHistoryFile,
  emptyDeployHistory,
  readDeployHistory,
  writeDeployHistory,
  type DeployHistory,
  type DeployHistoryEntry,
} from '../../src/jamal/production/history.js';
import type { CommandRunner } from '../../src/jamal/production/command-runner.js';
import type { RemoteRunner } from '../../src/jamal/production/transport.js';
import type { HealthCheck } from '../../src/jamal/production/release.js';

/**
 * Tests for the jamal production deploy/rollback execution and inspection
 * verbs. Every seam (command runner, remote runner, health check, hooks
 * filesystem/runner, tag resolver, history store) is injected, so no docker,
 * ssh, git, or HTTP call happens except the one opt-in health-check test
 * against a loopback server. Assertions target lock ordering, hook ordering,
 * failure stop points, error classes, history persistence, and the CLI routing
 * (execute-by-default, `--dry-run` preview, and remote logs/exec).
 */

function config(): JamalConfig {
  return normalizeJamalConfig({
    service: 'myapp',
    image: 'ghcr.io/acme/myapp',
    health: { path: '/up', timeoutMs: 5000, intervalMs: 30000 },
    production: { server: '1.2.3.4', domain: 'example.com' },
  });
}

function entry(service: string, tag: string): DeployHistoryEntry {
  return { service, tag, timestamp: '2026-01-01T00:00:00.000Z' };
}

interface RecordedRemote {
  server: string;
  remoteArgv: string[];
}

function makeRemoteRunner(
  exitCode = 0,
  stdout = '',
): { remote: RemoteRunner; calls: RecordedRemote[] } {
  const calls: RecordedRemote[] = [];
  const remote: RemoteRunner = {
    async run(server, remoteArgv) {
      calls.push({ server, remoteArgv: [...remoteArgv] });
      return { exitCode, stdout, stderr: '' };
    },
  };
  return { remote, calls };
}

/**
 * A remote runner whose lock operations (`mkdir`/`rmdir`) succeed so the lock
 * is acquired and released, while every release step (a `docker` command) fails
 * with `failExitCode`. This surfaces the failure at the first remote release
 * step ("pull") rather than during lock acquisition, which the uniform
 * {@link makeRemoteRunner} cannot distinguish.
 */
function makeFailingRemoteRunner(failExitCode: number): {
  remote: RemoteRunner;
  calls: RecordedRemote[];
} {
  const calls: RecordedRemote[] = [];
  const remote: RemoteRunner = {
    async run(server, remoteArgv) {
      calls.push({ server, remoteArgv: [...remoteArgv] });
      const isLockOperation = remoteArgv[0] === 'mkdir' || remoteArgv[0] === 'rmdir';
      return { exitCode: isLockOperation ? 0 : failExitCode, stdout: '', stderr: '' };
    },
  };
  return { remote, calls };
}

const okCommandRunner: CommandRunner = async () => ({ exitCode: 0, stdout: '', stderr: '' });
const okHealthCheck: HealthCheck = async () => {};
const noHooksFs = { exists: () => false, isExecutable: () => false };
const okHookRunner = async () => ({ exitCode: 0, stdout: '', stderr: '' });

function executionOptions(overrides: Partial<DeployExecutionOptions> = {}): DeployExecutionOptions {
  return {
    config: config(),
    imageTag: '2.0.0',
    commandRunner: okCommandRunner,
    remoteRunner: makeRemoteRunner().remote,
    healthCheck: okHealthCheck,
    hooksFs: noHooksFs,
    hookRunner: okHookRunner,
    ...overrides,
  };
}

describe('execute: runDeployExecution', () => {
  it('locks, runs the hooks and release, records the entry, and unlocks', async () => {
    const remote = makeRemoteRunner();
    const phases: string[] = [];
    const result = await runDeployExecution(
      executionOptions({
        remoteRunner: remote.remote,
        hooksFs: { exists: () => true, isExecutable: () => true },
        hookRunner: async (argv) => {
          phases.push(argv[0]?.split('/').pop() ?? '');
          return { exitCode: 0, stdout: '', stderr: '' };
        },
      }),
    );

    assert.deepEqual(phases, ['pre-build', 'pre-deploy', 'post-deploy']);
    assert.deepEqual(result.entry.service, 'myapp');
    assert.equal(result.entry.tag, '2.0.0');
    assert.equal(typeof result.entry.timestamp, 'string');

    assert.deepEqual(remote.calls[0]?.remoteArgv, ['mkdir', '/tmp/jamal-deploy-myapp.lock']);
    assert.deepEqual(remote.calls[remote.calls.length - 1]?.remoteArgv, [
      'rmdir',
      '/tmp/jamal-deploy-myapp.lock',
    ]);
  });

  it('skips post-deploy, releases the lock, and raises DeployExecuteError on a failed step', async () => {
    const remote = makeFailingRemoteRunner(9);
    const phases: string[] = [];

    await assert.rejects(
      () =>
        runDeployExecution(
          executionOptions({
            remoteRunner: remote.remote,
            hooksFs: { exists: () => true, isExecutable: () => true },
            hookRunner: async (argv) => {
              phases.push(argv[0]?.split('/').pop() ?? '');
              return { exitCode: 0, stdout: '', stderr: '' };
            },
          }),
        ),
      (error: unknown) =>
        error instanceof DeployExecuteError && /deploy failed at step "pull"/.test(error.message),
    );

    assert.deepEqual(phases, ['pre-build', 'pre-deploy'], 'post-deploy must not run on failure');
    assert.deepEqual(
      remote.calls[remote.calls.length - 1]?.remoteArgv,
      ['rmdir', '/tmp/jamal-deploy-myapp.lock'],
      'the lock is released even on failure',
    );
  });

  it('rejects a config without a production section before locking', async () => {
    const remote = makeRemoteRunner();
    await assert.rejects(
      () =>
        runDeployExecution(
          executionOptions({
            remoteRunner: remote.remote,
            config: normalizeJamalConfig({ service: 'myapp', image: 'ghcr.io/acme/myapp' }),
          }),
        ),
      (error: unknown) => error instanceof DeployExecuteError && /production/.test(error.message),
    );
    assert.equal(remote.calls.length, 0, 'no lock may be taken without a production config');
  });
});

describe('execute: runRollbackExecution', () => {
  it('raises RollbackError naming the failed step kind', async () => {
    await assert.rejects(
      () =>
        runRollbackExecution(executionOptions({ remoteRunner: makeFailingRemoteRunner(3).remote })),
      (error: unknown) =>
        error instanceof RollbackError && /rollback failed at step "pull"/.test(error.message),
    );
  });

  it('plans the target as the new image and the current as the previous', async () => {
    const remote = makeRemoteRunner();
    const result = await runRollbackExecution(
      executionOptions({ imageTag: '1.0.0', previousTag: '2.0.0', remoteRunner: remote.remote }),
    );

    assert.equal(result.entry.tag, '1.0.0');
    const stopCall = remote.calls.find(
      (call) => call.remoteArgv[0] === 'docker' && call.remoteArgv[1] === 'stop',
    );
    assert.equal(
      stopCall?.remoteArgv[2],
      containerNameForTag('myapp', '2.0.0'),
      'the current container is the one stopped',
    );
  });
});

describe('execute: helpers', () => {
  it('deployLockDir names the service', () => {
    assert.equal(deployLockDir('myapp'), '/tmp/jamal-deploy-myapp.lock');
  });

  it('remote argv builders assemble the fixed docker commands', () => {
    assert.deepEqual(remoteStatusArgv(), ['docker', 'ps']);
    assert.deepEqual(remoteLogsArgv('myapp-web-abc', false), ['docker', 'logs', 'myapp-web-abc']);
    assert.deepEqual(remoteLogsArgv('myapp-web-abc', true), [
      'docker',
      'logs',
      '--follow',
      'myapp-web-abc',
    ]);
    assert.deepEqual(remoteExecArgv('myapp-web-abc', ['sh', '-c', 'echo hi']), [
      'docker',
      'exec',
      'myapp-web-abc',
      'sh',
      '-c',
      'echo hi',
    ]);
  });

  it('remote argv builders reject an unsafe container name value-free', () => {
    for (const bad of ['', 'has space', 'leads\nnewline', '-opt']) {
      assert.throws(
        () => remoteLogsArgv(bad, false),
        (error: unknown) => {
          assert.ok(error instanceof DeployExecuteError);
          assert.ok(!JSON.stringify(bad).includes(error.message));
          return true;
        },
      );
    }
  });

  it('defaultImageTag falls back to a timestamp outside a git repo', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jamal-tag-'));
    try {
      const tag = await defaultImageTag(dir);
      assert.match(tag, /^\d{14}$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('execute: createFetchHealthCheck', () => {
  let server: Server;
  let baseUrl: string;

  before(async () => {
    server = createServer((req, res) => {
      if (req.url === '/up') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('ok');
      } else {
        res.writeHead(500);
        res.end('down');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('resolves once the health URL returns ok', async () => {
    await createFetchHealthCheck()(`${baseUrl}/up`, { timeoutMs: 1000, intervalMs: 5 });
  });
});

describe('history', () => {
  it('round-trips entries through write and read', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jamal-history-'));
    try {
      const history: DeployHistory = {
        version: 1,
        entries: [entry('myapp', '1.0.0'), entry('myapp', '2.0.0')],
      };
      await writeDeployHistory(dir, history);
      assert.deepEqual(await readDeployHistory(dir), history);
      assert.equal(DEPLOYS_HISTORY_PATH, '.jamal/deploys.json');
      assert.equal(deploysHistoryFile(dir), join(dir, '.jamal', 'deploys.json'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves an empty history when the file is missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jamal-history-'));
    try {
      assert.deepEqual(await readDeployHistory(dir), emptyDeployHistory());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('appends entries oldest-first', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jamal-history-'));
    try {
      await appendDeployEntry(dir, entry('myapp', '1.0.0'));
      await appendDeployEntry(dir, entry('myapp', '2.0.0'));
      const history = await readDeployHistory(dir);
      assert.deepEqual(
        history.entries.map((value) => value.tag),
        ['1.0.0', '2.0.0'],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects malformed and unsupported history value-free', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jamal-history-'));
    const file = deploysHistoryFile(dir);
    try {
      mkdirSync(join(dir, '.jamal'), { recursive: true });
      for (const bad of [
        'not json',
        '{"version":2,"entries":[]}',
        '{"version":1,"entries":[{"x":1}]}',
      ]) {
        writeFileSync(file, bad, 'utf8');
        await assert.rejects(
          () => readDeployHistory(dir),
          (error: unknown) => error instanceof DeployHistoryError,
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// CLI routing
// ---------------------------------------------------------------------------

interface Sinks {
  out: string[];
  err: string[];
}

function sinks(): Sinks {
  return { out: [], err: [] };
}

/** Build deps for the execute/inspect verbs; every seam is injected (no spawn). */
function deps(cwd: string, s: Sinks, overrides: Partial<JamalDeps> = {}): JamalDeps {
  return {
    createRegistry: () => {
      throw new Error('registry must not be built for execute/inspect verbs');
    },
    cwd,
    stdout: (text) => s.out.push(text),
    stderr: (text) => s.err.push(text),
    loadJamalConfig: async () => config(),
    readHistory: async () => emptyDeployHistory(),
    appendHistory: async (_dir, value) => ({ version: 1, entries: [value] }),
    resolveTag: async () => 'abcdef1',
    processRunner: okCommandRunner,
    remoteRunner: makeRemoteRunner().remote,
    healthCheck: okHealthCheck,
    hooksFs: noHooksFs,
    hookRunner: okHookRunner,
    ...overrides,
  };
}

const fixturesRoot = mkdtempSync(join(tmpdir(), 'jamal-exec-'));

after(() => {
  rmSync(fixturesRoot, { recursive: true, force: true });
});

describe('jamal deploy: flag scoping', () => {
  it('rejects planning flags for the kamal engine as usage errors', async () => {
    const s = sinks();
    const d = deps(join(fixturesRoot, 'flags'), s);
    for (const flags of [
      ['deploy', '--write'],
      ['deploy', '--dir', 'x'],
      ['deploy', '--target', 'vercel', '--tag', 'x'],
    ]) {
      assert.equal(await runJamalCommand(flags, d), 2, flags.join(' '));
    }
    assert.match(s.err.join('\n'), /--tag|--write|--dir/);
  });

  it('allows --dry-run on a static target (generate without executing)', async () => {
    const s = sinks();
    const dir = join(fixturesRoot, 'static-dry');
    const invoked: string[][] = [];
    const d = deps(dir, s, {
      createRegistry: (custom = []) => createDeploymentGeneratorRegistry({ generators: custom }),
    });
    d.runCommand = async (argv) => {
      invoked.push([...argv]);
      return { exitCode: 0, stdout: '', stderr: '' };
    };

    assert.equal(
      await runJamalCommand(['deploy', '--target', 'vercel', '--write', '--dry-run'], d),
      0,
    );
    assert.equal(invoked.length, 0, '--dry-run must not execute npx');
  });

  it('scopes --tag and --dry-run to deploy/rollback', async () => {
    const s = sinks();
    const d = deps(join(fixturesRoot, 'scope'), s);
    assert.equal(await runJamalCommand(['dev', '--tag', 'x'], d), 2);
    assert.match(s.err.join('\n'), /--tag is only valid/);
    assert.equal(await runJamalCommand(['dev', '--dry-run'], d), 2);
    assert.match(s.err.join('\n'), /--dry-run is only valid/);
  });
});

describe('jamal deploy (kamal engine)', () => {
  it('executes by default and records the tag in history', async () => {
    const dir = join(fixturesRoot, 'deploy-ok');
    const s = sinks();
    const remote = makeRemoteRunner();
    const appended: DeployHistoryEntry[] = [];
    const d = deps(dir, s, {
      remoteRunner: remote.remote,
      appendHistory: async (_dir, value) => {
        appended.push(value);
        return { version: 1, entries: [value] };
      },
    });

    const code = await runJamalCommand(['deploy'], d);

    assert.equal(code, 0, s.err.join('\n'));
    assert.equal(appended.length, 1);
    assert.equal(appended[0]?.service, 'myapp');
    assert.equal(appended[0]?.tag, 'abcdef1');
    assert.match(s.out.join('\n'), /deployed ghcr\.io\/acme\/myapp:abcdef1/);
    assert.deepEqual(remote.calls[0]?.remoteArgv, ['mkdir', '/tmp/jamal-deploy-myapp.lock']);
    assert.deepEqual(remote.calls[remote.calls.length - 1]?.remoteArgv, [
      'rmdir',
      '/tmp/jamal-deploy-myapp.lock',
    ]);
  });

  it('uses --tag when given', async () => {
    const s = sinks();
    const appended: DeployHistoryEntry[] = [];
    const d = deps(join(fixturesRoot, 'deploy-tag'), s, {
      appendHistory: async (_dir, value) => {
        appended.push(value);
        return { version: 1, entries: [value] };
      },
    });

    const code = await runJamalCommand(['deploy', '--tag', 'release-42'], d);

    assert.equal(code, 0, s.err.join('\n'));
    assert.equal(appended[0]?.tag, 'release-42');
  });

  it('--dry-run prints the engine plan and executes nothing', async () => {
    const s = sinks();
    const remote = makeRemoteRunner();
    const d = deps(join(fixturesRoot, 'deploy-dry-run'), s, { remoteRunner: remote.remote });

    const code = await runJamalCommand(['deploy', '--dry-run'], d);

    assert.equal(code, 0, s.err.join('\n'));
    assert.equal(remote.calls.length, 0, '--dry-run must not touch the remote server');
    const out = s.out.join('\n');
    assert.match(out, /image: ghcr\.io\/acme\/myapp:abcdef1/);
    for (const kind of ['build', 'push', 'pull', 'run', 'health', 'switch', 'stop']) {
      assert.match(out, new RegExp(`^${kind}:`, 'm'), `expected a "${kind}" step`);
    }
    assert.ok(!/deployed /.test(out), '--dry-run must not print the deploy summary');
  });

  it('reports a value-free failure and does not record history on a failed release', async () => {
    const s = sinks();
    let appended = 0;
    const d = deps(join(fixturesRoot, 'deploy-fail'), s, {
      remoteRunner: makeFailingRemoteRunner(5).remote,
      appendHistory: async (_dir, value) => {
        appended += 1;
        return { version: 1, entries: [value] };
      },
    });

    const code = await runJamalCommand(['deploy'], d);

    assert.equal(code, 1);
    assert.equal(appended, 0, 'no history entry is recorded after a failed release');
    assert.match(s.err.join('\n'), /deploy failed at step/);
    assert.ok(!s.err.join('\n').includes('ghcr.io'), 'image reference must not leak');
  });
});

describe('jamal rollback', () => {
  it('executes by default without --execute', async () => {
    const dir = join(fixturesRoot, 'rb-default');
    const s = sinks();
    const remote = makeRemoteRunner();
    const appended: DeployHistoryEntry[] = [];
    const history: DeployHistory = {
      version: 1,
      entries: [entry('myapp', '1.0.0'), entry('myapp', '2.0.0')],
    };
    const d = deps(dir, s, {
      readHistory: async () => history,
      remoteRunner: remote.remote,
      appendHistory: async (_dir, value) => {
        appended.push(value);
        return { version: 1, entries: [...history.entries, value] };
      },
    });

    const code = await runJamalCommand(['rollback'], d);

    assert.equal(code, 0, s.err.join('\n'));
    assert.equal(appended[0]?.tag, '1.0.0');
    assert.match(s.out.join('\n'), /rolled back to ghcr\.io\/acme\/myapp:1\.0\.0/);
    const stopCall = remote.calls.find(
      (call) => call.remoteArgv[0] === 'docker' && call.remoteArgv[1] === 'stop',
    );
    assert.equal(stopCall?.remoteArgv[2], containerNameForTag('myapp', '2.0.0'));
  });

  it('--dry-run prints the rollback plan and executes nothing', async () => {
    const s = sinks();
    const remote = makeRemoteRunner();
    const d = deps(join(fixturesRoot, 'rb-dry-run'), s, {
      readHistory: async () => ({
        version: 1,
        entries: [entry('myapp', '1.0.0'), entry('myapp', '2.0.0')],
      }),
      remoteRunner: remote.remote,
    });

    const code = await runJamalCommand(['rollback', '--dry-run'], d);

    assert.equal(code, 0, s.err.join('\n'));
    assert.equal(remote.calls.length, 0, '--dry-run must not touch the remote server');
    const out = s.out.join('\n');
    assert.match(out, /image: ghcr\.io\/acme\/myapp:1\.0\.0/);
    assert.match(out, /^rollback:/m);
    assert.ok(!/rolled back/.test(out), '--dry-run must not print the rollback summary');
  });

  it('reports no history and no previous deploy value-free', async () => {
    const s = sinks();
    const empty = deps(join(fixturesRoot, 'rb-empty'), s, {
      readHistory: async () => emptyDeployHistory(),
    });
    assert.equal(await runJamalCommand(['rollback'], empty), 1);
    assert.match(s.err.join('\n'), /no deploy history/);

    const single = deps(join(fixturesRoot, 'rb-single'), s, {
      readHistory: async () => ({ version: 1, entries: [entry('myapp', '1.0.0')] }),
    });
    assert.equal(await runJamalCommand(['rollback'], single), 1);
    assert.match(s.err.join('\n'), /no previous deploy/);
  });
});

describe('jamal status', () => {
  it('requires a production config', async () => {
    const s = sinks();
    const d = deps(join(fixturesRoot, 'status-no-prod'), s, {
      loadJamalConfig: async () =>
        normalizeJamalConfig({ service: 'myapp', image: 'ghcr.io/acme/myapp' }),
    });
    assert.equal(await runJamalCommand(['status'], d), 1);
    assert.match(s.err.join('\n'), /config\.production is required/);
  });

  it('lists containers on the remote server', async () => {
    const s = sinks();
    const remote = makeRemoteRunner(0, 'CONTAINER ID   NAMES\n');
    const d = deps(join(fixturesRoot, 'status-ok'), s, { remoteRunner: remote.remote });
    const code = await runJamalCommand(['status'], d);
    assert.equal(code, 0, s.err.join('\n'));
    assert.deepEqual(remote.calls[0], { server: '1.2.3.4', remoteArgv: ['docker', 'ps'] });
    assert.match(s.out.join('\n'), /CONTAINER ID/);
  });
});

describe('jamal remote logs/exec', () => {
  it('routes logs to the remote container when production is present', async () => {
    const s = sinks();
    const remote = makeRemoteRunner();
    const d = deps(join(fixturesRoot, 'logs-remote'), s, {
      readHistory: async () => ({ version: 1, entries: [entry('myapp', '2.0.0')] }),
      remoteRunner: remote.remote,
    });

    const code = await runJamalCommand(['logs', '--follow'], d);

    assert.equal(code, 0, s.err.join('\n'));
    assert.deepEqual(remote.calls[0]?.remoteArgv, [
      'docker',
      'logs',
      '--follow',
      containerNameForTag('myapp', '2.0.0'),
    ]);
  });

  it('routes exec to the remote container after "--"', async () => {
    const s = sinks();
    const remote = makeRemoteRunner();
    const d = deps(join(fixturesRoot, 'exec-remote'), s, {
      readHistory: async () => ({ version: 1, entries: [entry('myapp', '2.0.0')] }),
      remoteRunner: remote.remote,
    });

    const code = await runJamalCommand(['exec', '--', 'sh', '-c', 'echo hi'], d);

    assert.equal(code, 0, s.err.join('\n'));
    assert.deepEqual(remote.calls[0]?.remoteArgv, [
      'docker',
      'exec',
      containerNameForTag('myapp', '2.0.0'),
      'sh',
      '-c',
      'echo hi',
    ]);
  });

  it('reports no deploy history when there is none to inspect', async () => {
    const s = sinks();
    const d = deps(join(fixturesRoot, 'logs-empty'), s, {
      readHistory: async () => emptyDeployHistory(),
    });
    assert.equal(await runJamalCommand(['logs'], d), 1);
    assert.match(s.err.join('\n'), /no deploy history/);
  });

  it('falls back to local logs when no production config is present', async () => {
    const dir = join(fixturesRoot, 'logs-local');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'docker-compose.yml'), 'services: {}\n');
    const s = sinks();
    const runCommandCalls: { argv: readonly string[] }[] = [];
    const d = deps(dir, s, {
      loadJamalConfig: async () =>
        normalizeJamalConfig({ service: 'myapp', image: 'ghcr.io/acme/myapp' }),
      runCommand: async (argv) => {
        runCommandCalls.push({ argv });
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });

    const code = await runJamalCommand(['logs'], d);

    assert.equal(code, 0, s.err.join('\n'));
    assert.ok(runCommandCalls.length > 0, 'local logs must reach docker compose');
    assert.deepEqual(runCommandCalls[0]?.argv.slice(0, 2), ['docker', 'compose']);
  });
});

describe('planProduction integration', () => {
  it('containerNameForTag matches the plan container for a roll-forward', () => {
    const plan: ProductionPlan = planProduction(config(), {
      imageTag: '2.0.0',
      previousTag: '1.0.0',
    });
    assert.equal(plan.containerName, containerNameForTag('myapp', '2.0.0'));
  });
});
