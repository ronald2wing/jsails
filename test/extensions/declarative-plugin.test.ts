import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createServiceRegistry, createServiceToken } from '../../src/extensions/services.js';
import {
  DeclarativePluginError,
  defineDeclarativePlugin,
} from '../../src/extensions/declarative-plugin.js';
import type { PluginContext } from '../../src/extensions/plugin-contract.js';

/** Build a minimal fake PluginContext for testing setup behaviour. */
function fakeContext(overrides: Partial<PluginContext> = {}): PluginContext {
  const registry = createServiceRegistry();
  return {
    services: registry.registrar,
    configureHttp: () => {},
    onServe: () => {},
    configureMiddleware: () => {},
    intercept: () => {},
    observe: () => {},
    interceptorRegistry: {} as PluginContext['interceptorRegistry'],
    ...overrides,
  };
}

describe('defineDeclarativePlugin', () => {
  it('produces a plugin matching the JsailsPlugin contract', () => {
    const plugin = defineDeclarativePlugin({
      name: 'test-plugin',
    });

    assert.equal(typeof plugin.name, 'string');
    assert.equal(typeof plugin.setup, 'function');
    assert.equal(plugin.requires, undefined);
    assert.equal(plugin.commands, undefined);
    assert.equal(plugin.deployments, undefined);
    assert.equal(plugin.renderer, undefined);
    assert.equal(plugin.priority, undefined);
    assert.equal(plugin.disabled, undefined);
  });

  it('throws a value-free error for a missing name', () => {
    assert.throws(
      () => defineDeclarativePlugin({ name: '' }),
      (error: unknown) => {
        assert.ok(error instanceof DeclarativePluginError);
        assert.equal(error.code, 'invalid_name');
        assert.ok(!error.message.includes('test'));
        return true;
      },
    );
  });

  it('throws a value-free error for an empty name', () => {
    assert.throws(() => defineDeclarativePlugin({ name: '  ' }), DeclarativePluginError);
  });

  it('throws a value-free error for a non-string name', () => {
    // @ts-expect-error testing invalid name type
    assert.throws(() => defineDeclarativePlugin({ name: 1 }), DeclarativePluginError);
  });
});

describe('provide → services.provide mapping', () => {
  it('calls services.provide for every entry during setup', () => {
    const tokenA = createServiceToken<string>('tokenA');
    const tokenB = createServiceToken<number>('tokenB');

    const registry = createServiceRegistry();
    let httpCalled = false;

    const plugin = defineDeclarativePlugin({
      name: 'provider',
      provide: [
        [tokenA, 'valueA'],
        [tokenB, 42],
      ],
      http: () => {
        httpCalled = true;
      },
    });

    const setupResult = plugin.setup(
      fakeContext({
        services: registry.registrar,
        configureHttp: (hook) => {
          hook({} as never);
        },
      }),
    );

    assert.equal(setupResult, undefined);
    assert.equal(registry.services.get(tokenA), 'valueA');
    assert.equal(registry.services.get(tokenB), 42);
    assert.equal(httpCalled, true);
  });

  it('throws value-free for a non-token provide key', () => {
    assert.throws(
      () =>
        // @ts-expect-error testing invalid provide entry
        defineDeclarativePlugin({ name: 'bad', provide: [['not-a-token', 'value']] }),
      (error: unknown) => {
        assert.ok(error instanceof DeclarativePluginError);
        assert.equal(error.code, 'invalid_provide_key');
        assert.ok(!error.message.includes('not-a-token'));
        return true;
      },
    );
  });

  it('throws value-free for a non-array provide entry', () => {
    assert.throws(
      () =>
        // @ts-expect-error testing invalid provide entry
        defineDeclarativePlugin({ name: 'bad', provide: [42] }),
      (error: unknown) => {
        assert.ok(error instanceof DeclarativePluginError);
        assert.equal(error.code, 'invalid_provide_entry');
        return true;
      },
    );
  });

  it('throws value-free for a provide entry with wrong length', () => {
    const token = createServiceToken<string>('tok');
    assert.throws(
      () =>
        // @ts-expect-error testing invalid provide entry
        defineDeclarativePlugin({ name: 'bad', provide: [[token]] }),
      (error: unknown) => {
        assert.ok(error instanceof DeclarativePluginError);
        assert.equal(error.code, 'invalid_provide_entry');
        return true;
      },
    );
  });

  it('rejects a plain object without a name property as a provide key', () => {
    const plain = {};
    assert.throws(
      () =>
        // @ts-expect-error testing invalid provide entry
        defineDeclarativePlugin({ name: 'bad', provide: [[plain, 'val']] }),
      (error: unknown) => {
        assert.ok(error instanceof DeclarativePluginError);
        assert.equal(error.code, 'invalid_provide_key');
        return true;
      },
    );
  });

  it('rejects null as a provide key', () => {
    assert.throws(
      () =>
        // @ts-expect-error testing invalid provide entry
        defineDeclarativePlugin({ name: 'bad', provide: [[null, 'val']] }),
      (error: unknown) => {
        assert.ok(error instanceof DeclarativePluginError);
        assert.equal(error.code, 'invalid_provide_key');
        return true;
      },
    );
  });

  it('rejects an array as a provide key', () => {
    assert.throws(
      () =>
        // @ts-expect-error testing invalid provide entry
        defineDeclarativePlugin({ name: 'bad', provide: [['clock', 'val']] }),
      (error: unknown) => {
        assert.ok(error instanceof DeclarativePluginError);
        assert.equal(error.code, 'invalid_provide_key');
        return true;
      },
    );
  });

  it('accepts an empty provide array', () => {
    const registry = createServiceRegistry();
    const plugin = defineDeclarativePlugin({
      name: 'empty',
      provide: [],
    });

    plugin.setup(
      fakeContext({
        services: registry.registrar,
      }),
    );

    // Nothing registered — no error.
    assert.equal(registry.services.tryGet(createServiceToken('x')), undefined);
  });
});

describe('http hook passthrough', () => {
  it('calls configureHttp with the provided hook during setup', () => {
    const captured: unknown[] = [];

    const plugin = defineDeclarativePlugin({
      name: 'http-plugin',
      http: () => {
        captured.push('hook');
      },
    });

    plugin.setup(
      fakeContext({
        configureHttp: (hook) => {
          captured.push('configureHttp');
          hook({} as never);
        },
      }),
    );

    assert.deepEqual(captured, ['configureHttp', 'hook']);
  });

  it('does not call configureHttp when http is omitted', () => {
    let called = false;
    const plugin = defineDeclarativePlugin({ name: 'no-http' });

    plugin.setup(
      fakeContext({
        configureHttp: () => {
          called = true;
        },
      }),
    );

    assert.equal(called, false);
  });
});

describe('requires and commands pass through', () => {
  it('preserves requires unchanged', () => {
    const token = createServiceToken<number>('db');
    const plugin = defineDeclarativePlugin({
      name: 'consumer',
      requires: [token],
    });

    assert.deepEqual(plugin.requires, [token]);
  });

  it('preserves commands unchanged', () => {
    const command = {
      name: 'hello',
      summary: 'say hello',
      run: () => {
        /* noop */
      },
    };

    const plugin = defineDeclarativePlugin({
      name: 'cmd-plugin',
      commands: [command],
    });

    assert.equal(plugin.commands![0]!.name, 'hello');
    assert.equal(plugin.commands![0]!.summary, 'say hello');
  });

  it('preserves describe unchanged', () => {
    const desc = () => ({ components: [{ name: 'c', actions: [], writableKeys: [] }] });
    const plugin = defineDeclarativePlugin({
      name: 'desc-plugin',
      describe: desc,
    });

    assert.equal(plugin.describe, desc);
  });
});

describe('optional user setup runs after auto-wiring', () => {
  it('runs user setup after provide and http', () => {
    const token = createServiceToken<string>('tok');
    const order: string[] = [];

    const registry = createServiceRegistry();
    const plugin = defineDeclarativePlugin({
      name: 'ordered',
      provide: [[token, 'val']],
      http: () => {
        order.push('http');
      },
      setup: () => {
        order.push('user-setup');
      },
    });

    plugin.setup(
      fakeContext({
        services: registry.registrar,
        configureHttp: (hook) => {
          order.push('configureHttp-call');
          hook({} as never);
        },
      }),
    );

    assert.deepEqual(order, ['configureHttp-call', 'http', 'user-setup']);
  });
});

describe('DeclarativePluginError is value-free', () => {
  it('never echoes the problematic value in the message', () => {
    const badToken = { foo: 'bar' };
    try {
      // @ts-expect-error testing invalid provide entry
      defineDeclarativePlugin({ name: 'bad', provide: [[badToken, 'x']] });
      assert.fail('expected an error');
    } catch (error) {
      assert.ok(error instanceof DeclarativePluginError);
      const msg = error.message;
      assert.ok(!msg.includes('foo'));
      assert.ok(!msg.includes('bar'));
      assert.ok(!msg.includes('bad'));
      assert.equal(error.code, 'invalid_provide_key');
    }
  });
});
