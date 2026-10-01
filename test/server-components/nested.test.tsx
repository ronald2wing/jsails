/**
 * Nested component tests.
 *
 * These tests cover `src/server-components/nested.ts`: `defineNestedComponent`
 * validation, `renderNested` with a real runtime (child gets independent
 * snapshot, CSRF, and id), child `authorize` denial, runtime-not-found errors,
 * and static fallback paths.
 *
 * Uses the same in-memory signer and runtime factory pattern as
 * `server-component-runtime.test.tsx`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { z } from 'zod';

import type { RequestContext } from '../../src/contracts/http.js';
import {
  defineAction,
  defineServerComponent,
  type ServerComponentDefinition,
} from '../../src/server-components/component.js';
import {
  defineNestedComponent,
  NestedComponentError,
  renderNested,
} from '../../src/server-components/nested.js';
import {
  COMPONENT_ATTRIBUTE,
  COMPONENT_NAME_ATTRIBUTE,
  COMPONENT_SNAPSHOT_ATTRIBUTE,
  COMPONENT_CSRF_ATTRIBUTE,
} from '../../src/server-components/protocol.js';
import {
  createServerComponentsRuntime,
  type ServerComponentsRuntime,
} from '../../src/server-components/runtime.js';
import { createComponentSigner } from '../../src/server-components/snapshot.js';
import { createServiceRegistry } from '../../src/extensions/services.js';
import { serverComponentsToken } from '../../src/server-components/extension.js';

const KEY = '0123456789abcdef0123456789abcdef';
const ORIGIN = 'http://localhost';

// Preact VNode generic doesn't expose dangerouslySetInnerHTML in its props
// type for intrinsic elements; this helper extracts the inner HTML safely.
function getNestedHtml(vnode: any): string {
  return vnode.props.dangerouslySetInnerHTML.__html as string;
}

function getNestedProp(vnode: any, key: string): unknown {
  return vnode.props[key];
}

// ---------------------------------------------------------------------------
// Child components
// ---------------------------------------------------------------------------

type CardState = { label: string; count: number };

const card = defineServerComponent<CardState>({
  name: 'card',
  stateSchema: z.object({ label: z.string(), count: z.number() }).strict(),
  writableKeys: ['label'],
  initialState() {
    return { label: 'default', count: 0 };
  },
  authorize() {
    return true;
  },
  actions: {
    increment: defineAction({
      run(state) {
        state.count += 1;
      },
    }),
  },
  render(state, { bind }) {
    // JSX is compiled by the test runner; we use plain function calls.
    return (
      <div>
        <span id="child-label">{state.label}</span>
        <span id="child-count">{state.count}</span>
        <input {...bind('label')} />
      </div>
    );
  },
});

const childDenied = defineServerComponent({
  name: 'child-denied',
  stateSchema: z.object({}).strict(),
  initialState() {
    return {};
  },
  authorize() {
    return false;
  },
  render() {
    return null;
  },
});

/** A child whose initialState() throws. */
const _childBoom = defineServerComponent({
  name: 'child-boom',
  stateSchema: z.object({}).strict(),
  initialState() {
    throw new Error('boom');
  },
  authorize() {
    return true;
  },
  render() {
    return null;
  },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRuntime(
  components: Readonly<Record<string, ServerComponentDefinition<any>>>,
): ServerComponentsRuntime {
  return createServerComponentsRuntime({
    components,
    signer: createComponentSigner({ key: KEY, now: () => 0 }),
  });
}

function makeRequest(url: string): Request {
  return new Request(url);
}

/**
 * Build a RequestContext that carries a service registry with the runtime
 * registered, so renderNested can resolve it.
 */
function nestedContext(runtime: ServerComponentsRuntime, path = '/'): RequestContext {
  const url = new URL(path, ORIGIN);
  const controller = createServiceRegistry();
  controller.registrar.provide(serverComponentsToken, runtime);
  controller.seal();

  return {
    request: makeRequest(url.toString()),
    url,
    params: {},
    session: null,
    services: controller.services,
  };
}

function extractAttr(html: string, name: string): string {
  const match = html.match(new RegExp(`${name}="([^"]*)"`));
  assert.ok(match, `expected attribute ${name} in HTML: ${html}`);
  return match[1]!;
}

// ---------------------------------------------------------------------------
// defineNestedComponent validation
// ---------------------------------------------------------------------------

describe('defineNestedComponent', () => {
  it('rejects null', () => {
    assert.throws(() => defineNestedComponent(null as unknown as any), NestedComponentError);
  });

  it('rejects non-object', () => {
    assert.throws(() => defineNestedComponent(42 as unknown as any), NestedComponentError);
  });

  it('rejects empty component name', () => {
    assert.throws(
      () => defineNestedComponent({ name: 'div', component: '' }),
      NestedComponentError,
    );
  });

  it('rejects empty tag name', () => {
    assert.throws(
      () => defineNestedComponent({ name: '', component: 'card' }),
      NestedComponentError,
    );
  });

  it('rejects invalid tag name', () => {
    assert.throws(
      () => defineNestedComponent({ name: '123bad', component: 'card' }),
      NestedComponentError,
    );
  });

  it('accepts valid tag with optional key', () => {
    const config = defineNestedComponent({ name: 'section', component: 'card', key: 'my-key' });
    assert.equal(config.tag, 'section');
    assert.equal(config.component, 'card');
    assert.equal(config.key, 'my-key');
  });

  it('returns a frozen object', () => {
    const config = defineNestedComponent({ name: 'div', component: 'card' });
    assert.throws(() => {
      (config as any).tag = 'span';
    });
  });

  it('key is absent when omitted', () => {
    const config = defineNestedComponent({ name: 'div', component: 'card' });
    assert.equal(config.key, undefined);
  });
});

// ---------------------------------------------------------------------------
// renderNested with real runtime
// ---------------------------------------------------------------------------

describe('renderNested', () => {
  it('renders a child component with its own snapshot and markers', async () => {
    const runtime = makeRuntime({ card });
    const ctx = nestedContext(runtime);
    const vnode = await renderNested('card', ctx);

    assert.ok(vnode.type === 'div');
    assert.ok(getNestedHtml(vnode) !== undefined);
    const html = getNestedHtml(vnode);

    // The child carries its own component-root markers.
    assert.ok(html.includes(`${COMPONENT_ATTRIBUTE}="card"`));
    assert.ok(html.includes(`${COMPONENT_NAME_ATTRIBUTE}="card"`));
    // It has its own snapshot token.
    const childSnapshot = extractAttr(html, COMPONENT_SNAPSHOT_ATTRIBUTE);
    assert.ok(childSnapshot.length > 0);
    // It has its own CSRF token.
    const childCsrf = extractAttr(html, COMPONENT_CSRF_ATTRIBUTE);
    assert.ok(childCsrf.length > 0);
  });

  it('renders child content (label/count in initial state)', async () => {
    const runtime = makeRuntime({ card });
    const ctx = nestedContext(runtime);
    const vnode = await renderNested('card', ctx);
    const html = getNestedHtml(vnode);

    assert.ok(html.includes('default'));
    assert.ok(html.includes('>0<'));
  });

  it('accepts a string name (default div wrapper)', async () => {
    const runtime = makeRuntime({ card });
    const ctx = nestedContext(runtime);
    const vnode = await renderNested('card', ctx);
    assert.equal(vnode.type, 'div');
  });

  it('accepts a NestedComponentConfig with custom tag', async () => {
    const runtime = makeRuntime({ card });
    const ctx = nestedContext(runtime);
    const config = defineNestedComponent({ name: 'section', component: 'card' });
    const vnode = await renderNested(config, ctx);
    assert.equal(vnode.type, 'section');
  });

  it('places data-nested-key on the wrapper when key is set', async () => {
    const runtime = makeRuntime({ card });
    const ctx = nestedContext(runtime);
    const config = defineNestedComponent({ name: 'div', component: 'card', key: 'child-1' });
    const vnode = await renderNested(config, ctx);
    assert.equal(getNestedProp(vnode, 'data-nested-key'), 'child-1');
  });

  it('child state is independent — two renders produce distinct tokens', async () => {
    const runtime = makeRuntime({ card });
    const ctx1 = nestedContext(runtime);
    const ctx2 = nestedContext(runtime);

    const vnode1 = await renderNested('card', ctx1);
    const vnode2 = await renderNested('card', ctx2);

    const snap1 = extractAttr(getNestedHtml(vnode1), COMPONENT_SNAPSHOT_ATTRIBUTE);
    const snap2 = extractAttr(getNestedHtml(vnode2), COMPONENT_SNAPSHOT_ATTRIBUTE);
    assert.notEqual(snap1, snap2);
  });

  it('a child with a failing authorize throws NestedComponentError', async () => {
    const runtime = makeRuntime({ 'child-denied': childDenied });
    const ctx = nestedContext(runtime);
    await assert.rejects(() => renderNested('child-denied', ctx), NestedComponentError);
  });
});

// ---------------------------------------------------------------------------
// renderNested error paths
// ---------------------------------------------------------------------------

describe('renderNested errors', () => {
  it('throws when no runtime is registered on the context', async () => {
    // Build a context with no services.
    const bareContext: RequestContext = {
      request: makeRequest(`${ORIGIN}/`),
      url: new URL(ORIGIN),
      params: {},
      session: null,
    };
    await assert.rejects(() => renderNested('card', bareContext), NestedComponentError);
  });

  it('throws for an unknown component name', async () => {
    const runtime = makeRuntime({ card });
    const ctx = nestedContext(runtime);
    await assert.rejects(() => renderNested('nonexistent', ctx), NestedComponentError);
  });

  it('throws when the name string is invalid', async () => {
    const runtime = makeRuntime({ card });
    const ctx = nestedContext(runtime);
    await assert.rejects(() => renderNested(42 as unknown as string, ctx), NestedComponentError);
  });
});

// ---------------------------------------------------------------------------
// Integration: child snapshots are independently verified
// ---------------------------------------------------------------------------

describe('child snapshot independence', () => {
  it('child snapshot carries its own component name, not the parent', async () => {
    const runtime = makeRuntime({ card });
    const ctx = nestedContext(runtime);
    const vnode = await renderNested('card', ctx);
    const html = getNestedHtml(vnode);
    assert.ok(html.includes(`${COMPONENT_ATTRIBUTE}="card"`));
  });

  it('child snapshot is signed and carries an id', async () => {
    const runtime = makeRuntime({ card });
    const ctx = nestedContext(runtime);
    const vnode = await renderNested('card', ctx);
    const html = getNestedHtml(vnode);

    // Extract the snapshot token: it is a base64url payload.signature pair.
    const snap = extractAttr(html, COMPONENT_SNAPSHOT_ATTRIBUTE);
    const parts = snap.split('.');
    assert.equal(parts.length, 2);
    assert.ok(parts[0]!.length > 0);
    assert.ok(parts[1]!.length > 0);
  });
});
