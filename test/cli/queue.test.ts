import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { JobsRuntimeError, type JobsRuntime } from '../../src/jobs/runtime.js';
import { runQueueCommand, type QueueDeps } from '../../src/cli/queue-commands.js';

/**
 * The `queue` dashboard is exercised through its dependency seam (a fake
 * runtime controller returns fixed metrics), so no live Valkey/Redis is
 * contacted. The config module must still validate, so a custom adapter is
 * supplied — it is selected verbatim and never constructed. Subprocess cases
 * cover the CLI wiring and cross-command flag gating.
 */

const tmpRoot = mkdtempSync(join(fileURLToPath(new URL('..', import.meta.url)), 'queue-fixture-'));

after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

// A config that validates without any connection: a custom adapter is selected
// verbatim (identity preserved) and never invoked by the injected fake runtime.
const CONFIG = `export default {
  registry: { ping: { schema: {}, handler: async () => {} } },
  adapter: {
    name: 'custom',
    createProducer: () => ({ dispatch: async () => undefined, close: async () => undefined }),
    createWorker: () => ({ close: async () => undefined }),
  },
  queueName: 'mailer',
};`;

function writeConfig(dir: string): string {
  const path = join(dir, 'jsails.runtime.js');
  writeFileSync(path, CONFIG);
  return path;
}

interface FakeState {
  closes: number;
}

function makeFakeRuntime(state?: FakeState): { runtime: JobsRuntime; state: FakeState } {
  const s: FakeState = state ?? { closes: 0 };
  const runtime: JobsRuntime = {
    async dispatch() {
      return undefined;
    },
    async startWorker() {},
    async pauseQueue() {},
    async resumeQueue() {},
    async upsertSchedules() {},
    async readCounts() {
      return { waiting: 1, active: 2, completed: 3, failed: 4, delayed: 5 };
    },
    async listSchedules() {
      return [];
    },
    async pauseSchedules() {},
    async close() {
      s.closes += 1;
    },
  };
  return { runtime, state: s };
}

function depsFor(runtime: JobsRuntime): { deps: QueueDeps; lines: string[] } {
  const lines: string[] = [];
  const deps: QueueDeps = {
    createRuntime: () => runtime,
    stdout: (text) => lines.push(text),
  };
  return { deps, lines };
}

describe('runQueueCommand', () => {
  it('reads metrics, renders the human block, and closes the runtime', async () => {
    const dir = join(tmpRoot, 'queue-human');
    mkdirSync(dir, { recursive: true });
    const configPath = writeConfig(dir);
    const state: FakeState = { closes: 0 };
    const { runtime } = makeFakeRuntime(state);
    const { deps, lines } = depsFor(runtime);

    const code = await runQueueCommand(configPath, {}, deps);

    assert.equal(code, 0);
    assert.deepEqual(lines, [
      'Queue "mailer" counts:',
      '  waiting:   1',
      '  active:    2',
      '  completed: 3',
      '  failed:    4',
      '  delayed:   5',
    ]);
    assert.equal(state.closes, 1, 'the runtime is closed after reading');
  });

  it('renders a single JSON object with --json', async () => {
    const dir = join(tmpRoot, 'queue-json');
    mkdirSync(dir, { recursive: true });
    const configPath = writeConfig(dir);
    const state: FakeState = { closes: 0 };
    const { runtime } = makeFakeRuntime(state);
    const { deps, lines } = depsFor(runtime);

    const code = await runQueueCommand(configPath, { json: true }, deps);

    assert.equal(code, 0);
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0] as string), {
      queue: 'mailer',
      waiting: 1,
      active: 2,
      completed: 3,
      failed: 4,
      delayed: 5,
    });
    assert.equal(state.closes, 1);
  });

  it('fails with a capability error when the runtime has no readCounts, still closing', async () => {
    const dir = join(tmpRoot, 'queue-unsupported');
    mkdirSync(dir, { recursive: true });
    const configPath = writeConfig(dir);
    const state: FakeState = { closes: 0 };
    const runtime: JobsRuntime = {
      async dispatch() {
        return undefined;
      },
      async startWorker() {},
      async pauseQueue() {},
      async resumeQueue() {},
      async upsertSchedules() {},
      async listSchedules() {
        return [];
      },
      async pauseSchedules() {},
      async close() {
        state.closes += 1;
      },
    };
    const { deps } = depsFor(runtime);

    await assert.rejects(runQueueCommand(configPath, {}, deps), (error: unknown) => {
      assert.ok(error instanceof JobsRuntimeError);
      assert.match(error.message, /does not support queue metrics/);
      return true;
    });
    assert.equal(state.closes, 1, 'the runtime is closed even when metrics fail');
  });
});

// ---------------------------------------------------------------------------
// subprocess: CLI wiring
// ---------------------------------------------------------------------------

const cliPath = fileURLToPath(new URL('../../src/cli.js', import.meta.url));

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], cwd: string): CliResult {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('cli: queue subprocess', () => {
  it('fails to load the default jsails.runtime.js when absent', () => {
    const dir = join(tmpRoot, 'queue-missing-config');
    mkdirSync(dir, { recursive: true });
    const result = runCli(['queue'], dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /failed to load runtime config/);
  });

  it('gates --only away from queue', () => {
    const result = runCli(['queue', '--only', 'x'], tmpRoot);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--only is only valid for seed/);
  });
});
