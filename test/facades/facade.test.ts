import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { JsailsExtension } from '../../src/extensions/index.js';
import { createServiceRegistry, createServiceToken } from '../../src/extensions/index.js';
import {
  currentAppScope,
  facade,
  FacadeError,
  installFacades,
  withAppScope,
} from '../../src/facades/index.js';
import { createTestApp, type JsailsAppConfig } from '../../src/testing/index.js';

/**
 * Tests for facades and the ambient application scope. They cover typed
 * resolution through the scope, method binding and chaining, canonical
 * per-token identity, the value-free `no_app_scope` / `unresolved` failures,
 * idempotent install and conflict detection, resolution across two
 * concurrently-live applications, and the clean failure once a scope ends.
 */

interface Counter {
  count: number;
  increment(by: number): number;
  label(): string;
}

/** A representative service: state plus a chainable method. */
function makeCounter(): Counter {
  return {
    count: 0,
    increment(by: number): number {
      this.count += by;
      return this.count;
    },
    label(): string {
      return `count=${this.count}`;
    },
  };
}

/** Assert a thrown `FacadeError` has the expected code. */
function facadeError(fn: () => unknown, code: FacadeError['code']): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof FacadeError, `expected FacadeError, got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  });
}

const counterToken = createServiceToken<Counter>('test.counter');
const otherToken = createServiceToken<{ value: string }>('test.other');

describe('facade resolution', () => {
  it('resolves a service from the ambient scope and forwards members', () => {
    const counter = makeCounter();
    const { services, registrar } = createServiceRegistry();
    registrar.provide(counterToken, counter);

    const Counter = facade(counterToken);
    withAppScope(services, () => {
      assert.equal(Counter.increment(2), 2);
      assert.equal(Counter.increment(3), 5);
      assert.equal(Counter.count, 5);
      assert.equal(Counter.label(), 'count=5');
    });
  });

  it('binds methods so a detached reference still hits the instance', () => {
    const counter = makeCounter();
    const { services, registrar } = createServiceRegistry();
    registrar.provide(counterToken, counter);

    const Counter = facade(counterToken);
    withAppScope(services, () => {
      const increment = Counter.increment;
      increment.call(Counter, 4); // bound to the instance regardless of receiver
      assert.equal(counter.count, 4);
    });
  });

  it('is canonical per token: repeated facade() returns the same proxy', () => {
    assert.equal(facade(counterToken), facade(counterToken));
    assert.notEqual(facade(counterToken), facade(otherToken));
  });

  it('raises a value-free no_app_scope outside any scope', () => {
    const Counter = facade(counterToken);
    assert.equal(currentAppScope(), undefined);
    facadeError(() => Counter.count, 'no_app_scope');
  });

  it('raises a value-free unresolved when the scope lacks a provider', () => {
    const { services } = createServiceRegistry();
    const Other = facade(otherToken);
    withAppScope(services, () => {
      facadeError(() => Other.value, 'unresolved');
    });
  });
});

describe('installFacades', () => {
  it('is idempotent when the same token re-installs its facade', () => {
    installFacades({ __jsailsTestCounter: facade(counterToken) });
    // A second facade(counterToken) is the SAME proxy, so the reinstall no-ops.
    installFacades({ __jsailsTestCounter: facade(counterToken) });
    const global = globalThis as Record<string, unknown>;
    delete global.__jsailsTestCounter;
  });

  it('throws a value-free TypeError on a genuine name conflict', () => {
    const first = facade(counterToken);
    const second = facade(otherToken);
    installFacades({ __jsailsTestConflict: first });
    assert.throws(
      () => installFacades({ __jsailsTestConflict: second }),
      (error: unknown) => error instanceof TypeError,
    );
    const global = globalThis as Record<string, unknown>;
    delete global.__jsailsTestConflict;
  });
});

describe('facades through a live application', () => {
  const Counter = facade(counterToken);

  const fixturesRoot = mkdtempSync(
    join(fileURLToPath(new URL('..', import.meta.url)), 'facade-fixture-'),
  );
  let sequence = 0;

  after(() => {
    rmSync(fixturesRoot, { recursive: true, force: true });
  });

  /**
   * An extension that provides a per-app counter and mounts an HTTP hook which
   * reads it through the facade. The hook runs inside the real Hono pipeline, so
   * it exercises the request-scoped ambient scope without a filesystem fixture.
   */
  function counterExtension(counter: Counter): JsailsExtension {
    return {
      name: 'counter',
      setup(context) {
        context.services.provide(counterToken, counter);
        context.configureHttp((app) => {
          app.get('/api/value', (c) => c.json({ count: Counter.increment(1) }));
        });
      },
    };
  }

  /** A minimal app config that only mounts the given extension. */
  function makeConfig(extension: JsailsExtension): JsailsAppConfig {
    const dir = mkdtempSync(join(fixturesRoot, `case-${sequence++}-`));
    return { rootDir: dir, port: 0, extensions: [extension] };
  }

  it('resolves facades inside a request against that app only', async (t) => {
    const app = await createTestApp({
      config: makeConfig(counterExtension(makeCounter())),
      lifecycle: t,
    });
    const response = await app.request('/api/value');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { count: 1 });
  });

  it('keeps two concurrently-live apps isolated', async (t) => {
    const first = makeCounter();
    const second = makeCounter();
    const appA = await createTestApp({
      config: makeConfig(counterExtension(first)),
      lifecycle: t,
    });
    const appB = await createTestApp({
      config: makeConfig(counterExtension(second)),
      lifecycle: t,
    });

    const [a, b] = await Promise.all([appA.request('/api/value'), appB.request('/api/value')]);
    assert.deepEqual(await a.json(), { count: 1 });
    assert.deepEqual(await b.json(), { count: 1 });
    assert.equal(first.count, 1);
    assert.equal(second.count, 1);
  });

  it('fails cleanly (no_app_scope) after the application closes', async () => {
    const app = await createTestApp({ config: makeConfig(counterExtension(makeCounter())) });
    await app.request('/api/value');
    await app.close();
    facadeError(() => Counter.count, 'no_app_scope');
  });
});

// ---------------------------------------------------------------------------
// nested scope shadowing
// ---------------------------------------------------------------------------

describe('nested scope shadowing', () => {
  const token = createServiceToken<{ x: string }>('test.nested');

  it('inner scope shadows outer; outer is restored after inner returns', () => {
    const { services: outer, registrar: outerReg } = createServiceRegistry();
    const { services: inner, registrar: innerReg } = createServiceRegistry();
    outerReg.provide(token, { x: 'outer' });
    innerReg.provide(token, { x: 'inner' });
    const C = facade(token);

    withAppScope(outer, () => {
      assert.equal(C.x, 'outer');

      withAppScope(inner, () => {
        assert.equal(C.x, 'inner');
      });

      // After the inner scope exits, the outer scope is restored.
      assert.equal(C.x, 'outer');
    });
  });
});
