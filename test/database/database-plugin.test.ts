/**
 * Tests for the first-party `database` plugin: exposing an injected data source
 * under `databaseToken`, deferring the connection by default (and honoring
 * `initialize`), and destroying only an initialized source, idempotently. A
 * minimal fake data source stands in for `JsailsDataSource`, so no real
 * database connection is opened.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { JsailsDataSource } from '../../src/database/data-source.js';
import { databasePlugin, databaseToken } from '../../src/database/plugin.js';
import { runExtensions } from '../../src/extensions/extension.js';

interface FakeDataSource {
  isInitialized: boolean;
  initializeCalls: number;
  destroyCalls: number;
  initialize(): Promise<void>;
  destroy(): Promise<void>;
}

function fakeDataSource(initialized = false): FakeDataSource {
  const ds: FakeDataSource = {
    isInitialized: initialized,
    initializeCalls: 0,
    destroyCalls: 0,
    async initialize() {
      ds.initializeCalls += 1;
      ds.isInitialized = true;
    },
    async destroy() {
      ds.destroyCalls += 1;
      ds.isInitialized = false;
    },
  };
  return ds;
}

const asDataSource = (ds: FakeDataSource): JsailsDataSource => ds as unknown as JsailsDataSource;

describe('databasePlugin', () => {
  it('provides the data source under databaseToken without connecting on setup', async () => {
    const ds = fakeDataSource(false);
    const runtime = await runExtensions([databasePlugin({ dataSource: asDataSource(ds) })]);
    try {
      assert.equal(runtime.services.get(databaseToken), ds);
      assert.equal(ds.initializeCalls, 0, 'setup does not connect by default');
      assert.equal(ds.isInitialized, false);
    } finally {
      await runtime.close();
    }
    assert.equal(ds.destroyCalls, 0, 'a never-initialized source is not destroyed');
  });

  it('connects during setup when initialize is true', async () => {
    const ds = fakeDataSource(false);
    const runtime = await runExtensions([
      databasePlugin({ dataSource: asDataSource(ds), initialize: true }),
    ]);
    assert.equal(ds.initializeCalls, 1);
    assert.equal(ds.isInitialized, true);

    await runtime.close();
    assert.equal(ds.destroyCalls, 1);
  });

  it('destroys only an initialized source, and idempotently', async () => {
    const ds = fakeDataSource(true);
    const runtime = await runExtensions([databasePlugin({ dataSource: asDataSource(ds) })]);
    await runtime.close();
    assert.equal(ds.destroyCalls, 1);

    await runtime.close();
    assert.equal(ds.destroyCalls, 1, 'a second close does not destroy again');
  });

  it('rejects a data source that was never provided', () => {
    assert.throws(() => databasePlugin({} as never), TypeError);
    assert.throws(() => databasePlugin({ dataSource: null } as never), TypeError);
    assert.throws(() => databasePlugin(null as never), TypeError);
  });

  it('exposes a stable databaseToken singleton', async () => {
    assert.equal(databaseToken.name, 'database');
    const again = await import('../../src/database/plugin.js');
    assert.equal(again.databaseToken, databaseToken);
  });
});
