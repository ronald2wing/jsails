import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { runRuntimeCommand, type RuntimeDeps } from '../../src/cli/dispatch.js';
import type { ShutdownSignal } from '../../src/cli.js';
import {
  assertRedisUrl,
  resolveRuntimeValkeyUrl,
  validateRuntimeConfig,
  RuntimeConfigError,
  type ResolvedRuntimeConfig,
} from '../../src/jobs/runtime-config.js';
import type { JobsRuntimeAdapter, JobsRuntime } from '../../src/jobs/runtime.js';

/**
 * Tests for the jobs runtime CLI (`work` / `schedule`) and the runtime config
 * module. No live Valkey/Redis is ever contacted: lifecycle tests inject a fake
 * runtime controller through `runRuntimeCommand`, and subprocess tests run
 * configs with empty schedules (no handle is ever constructed) or invalid
 * shapes that fail before any connection.
 */

// ---------------------------------------------------------------------------
// pure config resolution: precedence + URL validation
// ---------------------------------------------------------------------------

describe('resolveRuntimeValkeyUrl: precedence', () => {
  it('prefers config.valkeyUrl over env.VALKEY_URL', () => {
    assert.equal(
      resolveRuntimeValkeyUrl({ valkeyUrl: 'redis://a:6379' }, { VALKEY_URL: 'redis://b:6379' }),
      'redis://a:6379',
    );
  });

  it('falls back to env.VALKEY_URL when config.valkeyUrl is absent', () => {
    assert.equal(resolveRuntimeValkeyUrl({}, { VALKEY_URL: 'redis://c:6379' }), 'redis://c:6379');
  });

  it('ignores the legacy REDIS_URL environment variable', () => {
    assert.throws(
      () => resolveRuntimeValkeyUrl({}, { REDIS_URL: 'rediss://d:6379' }),
      /no Valkey\/Redis URL configured/,
    );
  });

  it('throws a clear error when no URL is configured anywhere', () => {
    assert.throws(() => resolveRuntimeValkeyUrl({}, {}), /no Valkey\/Redis URL configured/);
  });
});

describe('assertRedisUrl: explicit scheme validation', () => {
  it('accepts redis:// and rediss:// and returns the URL', () => {
    assert.equal(assertRedisUrl('redis://127.0.0.1:6379'), 'redis://127.0.0.1:6379');
    assert.equal(assertRedisUrl('rediss://:pw@host:6380/1'), 'rediss://:pw@host:6380/1');
  });

  it('rejects non-redis schemes', () => {
    assert.throws(() => assertRedisUrl('http://example.com'), /redis:\/\/ or rediss:\/\//);
    assert.throws(() => assertRedisUrl('postgres://x:5432'), /redis:\/\/ or rediss:\/\//);
  });

  it('rejects an empty or malformed URL', () => {
    assert.throws(() => assertRedisUrl(''), /non-empty/);
    assert.throws(() => assertRedisUrl('   '), /non-empty/);
    assert.throws(() => assertRedisUrl('not a url'), /valid redis:\/\/ or rediss:\/\//);
  });

  it('never echoes the URL (which may embed a password) in errors', () => {
    assert.throws(
      () => assertRedisUrl('http://user:supersecret-password@example.com'),
      (error: unknown) => {
        assert.ok(error instanceof RuntimeConfigError);
        assert.doesNotMatch(error.message, /supersecret-password/);
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// config shape validation (registry never executed, adapter never constructed)
// ---------------------------------------------------------------------------

/** A minimal custom adapter that satisfies the contract but never connects. */
function customAdapter(): JobsRuntimeAdapter {
  return {
    name: 'custom',
    createProducer: () => ({
      dispatch: async () => undefined,
      close: async () => undefined,
    }),
    createWorker: () => ({ close: async () => undefined }),
  };
}

describe('validateRuntimeConfig', () => {
  it('validates the registry without executing handlers, selecting the builtin adapter', () => {
    let executed = false;
    const resolved = validateRuntimeConfig(
      {
        registry: {
          ping: {
            schema: {},
            handler: async () => {
              executed = true;
            },
          },
        },
        valkeyUrl: 'redis://127.0.0.1:6379',
      },
      {},
    );
    assert.equal(resolved.valkeyUrl, 'redis://127.0.0.1:6379');
    assert.equal(resolved.adapter.name, 'bullmq');
    assert.equal(resolved.queueName, 'default');
    assert.equal(resolved.prefix, 'bull');
    assert.equal(resolved.concurrency, 1);
    assert.deepEqual(resolved.schedules, []);
    assert.equal(executed, false, 'a handler must never run during validation');
  });

  it('rejects a config that is not an object', () => {
    assert.throws(() => validateRuntimeConfig('nope', {}), /default-export an object/);
    assert.throws(() => validateRuntimeConfig(null, {}), /default-export an object/);
  });

  it('rejects a missing or structurally invalid registry', () => {
    assert.throws(
      () => validateRuntimeConfig({ valkeyUrl: 'redis://h:6379' }, {}),
      /config\.registry must be an object/,
    );
    assert.throws(
      () =>
        validateRuntimeConfig(
          { registry: { broken: { schema: {}, handler: undefined } }, valkeyUrl: 'redis://h:6379' },
          {},
        ),
      /must define a schema and a handler/,
    );
  });

  it('applies queueName/prefix/concurrency defaults and validates overrides', () => {
    const resolved = validateRuntimeConfig(
      {
        registry: { p: { schema: {}, handler: async () => {} } },
        valkeyUrl: 'redis://h:6379',
        queueName: 'mailer',
        prefix: 'custom',
        concurrency: 3,
      },
      {},
    );
    assert.equal(resolved.queueName, 'mailer');
    assert.equal(resolved.prefix, 'custom');
    assert.equal(resolved.concurrency, 3);

    assert.throws(
      () =>
        validateRuntimeConfig(
          {
            registry: { p: { schema: {}, handler: async () => {} } },
            valkeyUrl: 'redis://h',
            concurrency: 0,
          },
          {},
        ),
      /positive integer/,
    );
  });

  it('requires schedules to be an array when present', () => {
    assert.throws(
      () =>
        validateRuntimeConfig(
          {
            registry: { p: { schema: {}, handler: async () => {} } },
            valkeyUrl: 'redis://h',
            schedules: {},
          },
          {},
        ),
      /config\.schedules must be an array/,
    );
  });

  it('preserves a custom adapter identity and requires no URL', () => {
    const adapter = customAdapter();
    const resolved = validateRuntimeConfig(
      {
        registry: { p: { schema: {}, handler: async () => {} } },
        adapter,
      },
      {},
    );

    assert.equal(resolved.adapter, adapter, 'the custom adapter identity is preserved');
    assert.equal(resolved.valkeyUrl, undefined, 'a custom adapter resolves no URL');
  });

  it('does not read or validate a URL when a custom adapter is supplied', () => {
    const adapter = customAdapter();
    // A poison URL that would fail builtin validation is ignored entirely.
    const resolved = validateRuntimeConfig(
      {
        registry: { p: { schema: {}, handler: async () => {} } },
        adapter,
        valkeyUrl: 'http://user:sup3rsecret@example.com',
      },
      {},
    );

    assert.equal(resolved.adapter, adapter);
    assert.equal(resolved.valkeyUrl, undefined);
  });

  it('rejects a malformed adapter without invoking its factories', () => {
    let created = false;
    const makeRegistry = () => ({
      p: {
        schema: {},
        handler: async () => {
          created = true;
        },
      },
    });

    assert.throws(
      () => validateRuntimeConfig({ registry: makeRegistry(), adapter: null }, {}),
      /config\.adapter is invalid/,
    );
    assert.throws(
      () => validateRuntimeConfig({ registry: makeRegistry(), adapter: {} }, {}),
      /non-empty name/,
    );
    assert.throws(
      () =>
        validateRuntimeConfig(
          { registry: makeRegistry(), adapter: { name: 'x', createWorker: () => undefined } },
          {},
        ),
      /createProducer/,
    );
    assert.throws(
      () =>
        validateRuntimeConfig(
          { registry: makeRegistry(), adapter: { name: 'x', createProducer: () => undefined } },
          {},
        ),
      /createWorker/,
    );
    assert.throws(
      () =>
        validateRuntimeConfig(
          {
            registry: makeRegistry(),
            adapter: {
              name: 'x',
              createProducer: () => undefined,
              createWorker: () => undefined,
              upsertSchedules: 1,
            },
          },
          {},
        ),
      /upsertSchedules/,
    );

    assert.equal(created, false, 'adapter factories must never run during validation');
  });
});

// ---------------------------------------------------------------------------
// lifecycle: fake runtime controller injected through runRuntimeCommand
// ---------------------------------------------------------------------------

const cliPath = fileURLToPath(new URL('../../src/cli.js', import.meta.url));

const fixturesRoot = mkdtempSync(
  join(fileURLToPath(new URL('..', import.meta.url)), 'runtime-fixture-'),
);

after(() => {
  rmSync(fixturesRoot, { recursive: true, force: true });
});

function emptyDir(name: string): string {
  const dir = join(fixturesRoot, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeConfig(dir: string, content: string, filename = 'jsails.runtime.js'): string {
  const path = join(dir, filename);
  writeFileSync(path, content);
  return path;
}

interface FakeRuntimeState {
  creates: number;
  upserted: unknown[][];
  workerStarts: number;
  closes: number;
}

interface FakeDeps {
  deps: RuntimeDeps;
  state: FakeRuntimeState;
  configs: ResolvedRuntimeConfig[];
  started: Promise<void>;
}

function makeFakeDeps(): FakeDeps {
  const state: FakeRuntimeState = {
    creates: 0,
    upserted: [],
    workerStarts: 0,
    closes: 0,
  };
  const configs: ResolvedRuntimeConfig[] = [];
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });

  const runtime: JobsRuntime = {
    async dispatch() {
      return undefined;
    },
    async startWorker() {
      state.workerStarts += 1;
      markStarted();
    },
    async pauseQueue() {},
    async resumeQueue() {},
    async upsertSchedules(schedules) {
      state.upserted.push([...schedules]);
    },
    async listSchedules() {
      return [];
    },
    async pauseSchedules() {},
    async close() {
      state.closes += 1;
    },
  };

  const deps: RuntimeDeps = {
    createRuntime: (config) => {
      state.creates += 1;
      configs.push(config);
      return runtime;
    },
  };

  return { deps, state, configs, started };
}

function makeSignal() {
  let disposed = 0;
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  const signal: ShutdownSignal = {
    promise,
    dispose: () => {
      disposed += 1;
    },
  };
  return {
    signal,
    resolve: () => resolve(),
    disposeCount: () => disposed,
  };
}

const REGISTRY_CONFIG = (schedules: string): string => `export default {
  registry: { sendEmail: { schema: {}, handler: async () => {} } },
  valkeyUrl: 'redis://127.0.0.1:6379',
  queueName: 'mailer',
  prefix: 'custom',
  concurrency: 2,
  schedules: ${schedules},
};`;

const ONE_SCHEDULE = `[{ id: 'nightly', job: 'sendEmail', cron: '0 3 * * *' }]`;

describe('runRuntimeCommand: schedule (one-shot)', () => {
  it('creates the runtime, registers schedules, and closes it', async () => {
    const dir = emptyDir('schedule-lifecycle');
    const configPath = writeConfig(dir, REGISTRY_CONFIG(ONE_SCHEDULE));
    const fake = makeFakeDeps();

    const code = await runRuntimeCommand('schedule', configPath, fake.deps);

    assert.equal(code, 0);
    assert.equal(fake.state.creates, 1);
    assert.equal(fake.configs[0]?.queueName, 'mailer');
    assert.equal(fake.configs[0]?.prefix, 'custom');
    assert.equal(fake.configs[0]?.concurrency, 2);
    assert.equal(fake.configs[0]?.adapter.name, 'bullmq');
    assert.equal(fake.state.upserted.length, 1);
    assert.equal(fake.state.upserted[0]?.length, 1);
    assert.equal(fake.state.workerStarts, 0, 'schedule never starts a worker');
    assert.equal(fake.state.closes, 1, 'the runtime must be closed after registration');
  });

  it('does not register schedules when there are none', async () => {
    const dir = emptyDir('schedule-empty');
    const configPath = writeConfig(dir, REGISTRY_CONFIG('[]'));
    const fake = makeFakeDeps();

    const code = await runRuntimeCommand('schedule', configPath, fake.deps);

    assert.equal(code, 0);
    assert.equal(fake.state.creates, 1);
    assert.equal(fake.state.upserted.length, 0, 'no registration without schedules');
    assert.equal(fake.state.workerStarts, 0);
    assert.equal(fake.state.closes, 1, 'the runtime is still closed');
  });
});

describe('runRuntimeCommand: work (signal + close lifecycle)', () => {
  it('registers schedules, starts the worker, then closes on signal', async () => {
    const dir = emptyDir('work-lifecycle');
    const configPath = writeConfig(dir, REGISTRY_CONFIG(ONE_SCHEDULE));
    const fake = makeFakeDeps();
    const sig = makeSignal();

    const pending = runRuntimeCommand('work', configPath, {
      ...fake.deps,
      waitForShutdown: () => sig.signal,
    });

    // Wait until the worker has started before firing the shutdown signal.
    await fake.started;

    assert.equal(fake.state.upserted.length, 1, 'schedules registered before the worker starts');
    assert.equal(fake.state.workerStarts, 1);
    assert.equal(fake.state.closes, 0, 'runtime stays open while running');

    sig.resolve();
    const code = await pending;

    assert.equal(code, 0);
    assert.equal(fake.state.closes, 1, 'runtime closed exactly once on shutdown');
    assert.equal(sig.disposeCount(), 1, 'signal listeners disposed on shutdown');
  });

  it('disposes signal listeners and never creates a runtime when config is invalid', async () => {
    const dir = emptyDir('work-bad-config');
    const configPath = writeConfig(dir, `export default { valkeyUrl: 'redis://127.0.0.1:6379' };`);
    const sig = makeSignal();
    const fake = makeFakeDeps();

    await assert.rejects(
      runRuntimeCommand('work', configPath, {
        ...fake.deps,
        waitForShutdown: () => sig.signal,
      }),
      /registry/,
    );
    assert.equal(fake.state.creates, 0, 'no runtime created on config failure');
    assert.equal(sig.disposeCount(), 0, 'no signal listeners installed on config failure');
  });

  it('disposes the signal and closes the runtime when worker startup fails', async () => {
    const dir = emptyDir('work-startup-fail');
    const configPath = writeConfig(dir, REGISTRY_CONFIG('[]'));
    const sig = makeSignal();
    let closes = 0;
    const runtime: JobsRuntime = {
      async dispatch() {
        return undefined;
      },
      async startWorker() {
        throw new Error('worker failed to start');
      },
      async pauseQueue() {},
      async resumeQueue() {},
      async upsertSchedules() {},
      async listSchedules() {
        return [];
      },
      async pauseSchedules() {},
      async close() {
        closes += 1;
      },
    };

    await assert.rejects(
      runRuntimeCommand('work', configPath, {
        createRuntime: () => runtime,
        waitForShutdown: () => sig.signal,
      }),
      /worker failed to start/,
    );
    assert.equal(closes, 1, 'runtime closed on startup failure');
    assert.equal(sig.disposeCount(), 1, 'signal disposed on startup failure');
  });
});

// ---------------------------------------------------------------------------
// subprocess: real CLI help / default paths / bad configs
// ---------------------------------------------------------------------------

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

const VALID_CONFIG = `export default {
  registry: { ping: { schema: {}, handler: async () => {} } },
  valkeyUrl: 'redis://127.0.0.1:6379',
};`;

describe('cli: work/schedule subprocess', () => {
  it('prints work and schedule in help', () => {
    const result = runCli(['--help'], emptyDir('help'));
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /work/);
    assert.match(result.stdout, /schedule/);
    assert.match(result.stdout, /jsails\.runtime\.js/);
  });

  it('schedule defaults to jsails.runtime.js', () => {
    const dir = emptyDir('default-runtime');
    writeConfig(dir, VALID_CONFIG);
    const result = runCli(['schedule'], dir);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Registered 0 schedule/);
  });

  it('schedule ignores jsails.config.js (migration config is not the runtime default)', () => {
    const dir = emptyDir('runtime-missing');
    writeFileSync(join(dir, 'jsails.config.js'), 'export default {};\n');
    const result = runCli(['schedule'], dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /failed to load runtime config/);
  });

  it('rejects a runtime config missing its registry', () => {
    const dir = emptyDir('bad-registry');
    writeConfig(dir, `export default { valkeyUrl: 'redis://127.0.0.1:6379' };`);
    const result = runCli(['schedule'], dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /registry/);
  });

  it('rejects a TypeScript runtime config with a compile hint', () => {
    const dir = emptyDir('ts-runtime');
    const result = runCli(['schedule', '--config', 'jsails.runtime.ts'], dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /compile it to JavaScript first/);
  });

  it('rejects an invalid URL scheme without echoing the password', () => {
    const dir = emptyDir('bad-url');
    writeConfig(
      dir,
      `export default {
  registry: { ping: { schema: {}, handler: async () => {} } },
  valkeyUrl: 'http://user:supersecret-password@example.com',
};`,
    );
    const result = runCli(['schedule'], dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /redis:\/\/ or rediss:\/\//);
    assert.doesNotMatch(result.stderr, /supersecret-password/);
  });

  it('accepts a .mjs runtime config', () => {
    const dir = emptyDir('mjs-runtime');
    writeConfig(dir, VALID_CONFIG, 'jsails.runtime.mjs');
    const result = runCli(['schedule', '--config', 'jsails.runtime.mjs'], dir);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Registered 0 schedule/);
  });
});
