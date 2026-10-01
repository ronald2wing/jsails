import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_HOOKS_DIR,
  DevHookError,
  HOOK_PHASES,
  HooksError,
  planDevHook,
  runHookPhase,
  type HookRunner,
  type HooksFilesystem,
} from '../../../src/jamal/production/hooks.js';
import type { CommandResult } from '../../../src/jamal/production/command-runner.js';

/**
 * Tests for deployment hooks. Both the filesystem probe and the process runner
 * are injected, so no script is read from disk and no process is spawned:
 * assertions target skip-when-absent, run-when-present, the `JAMAL_*`
 * environment, and the value-free error for a non-zero exit.
 */

interface RecordingFs {
  fs: HooksFilesystem;
  existing: Set<string>;
  executable: Set<string>;
}

function makeFs(existing: string[] = [], executable: string[] = []): RecordingFs {
  const existingSet = new Set(existing);
  const executableSet = new Set(executable);
  return {
    existing: existingSet,
    executable: executableSet,
    fs: {
      exists: (path) => existingSet.has(path),
      isExecutable: (path) => executableSet.has(path),
    },
  };
}

interface RecordedRun {
  argv: string[];
  cwd?: string;
  env?: Readonly<Record<string, string>>;
}

function makeRunner(result: CommandResult = { exitCode: 0, stdout: '', stderr: '' }): {
  runner: HookRunner;
  calls: RecordedRun[];
} {
  const calls: RecordedRun[] = [];
  const runner: HookRunner = async (argv, options) => {
    calls.push({
      argv: [...argv],
      cwd: options?.cwd,
      env: options?.env === undefined ? undefined : { ...options.env },
    });
    return result;
  };
  return { runner, calls };
}

describe('runHookPhase: skip when absent or not executable', () => {
  it('skips silently when the script file does not exist', async () => {
    const { fs } = makeFs();
    const { runner, calls } = makeRunner();

    const outcome = await runHookPhase({
      phase: 'pre-build',
      server: '1.2.3.4',
      version: '1.0.0',
      fs,
      runner,
    });

    assert.deepEqual(outcome, { phase: 'pre-build', ran: false });
    assert.equal(calls.length, 0);
  });

  it('skips silently when the script exists but is not executable', async () => {
    const { fs } = makeFs(['.jamal/hooks/pre-deploy']);
    const { runner, calls } = makeRunner();

    const outcome = await runHookPhase({
      phase: 'pre-deploy',
      server: '1.2.3.4',
      version: '1.0.0',
      fs,
      runner,
    });

    assert.deepEqual(outcome, { phase: 'pre-deploy', ran: false });
    assert.equal(calls.length, 0);
  });
});

describe('runHookPhase: run when present', () => {
  it('runs the phase script with the JAMAL_* environment and cwd', async () => {
    const { fs } = makeFs(['.jamal/hooks/post-deploy'], ['.jamal/hooks/post-deploy']);
    const { runner, calls } = makeRunner();

    const outcome = await runHookPhase({
      phase: 'post-deploy',
      server: '1.2.3.4',
      version: '2.0.0',
      fs,
      runner,
      cwd: '/app',
      env: { HOME: '/root' },
    });

    assert.deepEqual(outcome, { phase: 'post-deploy', ran: true });
    assert.deepEqual(calls[0]?.argv, ['.jamal/hooks/post-deploy']);
    assert.equal(calls[0]?.cwd, '/app');
    assert.deepEqual(calls[0]?.env, {
      HOME: '/root',
      JAMAL_SERVER: '1.2.3.4',
      JAMAL_VERSION: '2.0.0',
    });
  });

  it('defaults the hooks directory to .jamal/hooks', async () => {
    const { fs } = makeFs(['.jamal/hooks/pre-build'], ['.jamal/hooks/pre-build']);
    const { runner, calls } = makeRunner();

    await runHookPhase({
      phase: 'pre-build',
      server: 's',
      version: 'v',
      fs,
      runner,
    });

    assert.equal(DEFAULT_HOOKS_DIR, '.jamal/hooks');
    assert.deepEqual(calls[0]?.argv, ['.jamal/hooks/pre-build']);
  });

  it('honors an explicit hooks directory', async () => {
    const { fs } = makeFs(['scripts/pre-build'], ['scripts/pre-build']);
    const { runner, calls } = makeRunner();

    await runHookPhase({
      phase: 'pre-build',
      hooksDir: 'scripts',
      server: 's',
      version: 'v',
      fs,
      runner,
    });

    assert.deepEqual(calls[0]?.argv, ['scripts/pre-build']);
  });

  it('runs without a base environment, carrying only the JAMAL_* variables', async () => {
    const { fs } = makeFs(['.jamal/hooks/pre-build'], ['.jamal/hooks/pre-build']);
    const { runner, calls } = makeRunner();

    await runHookPhase({ phase: 'pre-build', server: 's', version: 'v', fs, runner });

    assert.deepEqual(calls[0]?.env, { JAMAL_SERVER: 's', JAMAL_VERSION: 'v' });
    assert.equal(calls[0]?.cwd, undefined);
  });
});

describe('runHookPhase: non-zero exit', () => {
  it('raises a HooksError naming only the phase and exit code', async () => {
    const { fs } = makeFs(['.jamal/hooks/pre-deploy'], ['.jamal/hooks/pre-deploy']);
    const { runner } = makeRunner({ exitCode: 3, stdout: 'boom', stderr: 'secret detail' });

    await assert.rejects(
      () =>
        runHookPhase({
          phase: 'pre-deploy',
          server: '1.2.3.4',
          version: '1.0.0',
          fs,
          runner,
        }),
      (error: unknown) => {
        assert.ok(error instanceof HooksError);
        assert.equal(error.phase, 'pre-deploy');
        assert.equal(error.exitCode, 3);
        assert.equal(error.message, 'pre-deploy hook exited with code 3');
        assert.ok(!error.message.includes('.jamal/hooks'), 'script path must not leak');
        assert.ok(!error.message.includes('secret'), 'hook output must not leak');
        return true;
      },
    );
  });
});

describe('HOOK_PHASES', () => {
  it('lists pre-build, pre-deploy, post-deploy in order', () => {
    assert.deepEqual(HOOK_PHASES, ['pre-build', 'pre-deploy', 'post-deploy']);
  });
});

describe('planDevHook', () => {
  it('resolves the pre-start phase script path and argv', () => {
    const plan = planDevHook('pre-start', '.jamal/dev-hooks');

    assert.equal(plan.phase, 'pre-start');
    assert.equal(plan.scriptPath, '.jamal/dev-hooks/pre-start');
    assert.deepEqual(plan.argv, ['.jamal/dev-hooks/pre-start']);
  });

  it('resolves the post-start phase', () => {
    const plan = planDevHook('post-start', '/opt/app/hooks');

    assert.equal(plan.phase, 'post-start');
    assert.equal(plan.scriptPath, '/opt/app/hooks/post-start');
  });

  it('resolves the pre-import-db phase', () => {
    const plan = planDevHook('pre-import-db', 'scripts');

    assert.equal(plan.phase, 'pre-import-db');
    assert.equal(plan.scriptPath, 'scripts/pre-import-db');
  });

  it('resolves the post-import-db phase', () => {
    const plan = planDevHook('post-import-db', '.jamal/hooks');

    assert.equal(plan.phase, 'post-import-db');
    assert.equal(plan.scriptPath, '.jamal/hooks/post-import-db');
  });

  it('rejects an unknown phase value-free', () => {
    assert.throws(
      () => planDevHook('pre-build' as never, '.jamal/hooks'),
      (error: unknown) => {
        assert.ok(error instanceof DevHookError);
        assert.equal(error.message, 'unknown dev hook phase');
        return true;
      },
    );
  });

  it('does not check if the script exists', () => {
    // Plan should succeed even for a non-existent path.
    const plan = planDevHook('pre-start', '/does/not/exist');
    assert.equal(plan.scriptPath, '/does/not/exist/pre-start');
  });
});
