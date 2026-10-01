/**
 * Tests for the `jsails test` command seam — proves the boot → `*_test` derive →
 * migrate → `node --test` ordering without Docker or a live database.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  deriveTestDatabaseName,
  runTestCommand,
  type TestCommandDeps,
  type TestDataSource,
} from '../../src/cli/test-commands.js';

function fakeDataSource(name: string): TestDataSource {
  // Only the database name and destroy() are exercised by the seam.
  return {
    options: { database: name },
    destroy: async () => {},
  } as unknown as TestDataSource;
}

interface Sink {
  out: string[];
  state: {
    services: number;
    loads: string[];
    reconciles: { db: string }[];
    ran: { args: readonly string[]; env: Readonly<Record<string, string>> };
  };
}

function makeDeps(dbName: string): { deps: TestCommandDeps; sink: Sink } {
  const sink: Sink = {
    out: [],
    state: {
      services: 0,
      loads: [],
      reconciles: [],
      ran: { args: [], env: {} },
    },
  };
  const deps: TestCommandDeps = {
    cwd: '/tmp/opencode/app',
    stdout: (l) => sink.out.push(l),
    stderr: () => {},
    env: {},
    runServices: async () => {
      sink.state.services += 1;
      return 0;
    },
    loadDataSource: async (p) => {
      sink.state.loads.push(p);
      // The config re-reads DATABASE_NAME on the second load, so the test DB
      // carries the derived *_test name.
      return fakeDataSource(sink.state.loads.length === 1 ? dbName : `${dbName}_test`);
    },
    reconcileDataSource: async (dataSource) => {
      const database = dataSource.options.database;
      sink.state.reconciles.push({ db: typeof database === 'string' ? database : '' });
    },
    runTests: async (args, env) => {
      sink.state.ran = { args, env };
      return 0;
    },
  };
  return { deps, sink };
}

describe('deriveTestDatabaseName', () => {
  it('suffixes a database name with _test', () => {
    assert.equal(deriveTestDatabaseName('myapp'), 'myapp_test');
  });
  it('names an empty database "test"', () => {
    assert.equal(deriveTestDatabaseName(''), 'test');
  });
});

describe('runTestCommand', () => {
  it('boots services, derives *_test, migrates, and runs tests with the env', async () => {
    const { deps, sink } = makeDeps('shop');
    const code = await runTestCommand({ noServices: false, watch: false }, deps);

    assert.equal(code, 0);
    assert.equal(sink.state.services, 1);
    assert.equal(sink.state.loads.length, 2, 'loads once for name, once for the test DB');
    assert.equal(sink.state.reconciles.length, 1);
    assert.equal(sink.state.reconciles[0]!.db, 'shop_test');
    assert.equal(sink.state.ran.env.DATABASE_NAME, 'shop_test');
    assert.equal(sink.state.ran.env.NODE_ENV, 'test');
  });

  it('skips service boot with --no-services', async () => {
    const { deps, sink } = makeDeps('shop');
    await runTestCommand({ noServices: true, watch: false }, deps);
    assert.equal(sink.state.services, 0);
  });

  it('forwards --watch and --test-file to the child', async () => {
    const { deps, sink } = makeDeps('shop');
    await runTestCommand(
      { noServices: true, watch: true, testFile: 'dist/test/foo.test.js' },
      deps,
    );
    assert.ok(sink.state.ran.args.includes('--watch'));
    assert.ok(sink.state.ran.args.includes('dist/test/foo.test.js'));
  });

  it('returns non-zero when jamal up fails', async () => {
    const { deps } = makeDeps('shop');
    // force the service boot to fail
    const failing = { ...deps, runServices: async () => 1 };
    const code = await runTestCommand({ noServices: false, watch: false }, failing);
    assert.equal(code, 1);
  });
});
