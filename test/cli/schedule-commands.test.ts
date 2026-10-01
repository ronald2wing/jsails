import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { JobsRuntimeError, type JobsRuntime } from '../../src/jobs/runtime.js';
import { runSchedulesCommand, type SchedulesDeps } from '../../src/cli/schedule-commands.js';

/**
 * The `schedules` dashboard is exercised through its dependency seam (a fake
 * runtime controller returns fixed schedules), so no live Valkey/Redis is
 * contacted. The config module must still validate, so a custom adapter is
 * supplied — it is selected verbatim and never constructed. Subprocess cases
 * cover the CLI wiring and cross-command flag gating.
 */

const tmpRoot = mkdtempSync(
  join(fileURLToPath(new URL('..', import.meta.url)), 'schedules-fixture-'),
);

after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

// A config that validates without any connection: a custom adapter is selected
// verbatim (identity preserved) and never invoked by the injected fake runtime.
// The `listSchedules` capability is included so the subprocess tests exercise
// the real createJobsRuntime path without a live Valkey/Redis.
const CONFIG = `export default {
  registry: { ping: { schema: {}, handler: async () => {} } },
  adapter: {
    name: 'custom',
    createProducer: () => ({ dispatch: async () => undefined, close: async () => undefined }),
    createWorker: () => ({ close: async () => undefined }),
    listSchedules: async () => [],
  },
  queueName: 'default',
};`;

function writeConfig(dir: string): string {
  const path = join(dir, 'jsails.runtime.js');
  writeFileSync(path, CONFIG);
  return path;
}

interface FakeState {
  closes: number;
}

function makeFakeRuntime(
  schedules: import('../../src/jobs/runtime.js').ScheduleInfo[],
  state?: FakeState,
): { runtime: JobsRuntime; state: FakeState } {
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
      return { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 };
    },
    async listSchedules() {
      return schedules;
    },
    async pauseSchedules() {},
    async close() {
      s.closes += 1;
    },
  };
  return { runtime, state: s };
}

function depsFor(runtime: JobsRuntime): { deps: SchedulesDeps; lines: string[] } {
  const lines: string[] = [];
  const deps: SchedulesDeps = {
    createRuntime: () => runtime,
    stdout: (text) => lines.push(text),
  };
  return { deps, lines };
}

describe('runSchedulesCommand', () => {
  it('renders human output for one schedule with id/job/repeat', async () => {
    const dir = join(tmpRoot, 'schedules-human');
    mkdirSync(dir, { recursive: true });
    const configPath = writeConfig(dir);
    const state: FakeState = { closes: 0 };
    const { runtime } = makeFakeRuntime(
      [{ id: 'digest', job: 'sendEmail', repeat: '0 3 * * *' }],
      state,
    );
    const { deps, lines } = depsFor(runtime);

    const code = await runSchedulesCommand(configPath, {}, deps);

    assert.equal(code, 0);
    assert.deepEqual(lines, ['Schedules:', '  digest  sendEmail  0 3 * * *']);
    assert.equal(state.closes, 1, 'the runtime is closed after reading');
  });

  it('renders (none) for an empty schedule list', async () => {
    const dir = join(tmpRoot, 'schedules-empty');
    mkdirSync(dir, { recursive: true });
    const configPath = writeConfig(dir);
    const state: FakeState = { closes: 0 };
    const { runtime } = makeFakeRuntime([], state);
    const { deps, lines } = depsFor(runtime);

    const code = await runSchedulesCommand(configPath, {}, deps);

    assert.equal(code, 0);
    assert.deepEqual(lines, ['Schedules: (none)']);
    assert.equal(state.closes, 1);
  });

  it('renders a single JSON line with --json', async () => {
    const dir = join(tmpRoot, 'schedules-json');
    mkdirSync(dir, { recursive: true });
    const configPath = writeConfig(dir);
    const state: FakeState = { closes: 0 };
    const schedules = [{ id: 'digest', job: 'sendEmail', repeat: '0 3 * * *' }];
    const { runtime } = makeFakeRuntime(schedules, state);
    const { deps, lines } = depsFor(runtime);

    const code = await runSchedulesCommand(configPath, { json: true }, deps);

    assert.equal(code, 0);
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0] as string), { schedules });
    assert.equal(state.closes, 1);
  });

  it('renders nextRunAt as an ISO line when present', async () => {
    const dir = join(tmpRoot, 'schedules-next');
    mkdirSync(dir, { recursive: true });
    const configPath = writeConfig(dir);
    const state: FakeState = { closes: 0 };
    const nextRunAt = new Date('2026-10-08T12:00:00Z').getTime();
    const { runtime } = makeFakeRuntime(
      [{ id: 'digest', job: 'sendEmail', repeat: '0 3 * * *', nextRunAt }],
      state,
    );
    const { deps, lines } = depsFor(runtime);

    const code = await runSchedulesCommand(configPath, {}, deps);

    assert.equal(code, 0);
    assert.deepEqual(lines, [
      'Schedules:',
      '  digest  sendEmail  0 3 * * *',
      '  next: 2026-10-08T12:00:00.000Z',
    ]);
  });

  it('omits nextRunAt line when absent', async () => {
    const dir = join(tmpRoot, 'schedules-no-next');
    mkdirSync(dir, { recursive: true });
    const configPath = writeConfig(dir);
    const state: FakeState = { closes: 0 };
    const { runtime } = makeFakeRuntime(
      [{ id: 'digest', job: 'sendEmail', repeat: '0 3 * * *' }],
      state,
    );
    const { deps, lines } = depsFor(runtime);

    const code = await runSchedulesCommand(configPath, {}, deps);

    assert.equal(code, 0);
    // Only the main line, no "next:" line.
    assert.deepEqual(lines, ['Schedules:', '  digest  sendEmail  0 3 * * *']);
  });

  it('renders overlap when present', async () => {
    const dir = join(tmpRoot, 'schedules-overlap');
    mkdirSync(dir, { recursive: true });
    const configPath = writeConfig(dir);
    const state: FakeState = { closes: 0 };
    const { runtime } = makeFakeRuntime(
      [
        {
          id: 'digest',
          job: 'sendEmail',
          repeat: '0 3 * * *',
          overlap: { key: 'schedule:digest', ttlMs: 300_000 },
        },
      ],
      state,
    );
    const { deps, lines } = depsFor(runtime);

    const code = await runSchedulesCommand(configPath, {}, deps);

    assert.equal(code, 0);
    assert.deepEqual(lines, [
      'Schedules:',
      '  overlap: schedule:digest (300000ms)',
      '  digest  sendEmail  0 3 * * *',
    ]);
  });

  it('omits overlap when absent', async () => {
    const dir = join(tmpRoot, 'schedules-no-overlap');
    mkdirSync(dir, { recursive: true });
    const configPath = writeConfig(dir);
    const state: FakeState = { closes: 0 };
    const { runtime } = makeFakeRuntime(
      [{ id: 'digest', job: 'sendEmail', repeat: '0 3 * * *' }],
      state,
    );
    const { deps, lines } = depsFor(runtime);

    const code = await runSchedulesCommand(configPath, {}, deps);

    assert.equal(code, 0);
    // Only the main line, no "overlap:" line.
    assert.deepEqual(lines, ['Schedules:', '  digest  sendEmail  0 3 * * *']);
  });

  it('fails with a capability error when the runtime has no listSchedules, still closing', async () => {
    const dir = join(tmpRoot, 'schedules-unsupported');
    mkdirSync(dir, { recursive: true });
    const configPath = writeConfig(dir);
    const state: FakeState = { closes: 0 };
    // `listSchedules` is required on the JobsRuntime interface but absent on
    // this fake: use a cast to simulate a runtime that lacks the capability.
    const runtime = {
      async dispatch() {
        return undefined;
      },
      async startWorker() {},
      async upsertSchedules() {},
      async readCounts() {
        return { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 };
      },
      async pauseSchedules() {},
      async close() {
        state.closes += 1;
      },
    } as unknown as JobsRuntime;
    const { deps } = depsFor(runtime);

    await assert.rejects(runSchedulesCommand(configPath, {}, deps), (error: unknown) => {
      assert.ok(error instanceof JobsRuntimeError);
      assert.match(error.message, /does not support listing schedules/);
      return true;
    });
    assert.equal(state.closes, 1, 'the runtime is closed even when listing schedules fails');
  });

  it('returns 0 on success', async () => {
    const dir = join(tmpRoot, 'schedules-code');
    mkdirSync(dir, { recursive: true });
    const configPath = writeConfig(dir);
    const state: FakeState = { closes: 0 };
    const { runtime } = makeFakeRuntime([], state);
    const { deps } = depsFor(runtime);

    const code = await runSchedulesCommand(configPath, {}, deps);

    assert.equal(code, 0);
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

describe('cli: schedules subprocess', () => {
  it('fails to load the default jsails.runtime.js when absent', () => {
    const dir = join(tmpRoot, 'schedules-missing-config');
    mkdirSync(dir, { recursive: true });
    const result = runCli(['schedules'], dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /failed to load runtime config/);
  });

  it('gates --only away from schedules', () => {
    const result = runCli(['schedules', '--only', 'x'], tmpRoot);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--only is only valid for seed/);
  });

  it('accepts --json', () => {
    const dir = join(tmpRoot, 'schedules-json-cli');
    mkdirSync(dir, { recursive: true });
    writeConfig(dir);
    const result = runCli(['schedules', '--json'], dir);
    // The fake config has no schedules registered on the adapter; the runtime
    // dispatches to listSchedules and gets an empty array.
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout.trim()), { schedules: [] });
  });
});
