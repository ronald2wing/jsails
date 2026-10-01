import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { runJamalCommand, type JamalDeps } from '../../src/jamal/command.js';
import { normalizeJamalConfig } from '../../src/jamal/config.js';
import {
  COMPOSE_FILENAME,
  composeArgv,
  execArgv,
  type CommandResult,
  type CommandRunner,
} from '../../src/jamal/docker.js';
import { createDeploymentGeneratorRegistry } from '../../src/deploy/registry.js';

/** A minimal valid jamal config for the managed `.jamal/compose.yml` path. */
function fakeJamalConfig(): ReturnType<typeof normalizeJamalConfig> {
  return normalizeJamalConfig({
    service: 'myapp',
    image: 'ghcr.io/acme/myapp:latest',
  });
}

/**
 * Tests for the Sail-like `jamal up|down|ps|logs` execution verbs. They inject
 * a command-runner seam so no real `docker` process is ever spawned; the seam
 * records the argv + cwd it was handed and returns canned results. Compose-file
 * existence is exercised against throwaway temp directories. The generation
 * subcommands (`dev`/`deploy`/`targets`) are asserted to never reach the
 * runner.
 */

interface Sinks {
  out: string[];
  err: string[];
}

function sinks(): Sinks {
  return { out: [], err: [] };
}

/** What the injected runner resolves to (or throws) on each call. */
type RunnerSpec = CommandResult | Error;

interface Recorder {
  calls: { argv: readonly string[]; cwd: string }[];
  run: CommandRunner;
}

function makeRunner(spec: RunnerSpec = { exitCode: 0, stdout: '', stderr: '' }): Recorder {
  const calls: { argv: readonly string[]; cwd: string }[] = [];
  const run: CommandRunner = async (argv, options) => {
    calls.push({ argv, cwd: options.cwd });
    if (spec instanceof Error) {
      throw spec;
    }
    return spec;
  };
  return { calls, run };
}

/**
 * Build deps with an injected runner and the real built-in registry. Pass
 * `loadJamalConfig` to exercise the managed `.jamal/compose.yml` path; when
 * omitted, the real loader runs (so a missing config is a real failure).
 */
function deps(
  cwd: string,
  s: Sinks,
  run?: CommandRunner,
  loadJamalConfig?: JamalDeps['loadJamalConfig'],
): JamalDeps {
  return {
    createRegistry: (custom = []) => createDeploymentGeneratorRegistry({ generators: custom }),
    cwd,
    stdout: (text) => s.out.push(text),
    stderr: (text) => s.err.push(text),
    runCommand: run,
    loadJamalConfig,
  };
}

const fixturesRoot = mkdtempSync(join(tmpdir(), 'jamal-docker-test-'));

after(() => {
  rmSync(fixturesRoot, { recursive: true, force: true });
});

function makeDir(name: string): string {
  const dir = join(fixturesRoot, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Create a project directory already containing the compose file. */
function withComposeFile(name: string): string {
  const dir = makeDir(name);
  writeFileSync(join(dir, COMPOSE_FILENAME), 'services: {}\n');
  return dir;
}

describe('jamal docker: argv assembly', () => {
  it('up materializes the managed compose file and runs docker compose up -d --wait', async () => {
    const dir = makeDir('up');
    const s = sinks();
    const r = makeRunner();

    const code = await runJamalCommand(
      ['up'],
      deps(dir, s, r.run, async () => fakeJamalConfig()),
    );

    assert.equal(code, 0, s.err.join('\n'));
    assert.equal(r.calls.length, 1);
    assert.deepEqual(r.calls[0]?.argv, [
      'docker',
      'compose',
      '-f',
      '.jamal/compose.yml',
      '-p',
      'myapp',
      'up',
      '-d',
      '--wait',
    ]);
    assert.equal(r.calls[0]?.cwd, dir);
    assert.equal(existsSync(join(dir, '.jamal', 'compose.yml')), true);
  });

  it('up --detach is accepted and idempotent (already detached by default)', async () => {
    const dir = makeDir('up-detach');
    const s = sinks();
    const r = makeRunner();

    const code = await runJamalCommand(
      ['up', '--detach'],
      deps(dir, s, r.run, async () => fakeJamalConfig()),
    );

    assert.equal(code, 0, s.err.join('\n'));
    assert.equal(r.calls.length, 1);
    assert.deepEqual(r.calls[0]?.argv, [
      'docker',
      'compose',
      '-f',
      '.jamal/compose.yml',
      '-p',
      'myapp',
      'up',
      '-d',
      '--wait',
    ]);
  });

  it('up leaves the managed compose file unchanged on a second identical run', async () => {
    const dir = makeDir('up-idempotent');
    const s = sinks();
    const load = async () => fakeJamalConfig();

    assert.equal(await runJamalCommand(['up'], deps(dir, s, makeRunner().run, load)), 0);
    const first = readFileSync(join(dir, '.jamal', 'compose.yml'), 'utf8');

    const r = makeRunner();
    assert.equal(await runJamalCommand(['up'], deps(dir, s, r.run, load)), 0);
    const second = readFileSync(join(dir, '.jamal', 'compose.yml'), 'utf8');

    assert.equal(second, first);
  });

  it('down and ps map to their docker compose verbs', async () => {
    const dir = withComposeFile('down-ps');
    const s = sinks();

    const down = makeRunner();
    assert.equal(await runJamalCommand(['down'], deps(dir, s, down.run)), 0);
    assert.deepEqual(down.calls[0]?.argv, ['docker', 'compose', 'down']);
    assert.equal(down.calls[0]?.cwd, dir);

    const ps = makeRunner();
    assert.equal(await runJamalCommand(['ps'], deps(dir, s, ps.run)), 0);
    assert.deepEqual(ps.calls[0]?.argv, ['docker', 'compose', 'ps']);
    assert.equal(ps.calls[0]?.cwd, dir);
  });

  it('logs maps to docker compose logs with no extra flags', async () => {
    const dir = withComposeFile('logs');
    const s = sinks();
    const r = makeRunner();

    const code = await runJamalCommand(['logs'], deps(dir, s, r.run));

    assert.equal(code, 0, s.err.join('\n'));
    assert.deepEqual(r.calls[0]?.argv, ['docker', 'compose', 'logs']);
  });

  it('logs --follow appends --follow', async () => {
    const dir = withComposeFile('logs-follow');
    const s = sinks();
    const r = makeRunner();

    const code = await runJamalCommand(['logs', '--follow'], deps(dir, s, r.run));

    assert.equal(code, 0, s.err.join('\n'));
    assert.deepEqual(r.calls[0]?.argv, ['docker', 'compose', 'logs', '--follow']);
  });

  it('logs <service> appends the service name', async () => {
    const dir = withComposeFile('logs-service');
    const s = sinks();
    const r = makeRunner();

    const code = await runJamalCommand(['logs', 'valkey'], deps(dir, s, r.run));

    assert.equal(code, 0, s.err.join('\n'));
    assert.deepEqual(r.calls[0]?.argv, ['docker', 'compose', 'logs', 'valkey']);
  });

  it('logs --follow <service> appends both in order', async () => {
    const dir = withComposeFile('logs-follow-service');
    const s = sinks();
    const r = makeRunner();

    const code = await runJamalCommand(['logs', '--follow', 'valkey'], deps(dir, s, r.run));

    assert.equal(code, 0, s.err.join('\n'));
    assert.deepEqual(r.calls[0]?.argv, ['docker', 'compose', 'logs', '--follow', 'valkey']);
  });

  it('rejects more than one service for logs as a usage error', async () => {
    const dir = withComposeFile('logs-many');
    const s = sinks();
    const r = makeRunner();

    const code = await runJamalCommand(['logs', 'a', 'b'], deps(dir, s, r.run));

    assert.equal(code, 2);
    assert.equal(r.calls.length, 0);
    assert.match(s.err.join('\n'), /at most one service/);
  });

  it('rejects a positional argument on up/down/ps as a usage error', async () => {
    const dir = withComposeFile('up-arg');
    const s = sinks();
    const r = makeRunner();

    const code = await runJamalCommand(['up', 'extra'], deps(dir, s, r.run));

    assert.equal(code, 2);
    assert.equal(r.calls.length, 0);
    assert.match(s.err.join('\n'), /takes no arguments/);
  });
});

describe('jamal docker: --dir', () => {
  it('runs docker compose with cwd set to the --dir project root', async () => {
    const root = makeDir('dir-root');
    const sub = join(root, 'deploy');
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, COMPOSE_FILENAME), 'services: {}\n');
    const s = sinks();
    const r = makeRunner();

    const code = await runJamalCommand(
      ['up', '--dir', 'deploy'],
      deps(root, s, r.run, async () => fakeJamalConfig()),
    );

    assert.equal(code, 0, s.err.join('\n'));
    assert.equal(r.calls.length, 1);
    assert.equal(r.calls[0]?.cwd, sub);
    assert.deepEqual(r.calls[0]?.argv, [
      'docker',
      'compose',
      '-f',
      '.jamal/compose.yml',
      '-p',
      'myapp',
      'up',
      '-d',
      '--wait',
    ]);
    assert.equal(existsSync(join(sub, '.jamal', 'compose.yml')), true);
  });
});

describe('jamal docker: missing compose file', () => {
  it('up fails with a clear, value-free error when jamal.config.js is missing', async () => {
    const dir = makeDir('no-compose');
    const s = sinks();
    const r = makeRunner();

    const code = await runJamalCommand(['up'], deps(dir, s, r.run));

    assert.equal(code, 1);
    assert.equal(r.calls.length, 0);
    const err = s.err.join('\n');
    assert.match(err, /jamal\.config\.js/);
    assert.match(err, /not found/);
    assert.ok(!err.includes('\n    at '), 'no stack trace may leak');
  });

  it('applies the same compose-file check to down, ps, and logs', async () => {
    const dir = makeDir('no-compose-verbs');
    const s = sinks();
    const r = makeRunner();

    for (const verb of ['down', 'ps', 'logs']) {
      const code = await runJamalCommand([verb], deps(dir, s, r.run));
      assert.equal(code, 1, verb);
      assert.equal(r.calls.length, 0);
    }
    assert.match(s.err.join('\n'), /jamal dev --write/);
  });
});

describe('jamal docker: unavailable docker compose', () => {
  it('fails with a clear, sanitized error when docker is missing (ENOENT)', async () => {
    const dir = withComposeFile('missing-docker');
    const s = sinks();
    const enoent = Object.assign(new Error('spawn docker ENOENT'), {
      code: 'ENOENT',
    });
    const r = makeRunner(enoent);

    const code = await runJamalCommand(
      ['up'],
      deps(dir, s, r.run, async () => fakeJamalConfig()),
    );

    assert.equal(code, 127);
    const err = s.err.join('\n');
    assert.match(err, /docker compose is not available/);
    assert.ok(!err.includes('spawn docker ENOENT'), 'raw spawn error must not leak');
  });

  it('reports unavailability when the runner seam is absent', async () => {
    const dir = withComposeFile('no-seam');
    const s = sinks();
    const d = deps(dir, s, undefined, async () => fakeJamalConfig());
    delete d.runCommand;

    const code = await runJamalCommand(['up'], d);

    assert.equal(code, 127);
    assert.match(s.err.join('\n'), /docker compose is not available/);
  });
});

describe('jamal docker: runner failure propagation', () => {
  it('propagates the docker compose exit code and emits a sanitized summary', async () => {
    const dir = withComposeFile('exit-code');
    const s = sinks();
    const r = makeRunner({
      exitCode: 5,
      stdout: '',
      stderr: 'docker: something broke\n',
    });

    const code = await runJamalCommand(
      ['up'],
      deps(dir, s, r.run, async () => fakeJamalConfig()),
    );

    assert.equal(code, 5);
    assert.match(s.err.join('\n'), /docker compose up exited with code 5/);
  });

  it('sanitizes a non-ENOENT spawn failure into a single jsails line', async () => {
    const dir = withComposeFile('spawn-fail');
    const s = sinks();
    const r = makeRunner(new Error('underlying reason'));

    const code = await runJamalCommand(['down'], deps(dir, s, r.run));

    assert.equal(code, 1);
    const err = s.err.join('\n');
    assert.match(err, /jsails: failed to run docker compose down/);
    assert.ok(!err.includes('\n    at '), 'no stack trace may leak');
  });

  it('forwards the runner stdout on success (logs/ps output)', async () => {
    const dir = withComposeFile('forward');
    const s = sinks();
    const r = makeRunner({
      exitCode: 0,
      stdout: 'valkey  Up 5 seconds\n',
      stderr: '',
    });

    const code = await runJamalCommand(['ps'], deps(dir, s, r.run));

    assert.equal(code, 0);
    assert.equal(s.out.join('\n'), 'valkey  Up 5 seconds');
  });
});

describe('jamal docker: generator subcommands unchanged', () => {
  it('dev/targets never reach the runner; static deploy reaches it via npx', async () => {
    const dir = withComposeFile('generators');
    const s = sinks();
    const r = makeRunner();

    assert.equal(await runJamalCommand(['dev'], deps(dir, s, r.run)), 0);
    assert.equal(await runJamalCommand(['targets'], deps(dir, s, r.run)), 0);
    assert.equal(r.calls.length, 0, 'dev/targets must not spawn any command');

    assert.equal(
      await runJamalCommand(['deploy', '--target', 'vercel', '--write'], deps(dir, s, r.run)),
      0,
    );
    assert.equal(r.calls.length, 1, 'static vercel deploy runs exactly one npx command');
    assert.deepEqual(r.calls[0]?.argv, ['npx', '--yes', 'vercel', 'deploy', '--prod']);
    assert.match(s.out.join('\n'), /wrote 1 file\(s\), skipped 0/);
  });
});

describe('jamal docker: composeArgv unit', () => {
  it('builds the fixed argv arrays without shell interpolation', () => {
    assert.deepEqual(composeArgv('up'), ['docker', 'compose', 'up', '-d']);
    assert.deepEqual(composeArgv('down'), ['docker', 'compose', 'down']);
    assert.deepEqual(composeArgv('ps'), ['docker', 'compose', 'ps']);
    assert.deepEqual(composeArgv('logs'), ['docker', 'compose', 'logs']);
    assert.deepEqual(composeArgv('logs', { follow: true }), [
      'docker',
      'compose',
      'logs',
      '--follow',
    ]);
    assert.deepEqual(composeArgv('logs', { service: 'valkey' }), [
      'docker',
      'compose',
      'logs',
      'valkey',
    ]);
    assert.deepEqual(composeArgv('logs', { follow: true, service: 'valkey' }), [
      'docker',
      'compose',
      'logs',
      '--follow',
      'valkey',
    ]);
  });

  it('inserts -f and -p before the verb and appends --wait to up', () => {
    const target = { file: '.jamal/compose.yml', project: 'myapp' };
    assert.deepEqual(composeArgv('up', { ...target, wait: true }), [
      'docker',
      'compose',
      '-f',
      '.jamal/compose.yml',
      '-p',
      'myapp',
      'up',
      '-d',
      '--wait',
    ]);
    assert.deepEqual(composeArgv('down', target), [
      'docker',
      'compose',
      '-f',
      '.jamal/compose.yml',
      '-p',
      'myapp',
      'down',
    ]);
    assert.deepEqual(composeArgv('logs', { ...target, follow: true, service: 'valkey' }), [
      'docker',
      'compose',
      '-f',
      '.jamal/compose.yml',
      '-p',
      'myapp',
      'logs',
      '--follow',
      'valkey',
    ]);
    // A lone -f or -p is emitted independently, still before the verb.
    assert.deepEqual(composeArgv('ps', { file: 'custom.yml' }), [
      'docker',
      'compose',
      '-f',
      'custom.yml',
      'ps',
    ]);
    assert.deepEqual(composeArgv('ps', { project: 'proj' }), [
      'docker',
      'compose',
      '-p',
      'proj',
      'ps',
    ]);
  });

  it('builds the fixed exec argv with the -- separator', () => {
    assert.deepEqual(execArgv('valkey', ['sh', '-c', 'echo hi']), [
      'docker',
      'compose',
      'exec',
      'valkey',
      '--',
      'sh',
      '-c',
      'echo hi',
    ]);
    assert.deepEqual(
      execArgv('app', ['node', '--foo'], {
        file: '.jamal/compose.yml',
        project: 'myapp',
      }),
      [
        'docker',
        'compose',
        '-f',
        '.jamal/compose.yml',
        '-p',
        'myapp',
        'exec',
        'app',
        '--',
        'node',
        '--foo',
      ],
    );
  });
});
