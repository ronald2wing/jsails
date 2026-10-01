import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  clearComponentRegistry,
  registerComponent,
  registeredComponents,
} from '../../src/server-components/registry.js';

import type { ServerComponentDefinition } from '../../src/server-components/component.js';

function component(name: string): ServerComponentDefinition<any> {
  return { name } as unknown as ServerComponentDefinition<any>;
}

afterEach(() => {
  clearComponentRegistry();
});

describe('component registry', () => {
  it('registers components keyed by name, in registration order', () => {
    registerComponent(component('alpha'));
    registerComponent(component('beta'));

    assert.deepEqual(Object.keys(registeredComponents()), ['alpha', 'beta']);
  });

  it('is idempotent per name, replacing in place and preserving order', () => {
    const first = component('alpha');
    const replacement = component('alpha');
    registerComponent(first);
    registerComponent(component('beta'));
    registerComponent(replacement);

    const registered = registeredComponents();
    assert.deepEqual(Object.keys(registered), ['alpha', 'beta']);
    assert.equal(registered.alpha, replacement);
  });

  it('returns a frozen snapshot that cannot mutate the registry', () => {
    registerComponent(component('alpha'));
    const snapshot = registeredComponents();

    assert.equal(Object.isFrozen(snapshot), true);
    assert.throws(() => {
      (snapshot as Record<string, unknown>).beta = component('beta');
    }, TypeError);
    assert.deepEqual(Object.keys(registeredComponents()), ['alpha']);
  });

  it('clears the registry', () => {
    registerComponent(component('alpha'));
    clearComponentRegistry();
    assert.deepEqual(registeredComponents(), {});
  });
});
