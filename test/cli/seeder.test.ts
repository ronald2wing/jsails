import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { DataSource } from 'typeorm';

import { createSeederRegistry, defineSeeder } from '../../src/database/seeders.js';
import { JsailsDataSource } from '../../src/database/data-source.js';
import {
  runSeedCommand,
  validateSeedConfig,
  type SeedCommandDeps,
} from '../../src/cli/seeder-commands.js';

/**
 * The `seed` command is exercised through its dependency seam (an injected
 * config loader returns a real in-process sql.js data source, so the full
 * initialize -> run -> destroy lifecycle runs without a live database). A few
 * subprocess cases cover the CLI wiring: help surface, the default config path,
 * and cross-command flag gating.
 */

const tmpRoot = mkdtempSync(join(fileURLToPath(new URL('..', import.meta.url)), 'seed-fixture-'));

after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

let locationSeq = 0;

function freshDataSource(): JsailsDataSource {
  return new JsailsDataSource({
    type: 'sqljs',
    location: join(tmpRoot, `seed-cli-${locationSeq++}.sqlite`),
    entities: [],
  });
}

interface Harness {
  dataSource: JsailsDataSource;
  ran: string[];
  lines: string[];
  deps: SeedCommandDeps;
}

function makeHarness(): Harness {
  const dataSource = freshDataSource();
  const ran: string[] = [];
  const lines: string[] = [];
  const registry = createSeederRegistry({
    first: defineSeeder('first', async () => {
      ran.push('first');
    }),
    second: defineSeeder('second', async () => {
      ran.push('second');
    }),
  });
  const deps: SeedCommandDeps = {
    loadConfig: async () => ({ registry, dataSource }),
    stdout: (text) => lines.push(text),
  };
  return { dataSource, ran, lines, deps };
}

describe('validateSeedConfig', () => {
  it('rejects a non-object default export', () => {
    assert.throws(() => validateSeedConfig(null, 'jsails.seed.js'), /default-export an object/);
    assert.throws(() => validateSeedConfig('nope', 'jsails.seed.js'), /default-export an object/);
  });

  it('rejects a missing or invalid registry', () => {
    assert.throws(
      () => validateSeedConfig({ dataSource: new DataSource({ type: 'sqljs' }) }, 'jsails.seed.js'),
      /invalid registry/,
    );
  });

  it('rejects a missing data source', () => {
    assert.throws(
      () => validateSeedConfig({ registry: {} }, 'jsails.seed.js'),
      /must include a TypeORM DataSource/,
    );
  });
});

describe('runSeedCommand', () => {
  it('initializes the source, runs all seeders, prints each, then destroys', async () => {
    const { dataSource, ran, lines, deps } = makeHarness();

    const code = await runSeedCommand('jsails.seed.js', {}, deps);

    assert.equal(code, 0);
    assert.deepEqual(ran, ['first', 'second']);
    assert.deepEqual(lines, ['Seeded first', 'Seeded second']);
    assert.equal(dataSource.isInitialized, false, 'the data source is destroyed afterward');
  });

  it('runs only the requested seeders', async () => {
    const { dataSource, ran, lines, deps } = makeHarness();

    const code = await runSeedCommand('jsails.seed.js', { names: ['second'] }, deps);

    assert.equal(code, 0);
    assert.deepEqual(ran, ['second']);
    assert.deepEqual(lines, ['Seeded second']);
    assert.equal(dataSource.isInitialized, false);
  });

  it('prints a no-op message when nothing runs', async () => {
    const dataSource = freshDataSource();
    const lines: string[] = [];
    const registry = createSeederRegistry({});
    const deps: SeedCommandDeps = {
      loadConfig: async () => ({ registry, dataSource }),
      stdout: (text) => lines.push(text),
    };

    const code = await runSeedCommand('jsails.seed.js', {}, deps);

    assert.equal(code, 0);
    assert.deepEqual(lines, ['No seeders to run.']);
    assert.equal(dataSource.isInitialized, false);
  });

  it('destroys the source even when a seeder fails', async () => {
    const dataSource = freshDataSource();
    const registry = createSeederRegistry({
      bad: defineSeeder('bad', async () => {
        throw new Error('boom');
      }),
    });
    const deps: SeedCommandDeps = {
      loadConfig: async () => ({ registry, dataSource }),
      stdout: () => {},
    };

    await assert.rejects(runSeedCommand('jsails.seed.js', {}, deps), /seeder "bad" failed/);
    assert.equal(dataSource.isInitialized, false, 'destroy still runs on failure');
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

describe('cli: seed subprocess', () => {
  it('surfaces seed, queue, and make in help', () => {
    const result = runCli(['--help'], tmpRoot);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /seed/);
    assert.match(result.stdout, /queue/);
    assert.match(
      result.stdout,
      /make:<page\|api\|job\|model\|command\|server-component\|serializer\|middleware>/,
    );
    assert.match(result.stdout, /jsails\.seed\.js/);
  });

  it('fails to load the default jsails.seed.js when absent', () => {
    const dir = join(tmpRoot, 'seed-missing-config');
    mkdirSync(dir, { recursive: true });
    const result = runCli(['seed'], dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /failed to load config/);
  });

  it('gates --json away from seed', () => {
    const result = runCli(['seed', '--json'], tmpRoot);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--json is only valid for queue/);
  });
});
