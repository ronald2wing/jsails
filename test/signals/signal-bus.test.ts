import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createInterceptorRegistry,
  defineEvent,
  definePlugin,
  InterceptorError,
  runExtensions,
} from '../../src/extensions/index.js';
import {
  createSignalBus,
  SignalError,
  signalsPlugin,
  signalsToken,
} from '../../src/signals/index.js';

describe('SignalBus', () => {
  const event = defineEvent<{ n: number }>('test-event');

  it('delegates emit to the underlying InterceptorRegistry', async () => {
    const registry = createInterceptorRegistry();
    const bus = createSignalBus(registry);

    let observerRan = false;
    registry.observe(event, () => {
      observerRan = true;
    });

    const errors = await bus.emit(event, { n: 1 });
    assert.equal(errors.length, 0);
    assert.equal(observerRan, true);
  });

  it('emit returns isolated errors and continues through observers', async () => {
    const registry = createInterceptorRegistry();
    const bus = createSignalBus(registry);

    registry.observe(event, () => {
      throw new Error('first-error');
    });
    let secondRan = false;
    registry.observe(event, () => {
      secondRan = true;
    });
    registry.observe(event, () => {
      throw new Error('third-error');
    });

    const errors = await bus.emit(event, { n: 2 });
    assert.equal(errors.length, 2);
    const [e0, e1] = errors;
    assert.ok(e0 instanceof Error);
    assert.equal(e0.message, 'first-error');
    assert.ok(e1 instanceof Error);
    assert.equal(e1.message, 'third-error');
    assert.equal(secondRan, true);
  });

  it('observe after seal() throws InterceptorError with code sealed', () => {
    const registry = createInterceptorRegistry();
    const bus = createSignalBus(registry);

    registry.seal();

    assert.throws(
      () => bus.observe(event, () => {}),
      (error: unknown) => {
        assert.ok(error instanceof InterceptorError);
        assert.equal(error.code, 'sealed');
        return true;
      },
    );
  });

  it('emit through bus fires observers from another plugin on shared registry', async () => {
    let observerRan = false;

    const observerPlugin = definePlugin({
      name: 'observer',
      setup({ observe }) {
        observe(event, () => {
          observerRan = true;
        });
      },
    });

    const runtime = await runExtensions([signalsPlugin(), observerPlugin]);

    const bus = runtime.services.get(signalsToken);
    const errors = await bus.emit(event, { n: 42 });
    assert.equal(errors.length, 0);
    assert.equal(observerRan, true);

    await runtime.close();
  });

  it('signalsPlugin provides signalsToken', async () => {
    const runtime = await runExtensions([signalsPlugin()]);

    assert.equal(runtime.services.has(signalsToken), true);
    const bus = runtime.services.get(signalsToken);
    assert.equal(typeof bus.observe, 'function');
    assert.equal(typeof bus.emit, 'function');

    await runtime.close();
  });
});

describe('createSignalBus guards', () => {
  it('throws SignalError when registry is missing', () => {
    assert.throws(
      () => createSignalBus(undefined as never),
      (error: unknown) => {
        assert.ok(error instanceof SignalError);
        assert.equal(error.code, 'registry_unavailable');
        return true;
      },
    );
  });
});
