/**
 * Client navigation runtime tests (Node-import safe).
 *
 * These tests exercise the pieces that do not require a real browser: module
 * import safety, registry typing/validation, bounded-JSON props parsing, and
 * the wiring/idempotence of the injectable `createClientRuntime` seam against a
 * small structural `document` double. They deliberately do NOT simulate real
 * Preact hydration or Turbo navigation — those need a live DOM and are owned by
 * the browser fixture (Vite + Chromium, no screenshot) in the integration suite.
 *
 * The structural `document` double here is a focused contract stand-in, not a
 * blanket DOM mock: it records listener registration and event dispatch so the
 * runtime's own decisions (which events it listens to, what it dispatches, and
 * how it reports a missing JSails-owned frame) can be asserted without claiming
 * any visual/browser proof.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  FRAME_MISSING_MESSAGE,
  ISLAND_ATTRIBUTE,
  JSAILS_BEFORE_NAVIGATION,
  IslandPropsError,
  IslandRegistryError,
  morphComponent,
  registerIsland,
  startClient,
  ClientEnvironmentError,
  type BeforeNavigationDetail,
  type IslandComponent,
} from '../../src/client/index.js';

import {
  ISLAND_HYDRATED_ATTRIBUTE,
  MAX_PROPS_LENGTH,
  createIslandManager,
  createIslandRegistry,
  parseIslandProps,
  type IslandProps,
  type JsailsDocument,
  type JsailsElement,
  type JsailsEvent,
} from '../../src/client/islands.js';

import {
  createCachedLoader,
  createClientRuntime,
  createTurboEventAdapter,
  TURBO_PREFETCH_ATTRIBUTE,
  TURBO_TO_JSAILS_EVENT_MAP,
  type BrowserScope,
  type TurboModule,
} from '../../src/client/navigation.js';

// ---------------------------------------------------------------------------
// Structural doubles (focused contract stand-ins, not a DOM mock)
// ---------------------------------------------------------------------------

interface FakeDocument extends JsailsDocument {
  readonly listeners: Map<string, Array<(event: JsailsEvent) => void>>;
  readonly dispatched: JsailsEvent[];
}

function fakeElement(id = '', attrs: Record<string, string> = {}): JsailsElement {
  const attributes = new Map<string, string>(Object.entries(attrs));
  return {
    id,
    isConnected: true,
    innerHTML: '',
    textContent: null,
    getAttribute: (name) => attributes.get(name) ?? null,
    setAttribute: (name, value) => {
      attributes.set(name, value);
    },
    removeAttribute: (name) => {
      attributes.delete(name);
    },
    hasAttribute: (name) => attributes.has(name),
    querySelectorAll: () => [],
  };
}

function fakeDocument(elements: JsailsElement[] = []): FakeDocument {
  const listeners = new Map<string, Array<(event: JsailsEvent) => void>>();
  const dispatched: JsailsEvent[] = [];
  return {
    querySelectorAll: () => elements,
    addEventListener: (type, listener) => {
      const list = listeners.get(type) ?? [];
      list.push(listener);
      listeners.set(type, list);
    },
    removeEventListener: (type, listener) => {
      const list = listeners.get(type) ?? [];
      const remaining = list.filter((entry) => entry !== listener);
      if (remaining.length === 0) {
        listeners.delete(type);
      } else {
        listeners.set(type, remaining);
      }
    },
    dispatchEvent: (event) => {
      dispatched.push(event);
      // Invoke registered listeners so a dispatched Turbo event reaches the
      // runtime's own handlers, mirroring the real DOM.
      for (const listener of listeners.get(event.type) ?? []) {
        listener(event);
      }
      return false;
    },
    listeners,
    dispatched,
  };
}

interface FakeEvent extends JsailsEvent {
  prevented: boolean;
}

function fakeEvent(
  type: string,
  options: { target?: JsailsElement | null; detail?: unknown } = {},
): FakeEvent {
  const event: FakeEvent = {
    type,
    target: options.target ?? null,
    detail: options.detail,
    prevented: false,
    preventDefault: () => {
      event.prevented = true;
    },
  };
  return event;
}

interface FakeTurbo extends TurboModule {
  started: number;
  readonly messages: string[];
  /** When set, `renderStreamMessage` dispatches the real stream-render event. */
  document?: FakeDocument;
  /** When true, the dispatched stream render rejects instead of resolving. */
  failRender?: boolean;
}

function fakeTurbo(document?: FakeDocument): FakeTurbo {
  return {
    started: 0,
    messages: [],
    document,
    start() {
      this.started += 1;
    },
    renderStreamMessage(message: string) {
      this.messages.push(message);
      const doc = this.document;
      if (doc === undefined) {
        return;
      }
      // Mirror Turbo: parse the stream element, then dispatch the cancelable
      // before-stream-render event whose `detail.render` performs the morph.
      const requestId = /request-id="([^"]+)"/.exec(message)?.[1] ?? null;
      const stream = { requestId };
      const detail = {
        newStream: stream,
        render: async (_stream: { requestId: string | null }) => {
          if (this.failRender === true) {
            throw new Error('morph failed');
          }
        },
      };
      const event = fakeEvent('turbo:before-stream-render', { detail });
      doc.dispatchEvent(event);
      // Turbo invokes the (possibly wrapped) render after the event; mirror it
      // so the runtime's await observes the actual morph.
      void detail.render(stream);
    },
  };
}

function fakeScope(doc: FakeDocument): BrowserScope & {
  created: JsailsEvent[];
  createdOptions: Array<{ cancelable?: boolean } | undefined>;
} {
  const created: JsailsEvent[] = [];
  const createdOptions: Array<{ cancelable?: boolean } | undefined> = [];
  const scope = {
    document: doc,
    createEvent: (type: string, detail?: unknown, options?: { cancelable?: boolean }) => {
      const event = fakeEvent(type, { detail });
      created.push(event);
      createdOptions.push(options);
      return event;
    },
    created,
    createdOptions,
  };
  return scope;
}

function listenerFor(doc: FakeDocument, type: string): ((event: JsailsEvent) => void) | undefined {
  return doc.listeners.get(type)?.[0];
}

/** Yield to the microtask/macrotask queue so pending promises can settle. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// ---------------------------------------------------------------------------
// Compile-time typing proof (never executed at runtime)
// ---------------------------------------------------------------------------

// `registerIsland` accepts a typed Preact FunctionComponent and preserves its
// props type through inference; a non-component is rejected by the compiler.
if (false) {
  const typedComponent: IslandComponent<{ initial: number }> = () => null;
  registerIsland('typed-component', typedComponent);
  // @ts-expect-error — a non-component argument is rejected at compile time
  registerIsland('not-a-component', 42);
}

// ---------------------------------------------------------------------------
// Import safety
// ---------------------------------------------------------------------------

describe('client runtime import safety', () => {
  it('exposes the public surface without touching the DOM at module scope', () => {
    assert.equal(typeof startClient, 'function');
    assert.equal(typeof registerIsland, 'function');
    assert.equal(typeof morphComponent, 'function');
    assert.equal(typeof parseIslandProps, 'function');
    assert.equal(typeof createClientRuntime, 'function');
  });
});

// ---------------------------------------------------------------------------
// Island registration
// ---------------------------------------------------------------------------

describe('island registration', () => {
  it('registers a typed component and rejects invalid names', () => {
    const component: IslandComponent<{ initial: number }> = () => null;
    registerIsland('registration-typed', component);
    assert.throws(() => registerIsland('', component), IslandRegistryError);
    assert.throws(() => registerIsland('   ', component), IslandRegistryError);
    assert.throws(() => registerIsland('__proto__', component), IslandRegistryError);
  });

  it('rejects a duplicate name with a different component but tolerates the same one', () => {
    const a: IslandComponent = () => null;
    const b: IslandComponent = () => null;
    registerIsland('registration-dup', a);
    registerIsland('registration-dup', a); // idempotent: same reference
    assert.throws(() => registerIsland('registration-dup', b), IslandRegistryError);
  });

  it('rejects a non-plain islands map', () => {
    const component: IslandComponent = () => null;
    assert.throws(() => createIslandRegistry(Object.create({ x: component })), IslandRegistryError);
  });
});

// ---------------------------------------------------------------------------
// Bounded-JSON props validation
// ---------------------------------------------------------------------------

describe('parseIslandProps', () => {
  it('returns an empty object for absent or empty markers', () => {
    assert.deepEqual(parseIslandProps(null), {});
    assert.deepEqual(parseIslandProps(undefined), {});
    assert.deepEqual(parseIslandProps(''), {});
  });

  it('decodes a valid object', () => {
    const props: IslandProps = parseIslandProps('{"a":1,"b":[true,null,"x"]}');
    assert.deepEqual(props, { a: 1, b: [true, null, 'x'] });
  });

  it('rejects invalid JSON and non-object top-level values', () => {
    assert.throws(() => parseIslandProps('{'), IslandPropsError);
    assert.throws(() => parseIslandProps('[1,2]'), IslandPropsError);
    assert.throws(() => parseIslandProps('42'), IslandPropsError);
    assert.throws(() => parseIslandProps('"str"'), IslandPropsError);
    assert.throws(() => parseIslandProps('null'), IslandPropsError);
  });

  it('rejects prototype-polluting keys at any depth', () => {
    assert.throws(() => parseIslandProps('{"__proto__":{}}'), IslandPropsError);
    assert.throws(() => parseIslandProps('{"ok":true,"constructor":1}'), IslandPropsError);
    assert.throws(() => parseIslandProps('{"nested":{"prototype":{}}}'), IslandPropsError);
  });

  it('allows forbidden names as values (keys only are guarded)', () => {
    assert.deepEqual(parseIslandProps('{"name":"__proto__"}'), {
      name: '__proto__',
    });
  });

  it('bounds the input length and nesting depth', () => {
    const oversized = JSON.stringify({ x: 'a'.repeat(MAX_PROPS_LENGTH) });
    assert.throws(() => parseIslandProps(oversized), IslandPropsError);

    let deep = '{}';
    for (let i = 0; i < 40; i += 1) {
      deep = `{"x":${deep}}`;
    }
    assert.throws(() => parseIslandProps(deep), IslandPropsError);
  });

  it('never evaluates code: a script-looking value stays a plain string', () => {
    const props = parseIslandProps('{"x":"<script>alert(1)</script>"}');
    assert.equal(props.x, '<script>alert(1)</script>');
  });
});

// ---------------------------------------------------------------------------
// startClient (Node-import safe, graceful failure)
// ---------------------------------------------------------------------------

describe('startClient', () => {
  it('rejects with ClientEnvironmentError when no browser document exists', async () => {
    await assert.rejects(startClient(), ClientEnvironmentError);
  });
});

// ---------------------------------------------------------------------------
// createCachedLoader (internal loader seam used by defaultLoadTurbo)
// ---------------------------------------------------------------------------

describe('createCachedLoader', () => {
  it('propagates the original failure, retries, then caches the success', async () => {
    const failure = new Error('turbo load failed');
    let attempts = 0;
    const load = createCachedLoader(() => {
      attempts += 1;
      if (attempts === 1) {
        return Promise.reject(failure);
      }
      return Promise.resolve({ attempt: attempts });
    });

    await assert.rejects(load(), (thrown: unknown) => thrown === failure);

    const first = await load();
    assert.deepEqual(first, { attempt: 2 });

    // The successful load is reused: no third attempt, same resolved value.
    const second = await load();
    assert.equal(second, first);
    assert.equal(attempts, 2);
  });

  it('dedupes concurrent callers and reuses the resolved value', async () => {
    let calls = 0;
    let release!: (value: number) => void;
    const gate = new Promise<number>((resolve) => {
      release = resolve;
    });
    const load = createCachedLoader(() => {
      calls += 1;
      return gate;
    });

    const a = load();
    const b = load();
    assert.equal(a, b, 'concurrent callers share the in-flight promise');

    release(7);
    assert.equal(await a, 7);
    assert.equal(await load(), 7);
    assert.equal(calls, 1, 'a resolved load is never re-invoked');
  });
});

// ---------------------------------------------------------------------------
// createClientRuntime (injectable seam: wiring, idempotence, morph, hook)
// ---------------------------------------------------------------------------

describe('createClientRuntime', () => {
  it('starts Turbo once and is idempotent across repeated start()', async () => {
    const doc = fakeDocument();
    const turbo = fakeTurbo();
    let loadCount = 0;
    const runtime = createClientRuntime({
      scope: fakeScope(doc),
      loadTurbo: async () => {
        loadCount += 1;
        return turbo;
      },
    });

    await runtime.start();
    await runtime.start();

    assert.equal(loadCount, 1);
    assert.equal(turbo.started, 1);
    assert.equal(runtime.started, true);
  });

  it('tears down a failed Turbo load and hydrates islands once on retry', async () => {
    let hydrations = 0;
    const Counter = () => {
      hydrations += 1;
      return null;
    };
    const island = fakeElement('island-1', { [ISLAND_ATTRIBUTE]: 'counter' });
    const doc = fakeDocument([island]);
    const turbo = fakeTurbo();
    let attempts = 0;
    const runtime = createClientRuntime({
      scope: fakeScope(doc),
      islands: { counter: Counter },
      components: false,
      loadTurbo: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error('turbo load failed');
        }
        return turbo;
      },
    });

    await assert.rejects(runtime.start(), /turbo load failed/);
    assert.equal(runtime.started, false);
    assert.equal(hydrations, 0, 'no hydration before Turbo loads');
    assert.equal(doc.listeners.size, 0, 'failed load leaked document listeners');

    await runtime.start();
    assert.equal(runtime.started, true);
    assert.equal(turbo.started, 1);
    assert.equal(hydrations, 1, 'retry hydrates each island exactly once');
    for (const [type, handlers] of doc.listeners) {
      // A shared event may carry the runtime handler plus the turbo→jsails
      // event-adapter handler; no type may ever accumulate more than that.
      assert.ok(handlers.length <= 2, `duplicate listener for ${type}`);
    }

    // A start after success is a no-op: no re-wiring, no re-hydration.
    await runtime.start();
    assert.equal(hydrations, 1);
    assert.equal(turbo.started, 1);

    runtime.close();
    assert.equal(doc.listeners.size, 0);
  });

  it('tears down a failed Turbo start and retries without duplicate listeners', async () => {
    const doc = fakeDocument();
    const good = fakeTurbo();
    let attempts = 0;
    const runtime = createClientRuntime({
      scope: fakeScope(doc),
      components: false,
      loadTurbo: () => {
        attempts += 1;
        if (attempts === 1) {
          return {
            start() {
              throw new Error('turbo start failed');
            },
            renderStreamMessage(_message: string) {},
          };
        }
        return good;
      },
    });

    await assert.rejects(runtime.start(), /turbo start failed/);
    assert.equal(runtime.started, false);
    assert.equal(doc.listeners.size, 0, 'failed start leaked document listeners');

    await runtime.start();
    assert.equal(good.started, 1);
    for (const [type, handlers] of doc.listeners) {
      assert.ok(handlers.length <= 2, `duplicate listener for ${type}`);
    }

    runtime.close();
    assert.equal(doc.listeners.size, 0);
  });

  it('unmounts islands hydrated before a later startup failure', async () => {
    let hydrations = 0;
    const Counter = () => {
      hydrations += 1;
      return null;
    };
    const island = fakeElement('island-1', { [ISLAND_ATTRIBUTE]: 'counter' });
    const doc = fakeDocument([island]);
    const runtime = createClientRuntime({
      scope: fakeScope(doc),
      islands: { counter: Counter },
      // An empty origin makes the component binding layer throw only after the
      // island manager has already hydrated, exercising partial teardown.
      componentOrigin: '',
      loadTurbo: async () => fakeTurbo(),
    });

    await assert.rejects(runtime.start(), /origin must be a non-empty string/);
    assert.equal(runtime.started, false);
    assert.equal(hydrations, 1, 'island was hydrated before the failure');
    assert.equal(
      island.getAttribute(ISLAND_HYDRATED_ATTRIBUTE),
      null,
      'hydrated island must be restored on startup failure',
    );
    assert.equal(doc.listeners.size, 0);
  });

  it('morphs content via a Turbo replace/update morph stream message', async () => {
    const doc = fakeDocument();
    const turbo = fakeTurbo(doc);
    const runtime = createClientRuntime({
      scope: fakeScope(doc),
      loadTurbo: async () => turbo,
    });

    await runtime.morphComponent('counter-1', '<div>hi</div>');
    await runtime.morphComponent('counter-1', '<div>hi</div>', {
      action: 'update',
    });

    assert.equal(turbo.messages.length, 2);
    assert.match(turbo.messages[0] ?? '', /action="replace"/);
    assert.match(turbo.messages[0] ?? '', /target="counter-1"/);
    assert.match(turbo.messages[0] ?? '', /method="morph"/);
    assert.match(turbo.messages[0] ?? '', /request-id="[^"]+"/);
    assert.match(turbo.messages[0] ?? '', /<div>hi<\/div>/);
    assert.match(turbo.messages[1] ?? '', /action="update"/);

    await assert.rejects(runtime.morphComponent('bad id', '<div/>'), TypeError);
  });

  it('awaits the actual stream render, not merely the enqueue', async () => {
    const doc = fakeDocument();
    const turbo = fakeTurbo(doc);
    // Hold the morph open so the await is observable: the promise must not
    // settle until `detail.render` resolves.
    let releaseRender!: () => void;
    const renderGate = new Promise<void>((resolve) => {
      releaseRender = resolve;
    });
    // A Turbo double whose stream render stays pending until released.
    const gatedTurbo: FakeTurbo = {
      ...turbo,
      renderStreamMessage(message: string) {
        turbo.messages.push(message);
        const requestId = /request-id="([^"]+)"/.exec(message)?.[1] ?? null;
        const detail = {
          newStream: { requestId },
          render: (_stream: { requestId: string | null }) => renderGate,
        };
        doc.dispatchEvent(fakeEvent('turbo:before-stream-render', { detail }));
        void detail.render({ requestId });
      },
    };
    const runtime = createClientRuntime({
      scope: fakeScope(doc),
      loadTurbo: async () => gatedTurbo,
    });

    let settled = false;
    const pending = runtime.morphComponent('counter-1', '<div>hi</div>').then(() => {
      settled = true;
    });
    await flush();
    assert.equal(settled, false, 'must not settle before the morph renders');

    releaseRender();
    await pending;
    assert.equal(settled, true);
  });

  it('rejects when the stream render rejects and removes its listener', async () => {
    const doc = fakeDocument();
    const turbo = fakeTurbo(doc);
    turbo.failRender = true;
    const runtime = createClientRuntime({
      scope: fakeScope(doc),
      loadTurbo: async () => turbo,
    });

    await assert.rejects(runtime.morphComponent('counter-1', '<div>hi</div>'), /morph failed/);
    // The one-shot listener is cleaned up on settle.
    assert.equal(doc.listeners.get('turbo:before-stream-render')?.length ?? 0, 0);
  });

  it('rejects after the bounded timeout when no stream render arrives', async () => {
    const doc = fakeDocument();
    // A Turbo double that records the message but never dispatches the event.
    const silentTurbo = fakeTurbo();
    const runtime = createClientRuntime({
      scope: fakeScope(doc),
      loadTurbo: async () => silentTurbo,
    });

    await assert.rejects(
      runtime.morphComponent('counter-1', '<div>hi</div>', { timeoutMs: 20 }),
      /timed out/,
    );
    assert.equal(doc.listeners.get('turbo:before-stream-render')?.length ?? 0, 0);
  });

  it('dispatches the before-navigation hook (callback + custom event)', () => {
    const doc = fakeDocument();
    const scope = fakeScope(doc);
    const calls: BeforeNavigationDetail[] = [];
    createClientRuntime({
      scope,
      loadTurbo: async () => fakeTurbo(),
      onBeforeNavigation: (detail) => {
        calls.push(detail);
      },
    });

    const visitHandler = listenerFor(doc, 'turbo:visit');
    const renderHandler = listenerFor(doc, 'turbo:before-render');
    assert.ok(visitHandler);
    assert.ok(renderHandler);

    visitHandler(
      fakeEvent('turbo:visit', {
        detail: { url: '/next', action: 'advance' },
      }),
    );
    renderHandler(
      fakeEvent('turbo:before-render', {
        detail: { renderMethod: 'replace', isPreview: false },
      }),
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, '/next');
    assert.equal(calls[0]?.action, 'advance');
    assert.equal(calls[0]?.renderMethod, 'replace');
    assert.equal(calls[0]?.isPreview, false);

    const navEvent = scope.created.find((event) => event.type === JSAILS_BEFORE_NAVIGATION);
    assert.ok(navEvent);
    assert.deepEqual(navEvent.detail, calls[0]);
  });

  it('shows generic text for a missing JSails-owned frame and leaves others alone', () => {
    const owned = fakeElement('owned-frame', { [ISLAND_ATTRIBUTE]: 'counter' });
    const unowned = fakeElement('plain-frame');
    const doc = fakeDocument();
    createClientRuntime({
      scope: fakeScope(doc),
      loadTurbo: async () => fakeTurbo(),
    });

    const handler = listenerFor(doc, 'turbo:frame-missing');
    assert.ok(handler);

    const ownedEvent = fakeEvent('turbo:frame-missing', { target: owned });
    handler(ownedEvent);
    assert.equal(ownedEvent.prevented, true);
    assert.equal(owned.textContent, FRAME_MISSING_MESSAGE);

    const unownedEvent = fakeEvent('turbo:frame-missing', { target: unowned });
    handler(unownedEvent);
    assert.equal(unownedEvent.prevented, false);
    assert.equal(unowned.textContent, null);
  });

  it('close() removes listeners and is idempotent', () => {
    const doc = fakeDocument();
    const runtime = createClientRuntime({
      scope: fakeScope(doc),
      loadTurbo: async () => fakeTurbo(),
    });

    runtime.close();
    runtime.close();

    assert.equal(doc.listeners.size, 0);
  });
});

// ---------------------------------------------------------------------------
// createTurboEventAdapter (turbo:* → jsails:* lifecycle bridge)
// ---------------------------------------------------------------------------

describe('createTurboEventAdapter', () => {
  it('re-dispatches every mapped Turbo event as a non-cancelable jsails:* event', () => {
    const doc = fakeDocument();
    const scope = fakeScope(doc);
    createTurboEventAdapter(scope);

    // A listener exists for every mapped Turbo event.
    for (const turboType of Object.keys(TURBO_TO_JSAILS_EVENT_MAP)) {
      assert.equal(doc.listeners.get(turboType)?.length, 1, `missing listener for ${turboType}`);
    }

    // Dispatching one Turbo event re-dispatches its jsails:* counterpart with
    // the same detail, non-cancelable.
    const detail = { url: '/next', action: 'advance' };
    doc.dispatchEvent(fakeEvent('turbo:click', { detail }));

    const forwarded = scope.created.find((event) => event.type === 'jsails:click');
    assert.ok(forwarded, 'a jsails:click event must be created');
    assert.deepEqual(forwarded.detail, detail);
    const options = scope.createdOptions[scope.created.indexOf(forwarded)];
    assert.deepEqual(options, { cancelable: false });
    // The created event is itself dispatched onto the document.
    assert.ok(doc.dispatched.some((event) => event.type === 'jsails:click'));
  });

  it('excludes the stream/morph events, which belong to the morph mechanism', () => {
    assert.equal(TURBO_TO_JSAILS_EVENT_MAP['turbo:before-stream-render'], undefined);
    assert.equal(
      TURBO_TO_JSAILS_EVENT_MAP['turbo:before-frame-render'],
      'jsails:before-frame-render',
    );
    assert.ok(!Object.keys(TURBO_TO_JSAILS_EVENT_MAP).some((type) => type.includes('stream')));
  });

  it('dispose() removes every installed listener and is idempotent', () => {
    const doc = fakeDocument();
    const scope = fakeScope(doc);
    const adapter = createTurboEventAdapter(scope);

    for (const turboType of Object.keys(TURBO_TO_JSAILS_EVENT_MAP)) {
      assert.equal(doc.listeners.get(turboType)?.length, 1);
    }

    adapter.dispose();
    adapter.dispose();

    for (const turboType of Object.keys(TURBO_TO_JSAILS_EVENT_MAP)) {
      assert.equal(doc.listeners.get(turboType), undefined, `leaked listener for ${turboType}`);
    }
  });

  it('exposes the Turbo hover-prefetch passthrough marker', () => {
    assert.equal(TURBO_PREFETCH_ATTRIBUTE, 'data-turbo-prefetch');
  });
});

// ---------------------------------------------------------------------------
// createIslandManager (reporting, without real hydration)
// ---------------------------------------------------------------------------

describe('createIslandManager', () => {
  it('reports an unknown island through onError instead of throwing', () => {
    const element = fakeElement('', { [ISLAND_ATTRIBUTE]: 'nope' });
    const doc = fakeDocument([element]);
    const errors: unknown[] = [];
    const manager = createIslandManager({
      document: doc,
      registry: new Map(),
      onError: (error) => {
        errors.push(error);
      },
    });

    manager.mountAll();

    assert.equal(errors.length, 1);
    assert.ok(errors[0] instanceof IslandRegistryError);
  });
});
