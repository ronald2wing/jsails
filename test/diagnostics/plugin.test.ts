/**
 * Diagnostics plugin tests: service wiring through the extension runner,
 * disabled/no-op mode, provided-recorder identity, option validation, and
 * idempotent close. No connection, database, or external service is opened.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runExtensions } from '../../src/extensions/index.js';
import {
  diagnosticsPlugin,
  diagnosticsToken,
  type Diagnostics,
  type DiagnosticsRecorder,
} from '../../src/diagnostics/index.js';

describe('diagnosticsPlugin', () => {
  it('has name "diagnostics" and a stable token', () => {
    assert.equal(diagnosticsToken.name, 'diagnostics');
    assert.equal(diagnosticsPlugin().name, 'diagnostics');
  });

  it('provides a Diagnostics service under the token', async () => {
    const runtime = await runExtensions([diagnosticsPlugin()]);
    try {
      const diag: Diagnostics = runtime.services.get(diagnosticsToken);
      assert.equal(typeof diag.record, 'function');
      assert.equal(typeof diag.entries, 'function');

      // Default state: empty.
      assert.deepEqual(diag.entries(), []);
      assert.deepEqual(diag.stats(), { total: 0, byType: {}, withDuration: 0 });
    } finally {
      await runtime.close();
    }
  });

  it('records and reads entries through the service', async () => {
    const runtime = await runExtensions([diagnosticsPlugin({})]);
    try {
      const diag = runtime.services.get(diagnosticsToken);

      diag.record({ type: 'query' });
      diag.record({ type: 'http', durationMs: 10 });
      diag.record({ type: 'query' });

      const queries = diag.entries({ type: 'query' });
      assert.equal(queries.length, 2);

      const s = diag.stats();
      assert.equal(s.total, 3);
      assert.equal(s.byType['query'], 2);
      assert.equal(s.byType['http'], 1);
      assert.equal(s.withDuration, 1);
    } finally {
      await runtime.close();
    }
  });

  it('uses a provided recorder verbatim', async () => {
    // Pre-seed a recorder.
    const calls: number[] = [];
    const recorder: DiagnosticsRecorder = {
      record() {
        calls.push(1);
      },
      entries() {
        return [{ type: 'pre-seeded', at: 1 }];
      },
      clear() {},
      stats() {
        return { total: 99, byType: { stub: 99 }, withDuration: 0 };
      },
      async wrapAsync<T>(_type: string, fn: () => Promise<T>): Promise<T> {
        return fn();
      },
      pause() {},
      resume() {},
      isPaused() {
        return false;
      },
      prune() {
        return 0;
      },
    };

    const runtime = await runExtensions([diagnosticsPlugin({ recorder })]);
    try {
      const diag = runtime.services.get(diagnosticsToken);

      assert.equal(diag.stats().total, 99, 'the provided recorder backs the service');
      assert.equal(diag.entries()[0]!.type, 'pre-seeded');
    } finally {
      await runtime.close();
    }
  });
});

describe('disabled plugin', () => {
  it('when enabled is false, the service records nothing', async () => {
    const runtime = await runExtensions([diagnosticsPlugin({ enabled: false })]);
    try {
      const diag = runtime.services.get(diagnosticsToken);

      assert.equal(typeof diag.record, 'function');
      assert.equal(typeof diag.entries, 'function');

      diag.record({ type: 'query' });
      diag.record({ type: 'http', durationMs: 42 });

      assert.deepEqual(diag.entries(), []);
      assert.deepEqual(diag.entries({ type: 'query' }), []);
      assert.deepEqual(diag.stats(), { total: 0, byType: {}, withDuration: 0 });
    } finally {
      await runtime.close();
    }
  });

  it('disabled service clear is a no-op', async () => {
    const runtime = await runExtensions([diagnosticsPlugin({ enabled: false })]);
    try {
      const diag = runtime.services.get(diagnosticsToken);

      diag.record({ type: 'anything' });
      diag.clear();

      // Still empty — clear is a no-op on a no-op.
      assert.deepEqual(diag.entries(), []);
    } finally {
      await runtime.close();
    }
  });

  it('still provides the service so consumers do not fail', async () => {
    const runtime = await runExtensions([diagnosticsPlugin({ enabled: false })]);
    try {
      assert.ok(runtime.services.has(diagnosticsToken));
      const diag = runtime.services.get(diagnosticsToken);
      assert.ok(diag !== null && typeof diag === 'object');
    } finally {
      await runtime.close();
    }
  });
});

describe('option validation', () => {
  it('rejects malformed options eagerly', () => {
    assert.throws(() => diagnosticsPlugin(null as never), TypeError);
    assert.throws(() => diagnosticsPlugin([] as never), TypeError);
    assert.throws(() => diagnosticsPlugin({ recorder: {} } as never), TypeError);
    assert.throws(() => diagnosticsPlugin({ recorder: null } as never), TypeError);
    assert.throws(() => diagnosticsPlugin({ enabled: 'yes' as never }), TypeError);
  });
});

describe('idempotent close', () => {
  it('closes idempotently with no handles held', async () => {
    const runtime = await runExtensions([diagnosticsPlugin()]);
    await runtime.close();
    await runtime.close();
  });
});

describe('import/construction laziness', () => {
  it('constructing a plugin performs no I/O', () => {
    const plugin = diagnosticsPlugin();
    assert.equal(typeof plugin.name, 'string');
    assert.equal(typeof plugin.setup, 'function');
  });

  it('constructing a disabled plugin performs no I/O', () => {
    const plugin = diagnosticsPlugin({ enabled: false });
    assert.equal(plugin.name, 'diagnostics');
  });
});

describe('service + recorder integration', () => {
  it('the plugin-owned recorder is a true ring buffer', async () => {
    const runtime = await runExtensions([diagnosticsPlugin()]);
    try {
      const diag = runtime.services.get(diagnosticsToken);

      // The default is 1000 entries — verify boundedness by pushing many.
      for (let i = 0; i < 1500; i++) {
        diag.record({ type: 'query', data: { i } });
      }

      const s = diag.stats();
      assert.equal(s.total, 1000, 'buffer stays capped at the default 1000');
      assert.equal(s.byType['query'], 1000);

      // The earliest 500 should have been evicted.
      const all = diag.entries();
      const firstRemaining = all[0]!.data?.i as number;
      assert.ok(firstRemaining >= 500, `expected >= 500, got ${firstRemaining}`);
    } finally {
      await runtime.close();
    }
  });
});
