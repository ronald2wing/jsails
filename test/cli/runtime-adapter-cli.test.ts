import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

/**
 * End-to-end CLI tests that run `jsails work` / `jsails schedule` as real
 * subprocesses against a runtime config that supplies a *custom* job runtime
 * adapter (no Valkey/Redis URL anywhere). The adapter writes owned marker files
 * from inside the subprocess, so the test proves the CLI actually selected the
 * configured adapter, exercised the neutral runtime contract (producer/worker/
 * schedule lifecycle), and cleaned up — all without any network connection or
 * URL.
 */

const cliPath = fileURLToPath(new URL('../../src/cli.js', import.meta.url));

const fixturesRoot = mkdtempSync(
  join(fileURLToPath(new URL('..', import.meta.url)), 'runtime-adapter-fixture-'),
);

after(() => {
  rmSync(fixturesRoot, { recursive: true, force: true });
});

function makeFixture(name: string): string {
  const dir = join(fixturesRoot, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Build a runtime config whose `adapter` is a pure fake that writes a marker
 * file for each lifecycle event. No `valkeyUrl`/`redisUrl` is present, so a
 * builtin selection would fail with "no Valkey/Redis URL configured" — success
 * proves the custom adapter path was taken.
 */
function adapterConfig(schedules: string): string {
  return `
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.env.MARKER_DIR;
const mark = (name, value) => writeFileSync(join(dir, name), value ?? name);

export default {
  registry: { ping: { schema: {}, handler: async () => {} } },
  schedules: ${schedules},
  adapter: {
    name: 'fake-subprocess-adapter',
    createProducer() {
      mark('producer');
      return {
        dispatch: async () => ({ id: 'fake' }),
        close: async () => { mark('producer-close'); },
      };
    },
    createWorker(_context, _processJob) {
      mark('worker');
      // A real worker holds an open connection that keeps the process alive;
      // a ref'd interval stands in for it so the CLI's owned SIGTERM handler
      // can run its cleanup before the event loop drains.
      const keepalive = setInterval(() => {}, 1000);
      return {
        close: async () => {
          clearInterval(keepalive);
          mark('worker-close');
        },
      };
    },
    async upsertSchedules(_producer, schedules) {
      mark('schedules', JSON.stringify(schedules.map((s) => s.id)));
    },
  },
};
`;
}

/** A child environment with the marker dir set and every Valkey/Redis URL stripped. */
function childEnv(dir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, MARKER_DIR: dir };
  delete env.VALKEY_URL;
  delete env.REDIS_URL;
  return env;
}

function marker(dir: string, name: string): string {
  return join(dir, name);
}

function hasMarker(dir: string, name: string): boolean {
  return existsSync(marker(dir, name));
}

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], cwd: string): CliResult {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    env: childEnv(cwd),
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

interface SpawnedWork {
  child: ChildProcess;
  stdout: string;
  stderr: string;
}

function spawnWork(dir: string): SpawnedWork {
  const child = spawn(process.execPath, [cliPath, 'work'], {
    cwd: dir,
    env: childEnv(dir),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const box: SpawnedWork = { child, stdout: '', stderr: '' };
  child.stdout?.on('data', (chunk) => {
    box.stdout += chunk;
  });
  child.stderr?.on('data', (chunk) => {
    box.stderr += chunk;
  });
  return box;
}

/** Poll for a marker file, failing after `timeoutMs`. */
async function waitForMarker(dir: string, name: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (hasMarker(dir, name)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`marker "${name}" did not appear within ${timeoutMs}ms`);
}

/** Resolve once the child exits (or SIGKILL it after `timeoutMs`). */
function waitForExit(
  child: ChildProcess,
  timeoutMs = 5000,
): Promise<{ code: number | null; signal: string | null }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/** Kill a still-running work child so a failed assertion cannot leak a process. */
function ensureStopped(child: ChildProcess): void {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
  }
}

describe('cli: work/schedule with a custom adapter (no URL)', () => {
  it('schedule selects the custom adapter and forces no producer on an empty list', () => {
    const dir = makeFixture('schedule-empty');
    writeFileSync(join(dir, 'jsails.runtime.js'), adapterConfig('[]'));

    const result = runCli(['schedule'], dir);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Registered 0 schedule/);
    assert.equal(hasMarker(dir, 'producer'), false, 'empty schedules never force a producer');
    assert.equal(hasMarker(dir, 'worker'), false, 'schedule never starts a worker');
    assert.equal(hasMarker(dir, 'schedules'), false, 'nothing registered for an empty list');
  });

  it('schedule registers through the adapter and closes its producer', () => {
    const dir = makeFixture('schedule-one');
    writeFileSync(
      join(dir, 'jsails.runtime.js'),
      adapterConfig(`[{ id: 'nightly', job: 'ping', cron: '0 3 * * *' }]`),
    );

    const result = runCli(['schedule'], dir);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Registered 1 schedule/);
    assert.ok(hasMarker(dir, 'producer'), 'the custom adapter producer was created');
    assert.ok(hasMarker(dir, 'schedules'), 'schedules were registered through the adapter');
    assert.ok(hasMarker(dir, 'producer-close'), 'the producer was closed after registration');
    assert.equal(hasMarker(dir, 'worker'), false, 'schedule never starts a worker');
  });

  it('work starts the worker through the adapter and cleans up on SIGTERM', async () => {
    const dir = makeFixture('work-empty');
    writeFileSync(join(dir, 'jsails.runtime.js'), adapterConfig('[]'));

    const spawned = spawnWork(dir);
    try {
      await waitForMarker(dir, 'worker');
      spawned.child.kill('SIGTERM');
      const exit = await waitForExit(spawned.child);

      assert.equal(exit.code, 0, `stderr: ${spawned.stderr}`);
      assert.ok(hasMarker(dir, 'worker-close'), 'the worker was closed on shutdown');
      assert.equal(hasMarker(dir, 'producer'), false, 'empty schedules never force a producer');
    } finally {
      ensureStopped(spawned.child);
    }
  });

  it('work registers schedules, starts the worker, and closes everything on SIGTERM', async () => {
    const dir = makeFixture('work-one');
    writeFileSync(
      join(dir, 'jsails.runtime.js'),
      adapterConfig(`[{ id: 'nightly', job: 'ping', cron: '0 3 * * *' }]`),
    );

    const spawned = spawnWork(dir);
    try {
      await waitForMarker(dir, 'worker');
      spawned.child.kill('SIGTERM');
      const exit = await waitForExit(spawned.child);

      assert.equal(exit.code, 0, `stderr: ${spawned.stderr}`);
      assert.ok(hasMarker(dir, 'producer'), 'producer created for schedule registration');
      assert.ok(hasMarker(dir, 'schedules'), 'schedules registered before the worker started');
      assert.ok(hasMarker(dir, 'worker'), 'worker started');
      assert.ok(hasMarker(dir, 'producer-close'), 'producer closed on shutdown');
      assert.ok(hasMarker(dir, 'worker-close'), 'worker closed on shutdown');
    } finally {
      ensureStopped(spawned.child);
    }
  });
});
